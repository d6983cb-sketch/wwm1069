import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isHuntOpen, type HuntEventRecord } from "@/lib/hunt";

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

  return NextResponse.json({ ok: true, message: "照片已送出，等待管理員審核。", submission: created });
}
