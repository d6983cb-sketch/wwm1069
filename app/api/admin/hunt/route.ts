import { NextResponse } from "next/server";
import { authorizeAdmin, writeAuditLog } from "@/lib/admin-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import type { HuntEventStatus, HuntLeaderboardMode, HuntReviewStatus } from "@/lib/hunt";

const statuses: HuntEventStatus[] = ["draft", "open", "closed", "results_published", "archived"];
const leaderboardModes: HuntLeaderboardMode[] = ["hidden", "live", "final"];
const reviewStatuses: HuntReviewStatus[] = ["correct", "incorrect", "duplicate"];

function json(error: string, message: string, status: number) {
  return NextResponse.json({ error, message }, { status });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const type = String(body.type ?? "");
  const permission = type === "hunt_review" ? "submission_manager" : "event_manager";
  const auth = await authorizeAdmin(request, permission);
  if (!auth.ok) return auth.response;
  const { context } = auth;
  const admin = createAdminClient();

  if (type === "hunt_event_save") {
    const eventId = String(body.eventId ?? "");
    const title = String(body.title ?? "").trim();
    const description = String(body.description ?? "").trim().slice(0, 2000);
    const startsAt = String(body.startsAt ?? "");
    const endsAt = String(body.endsAt ?? "");
    const status = String(body.status ?? "draft") as HuntEventStatus;
    const leaderboardMode = String(body.leaderboardMode ?? "hidden") as HuntLeaderboardMode;
    const totalTargets = Number(body.totalTargets);
    if (!title || title.length > 100) return json("invalid_title", "活動名稱不可空白，且最多 100 字。", 400);
    if (!Number.isInteger(totalTargets) || totalTargets < 1 || totalTargets > 999) return json("invalid_target_count", "藏物總數必須介於 1 至 999。", 400);
    if (!statuses.includes(status) || !leaderboardModes.includes(leaderboardMode)) return json("invalid_settings", "活動狀態或排行榜設定不正確。", 400);
    if (!Number.isFinite(Date.parse(startsAt)) || !Number.isFinite(Date.parse(endsAt)) || Date.parse(startsAt) >= Date.parse(endsAt)) {
      return json("invalid_time", "活動開始時間必須早於結束時間。", 400);
    }
    const payload = {
      title,
      description: description || null,
      target_image_path: "/images/hunt-target.webp",
      show_target_image: body.showTargetImage === true,
      total_targets: totalTargets,
      starts_at: new Date(startsAt).toISOString(),
      ends_at: new Date(endsAt).toISOString(),
      status,
      leaderboard_mode: leaderboardMode,
      updated_at: new Date().toISOString(),
    };
    const { data: before } = eventId
      ? await admin.from("hunt_events").select("*").eq("id", eventId).maybeSingle()
      : { data: null };
    if (eventId && !before) return json("event_not_found", "找不到尋物活動。", 404);
    if (before?.status === "archived" && status !== "archived" && !context.isSuperAdmin) {
      return json("super_admin_required", "封存活動只有最高管理員可以重新開啟。", 403);
    }
    const query = before
      ? admin.from("hunt_events").update(payload).eq("id", before.id)
      : admin.from("hunt_events").insert({ ...payload, created_by: context.profile.id });
    const { data: after, error } = await query.select("*").single();
    if (error || !after) return json("event_save_failed", "尋物活動設定儲存失敗。", 500);
    await writeAuditLog({ context, actionType: before ? "hunt_event_update" : "hunt_event_create", targetType: "hunt_event", targetId: after.id, beforeData: before, afterData: after });
    return NextResponse.json({ ok: true, message: "尋物活動設定已儲存。" });
  }

  if (type === "hunt_review") {
    const submissionId = Number(body.submissionId);
    const requestedStatus = String(body.status ?? "") as HuntReviewStatus;
    const targetNumber = body.targetNumber === "" || body.targetNumber == null ? null : Number(body.targetNumber);
    const reviewNote = String(body.reviewNote ?? "").trim().slice(0, 500);
    if (!Number.isInteger(submissionId) || !reviewStatuses.includes(requestedStatus)) return json("invalid_review", "審核資料不正確。", 400);
    const { data: before } = await admin.from("hunt_submissions").select("*").eq("id", submissionId).maybeSingle();
    if (!before) return json("submission_not_found", "找不到這張尋物照片。", 404);
    const { data: event } = await admin.from("hunt_events").select("id,total_targets,status").eq("id", before.hunt_event_id).maybeSingle();
    if (!event) return json("event_not_found", "找不到尋物活動。", 404);
    if (event.status === "archived") return json("event_archived", "活動已封存，不能再修改審核結果。", 422);
    if ((requestedStatus === "correct" || requestedStatus === "duplicate")
      && (!Number.isInteger(targetNumber) || targetNumber! < 1 || targetNumber! > event.total_targets)) {
      return json("invalid_target", `請選擇 1 至 ${event.total_targets} 的藏物編號。`, 400);
    }

    let finalStatus = requestedStatus;
    let duplicateOfId: number | null = null;
    if (targetNumber !== null && (requestedStatus === "correct" || requestedStatus === "duplicate")) {
      const { data: existingCorrect } = await admin
        .from("hunt_submissions")
        .select("id")
        .eq("hunt_event_id", before.hunt_event_id)
        .eq("profile_id", before.profile_id)
        .eq("matched_target_number", targetNumber)
        .eq("status", "correct")
        .neq("id", before.id)
        .maybeSingle();
      if (existingCorrect) {
        finalStatus = "duplicate";
        duplicateOfId = existingCorrect.id;
      } else if (requestedStatus === "duplicate") {
        return json("duplicate_source_missing", "這位玩家尚無同一藏物的正確紀錄，不能標示為重複。", 422);
      }
    }

    const update = {
      status: finalStatus,
      matched_target_number: finalStatus === "incorrect" ? null : targetNumber,
      duplicate_of_id: finalStatus === "duplicate" ? duplicateOfId : null,
      review_note: reviewNote || null,
      reviewed_by: context.profile.id,
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const { data: after, error } = await admin.from("hunt_submissions").update(update).eq("id", submissionId).select("*").single();
    if (error || !after) return json("review_failed", "審核結果儲存失敗，原紀錄未變更。", error?.code === "23505" ? 409 : 500);
    await writeAuditLog({ context, actionType: "hunt_submission_review", targetType: "hunt_submission", targetId: submissionId, beforeData: before, afterData: after });
    return NextResponse.json({
      ok: true,
      message: finalStatus === "duplicate" && requestedStatus === "correct"
        ? "已偵測為同一玩家的重複藏物，照片已標記為重複。"
        : "審核結果已儲存。",
    });
  }

  return json("unsupported_action", "不支援的操作。", 400);
}
