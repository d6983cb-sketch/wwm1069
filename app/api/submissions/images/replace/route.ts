import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { writeAuditLog, type AdminContext } from "@/lib/admin-auth";
import { isSuperAdminDiscordId } from "@/lib/admin-access";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { SUBMISSION_IMAGE_ASPECT_VALUE } from "@/lib/types";

type CropInput = {
  storagePath: string;
  cropX: number;
  cropY: number;
  zoom: number;
  rotation: number;
};

type ReplacementInput = CropInput & { imageId: number };
type ImageStateInput = {
  imageId: number;
  displayPosition: number;
  isHidden: boolean;
};

function response(error: string, message: string, status: number) {
  return NextResponse.json({ error, message }, { status });
}

function validCorrectionPath(
  userId: string,
  value: unknown,
  kind: "entry" | "add" | "original",
) {
  const marker = kind === "entry"
    ? "-correction-entry-"
    : kind === "add"
      ? "-correction-add-"
      : "-correction-original-";
  return typeof value === "string"
    && value.startsWith(`${userId}/`)
    && value.includes(marker)
    && /\.(?:jpe?g|png|webp)$/i.test(value);
}

function normalizeCrop(
  value: unknown,
  userId: string,
  kind: "entry" | "add",
): CropInput | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const storagePath = String(source.storagePath ?? "");
  const cropX = Number(source.cropX);
  const cropY = Number(source.cropY);
  const zoom = Number(source.zoom);
  const rotation = Number(source.rotation);
  if (
    !validCorrectionPath(userId, storagePath, kind)
    || ![cropX, cropY, zoom, rotation].every(Number.isFinite)
    || cropX < -50 || cropX > 50
    || cropY < -50 || cropY > 50
    || zoom < 1 || zoom > 3
    || rotation < -180 || rotation > 180
  ) return null;
  return { storagePath, cropX, cropY, zoom, rotation };
}

function normalizeReplacement(value: unknown, userId: string): ReplacementInput | null {
  const crop = normalizeCrop(value, userId, "entry");
  if (!crop || !value || typeof value !== "object") return null;
  const imageId = Number((value as Record<string, unknown>).imageId);
  return Number.isInteger(imageId) ? { ...crop, imageId } : null;
}

function normalizeImageState(value: unknown): ImageStateInput | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const imageId = Number(source.imageId);
  const displayPosition = Number(source.displayPosition);
  const isHidden = source.isHidden;
  if (
    !Number.isInteger(imageId)
    || !Number.isInteger(displayPosition)
    || displayPosition < 1
    || displayPosition > 999
    || typeof isHidden !== "boolean"
  ) return null;
  return { imageId, displayPosition, isHidden };
}

async function storageObjectExists(bucket: "cos-entries" | "cos-originals", path: string) {
  const admin = createAdminClient();
  const separator = path.lastIndexOf("/");
  const folder = path.slice(0, separator);
  const filename = path.slice(separator + 1);
  const { data, error } = await admin.storage
    .from(bucket)
    .list(folder, { search: filename, limit: 10 });
  return !error && Boolean(data?.some((item) => item.name === filename));
}

async function removeUnreferencedCorrectionUploads(
  userId: string,
  entryPaths: unknown[],
  originalPaths: unknown[],
) {
  const admin = createAdminClient();
  const cleanEntries = [...new Set(entryPaths.filter((path) => (
    validCorrectionPath(userId, path, "entry") || validCorrectionPath(userId, path, "add")
  )) as string[])];
  const cleanOriginals = [...new Set(originalPaths.filter((path) => (
    validCorrectionPath(userId, path, "original")
  )) as string[])];

  if (cleanEntries.length) {
    const [{ data: revisions }, { data: entryImages }] = await Promise.all([
      admin.from("entry_image_revisions").select("storage_object_path").in("storage_object_path", cleanEntries),
      admin.from("entry_images").select("storage_path").in(
        "storage_path",
        cleanEntries.map((path) => admin.storage.from("cos-entries").getPublicUrl(path).data.publicUrl),
      ),
    ]);
    const referenced = new Set((revisions ?? []).map((item) => item.storage_object_path));
    for (const image of entryImages ?? []) {
      const path = cleanEntries.find((candidate) => (
        admin.storage.from("cos-entries").getPublicUrl(candidate).data.publicUrl === image.storage_path
      ));
      if (path) referenced.add(path);
    }
    const removable = cleanEntries.filter((path) => !referenced.has(path));
    if (removable.length) await admin.storage.from("cos-entries").remove(removable);
  }

  if (cleanOriginals.length) {
    const { data: revisions } = await admin
      .from("entry_original_image_revisions")
      .select("storage_object_path")
      .in("storage_object_path", cleanOriginals);
    const referenced = new Set((revisions ?? []).map((item) => item.storage_object_path));
    const removable = cleanOriginals.filter((path) => !referenced.has(path));
    if (removable.length) await admin.storage.from("cos-originals").remove(removable);
  }
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return response("unauthorized", "請先登入。", 401);

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const entryId = Number(body?.entryId);
  const grantId = String(body?.grantId ?? "");
  const requestedReplacements = Array.isArray(body?.replacements)
    ? body.replacements.map((item) => normalizeReplacement(item, user.id))
    : [];
  const requestedAdditions = Array.isArray(body?.additions)
    ? body.additions.map((item) => normalizeCrop(item, user.id, "add"))
    : [];
  const requestedImageStates = Array.isArray(body?.imageStates)
    ? body.imageStates.map(normalizeImageState)
    : [];
  const originalStoragePath = body?.originalStoragePath == null
    ? null
    : String(body.originalStoragePath);
  const rawEntryPaths = [
    ...(Array.isArray(body?.replacements)
      ? body.replacements.map((item) => (item as Record<string, unknown>)?.storagePath)
      : []),
    ...(Array.isArray(body?.additions)
      ? body.additions.map((item) => (item as Record<string, unknown>)?.storagePath)
      : []),
  ];
  const rawOriginalPaths = originalStoragePath ? [originalStoragePath] : [];
  const cleanup = () => removeUnreferencedCorrectionUploads(
    user.id,
    rawEntryPaths,
    rawOriginalPaths,
  );

  if (
    !Number.isInteger(entryId)
    || !grantId
    || requestedReplacements.length > 5
    || requestedAdditions.length > 5
    || requestedImageStates.length > 100
    || requestedReplacements.some((item) => !item)
    || requestedAdditions.some((item) => !item)
    || requestedImageStates.some((item) => !item)
    || (originalStoragePath !== null && !validCorrectionPath(user.id, originalStoragePath, "original"))
    || (
      !requestedReplacements.length
      && !requestedAdditions.length
      && !requestedImageStates.length
      && !originalStoragePath
    )
  ) {
    await cleanup();
    return response("invalid_media_corrections", "修正圖片資料格式不正確。", 400);
  }
  const replacements = requestedReplacements as ReplacementInput[];
  const additions = requestedAdditions as CropInput[];
  const imageStates = requestedImageStates as ImageStateInput[];
  const allStoragePaths = [
    ...replacements.map((item) => item.storagePath),
    ...additions.map((item) => item.storagePath),
    ...(originalStoragePath ? [originalStoragePath] : []),
  ];
  if (
    new Set(replacements.map((item) => item.imageId)).size !== replacements.length
    || new Set(imageStates.map((item) => item.imageId)).size !== imageStates.length
    || new Set(allStoragePaths).size !== allStoragePaths.length
  ) {
    await cleanup();
    return response("duplicate_media", "同一張圖片或上傳檔案不可重複送出。", 400);
  }

  const now = new Date().toISOString();
  const [
    { data: profile },
    { data: entry },
    { data: grant },
    { count: imageCount },
    { data: currentDisplaySettings },
  ] = await Promise.all([
    admin.from("profiles").select("id,discord_id,nickname,is_admin,is_disqualified").eq("id", user.id).maybeSingle(),
    admin.from("entries").select("id,event_id,owner_id,entry_code,uses_ai_background,original_image_path,withdrawn_at,status").eq("id", entryId).maybeSingle(),
    admin.from("submission_edit_grants")
      .select("id,entry_id,grantee_profile_id,allowed_positions,allowed_image_ids,allow_add_images,allow_replace_original,allow_reorder_images,allow_remove_images,reason,expires_at,is_active,revoked_at")
      .eq("id", grantId)
      .eq("entry_id", entryId)
      .eq("grantee_profile_id", user.id)
      .eq("is_active", true)
      .is("revoked_at", null)
      .gt("expires_at", now)
      .maybeSingle(),
    admin.from("entry_images").select("id", { count: "exact", head: true }).eq("entry_id", entryId),
    admin.from("entry_image_display_settings")
      .select("image_id,is_hidden")
      .eq("entry_id", entryId),
  ]);
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
  if (additions.length && !grant.allow_add_images) {
    await cleanup();
    return response("image_addition_not_allowed", "這次授權不允許新增公開圖片。", 403);
  }
  const hiddenIds = new Set(
    (currentDisplaySettings ?? [])
      .filter((setting) => setting.is_hidden && setting.image_id)
      .map((setting) => Number(setting.image_id)),
  );
  for (const state of imageStates) {
    if (state.isHidden) hiddenIds.add(state.imageId);
    else hiddenIds.delete(state.imageId);
  }
  const visibleCountAfter = (imageCount ?? 0) - hiddenIds.size + additions.length;
  if (visibleCountAfter > 5) {
    await cleanup();
    return response("image_limit_reached", "公開作品圖片最多只能有 5 張。", 422);
  }
  if (visibleCountAfter < 1) {
    await cleanup();
    return response("image_required", "作品至少需要保留 1 張公開圖片。", 422);
  }
  if (originalStoragePath && (!grant.allow_replace_original || !entry.uses_ai_background)) {
    await cleanup();
    return response("original_replacement_not_allowed", "這次授權不允許更換查核原圖。", 403);
  }

  const requestedImageIds = [...new Set([
    ...replacements.map((item) => item.imageId),
    ...imageStates.map((item) => item.imageId),
  ])];
  const { data: images } = requestedImageIds.length
    ? await admin
        .from("entry_images")
        .select("id,entry_id,position,storage_path,crop_x,crop_y,zoom,rotation,aspect_ratio")
        .eq("entry_id", entryId)
        .in("id", requestedImageIds)
    : { data: [] };
  if ((images ?? []).length !== requestedImageIds.length) {
    await cleanup();
    return response("image_not_found", "部分圖片不屬於這份投稿。", 404);
  }
  const allowedPositions = new Set((grant.allowed_positions ?? []).map(Number));
  const allowedImageIds = new Set((grant.allowed_image_ids ?? []).map(Number));
  const replacementIds = new Set(replacements.map((item) => item.imageId));
  if ((images ?? []).some((image) => (
    replacementIds.has(image.id)
    && !allowedImageIds.has(image.id)
    && !allowedPositions.has(image.position)
  ))) {
    await cleanup();
    return response("image_not_allowed", "這次授權不允許修改其中一張圖片。", 403);
  }

  const existence = await Promise.all([
    ...replacements.map((item) => storageObjectExists("cos-entries", item.storagePath)),
    ...additions.map((item) => storageObjectExists("cos-entries", item.storagePath)),
    ...(originalStoragePath
      ? [storageObjectExists("cos-originals", originalStoragePath)]
      : []),
  ]);
  if (existence.some((exists) => !exists)) {
    await cleanup();
    return response("upload_not_found", "部分新照片尚未成功上傳，請重新選擇後再試。", 400);
  }

  const entryObjectPaths = [
    ...replacements.map((item) => item.storagePath),
    ...additions.map((item) => item.storagePath),
  ];
  const [{ data: duplicateRevisions }, { data: duplicateImages }, { data: duplicateOriginals }] = await Promise.all([
    entryObjectPaths.length
      ? admin.from("entry_image_revisions").select("storage_object_path").in("storage_object_path", entryObjectPaths)
      : Promise.resolve({ data: [] }),
    entryObjectPaths.length
      ? admin.from("entry_images").select("storage_path").in(
          "storage_path",
          entryObjectPaths.map((path) => admin.storage.from("cos-entries").getPublicUrl(path).data.publicUrl),
        )
      : Promise.resolve({ data: [] }),
    originalStoragePath
      ? admin.from("entry_original_image_revisions").select("storage_object_path").eq("storage_object_path", originalStoragePath)
      : Promise.resolve({ data: [] }),
  ]);
  if (duplicateRevisions?.length || duplicateImages?.length || duplicateOriginals?.length) {
    await cleanup();
    return response("duplicate_upload", "這批照片已經送出，請重新整理確認結果。", 409);
  }

  const imagePayload = (item: CropInput) => ({
    storage_object_path: item.storagePath,
    display_storage_path: admin.storage.from("cos-entries").getPublicUrl(item.storagePath).data.publicUrl,
    crop_x: item.cropX,
    crop_y: item.cropY,
    zoom: item.zoom,
    rotation: item.rotation,
    aspect_ratio: SUBMISSION_IMAGE_ASPECT_VALUE,
  });
  const { data: processed, error } = await admin.rpc("apply_submission_media_corrections", {
    target_entry_id: entryId,
    target_grantee_profile_id: user.id,
    target_grant_id: grantId,
    replacements: replacements.map((item) => ({
      image_id: item.imageId,
      ...imagePayload(item),
    })),
    additions: additions.map(imagePayload),
    image_states: imageStates.map((state) => ({
      image_id: state.imageId,
      display_position: state.displayPosition,
      is_hidden: state.isHidden,
    })),
    new_original_storage_path: originalStoragePath,
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
      actionType: "submission_media_correction",
      targetType: "entry",
      targetId: entryId,
      beforeData: {
        image_count: imageCount ?? 0,
        original_path_unchanged: entry.original_image_path,
      },
      afterData: {
        grant_id: grantId,
        replacement_count: replacements.length,
        addition_count: additions.length,
        display_state_count: imageStates.length,
        original_replaced: Boolean(originalStoragePath),
      },
      result: "failure",
      failureReason: error.message,
    });
    return response("correction_failed", "圖片修正未完成，原作品仍保持不變。", 500);
  }

  await writeAuditLog({
    context,
    actionType: "submission_media_correction",
    targetType: "entry",
    targetId: entryId,
    beforeData: {
      grant_id: grantId,
      image_count: imageCount ?? 0,
      baseline_original_path: entry.original_image_path,
      replacement_image_ids: replacements.map((item) => item.imageId),
      display_states: imageStates,
    },
    afterData: {
      grant_id: grantId,
      actor_type: "owner",
      processed,
      baseline_images_unchanged: true,
      baseline_original_path_unchanged: true,
    },
  });
  revalidatePath("/");
  revalidatePath(`/entry/${entryId}`);
  revalidatePath("/awards");
  revalidatePath("/submit");
  revalidatePath("/admin");
  return NextResponse.json({
    ok: true,
    message: "圖片修正已儲存，原本照片與查核原圖均保留於版本紀錄。",
  });
}

export async function DELETE(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return response("unauthorized", "請先登入。", 401);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  await removeUnreferencedCorrectionUploads(
    user.id,
    Array.isArray(body?.entryStoragePaths) ? body.entryStoragePaths : [],
    Array.isArray(body?.originalStoragePaths) ? body.originalStoragePaths : [],
  );
  return NextResponse.json({ ok: true });
}
