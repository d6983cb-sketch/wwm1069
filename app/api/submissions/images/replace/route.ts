import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { writeAuditLog, type AdminContext } from "@/lib/admin-auth";
import { isSuperAdminDiscordId } from "@/lib/admin-access";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { SUBMISSION_IMAGE_ASPECT_VALUE } from "@/lib/types";

type ReplacementInput = {
  imageId: number;
  storagePath: string;
  cropX: number;
  cropY: number;
  zoom: number;
  rotation: number;
};

function response(error: string, message: string, status: number) {
  return NextResponse.json({ error, message }, { status });
}

function validCorrectionPath(userId: string, value: unknown) {
  return typeof value === "string"
    && value.startsWith(`${userId}/`)
    && value.includes("-correction-entry-")
    && /\.(?:jpe?g|png|webp)$/i.test(value);
}

function normalizeReplacement(value: unknown, userId: string): ReplacementInput | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const imageId = Number(source.imageId);
  const storagePath = String(source.storagePath ?? "");
  const cropX = Number(source.cropX);
  const cropY = Number(source.cropY);
  const zoom = Number(source.zoom);
  const rotation = Number(source.rotation);
  if (
    !Number.isInteger(imageId)
    || !validCorrectionPath(userId, storagePath)
    || ![cropX, cropY, zoom, rotation].every(Number.isFinite)
    || cropX < -50 || cropX > 50
    || cropY < -50 || cropY > 50
    || zoom < 1 || zoom > 3
    || rotation < -180 || rotation > 180
  ) return null;
  return { imageId, storagePath, cropX, cropY, zoom, rotation };
}

async function storageObjectExists(path: string) {
  const admin = createAdminClient();
  const separator = path.lastIndexOf("/");
  const folder = path.slice(0, separator);
  const filename = path.slice(separator + 1);
  const { data, error } = await admin.storage
    .from("cos-entries")
    .list(folder, { search: filename, limit: 10 });
  return !error && Boolean(data?.some((item) => item.name === filename));
}

async function removeUnreferencedCorrectionUploads(userId: string, paths: unknown[]) {
  const admin = createAdminClient();
  const clean = [...new Set(paths.filter((path) => validCorrectionPath(userId, path)) as string[])];
  if (!clean.length) return;
  const { data: used } = await admin
    .from("entry_image_revisions")
    .select("storage_object_path")
    .in("storage_object_path", clean);
  const referenced = new Set((used ?? []).map((item) => item.storage_object_path));
  const removable = clean.filter((path) => !referenced.has(path));
  if (removable.length) await admin.storage.from("cos-entries").remove(removable);
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return response("unauthorized", "請先登入。", 401);

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const entryId = Number(body?.entryId);
  const grantId = String(body?.grantId ?? "");
  const requested = Array.isArray(body?.replacements)
    ? body.replacements.map((item) => normalizeReplacement(item, user.id))
    : [];
  if (
    !Number.isInteger(entryId)
    || !grantId
    || requested.length < 1
    || requested.length > 5
    || requested.some((item) => !item)
  ) {
    await removeUnreferencedCorrectionUploads(user.id, Array.isArray(body?.replacements)
      ? body.replacements.map((item) => (item as Record<string, unknown>)?.storagePath)
      : []);
    return response("invalid_replacements", "修正圖片資料格式不正確。", 400);
  }
  const replacements = requested as ReplacementInput[];
  if (new Set(replacements.map((item) => item.imageId)).size !== replacements.length) {
    await removeUnreferencedCorrectionUploads(user.id, replacements.map((item) => item.storagePath));
    return response("duplicate_image", "同一張圖片不可重複修正。", 400);
  }

  const now = new Date().toISOString();
  const [{ data: profile }, { data: entry }, { data: grant }] = await Promise.all([
    admin.from("profiles").select("id,discord_id,nickname,is_admin,is_disqualified").eq("id", user.id).maybeSingle(),
    admin.from("entries").select("id,event_id,owner_id,entry_code,withdrawn_at,status").eq("id", entryId).maybeSingle(),
    admin.from("submission_edit_grants")
      .select("id,entry_id,grantee_profile_id,allowed_positions,reason,expires_at,is_active,revoked_at")
      .eq("id", grantId)
      .eq("entry_id", entryId)
      .eq("grantee_profile_id", user.id)
      .eq("is_active", true)
      .is("revoked_at", null)
      .gt("expires_at", now)
      .maybeSingle(),
  ]);
  const cleanup = () => removeUnreferencedCorrectionUploads(
    user.id,
    replacements.map((item) => item.storagePath),
  );
  if (!profile) {
    await cleanup();
    return response("profile_not_found", "找不到玩家資料。", 404);
  }
  if (!entry || entry.owner_id !== user.id) {
    await cleanup();
    return response("entry_not_found", "找不到你的投稿。", 404);
  }
  if (entry.withdrawn_at) {
    await cleanup();
    return response("entry_withdrawn", "已撤回的投稿不能修正圖片。", 422);
  }
  if (!grant) {
    await cleanup();
    return response("grant_unavailable", "修正權限不存在、已撤銷或已到期。", 422);
  }

  const { data: images } = await admin
    .from("entry_images")
    .select("id,entry_id,position,storage_path,crop_x,crop_y,zoom,rotation,aspect_ratio")
    .eq("entry_id", entryId)
    .in("id", replacements.map((item) => item.imageId));
  if ((images ?? []).length !== replacements.length) {
    await cleanup();
    return response("image_not_found", "部分圖片不屬於這份投稿。", 404);
  }
  const allowedPositions = new Set((grant.allowed_positions ?? []).map(Number));
  if ((images ?? []).some((image) => !allowedPositions.has(image.position))) {
    await cleanup();
    return response("image_not_allowed", "這次授權不允許修改其中一張圖片。", 403);
  }

  const existence = await Promise.all(replacements.map((item) => storageObjectExists(item.storagePath)));
  if (existence.some((exists) => !exists)) {
    await cleanup();
    return response("upload_not_found", "部分新照片尚未成功上傳，請重新選擇後再試。", 400);
  }
  const { data: duplicatePaths } = await admin
    .from("entry_image_revisions")
    .select("storage_object_path")
    .in("storage_object_path", replacements.map((item) => item.storagePath));
  if (duplicatePaths?.length) {
    await cleanup();
    return response("duplicate_upload", "這批照片已經送出，請重新整理確認結果。", 409);
  }

  const before = (images ?? []).map((image) => ({
    image_id: image.id,
    position: image.position,
    baseline_storage_path: image.storage_path,
  }));
  const rpcPayload = replacements.map((item) => ({
    image_id: item.imageId,
    storage_object_path: item.storagePath,
    display_storage_path: admin.storage.from("cos-entries").getPublicUrl(item.storagePath).data.publicUrl,
    crop_x: item.cropX,
    crop_y: item.cropY,
    zoom: item.zoom,
    rotation: item.rotation,
    aspect_ratio: SUBMISSION_IMAGE_ASPECT_VALUE,
  }));
  const { data: processed, error } = await admin.rpc("apply_submission_image_corrections", {
    target_entry_id: entryId,
    target_grantee_profile_id: user.id,
    target_grant_id: grantId,
    replacements: rpcPayload,
  });

  const context: AdminContext = {
    profile,
    isSuperAdmin: isSuperAdminDiscordId(profile.discord_id),
    permissions: {},
    requestId: request.headers.get("x-request-id")?.slice(0, 120) || crypto.randomUUID(),
  };
  if (error) {
    await cleanup();
    await writeAuditLog({
      context,
      actionType: "submission_image_correction",
      targetType: "entry",
      targetId: entryId,
      beforeData: before,
      afterData: { grant_id: grantId, replacement_count: replacements.length },
      result: "failure",
      failureReason: error.message,
    });
    return response("correction_failed", "圖片修正未完成，原作品仍保持不變。", 500);
  }

  await writeAuditLog({
    context,
    actionType: "submission_image_correction",
    targetType: "entry",
    targetId: entryId,
    beforeData: { grant_id: grantId, images: before },
    afterData: {
      grant_id: grantId,
      actor_type: "owner",
      replacement_count: processed,
      image_ids: replacements.map((item) => item.imageId),
      baseline_images_unchanged: true,
    },
  });
  revalidatePath("/");
  revalidatePath(`/entry/${entryId}`);
  revalidatePath("/awards");
  revalidatePath("/submit");
  revalidatePath("/admin");
  return NextResponse.json({ ok: true, message: "修正照片已儲存，舊照片已保留於修訂紀錄。" });
}

export async function DELETE(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return response("unauthorized", "請先登入。", 401);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const paths = Array.isArray(body?.storagePaths) ? body.storagePaths : [];
  await removeUnreferencedCorrectionUploads(user.id, paths);
  return NextResponse.json({ ok: true });
}
