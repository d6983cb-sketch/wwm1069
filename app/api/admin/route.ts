import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  authorizeAdmin,
  cleanNickname,
  normalizePermissions,
  writeAuditLog,
  type AdminContext,
} from "@/lib/admin-auth";
import type { AdminPermission } from "@/lib/admin-access";
import { hasValidTimeline, type EventStatus } from "@/lib/types";
import { calculateAwardRanking, isTieHandling } from "@/lib/award-ranking";

const eventDateFields = [
  "submission_starts_at",
  "submission_ends_at",
  "voting_starts_at",
  "voting_ends_at",
] as const;
const eventStatuses: EventStatus[] = [
  "draft",
  "submission_open",
  "submission_closed",
  "voting_open",
  "voting_closed",
  "results_published",
  "archived",
];

type JsonObject = Record<string, unknown>;

function normalizeZonedDate(value: unknown) {
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function response(error: string, message: string, status: number) {
  return NextResponse.json({ error, message }, { status });
}

function permissionFor(type: string): { permission?: AdminPermission; superOnly?: boolean } | null {
  if (["player_admin", "admin_permissions"].includes(type)) return { superOnly: true };
  if (type === "player_update") return { permission: "player_manager" };
  if (type === "player_disqualify") return { permission: "eligibility_manager" };
  if ([
    "entry_status",
    "entry_restore",
    "entry_edit_grant_create",
    "entry_edit_grant_revoke",
  ].includes(type)) return { permission: "submission_manager" };
  if (["event", "event_create"].includes(type)) return { permission: "event_manager" };
  if (type.startsWith("award_assignment")) return { permission: "award_assigner" };
  if (type.startsWith("award")) return { permission: "award_manager" };
  if (["announcement", "announcement_update", "announcement_archive"].includes(type)) {
    return { permission: "announcement_manager" };
  }
  if (type === "snapshot") return { permission: "report_viewer" };
  if (type === "safe_restore") return { superOnly: true };
  return null;
}

async function rememberIdempotency(
  context: AdminContext,
  type: string,
  key: unknown,
): Promise<NextResponse | null> {
  if (!key) return null;
  const clean = String(key).trim().slice(0, 160);
  if (!clean) return null;
  const admin = createAdminClient();
  const { data: existing, error: lookupError } = await admin
    .from("idempotency_keys")
    .select("response_data")
    .eq("key", clean)
    .eq("actor_profile_id", context.profile.id)
    .maybeSingle();
  if (lookupError) {
    console.error("Idempotency lookup failed", lookupError.code, lookupError.message);
    return response("request_guard_failed", "安全檢查暫時失敗，資料尚未變更。", 500);
  }
  if (existing?.response_data) return NextResponse.json(existing.response_data);
  if (existing) {
    return response("duplicate_request", "這個操作已送出或尚未完成，請重新整理後確認結果。", 409);
  }
  const { error } = await admin.from("idempotency_keys").insert({
    key: clean,
    actor_profile_id: context.profile.id,
    action_type: type,
  });
  if (!error) return null;
  if (error.code === "23505") {
    return response("duplicate_request", "這個操作已送出，請勿重複提交。", 409);
  }
  console.error("Idempotency insert failed", error.code, error.message);
  return response("request_guard_failed", "安全檢查暫時失敗，資料尚未變更。", 500);
}

async function auditFailure(
  context: AdminContext,
  type: string,
  targetType: string,
  targetId: unknown,
  reason: string,
) {
  await writeAuditLog({
    context,
    actionType: type,
    targetType,
    targetId: targetId === undefined ? undefined : String(targetId),
    result: "failure",
    failureReason: reason,
  });
}

export async function POST(request: Request) {
  let body: JsonObject;
  try {
    body = await request.json() as JsonObject;
  } catch {
    return response("invalid_json", "請求內容格式錯誤。", 400);
  }
  const type = String(body.type ?? "");
  const access = permissionFor(type);
  if (!access) return response("invalid_action", "不支援的管理操作。", 400);
  const auth = await authorizeAdmin(request, access.permission, access.superOnly);
  if (!auth.ok) return auth.response;
  const { context } = auth;
  const admin = createAdminClient();
  const repeated = await rememberIdempotency(context, type, body.idempotencyKey);
  if (repeated) return repeated;

  try {
    if (type === "player_update") {
      const playerId = String(body.playerId ?? "");
      const nickname = cleanNickname(body.nickname);
      if (!playerId || !nickname || nickname.length > 20) {
        return response("invalid_nickname", "暱稱不可空白，且最多 20 個字。", 400);
      }
      const { data: before } = await admin
        .from("profiles")
        .select("id,discord_id,nickname,admin_note,is_disqualified")
        .eq("id", playerId)
        .maybeSingle();
      if (!before) return response("player_not_found", "找不到這位玩家。", 404);
      const { data: duplicate } = await admin
        .from("profiles")
        .select("id")
        .ilike("nickname", nickname)
        .neq("id", playerId)
        .limit(1)
        .maybeSingle();
      if (duplicate) return response("nickname_taken", "這個暱稱已由其他玩家使用。", 409);
      const changes = {
        nickname,
        admin_note: typeof body.note === "string" ? body.note.trim().slice(0, 1000) || null : before.admin_note,
      };
      const { data: after, error } = await admin
        .from("profiles")
        .update(changes)
        .eq("id", playerId)
        .select("id,discord_id,nickname,admin_note,is_disqualified")
        .single();
      if (error) {
        const code = error.code === "23505" ? "nickname_taken" : "player_update_failed";
        return response(code, code === "nickname_taken" ? "這個暱稱已由其他玩家使用。" : "玩家資料更新失敗。", error.code === "23505" ? 409 : 500);
      }
      await writeAuditLog({ context, actionType: "player_update", targetType: "profile", targetId: playerId, beforeData: before, afterData: after });
    } else if (type === "player_disqualify") {
      const playerId = String(body.playerId ?? "");
      const { data: before } = await admin
        .from("profiles")
        .select("id,discord_id,nickname,is_disqualified")
        .eq("id", playerId)
        .maybeSingle();
      if (!before) return response("player_not_found", "找不到這位玩家。", 404);
      if (String(before.discord_id) === "635371564979716106") {
        return response("protected_super_admin", "最高管理員不可被取消資格。", 403);
      }
      const isDisqualified = body.disqualified === true;
      const { data: after, error } = await admin
        .from("profiles")
        .update({ is_disqualified: isDisqualified })
        .eq("id", playerId)
        .select("id,discord_id,nickname,is_disqualified")
        .single();
      if (error) return response("player_update_failed", "玩家資格更新失敗。", 500);
      await writeAuditLog({
        context,
        actionType: isDisqualified ? "player_disqualify" : "player_restore_eligibility",
        targetType: "profile",
        targetId: playerId,
        beforeData: before,
        afterData: after,
      });
    } else if (type === "player_admin" || type === "admin_permissions") {
      const playerId = String(body.playerId ?? "");
      const { data: target } = await admin
        .from("profiles")
        .select("id,discord_id,nickname,is_admin")
        .eq("id", playerId)
        .maybeSingle();
      if (!target) return response("player_not_found", "找不到這位玩家。", 404);
      if (String(target.discord_id) === "635371564979716106") {
        return response("protected_super_admin", "最高管理員權限由伺服器固定，不能修改。", 403);
      }
      const { data: beforeRole } = await admin.from("admin_roles").select("*").eq("profile_id", playerId).maybeSingle();
      const active = type === "player_admin" ? body.isAdmin === true : beforeRole?.is_active === true;
      const permissions = type === "admin_permissions"
        ? normalizePermissions(body.permissions)
        : (beforeRole?.permissions ?? {});
      if (!permissions) return response("invalid_permissions", "權限格式錯誤。", 400);
      const { data: afterRole, error } = await admin
        .from("admin_roles")
        .upsert({
          profile_id: playerId,
          permissions,
          is_active: active,
          created_by: beforeRole?.created_by ?? context.profile.id,
          updated_by: context.profile.id,
          updated_at: new Date().toISOString(),
        })
        .select("*")
        .single();
      if (error) return response("admin_update_failed", "管理員權限更新失敗。", 500);
      await admin.from("profiles").update({ is_admin: active }).eq("id", playerId);
      await writeAuditLog({
        context,
        actionType: type === "player_admin" ? (active ? "admin_grant" : "admin_remove") : "admin_permissions_update",
        targetType: "admin_role",
        targetId: playerId,
        beforeData: beforeRole,
        afterData: afterRole,
      });
    } else if (type === "entry_status") {
      const entryId = Number(body.entryId);
      const status = String(body.status ?? "");
      if (!Number.isInteger(entryId) || !["approved", "rejected", "disqualified"].includes(status)) {
        return response("invalid_entry_status", "投稿狀態不正確。", 400);
      }
      const { data: before } = await admin.from("entries").select("id,entry_code,status").eq("id", entryId).maybeSingle();
      if (!before) return response("entry_not_found", "找不到投稿。", 404);
      const { data: after, error } = await admin.from("entries").update({ status }).eq("id", entryId).select("id,entry_code,status").single();
      if (error) return response("entry_update_failed", "投稿狀態更新失敗。", 500);
      await writeAuditLog({ context, actionType: "entry_status_update", targetType: "entry", targetId: entryId, beforeData: before, afterData: after });
    } else if (type === "entry_restore") {
      const entryId = Number(body.entryId);
      const { data: before } = await admin
        .from("entries")
        .select("id,entry_code,event_id,withdrawn_at,withdrawn_by,withdrawal_reason")
        .eq("id", entryId)
        .maybeSingle();
      if (!before) return response("entry_not_found", "找不到投稿。", 404);
      const { data: event } = await admin.from("events").select("status").eq("id", before.event_id).maybeSingle();
      if (event?.status !== "submission_open") return response("invalid_event_state", "只有投稿開放期間可以復原投稿。", 422);
      const { data: after, error } = await admin
        .from("entries")
        .update({ withdrawn_at: null, withdrawn_by: null, withdrawal_reason: null })
        .eq("id", entryId)
        .select("id,entry_code,withdrawn_at,withdrawal_reason")
        .single();
      if (error) return response("entry_restore_failed", "投稿復原失敗。", 500);
      await writeAuditLog({ context, actionType: "entry_restore", targetType: "entry", targetId: entryId, beforeData: before, afterData: after });
    } else if (type === "entry_edit_grant_create") {
      const entryId = Number(body.entryId);
      const expiresAt = normalizeZonedDate(body.expiresAt);
      const reason = String(body.reason ?? "").trim().slice(0, 500) || null;
      const allowedPositions = Array.isArray(body.allowedPositions)
        ? [...new Set(body.allowedPositions.map(Number))]
        : [];
      if (
        !Number.isInteger(entryId)
        || !expiresAt
        || allowedPositions.length < 1
        || allowedPositions.length > 5
        || allowedPositions.some((position) => !Number.isInteger(position) || position < 1 || position > 5)
      ) {
        return response("invalid_correction_grant", "請選擇至少一張圖片並設定有效期限。", 400);
      }
      const expiryTime = Date.parse(expiresAt);
      if (expiryTime <= Date.now() || expiryTime > Date.now() + 7 * 24 * 60 * 60 * 1000) {
        return response("invalid_correction_expiry", "修正期限必須在現在之後、七天以內。", 400);
      }
      const [{ data: entry }, { data: images }, { data: activeGrant }] = await Promise.all([
        admin.from("entries").select("id,entry_code,event_id,owner_id,character_name,withdrawn_at").eq("id", entryId).maybeSingle(),
        admin.from("entry_images").select("id,entry_id,position").eq("entry_id", entryId),
        admin.from("submission_edit_grants").select("*").eq("entry_id", entryId).eq("is_active", true).maybeSingle(),
      ]);
      if (!entry) return response("entry_not_found", "找不到投稿。", 404);
      if (entry.withdrawn_at) return response("entry_withdrawn", "已撤回的投稿不能開啟圖片修正。", 422);
      if (activeGrant) return response("grant_exists", "這件作品已有啟用中的修正權限，請先撤銷或等待到期。", 409);
      const actualPositions = new Set((images ?? []).map((image) => image.position));
      if (allowedPositions.some((position) => !actualPositions.has(position))) {
        return response("image_position_not_found", "選取的圖片序號不存在。", 400);
      }
      const { data: created, error } = await admin
        .from("submission_edit_grants")
        .insert({
          entry_id: entryId,
          grantee_profile_id: entry.owner_id,
          allowed_positions: allowedPositions.sort((left, right) => left - right),
          reason,
          expires_at: expiresAt,
          granted_by: context.profile.id,
        })
        .select("*")
        .single();
      if (error) {
        if (error.code === "23505") return response("grant_exists", "這件作品已有啟用中的修正權限。", 409);
        return response("grant_create_failed", "圖片修正權限建立失敗。", 500);
      }
      await writeAuditLog({
        context,
        actionType: "submission_edit_grant_create",
        targetType: "entry",
        targetId: entryId,
        afterData: {
          ...created,
          entry_code: entry.entry_code,
          character_name: entry.character_name,
        },
      });
      return NextResponse.json({ ok: true, message: "已開放指定玩家修正所選圖片。" });
    } else if (type === "entry_edit_grant_revoke") {
      const grantId = String(body.grantId ?? "");
      if (!grantId) return response("invalid_grant", "修正權限編號不正確。", 400);
      const { data: before } = await admin
        .from("submission_edit_grants")
        .select("*")
        .eq("id", grantId)
        .maybeSingle();
      if (!before) return response("grant_not_found", "找不到圖片修正權限。", 404);
      if (!before.is_active) return response("grant_already_revoked", "這項修正權限已經停用。", 409);
      const { data: after, error } = await admin
        .from("submission_edit_grants")
        .update({
          is_active: false,
          revoked_at: new Date().toISOString(),
          revoked_by: context.profile.id,
          updated_at: new Date().toISOString(),
        })
        .eq("id", grantId)
        .eq("is_active", true)
        .select("*")
        .single();
      if (error) return response("grant_revoke_failed", "圖片修正權限撤銷失敗。", 500);
      await writeAuditLog({
        context,
        actionType: "submission_edit_grant_revoke",
        targetType: "entry",
        targetId: before.entry_id,
        beforeData: before,
        afterData: after,
      });
      return NextResponse.json({ ok: true, message: "已撤銷這件作品的圖片修正權限。" });
    } else if (type === "event") {
      const eventId = String(body.eventId ?? "");
      const allowed = [
        "title",
        "submission_starts_at",
        "submission_ends_at",
        "voting_starts_at",
        "voting_ends_at",
        "submissions_locked",
        "voting_locked",
        "voting_override",
        "leaderboard_mode",
        "status",
        "submission_identity_mode",
        "voting_identity_mode",
        "reveal_authors_after_results",
        "allow_admin_crop_after_submission",
      ];
      const changes = Object.fromEntries(
        Object.entries((body.changes ?? {}) as JsonObject).filter(([key]) => allowed.includes(key)),
      ) as JsonObject;
      for (const field of eventDateFields) {
        if (!(field in changes)) continue;
        const normalized = normalizeZonedDate(changes[field]);
        if (!normalized) return response("invalid_event_time", "日期或時間格式不正確。", 400);
        changes[field] = normalized;
      }
      if ("title" in changes) {
        changes.title = String(changes.title ?? "").trim();
        if (!changes.title) return response("invalid_event_title", "活動名稱不可空白。", 400);
      }
      if ("status" in changes && changes.status !== null && !eventStatuses.includes(String(changes.status) as EventStatus)) {
        return response("invalid_event_status", "活動狀態不正確。", 400);
      }
      if (["submission_identity_mode", "voting_identity_mode"].some((key) => key in changes)
        && ["submission_identity_mode", "voting_identity_mode"].some((key) => key in changes && !["anonymous", "named"].includes(String(changes[key])))) {
        return response("invalid_identity_mode", "匿名／實名模式不正確。", 400);
      }
      const { data: before } = await admin.from("events").select("*").eq("id", eventId).maybeSingle();
      if (!before) return response("event_not_found", "找不到活動。", 404);
      if (eventDateFields.some((field) => field in changes) && !hasValidTimeline({ ...before, ...changes } as never)) {
        return response("invalid_event_order", "活動時間順序不正確。", 400);
      }
      const nextStatus = changes.status as EventStatus | null | undefined;
      if ((before.status === "voting_closed" && nextStatus === "voting_open")
        || (before.status === "archived" && nextStatus && nextStatus !== "archived")) {
        if (!context.isSuperAdmin) return response("super_admin_required", "此狀態切換僅限最高管理員。", 403);
      }
      const { data: after, error } = await admin
        .from("events")
        .update({ ...changes, updated_at: new Date().toISOString() })
        .eq("id", eventId)
        .select("*")
        .single();
      if (error) return response("event_update_failed", "活動設定更新失敗。", 500);
      await writeAuditLog({ context, actionType: "event_update", targetType: "event", targetId: eventId, beforeData: before, afterData: after });
    } else if (type === "event_create") {
      const submissionStarts = normalizeZonedDate(body.submissionStarts);
      const submissionEnds = normalizeZonedDate(body.submissionEnds);
      const votingStarts = normalizeZonedDate(body.votingStarts);
      const votingEnds = normalizeZonedDate(body.votingEnds);
      const title = String(body.title ?? "").trim();
      if (!title || !submissionStarts || !submissionEnds || !votingStarts || !votingEnds
        || !hasValidTimeline({
          submission_starts_at: submissionStarts,
          submission_ends_at: submissionEnds,
          voting_starts_at: votingStarts,
          voting_ends_at: votingEnds,
        })) {
        return response("invalid_event_order", "活動時間或名稱不正確。", 400);
      }
      const { data: created, error } = await admin.from("events").insert({
        title,
        submission_starts_at: submissionStarts,
        submission_ends_at: submissionEnds,
        voting_starts_at: votingStarts,
        voting_ends_at: votingEnds,
        leaderboard_mode: "hidden",
        status: "draft",
      }).select("*").single();
      if (error) return response("event_create_failed", "活動建立失敗。", 500);
      await writeAuditLog({ context, actionType: "event_create", targetType: "event", targetId: created.id, afterData: created });
    } else if (type === "award_create" || type === "award_update") {
      const awardId = type === "award_update" ? String(body.awardId ?? "") : null;
      const name = String(body.name ?? "").trim();
      if (!name || name.length > 80) return response("invalid_award_name", "獎項名稱不可空白，且最多 80 字。", 400);
      const rawRankingPosition = body.rankingPosition;
      const rankingPosition = rawRankingPosition === null
        || rawRankingPosition === undefined
        || rawRankingPosition === ""
        || Number(rawRankingPosition) === 0
        ? null
        : Number(rawRankingPosition);
      if (
        rankingPosition !== null
        && (!Number.isInteger(rankingPosition) || rankingPosition < 1 || rankingPosition > 999)
      ) {
        return response("invalid_ranking_position", "自動排名必須介於第 1 名至第 999 名。", 400);
      }
      const eventId = String(body.eventId ?? "");
      const { data: eventExists } = await admin.from("events").select("id").eq("id", eventId).maybeSingle();
      if (!eventExists) return response("event_not_found", "找不到活動。", 404);
      const payload = {
        event_id: eventId,
        name,
        description: String(body.description ?? "").trim().slice(0, 1000) || null,
        award_type: rankingPosition ? "ranking" : "custom",
        ranking_position: rankingPosition,
        sort_order: Number.isInteger(body.sortOrder) ? Number(body.sortOrder) : 0,
        is_active: body.isActive !== false,
        is_archived: body.isArchived === true,
        updated_at: new Date().toISOString(),
      };
      const { data: before } = awardId ? await admin.from("awards").select("*").eq("id", awardId).maybeSingle() : { data: null };
      if (awardId && !before) return response("award_not_found", "找不到獎項。", 404);
      if (before && before.event_id !== eventId) {
        return response("award_event_mismatch", "獎項不屬於目前活動。", 422);
      }
      const query = awardId
        ? admin.from("awards").update({ ...payload, event_id: before!.event_id }).eq("id", awardId).eq("event_id", eventId)
        : admin.from("awards").insert({ ...payload, created_by: context.profile.id });
      const { data: after, error } = await query.select("*").single();
      if (error) return response("award_save_failed", "獎項儲存失敗。", 500);
      await writeAuditLog({ context, actionType: type, targetType: "award", targetId: after.id, beforeData: before, afterData: after });
    } else if (type === "award_reorder") {
      const eventId = String(body.eventId ?? "");
      const awardId = String(body.awardId ?? "");
      const direction = String(body.direction ?? "");
      if (!["up", "down"].includes(direction)) {
        return response("invalid_award_order", "獎項排序方向不正確。", 400);
      }
      const { data: ordered } = await admin
        .from("awards")
        .select("id,event_id,sort_order")
        .eq("event_id", eventId)
        .order("sort_order")
        .order("created_at");
      const currentIndex = (ordered ?? []).findIndex((item) => item.id === awardId);
      const targetIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
      if (currentIndex < 0) return response("award_not_found", "找不到獎項。", 404);
      if (targetIndex < 0 || targetIndex >= (ordered ?? []).length) {
        return response("award_order_unchanged", "獎項已在最前或最後。", 422);
      }
      const current = ordered![currentIndex];
      const target = ordered![targetIndex];
      const temporaryOrder = -1_000_000 - currentIndex;
      const { error: firstError } = await admin.from("awards").update({ sort_order: temporaryOrder }).eq("id", current.id).eq("event_id", eventId);
      const { error: secondError } = await admin.from("awards").update({ sort_order: current.sort_order }).eq("id", target.id).eq("event_id", eventId);
      const { error: thirdError } = await admin.from("awards").update({ sort_order: target.sort_order }).eq("id", current.id).eq("event_id", eventId);
      if (firstError || secondError || thirdError) return response("award_reorder_failed", "獎項排序失敗。", 500);
      await writeAuditLog({ context, actionType: "award_reorder", targetType: "award", targetId: awardId, beforeData: current, afterData: { ...current, sort_order: target.sort_order } });
    } else if (type === "award_archive") {
      const awardId = String(body.awardId ?? "");
      const { data: before } = await admin.from("awards").select("*,award_assignments(id)").eq("id", awardId).maybeSingle();
      if (!before) return response("award_not_found", "找不到獎項。", 404);
      const used = Array.isArray(before.award_assignments) && before.award_assignments.length > 0;
      const changes = used || body.archive === true
        ? { is_archived: true, is_active: false, updated_at: new Date().toISOString() }
        : { is_active: false, updated_at: new Date().toISOString() };
      const { data: after, error } = await admin.from("awards").update(changes).eq("id", awardId).select("*").single();
      if (error) return response("award_archive_failed", "獎項停用／封存失敗。", 500);
      await writeAuditLog({ context, actionType: used ? "award_archive" : "award_disable", targetType: "award", targetId: awardId, beforeData: before, afterData: after });
    } else if (type === "award_assignment_set") {
      const awardId = String(body.awardId ?? "");
      const submissionId = Number(body.submissionId);
      const [{ data: award }, { data: entry }, { data: rules }, { data: current }] = await Promise.all([
        admin.from("awards").select("*").eq("id", awardId).maybeSingle(),
        admin.from("entries").select("id,event_id,owner_id,entry_code,status,withdrawn_at,created_at").eq("id", submissionId).maybeSingle(),
        admin.from("award_rules").select("*").eq("event_id", String(body.eventId ?? "")).maybeSingle(),
        admin.from("award_assignments").select("*").eq("award_id", awardId).maybeSingle(),
      ]);
      if (!award || !entry || award.event_id !== entry.event_id) return response("award_entry_mismatch", "獎項與作品不屬於同一活動。", 422);
      const { data: owner } = await admin.from("profiles").select("is_disqualified").eq("id", entry.owner_id).maybeSingle();
      if (entry.status !== "approved" || entry.withdrawn_at || owner?.is_disqualified) {
        return response("entry_not_eligible", "只能指派已通過、未撤回且未取消資格的作品。", 422);
      }
      if (award.ranking_position) {
        if (rules?.tie_handling !== "admin_decision" && rules?.allow_manual_tie_winner !== true) {
          return response("ranking_award_is_automatic", "此獎項由票數排名自動決定；只有管理員決選同票時可指定。", 422);
        }
        const [{ data: eligibleEntries }, { data: eventVotes }, { data: eventProfiles }] = await Promise.all([
          admin.from("entries").select("id,owner_id,created_at,status,withdrawn_at").eq("event_id", entry.event_id),
          admin.from("votes").select("entry_id,created_at").eq("event_id", entry.event_id),
          admin.from("profiles").select("id,is_disqualified"),
        ]);
        const ranking = calculateAwardRanking(
          (eligibleEntries ?? []).filter((item) => (
            item.status === "approved"
            && !item.withdrawn_at
            && !eventProfiles?.find((profile) => profile.id === item.owner_id)?.is_disqualified
          )),
          eventVotes ?? [],
          "joint",
        );
        const tiedCandidates = ranking.filter((item) => item.rank === award.ranking_position);
        if (tiedCandidates.length < 2 || !tiedCandidates.some((item) => item.entryId === entry.id)) {
          return response("invalid_tie_winner", "指定作品不在這個名次的同票候選名單中。", 422);
        }
      }
      const { data: otherAssignments } = await admin
        .from("award_assignments")
        .select("id,award_id,submission_id,awards!inner(event_id),entries!inner(owner_id)")
        .eq("awards.event_id", entry.event_id);
      const conflicts: string[] = [];
      const sameSubmission = (otherAssignments ?? []).filter((item) => item.submission_id === entry.id && item.id !== current?.id).length;
      const samePlayer = (otherAssignments ?? []).filter((item) => {
        const linkedEntry = Array.isArray(item.entries) ? item.entries[0] : item.entries;
        return linkedEntry?.owner_id === entry.owner_id && item.id !== current?.id;
      }).length;
      if (rules?.allow_multiple_per_submission === false && sameSubmission > 0) conflicts.push("同一作品不可獲得多個獎項");
      if (rules?.max_awards_per_submission && sameSubmission >= rules.max_awards_per_submission) conflicts.push("作品已達得獎數量上限");
      if (rules?.allow_multiple_per_player === false && samePlayer > 0) conflicts.push("同一玩家不可獲得多個獎項");
      if (rules?.max_awards_per_player && samePlayer >= rules.max_awards_per_player) conflicts.push("玩家已達得獎數量上限");
      const { data: exclusions } = await admin
        .from("award_exclusions")
        .select("award_a_id,award_b_id")
        .eq("event_id", entry.event_id)
        .or(`award_a_id.eq.${awardId},award_b_id.eq.${awardId}`);
      const mutuallyExclusiveIds = new Set((exclusions ?? []).map((rule) => (
        rule.award_a_id === awardId ? rule.award_b_id : rule.award_a_id
      )));
      if ((otherAssignments ?? []).some((item) => (
        item.submission_id === entry.id && mutuallyExclusiveIds.has(item.award_id)
      ))) {
        conflicts.push("作品已獲得與此獎項互斥的獎項");
      }
      if (rules?.top_three_can_receive_special === false && award.award_type !== "ranking") {
        const { data: eventVotes } = await admin.from("votes").select("entry_id").eq("event_id", entry.event_id);
        const voteCounts = new Map<number, number>();
        for (const vote of eventVotes ?? []) {
          voteCounts.set(vote.entry_id, (voteCounts.get(vote.entry_id) ?? 0) + 1);
        }
        const topThree = [...voteCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([id]) => id);
        if (topThree.includes(entry.id)) conflicts.push("前三名不可再獲得特別獎");
      }
      if (conflicts.length && body.confirmConflict !== true) {
        return NextResponse.json({ error: "award_conflict", message: "得獎規則衝突。", conflicts }, { status: 409 });
      }
      const { data: after, error } = await admin.from("award_assignments").upsert({
        award_id: awardId,
        submission_id: submissionId,
        assigned_by: context.profile.id,
        decision_note: String(body.decisionNote ?? "").trim().slice(0, 1000) || null,
        updated_at: new Date().toISOString(),
      }, { onConflict: "award_id" }).select("*").single();
      if (error) return response("award_assignment_failed", "得獎作品指派失敗。", 500);
      await writeAuditLog({
        context,
        actionType: "award_assignment_set",
        targetType: "award_assignment",
        targetId: awardId,
        beforeData: current,
        afterData: { assignment: after, conflicts, conflictOverride: conflicts.length > 0 },
      });
    } else if (type === "award_assignment_remove") {
      const awardId = String(body.awardId ?? "");
      const { data: before } = await admin.from("award_assignments").select("*").eq("award_id", awardId).maybeSingle();
      if (!before) return response("assignment_not_found", "此獎項尚未指派作品。", 404);
      const { error } = await admin.from("award_assignments").delete().eq("award_id", awardId);
      if (error) return response("award_unassign_failed", "解除得獎作品失敗。", 500);
      await writeAuditLog({ context, actionType: "award_assignment_remove", targetType: "award_assignment", targetId: before.id, beforeData: before });
    } else if (type === "award_rules") {
      const eventId = String(body.eventId ?? "");
      const { data: before } = await admin.from("award_rules").select("*").eq("event_id", eventId).maybeSingle();
      const payload = {
        event_id: eventId,
        allow_multiple_per_submission: body.allowMultiplePerSubmission !== false,
        allow_multiple_per_player: body.allowMultiplePerPlayer !== false,
        top_three_can_receive_special: body.topThreeCanReceiveSpecial !== false,
        max_awards_per_player: Number(body.maxAwardsPerPlayer) > 0 ? Number(body.maxAwardsPerPlayer) : null,
        max_awards_per_submission: Number(body.maxAwardsPerSubmission) > 0 ? Number(body.maxAwardsPerSubmission) : null,
        tie_handling: isTieHandling(body.tieHandling) ? body.tieHandling : "joint",
        allow_manual_tie_winner: body.allowManualTieWinner === true,
        updated_by: context.profile.id,
        updated_at: new Date().toISOString(),
      };
      const { data: after, error } = await admin.from("award_rules").upsert(payload).select("*").single();
      if (error) return response("award_rules_failed", "得獎規則儲存失敗。", 500);
      await writeAuditLog({ context, actionType: "award_rules_update", targetType: "event", targetId: eventId, beforeData: before, afterData: after });
    } else if (type === "announcement" || type === "announcement_update") {
      const announcement = String(body.body ?? "").trim();
      const title = String(body.title ?? "").trim();
      if (!announcement || announcement.length > 5000 || title.length > 120) {
        return response("invalid_announcement", "公告內容不可空白，標題最多 120 字、內容最多 5000 字。", 400);
      }
      const payload = {
        event_id: String(body.eventId ?? ""),
        title: title || null,
        body: announcement,
        announcement_type: String(body.announcementType ?? "general").slice(0, 40),
        expires_at: body.expiresAt ? normalizeZonedDate(body.expiresAt) : null,
        is_pinned: body.isPinned === true,
        is_active: body.isActive !== false,
        requires_ack: body.requiresAck === true,
        audience: ["all", "participants", "submitters", "admins", "player"].includes(String(body.audience)) ? body.audience : "all",
        target_profile_id: body.targetProfileId ? String(body.targetProfileId) : null,
        updated_at: new Date().toISOString(),
      };
      if (payload.audience === "player" && !payload.target_profile_id) {
        return response("announcement_target_required", "個別玩家通知必須指定玩家。", 400);
      }
      const announcementId = type === "announcement_update" ? Number(body.announcementId) : null;
      const { data: before } = announcementId
        ? await admin.from("announcements").select("*").eq("id", announcementId).maybeSingle()
        : { data: null };
      if (announcementId && !before) return response("announcement_not_found", "找不到公告。", 404);
      if (before && before.event_id !== payload.event_id) {
        return response("announcement_event_mismatch", "公告不屬於目前活動。", 422);
      }
      const query = announcementId
        ? admin.from("announcements").update(payload).eq("id", announcementId)
        : admin.from("announcements").insert({ ...payload, created_by: context.profile.id });
      const { data: created, error } = await query.select("*").single();
      if (error) return response("announcement_failed", "公告發布失敗。", 500);
      await writeAuditLog({
        context,
        actionType: type === "announcement" ? "announcement_publish" : "announcement_update",
        targetType: "announcement",
        targetId: created.id,
        beforeData: before,
        afterData: created,
      });
    } else if (type === "announcement_archive") {
      const announcementId = Number(body.announcementId);
      const { data: before } = await admin.from("announcements").select("*").eq("id", announcementId).maybeSingle();
      if (!before) return response("announcement_not_found", "找不到公告。", 404);
      const { data: after, error } = await admin
        .from("announcements")
        .update({ is_active: false, archived_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", announcementId)
        .select("*")
        .single();
      if (error) return response("announcement_archive_failed", "公告撤下失敗。", 500);
      await writeAuditLog({
        context,
        actionType: "announcement_archive",
        targetType: "announcement",
        targetId: announcementId,
        beforeData: before,
        afterData: after,
      });
    } else if (type === "safe_restore") {
      const auditId = Number(body.auditId);
      const { data: source } = await admin.from("audit_logs").select("*").eq("id", auditId).maybeSingle();
      if (!source) return response("audit_not_found", "找不到可復原的操作紀錄。", 404);
      const before = source.before_data as JsonObject | null;
      const after = source.after_data as JsonObject | null;
      if (["vote", "votes"].includes(String(source.target_type)) || source.action_type.includes("vote")) {
        return response("restore_forbidden", "復原功能禁止修改投票或票數。", 422);
      }
      if (source.action_type === "player_update" && before) {
        const nickname = cleanNickname(before.nickname);
        const { data: duplicate } = await admin.from("profiles").select("id").ilike("nickname", nickname).neq("id", String(source.target_id)).limit(1).maybeSingle();
        if (duplicate) return response("nickname_taken", "原暱稱目前已由其他玩家使用。", 409);
        await admin.from("profiles").update({ nickname, admin_note: before.admin_note ?? null }).eq("id", String(source.target_id));
      } else if (["player_disqualify", "player_restore_eligibility"].includes(source.action_type) && before) {
        await admin.from("profiles").update({ is_disqualified: before.is_disqualified === true }).eq("id", String(source.target_id));
      } else if (["admin_grant", "admin_remove", "admin_permissions_update"].includes(source.action_type) && before) {
        await admin.from("admin_roles").upsert({
          profile_id: String(source.target_id),
          permissions: before.permissions ?? {},
          is_active: before.is_active === true,
          updated_by: context.profile.id,
          updated_at: new Date().toISOString(),
        });
      } else if (source.action_type.startsWith("award_") && source.target_type === "award" && before) {
        await admin.from("awards").update({
          name: before.name,
          description: before.description ?? null,
          sort_order: before.sort_order,
          is_active: before.is_active,
          is_archived: before.is_archived,
          updated_at: new Date().toISOString(),
        }).eq("id", String(source.target_id));
      } else if (source.action_type === "award_assignment_set") {
        if (before) {
          await admin.from("award_assignments").upsert({
            id: before.id,
            award_id: before.award_id,
            submission_id: before.submission_id,
            assigned_by: context.profile.id,
            decision_note: before.decision_note ?? null,
            updated_at: new Date().toISOString(),
          }, { onConflict: "award_id" });
        } else if (after?.award_id) {
          await admin.from("award_assignments").delete().eq("award_id", String(after.award_id));
        }
      } else if (source.action_type === "award_assignment_remove" && before) {
        await admin.from("award_assignments").upsert({
          id: before.id,
          award_id: before.award_id,
          submission_id: before.submission_id,
          assigned_by: context.profile.id,
          decision_note: before.decision_note ?? null,
          updated_at: new Date().toISOString(),
        }, { onConflict: "award_id" });
      } else if (source.action_type === "event_update" && before) {
        const allowedEventRestore = [
          "title", "submission_starts_at", "submission_ends_at", "voting_starts_at",
          "voting_ends_at", "submissions_locked", "voting_locked", "voting_override",
          "leaderboard_mode", "status", "submission_identity_mode",
          "voting_identity_mode", "reveal_authors_after_results",
          "allow_admin_crop_after_submission",
        ];
        await admin.from("events").update(Object.fromEntries(Object.entries(before).filter(([key]) => allowedEventRestore.includes(key)))).eq("id", String(source.target_id));
      } else if (source.action_type === "announcement_publish" && after?.id) {
        await admin.from("announcements").update({ is_active: false, archived_at: new Date().toISOString() }).eq("id", Number(after.id));
      } else if (["entry_withdraw", "entry_restore"].includes(source.action_type) && before) {
        await admin.from("entries").update({
          withdrawn_at: before.withdrawn_at ?? null,
          withdrawn_by: before.withdrawn_by ?? null,
          withdrawal_reason: before.withdrawal_reason ?? null,
        }).eq("id", Number(source.target_id));
      } else {
        return response("restore_unsupported", "這筆操作不在安全復原白名單中。", 422);
      }
      await writeAuditLog({
        context,
        actionType: "safe_restore",
        targetType: source.target_type ?? "audit",
        targetId: source.target_id ?? auditId,
        beforeData: after,
        afterData: before,
      });
    } else if (type === "snapshot") {
      const eventId = String(body.eventId ?? "");
      const [
        { data: event },
        { data: profiles },
        { data: entries },
        { data: votes },
        { data: awards },
        { data: assignments },
        { data: awardRules },
        { data: announcements },
      ] = await Promise.all([
        admin.from("events").select("*").eq("id", eventId).maybeSingle(),
        admin.from("profiles").select("id,discord_id,nickname,is_disqualified,created_at"),
        admin.from("entries").select("*").eq("event_id", eventId),
        admin.from("votes").select("entry_id,created_at").eq("event_id", eventId),
        admin.from("awards").select("*").eq("event_id", eventId),
        admin.from("award_assignments").select("*,awards!inner(event_id)").eq("awards.event_id", eventId),
        admin.from("award_rules").select("*").eq("event_id", eventId).maybeSingle(),
        admin.from("announcements").select("*").eq("event_id", eventId),
      ]);
      if (!event) return response("event_not_found", "找不到活動。", 404);
      const voteCounts = Object.entries(
        (votes ?? []).reduce<Record<string, number>>((sum, vote) => {
          sum[String(vote.entry_id)] = (sum[String(vote.entry_id)] ?? 0) + 1;
          return sum;
        }, {}),
      ).map(([submissionId, count]) => ({ submissionId: Number(submissionId), count }));
      const eligibleProfiles = new Map((profiles ?? []).map((profile) => [profile.id, profile]));
      const tieHandling = isTieHandling(awardRules?.tie_handling) ? awardRules.tie_handling : "joint";
      const rankingResult = calculateAwardRanking(
        (entries ?? []).filter((entry) => (
          entry.status === "approved"
          && !entry.withdrawn_at
          && !eligibleProfiles.get(entry.owner_id)?.is_disqualified
        )),
        votes ?? [],
        tieHandling,
      );
      const snapshotData = { event, profiles, entries, voteCounts, rankingResult, awards, assignments, awardRules, announcements };
      const { data: snapshot, error } = await admin.from("activity_snapshots").insert({
        event_id: eventId,
        snapshot_data: snapshotData,
        created_by: context.profile.id,
      }).select("id,event_id,created_at").single();
      if (error) return response("snapshot_failed", "活動快照建立失敗。", 500);
      await writeAuditLog({ context, actionType: "snapshot_create", targetType: "snapshot", targetId: snapshot.id, afterData: snapshot });
      return NextResponse.json({ ok: true, snapshot });
    } else {
      return response("invalid_action", "不支援的管理操作。", 400);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown_error";
    await auditFailure(context, type || "unknown", String(body.targetType ?? "unknown"), body.targetId, reason);
    return response("server_error", "伺服器處理失敗，資料未完成變更。", 500);
  }

  return NextResponse.json({ ok: true });
}
