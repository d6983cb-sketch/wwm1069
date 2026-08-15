import { NextResponse } from "next/server";
import { authorizeAdmin, writeAuditLog } from "@/lib/admin-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { embedHuntImage, HUNT_EMBEDDING_MODEL, isHuntAiConfigured } from "@/lib/hunt-ai";
import type { HuntEventStatus, HuntLeaderboardMode, HuntReviewStatus } from "@/lib/hunt";

export const maxDuration = 60;

const statuses: HuntEventStatus[] = ["draft", "open", "closed", "results_published", "archived"];
const leaderboardModes: HuntLeaderboardMode[] = ["hidden", "live", "final"];
const reviewStatuses: HuntReviewStatus[] = ["correct", "incorrect", "duplicate"];

function json(error: string, message: string, status: number) {
  return NextResponse.json({ error, message }, { status });
}

function referencePath(eventId: string, targetNumber: number, value: unknown) {
  if (typeof value !== "string") return null;
  const escapedEventId = eventId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escapedEventId}/H${String(targetNumber).padStart(3, "0")}/[0-9a-f-]{36}\\.(?:jpg|jpeg|png)$`, "i");
  return pattern.test(value) ? value : null;
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
    const autoMatchThreshold = Number(body.autoMatchThreshold ?? 0.78);
    const autoMatchMargin = Number(body.autoMatchMargin ?? 0.04);
    const photoRevealAtRaw = String(body.photoRevealAt ?? "").trim();
    const photoRevealAt = photoRevealAtRaw ? Date.parse(photoRevealAtRaw) : null;
    const revealPlayerPhotos = body.revealPlayerPhotos === true;
    const revealAnswerPhotos = body.revealAnswerPhotos === true;
    if (!title || title.length > 100) return json("invalid_title", "活動名稱不可空白，且最多 100 字。", 400);
    if (!Number.isInteger(totalTargets) || totalTargets < 1 || totalTargets > 999) return json("invalid_target_count", "藏物總數必須介於 1 至 999。", 400);
    if (!statuses.includes(status) || !leaderboardModes.includes(leaderboardMode)) return json("invalid_settings", "活動狀態或排行榜設定不正確。", 400);
    if (!Number.isFinite(autoMatchThreshold) || autoMatchThreshold < 0 || autoMatchThreshold > 1) return json("invalid_threshold", "自動辨識門檻必須介於 0 至 1。", 400);
    if (!Number.isFinite(autoMatchMargin) || autoMatchMargin < 0 || autoMatchMargin > 0.5) return json("invalid_margin", "候選差距必須介於 0 至 0.5。", 400);
    if (body.autoMatchEnabled === true && !isHuntAiConfigured()) return json("ai_not_configured", "尚未設定 Gemini API Key，不能開啟自動辨識。", 422);
    if (photoRevealAtRaw && !Number.isFinite(photoRevealAt)) return json("invalid_reveal_time", "照片公開時間格式不正確。", 400);
    if ((revealPlayerPhotos || revealAnswerPhotos) && photoRevealAt === null) {
      return json("reveal_time_required", "開啟照片公開功能時，必須設定公開時間。", 400);
    }
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
      auto_match_enabled: body.autoMatchEnabled === true,
      auto_match_threshold: autoMatchThreshold,
      auto_match_margin: autoMatchMargin,
      photo_reveal_at: photoRevealAt === null ? null : new Date(photoRevealAt).toISOString(),
      reveal_player_photos: revealPlayerPhotos,
      reveal_answer_photos: revealAnswerPhotos,
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

  if (type === "hunt_reference_upload_url") {
    const eventId = String(body.eventId ?? "");
    const targetNumber = Number(body.targetNumber);
    const mimeType = String(body.mimeType ?? "");
    if (!eventId || !Number.isInteger(targetNumber) || !["image/jpeg", "image/png"].includes(mimeType)) {
      return json("invalid_reference", "參考點位或圖片格式不正確。", 400);
    }
    const { data: event } = await admin.from("hunt_events").select("id,total_targets,status").eq("id", eventId).maybeSingle();
    if (!event) return json("event_not_found", "找不到尋物活動。", 404);
    if (event.status === "archived") return json("event_archived", "活動已封存，不能新增參考圖。", 422);
    if (targetNumber < 1 || targetNumber > event.total_targets) return json("invalid_target", `點位必須介於 1 至 ${event.total_targets}。`, 400);
    const extension = mimeType === "image/png" ? "png" : "jpg";
    const imagePath = `${event.id}/H${String(targetNumber).padStart(3, "0")}/${crypto.randomUUID()}.${extension}`;
    const { data, error } = await admin.storage.from("hunt-references").createSignedUploadUrl(imagePath);
    if (error || !data) return json("upload_url_failed", "無法建立參考圖上傳連結。", 500);
    return NextResponse.json({ ok: true, path: imagePath, token: data.token });
  }

  if (type === "hunt_reference_point_update") {
    const referencePointId = String(body.referencePointId ?? "");
    const label = String(body.label ?? "").trim();
    if (!referencePointId || label.length > 100) {
      return json("invalid_reference_point", "點位名稱最多 100 字。", 400);
    }
    const { data: before } = await admin
      .from("hunt_reference_points")
      .select("*")
      .eq("id", referencePointId)
      .maybeSingle();
    if (!before) return json("reference_point_not_found", "找不到這個辨識點位。", 404);
    const { data: event } = await admin
      .from("hunt_events")
      .select("id,status")
      .eq("id", before.hunt_event_id)
      .maybeSingle();
    if (!event) return json("event_not_found", "找不到尋物活動。", 404);
    if (event.status === "archived") return json("event_archived", "活動已封存，不能編輯辨識點位。", 422);
    const { data: after, error } = await admin
      .from("hunt_reference_points")
      .update({
        label: label || null,
        updated_by: context.profile.id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", before.id)
      .select("*")
      .single();
    if (error || !after) return json("reference_point_update_failed", "點位名稱儲存失敗，原資料未變更。", 500);
    await writeAuditLog({
      context,
      actionType: "hunt_reference_point_update",
      targetType: "hunt_reference_point",
      targetId: before.id,
      beforeData: before,
      afterData: after,
    });
    return NextResponse.json({ ok: true, message: `H${String(after.target_number).padStart(3, "0")} 點位名稱已儲存。` });
  }

  if (type === "hunt_reference_create") {
    const eventId = String(body.eventId ?? "");
    const targetNumber = Number(body.targetNumber);
    const label = String(body.label ?? "").trim().slice(0, 100);
    const mimeType = String(body.mimeType ?? "") as "image/jpeg" | "image/png";
    const imagePath = referencePath(eventId, targetNumber, body.imagePath);
    if (!eventId || !Number.isInteger(targetNumber) || !imagePath || !["image/jpeg", "image/png"].includes(mimeType)) {
      return json("invalid_reference", "參考圖資料不正確。", 400);
    }
    const { data: event } = await admin.from("hunt_events").select("id,total_targets,status").eq("id", eventId).maybeSingle();
    if (!event) return json("event_not_found", "找不到尋物活動。", 404);
    if (event.status === "archived") return json("event_archived", "活動已封存，不能新增參考圖。", 422);
    if (targetNumber < 1 || targetNumber > event.total_targets) return json("invalid_target", `點位必須介於 1 至 ${event.total_targets}。`, 400);
    if (!isHuntAiConfigured()) return json("ai_not_configured", "尚未設定 Gemini API Key，無法建立圖片向量。", 422);
    try {
      const { data: image, error: downloadError } = await admin.storage.from("hunt-references").download(imagePath);
      if (downloadError || !image) throw new Error("reference_download_failed");
      const embedding = await embedHuntImage(image);
      const { data: existingPoint, error: pointLookupError } = await admin
        .from("hunt_reference_points")
        .select("*")
        .eq("hunt_event_id", event.id)
        .eq("target_number", targetNumber)
        .maybeSingle();
      if (pointLookupError) throw new Error("reference_point_lookup_failed");
      const pointQuery = existingPoint
        ? admin.from("hunt_reference_points").update({
          ...(label ? { label } : {}),
          is_active: true,
          updated_by: context.profile.id,
          updated_at: new Date().toISOString(),
        }).eq("id", existingPoint.id)
        : admin.from("hunt_reference_points").insert({
          hunt_event_id: event.id,
          target_number: targetNumber,
          label: label || null,
          is_active: true,
          created_by: context.profile.id,
          updated_by: context.profile.id,
        });
      const { data: point, error: pointError } = await pointQuery.select("*").single();
      if (pointError || !point) throw new Error("reference_point_failed");
      const { data: created, error: imageError } = await admin.from("hunt_reference_images").insert({
        reference_point_id: point.id,
        image_path: imagePath,
        mime_type: mimeType,
        embedding,
        embedding_model: HUNT_EMBEDDING_MODEL,
        created_by: context.profile.id,
      }).select("id,image_path,reference_point_id,embedding_model,is_active,created_at").single();
      if (imageError || !created) throw new Error("reference_image_failed");
      await writeAuditLog({ context, actionType: "hunt_reference_create", targetType: "hunt_reference_image", targetId: created.id, afterData: { ...created, target_number: targetNumber } });
      return NextResponse.json({ ok: true, message: `H${String(targetNumber).padStart(3, "0")} 參考圖已建立並完成辨識索引。` });
    } catch {
      await admin.storage.from("hunt-references").remove([imagePath]);
      return json("reference_create_failed", "參考圖建立失敗，未留下不完整檔案。", 500);
    }
  }

  if (type === "hunt_reference_deactivate" || type === "hunt_reference_reprocess") {
    const referenceImageId = String(body.referenceImageId ?? "");
    if (!referenceImageId) return json("invalid_reference", "參考圖 ID 不正確。", 400);
    const { data: before } = await admin.from("hunt_reference_images").select("*").eq("id", referenceImageId).maybeSingle();
    if (!before) return json("reference_not_found", "找不到參考圖。", 404);
    if (type === "hunt_reference_deactivate") {
      const { data: after, error } = await admin.from("hunt_reference_images").update({ is_active: false, updated_at: new Date().toISOString() }).eq("id", before.id).select("*").single();
      if (error || !after) return json("reference_update_failed", "停用參考圖失敗。", 500);
      await writeAuditLog({ context, actionType: "hunt_reference_deactivate", targetType: "hunt_reference_image", targetId: before.id, beforeData: before, afterData: after });
      return NextResponse.json({ ok: true, message: "參考圖已停用，Storage 原圖仍完整保留。" });
    }
    if (!isHuntAiConfigured()) return json("ai_not_configured", "尚未設定 Gemini API Key，無法重新建立索引。", 422);
    try {
      const { data: image, error: downloadError } = await admin.storage.from("hunt-references").download(before.image_path);
      if (downloadError || !image) throw new Error("reference_download_failed");
      const embedding = await embedHuntImage(image);
      const { data: after, error } = await admin.from("hunt_reference_images").update({
        embedding,
        embedding_model: HUNT_EMBEDDING_MODEL,
        is_active: true,
        updated_at: new Date().toISOString(),
      }).eq("id", before.id).select("*").single();
      if (error || !after) throw new Error("reference_update_failed");
      await writeAuditLog({ context, actionType: "hunt_reference_reprocess", targetType: "hunt_reference_image", targetId: before.id, beforeData: before, afterData: after });
      return NextResponse.json({ ok: true, message: "參考圖辨識索引已重新建立。" });
    } catch {
      return json("reference_reprocess_failed", "重新建立索引失敗，舊索引與原圖未變更。", 500);
    }
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
