import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { calculateHuntProgress, isHuntOpen, type HuntAutoStatus, type HuntEventRecord, type HuntSubmissionRecord } from "@/lib/hunt";
import { HUNT_EMBEDDING_MODEL, isHuntAiConfigured, recognizeHuntImage } from "@/lib/hunt-ai";

export const maxDuration = 60;

const validPath = (userId: string, value: unknown) => {
  if (typeof value !== "string") return false;
  const escapedUserId = userId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escapedUserId}/[0-9a-f-]{36}-proof\\.(?:jpe?g|png|webp)$`, "i").test(value);
};

async function removeProof(path: string | null) {
  if (!path) return;
  await createAdminClient().storage.from("hunt-proofs").remove([path]);
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized", message: "請先登入。" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const imagePath = validPath(user.id, body.imagePath) ? String(body.imagePath) : null;
  const fileHash = String(body.fileHash ?? "").toLowerCase();
  const playerNote = String(body.playerNote ?? "").trim().slice(0, 200);
  if (!imagePath || !/^[a-f0-9]{64}$/.test(fileHash)) {
    await removeProof(imagePath);
    return NextResponse.json({ error: "invalid_submission", message: "照片資料不正確，請重新選擇。" }, { status: 400 });
  }

  const [{ data: eventData }, { data: profile }] = await Promise.all([
    admin.from("hunt_events").select("*").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    admin.from("profiles").select("id,is_disqualified").eq("id", user.id).maybeSingle(),
  ]);
  const event = eventData as HuntEventRecord | null;
  if (!profile || profile.is_disqualified) {
    await removeProof(imagePath);
    return NextResponse.json({ error: "ineligible", message: "目前沒有參加資格。" }, { status: 403 });
  }
  if (!event || !isHuntOpen(event)) {
    await removeProof(imagePath);
    return NextResponse.json({ error: "hunt_closed", message: "目前未開放上傳尋物照片。" }, { status: 422 });
  }

  const { data: duplicate } = await admin
    .from("hunt_submissions")
    .select("id")
    .eq("hunt_event_id", event.id)
    .eq("profile_id", user.id)
    .eq("file_hash", fileHash)
    .maybeSingle();
  if (duplicate) {
    await removeProof(imagePath);
    return NextResponse.json({ error: "duplicate_file", message: "這張照片已經上傳過，不需要重複送出。" }, { status: 409 });
  }

  const { data: created, error } = await admin.from("hunt_submissions").insert({
    hunt_event_id: event.id,
    profile_id: user.id,
    image_path: imagePath,
    file_hash: fileHash,
    player_note: playerNote || null,
    status: "pending",
  }).select("id,status,submitted_at").single();
  if (error || !created) {
    await removeProof(imagePath);
    const duplicateFile = error?.code === "23505";
    return NextResponse.json({
      error: duplicateFile ? "duplicate_file" : "create_failed",
      message: duplicateFile ? "這張照片已經上傳過。" : "照片紀錄建立失敗，請稍後再試。",
    }, { status: duplicateFile ? 409 : 500 });
  }

  let autoMessage = "照片已送出，等待管理員審核。";
  if (event.auto_match_enabled) {
    if (!isHuntAiConfigured()) {
      await admin.from("hunt_submissions").update({
        auto_status: "error",
        auto_checked_at: new Date().toISOString(),
        auto_model: HUNT_EMBEDDING_MODEL,
      }).eq("id", created.id);
      autoMessage = "照片已送出；自動辨識暫時未設定，將由管理員人工審核。";
    } else {
      try {
        const { data: proof, error: downloadError } = await admin.storage.from("hunt-proofs").download(imagePath);
        if (downloadError || !proof) throw new Error("hunt_proof_download_failed");
        const decision = await recognizeHuntImage(admin, event, proof);
        let autoStatus: HuntAutoStatus = decision.status;
        if (decision.status === "matched" && decision.targetNumber) {
          const { data: previous } = await admin
            .from("hunt_submissions")
            .select("id,status,matched_target_number,auto_status,auto_match_target_number")
            .eq("hunt_event_id", event.id)
            .eq("profile_id", user.id)
            .neq("id", created.id);
          const alreadyFound = (previous ?? []).some((row) => (
            row.status === "correct" && row.matched_target_number === decision.targetNumber
          ) || (
            row.status === "pending" && row.auto_status === "matched" && row.auto_match_target_number === decision.targetNumber
          ));
          if (alreadyFound) autoStatus = "duplicate";
        }
        await admin.from("hunt_submissions").update({
          auto_status: autoStatus,
          auto_match_target_number: decision.targetNumber,
          auto_similarity: decision.similarity,
          auto_candidates: decision.candidates,
          auto_checked_at: new Date().toISOString(),
          auto_model: HUNT_EMBEDDING_MODEL,
        }).eq("id", created.id);
        if (autoStatus === "matched" && decision.targetNumber) {
          autoMessage = `自動辨識暫定為 H${String(decision.targetNumber).padStart(3, "0")}，已立即計入暫定數量，仍需人工確認。`;
        } else if (autoStatus === "duplicate") {
          autoMessage = "自動辨識為已找到過的同一點位，暫不重複計數，仍會交由人工確認。";
        } else {
          autoMessage = "自動辨識無法確定點位，照片已保留並轉交人工審核。";
        }
      } catch {
        await admin.from("hunt_submissions").update({
          auto_status: "error",
          auto_checked_at: new Date().toISOString(),
          auto_model: HUNT_EMBEDDING_MODEL,
        }).eq("id", created.id);
        autoMessage = "照片已送出；自動辨識暫時無法完成，將由管理員人工審核。";
      }
    }
  }

  const { data: currentRows } = await admin
    .from("hunt_submissions")
    .select("status,matched_target_number,auto_status,auto_match_target_number")
    .eq("hunt_event_id", event.id)
    .eq("profile_id", user.id);
  const progress = calculateHuntProgress((currentRows ?? []) as Array<Pick<HuntSubmissionRecord, "status" | "matched_target_number" | "auto_status" | "auto_match_target_number">>);

  return NextResponse.json({ ok: true, message: autoMessage, submission: created, progress });
}

export async function DELETE(request: Request) {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized", message: "請先登入。" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const submissionId = Number(body.submissionId);
  if (!Number.isInteger(submissionId)) {
    return NextResponse.json({ error: "invalid_submission", message: "尋物投稿編號不正確。" }, { status: 400 });
  }

  const [{ data: submission }, { data: profile }] = await Promise.all([
    admin.from("hunt_submissions")
      .select("id,hunt_event_id,profile_id,image_path,status,matched_target_number,submitted_at")
      .eq("id", submissionId)
      .maybeSingle(),
    admin.from("profiles")
      .select("id,discord_id,nickname")
      .eq("id", user.id)
      .maybeSingle(),
  ]);
  if (!profile) {
    return NextResponse.json({ error: "profile_not_found", message: "找不到玩家資料。" }, { status: 404 });
  }
  if (!submission || submission.profile_id !== user.id) {
    return NextResponse.json({ error: "submission_not_found", message: "找不到你的這筆尋物投稿。" }, { status: 404 });
  }

  const { data: event } = await admin
    .from("hunt_events")
    .select("id,status,starts_at,ends_at")
    .eq("id", submission.hunt_event_id)
    .maybeSingle();
  if (!event || !isHuntOpen(event as HuntEventRecord)) {
    return NextResponse.json({ error: "hunt_closed", message: "活動目前未開放，不能刪除尋物投稿。" }, { status: 422 });
  }
  if (submission.status === "correct") {
    return NextResponse.json({ error: "confirmed_submission", message: "已由管理員確認正確的照片不能自行刪除，請聯絡管理員。" }, { status: 422 });
  }

  const { data: deleted, error: deleteError } = await admin
    .from("hunt_submissions")
    .delete()
    .eq("id", submission.id)
    .eq("profile_id", user.id)
    .neq("status", "correct")
    .select("id")
    .maybeSingle();
  if (deleteError || !deleted) {
    return NextResponse.json({ error: "delete_failed", message: "刪除失敗，原投稿仍保持不變。" }, { status: 409 });
  }

  const { error: storageError } = await admin.storage.from("hunt-proofs").remove([submission.image_path]);
  await admin.from("audit_logs").insert({
    actor_profile_id: profile.id,
    actor_discord_id: profile.discord_id,
    actor_nickname: profile.nickname,
    action_type: "hunt_submission_delete_by_owner",
    target_type: "hunt_submission",
    target_id: String(submission.id),
    before_data: submission,
    after_data: { deleted: true, storage_removed: !storageError },
    result: storageError ? "failure" : "success",
    failure_reason: storageError?.message ?? null,
    request_id: request.headers.get("x-request-id")?.slice(0, 120) || crypto.randomUUID(),
  });

  revalidatePath("/hunt");
  return NextResponse.json({
    ok: true,
    message: storageError
      ? "投稿紀錄已刪除；照片檔案將由管理員稍後清理。"
      : "錯誤的尋物投稿與照片已刪除。",
  });
}
