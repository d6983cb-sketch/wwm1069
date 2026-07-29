import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { isSuperAdminDiscordId, type AdminPermissions } from "@/lib/admin-access";
import { writeAuditLog, type AdminContext } from "@/lib/admin-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  SUBMISSION_IMAGE_ASPECT_VALUE,
  isSubmissionOpen,
  type EventRecord,
} from "@/lib/types";

type CropInput = {
  imageId: number;
  cropX: number;
  cropY: number;
  zoom: number;
  rotation: number;
};

function response(error: string, message: string, status: number) {
  return NextResponse.json({ error, message }, { status });
}

function normalizeCrop(value: unknown): CropInput | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const imageId = Number(source.imageId);
  const cropX = Number(source.cropX);
  const cropY = Number(source.cropY);
  const zoom = Number(source.zoom);
  const rotation = Number(source.rotation);
  if (
    !Number.isInteger(imageId)
    || ![cropX, cropY, zoom, rotation].every(Number.isFinite)
    || cropX < -50 || cropX > 50
    || cropY < -50 || cropY > 50
    || zoom < 1 || zoom > 3
    || rotation < -180 || rotation > 180
  ) return null;
  return { imageId, cropX, cropY, zoom, rotation };
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return response("unauthorized", "請先登入。", 401);

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const entryId = Number(body?.entryId);
  const requested = Array.isArray(body?.images) ? body.images.map(normalizeCrop) : [];
  if (
    !Number.isInteger(entryId)
    || requested.length < 1
    || requested.length > 5
    || requested.some((crop) => !crop)
  ) return response("invalid_crop", "圖片裁切資料格式不正確。", 400);
  const crops = requested as CropInput[];
  if (new Set(crops.map((crop) => crop.imageId)).size !== crops.length) {
    return response("duplicate_image", "同一張圖片不可重複送出。", 400);
  }

  const [{ data: profile }, { data: entry }] = await Promise.all([
    admin.from("profiles").select("id,discord_id,nickname,is_admin,is_disqualified").eq("id", user.id).maybeSingle(),
    admin.from("entries").select("id,event_id,owner_id,entry_code,withdrawn_at,status").eq("id", entryId).maybeSingle(),
  ]);
  if (!profile) return response("profile_not_found", "找不到玩家資料。", 404);
  if (!entry) return response("entry_not_found", "找不到投稿。", 404);
  if (entry.withdrawn_at) return response("entry_withdrawn", "已撤回的投稿不能調整圖片。", 422);

  const [{ data: eventData }, { data: role }, { data: existingImages }] = await Promise.all([
    admin.from("events").select("*").eq("id", entry.event_id).maybeSingle(),
    admin.from("admin_roles").select("permissions,is_active").eq("profile_id", user.id).maybeSingle(),
    admin.from("entry_images")
      .select("id,entry_id,position,crop_x,crop_y,zoom,rotation,aspect_ratio")
      .eq("entry_id", entryId)
      .in("id", crops.map((crop) => crop.imageId))
      .order("position"),
  ]);
  const event = eventData as EventRecord | null;
  if (!event) return response("event_not_found", "找不到活動。", 404);
  if ((existingImages ?? []).length !== crops.length) {
    return response("image_not_found", "部分圖片不屬於這份投稿。", 404);
  }

  const isOwner = entry.owner_id === user.id;
  const isSuperAdmin = isSuperAdminDiscordId(profile.discord_id);
  const permissions = (role?.permissions ?? {}) as AdminPermissions;
  const isSubmissionManager = isSuperAdmin || (role?.is_active === true && permissions.submission_manager === true);
  const playerAllowed = isOwner && isSubmissionOpen(event);
  const adminAllowed = isSubmissionManager && (
    isSubmissionOpen(event)
    || event.allow_admin_crop_after_submission === true
  );
  if (!playerAllowed && !adminAllowed) {
    return response(
      isOwner ? "crop_edit_closed" : "forbidden",
      isOwner ? "投稿截止後不能再調整圖片位置。" : "沒有投稿圖片管理權限。",
      isOwner ? 422 : 403,
    );
  }

  const context: AdminContext = {
    profile,
    isSuperAdmin,
    permissions: isSuperAdmin ? { submission_manager: true } : permissions,
    requestId: request.headers.get("x-request-id")?.slice(0, 120) || crypto.randomUUID(),
  };
  const before = existingImages ?? [];
  const after = before.map((image) => {
    const crop = crops.find((item) => item.imageId === image.id)!;
    return {
      ...image,
      crop_x: crop.cropX,
      crop_y: crop.cropY,
      zoom: crop.zoom,
      rotation: crop.rotation,
      aspect_ratio: SUBMISSION_IMAGE_ASPECT_VALUE,
    };
  });

  for (const image of after) {
    const { error } = await admin
      .from("entry_images")
      .update({
        crop_x: image.crop_x,
        crop_y: image.crop_y,
        zoom: image.zoom,
        rotation: image.rotation,
        aspect_ratio: image.aspect_ratio,
        crop_updated_at: new Date().toISOString(),
      })
      .eq("id", image.id)
      .eq("entry_id", entryId);
    if (error) {
      for (const original of before) {
        await admin.from("entry_images").update({
          crop_x: original.crop_x,
          crop_y: original.crop_y,
          zoom: original.zoom,
          rotation: original.rotation,
          aspect_ratio: original.aspect_ratio,
        }).eq("id", original.id).eq("entry_id", entryId);
      }
      await writeAuditLog({
        context,
        actionType: "submission_image_crop_update",
        targetType: "entry",
        targetId: entryId,
        beforeData: before,
        afterData: after,
        result: "failure",
        failureReason: error.message,
      });
      return response("crop_update_failed", "圖片位置儲存失敗，原設定已保留。", 500);
    }
  }

  await writeAuditLog({
    context,
    actionType: "submission_image_crop_update",
    targetType: "entry",
    targetId: entryId,
    beforeData: { actor_type: isOwner ? "owner" : "admin", images: before },
    afterData: { actor_type: isOwner ? "owner" : "admin", images: after },
  });
  revalidatePath("/");
  revalidatePath(`/entry/${entryId}`);
  revalidatePath("/awards");
  revalidatePath("/submit");
  revalidatePath("/admin");
  return NextResponse.json({ ok: true, message: "圖片展示位置已儲存。" });
}

export async function PUT(request: Request) {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return response("unauthorized", "請先登入。", 401);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const entryId = Number(body?.entryId);
  if (!Number.isInteger(entryId)) return response("invalid_entry", "投稿編號不正確。", 400);
  const [{ data: profile }, { data: entry }, { data: role }] = await Promise.all([
    admin.from("profiles").select("id,discord_id,nickname,is_admin,is_disqualified").eq("id", user.id).maybeSingle(),
    admin.from("entries").select("id,entry_code").eq("id", entryId).maybeSingle(),
    admin.from("admin_roles").select("permissions,is_active").eq("profile_id", user.id).maybeSingle(),
  ]);
  if (!profile) return response("profile_not_found", "找不到玩家資料。", 404);
  if (!entry) return response("entry_not_found", "找不到投稿。", 404);
  const isSuperAdmin = isSuperAdminDiscordId(profile.discord_id);
  const permissions = (role?.permissions ?? {}) as AdminPermissions;
  if (!isSuperAdmin && !(role?.is_active && permissions.submission_manager)) {
    return response("forbidden", "沒有投稿圖片管理權限。", 403);
  }
  const context: AdminContext = {
    profile,
    isSuperAdmin,
    permissions,
    requestId: request.headers.get("x-request-id")?.slice(0, 120) || crypto.randomUUID(),
  };
  revalidatePath("/");
  revalidatePath(`/entry/${entryId}`);
  revalidatePath("/awards");
  revalidatePath("/admin");
  await writeAuditLog({
    context,
    actionType: "submission_display_regenerate",
    targetType: "entry",
    targetId: entryId,
    beforeData: { storage_unchanged: true },
    afterData: { cache_revalidated: true, storage_unchanged: true },
  });
  return NextResponse.json({ ok: true, message: "展示快取已重新產生，原始圖片未變更。" });
}
