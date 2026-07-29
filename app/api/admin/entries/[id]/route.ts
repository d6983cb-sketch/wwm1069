import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { authorizeAdmin, writeAuditLog } from "@/lib/admin-auth";
import { createAdminClient } from "@/lib/supabase/admin";

type DeleteResult = {
  entry_id: number;
  entry_code: string | null;
  character_name: string;
  owner_id: string;
  original_image_path: string | null;
  image_urls: string[];
  votes_deleted: number;
  images_deleted: number;
  award_assignments_deleted: number;
  vote_history_deleted: number;
};

function response(error: string, message: string, status: number) {
  return NextResponse.json({ error, message }, { status });
}

function storageObjectPath(publicUrl: string) {
  const marker = "/storage/v1/object/public/cos-entries/";
  const markerIndex = publicUrl.indexOf(marker);
  if (markerIndex < 0) return null;
  try {
    return decodeURIComponent(publicUrl.slice(markerIndex + marker.length));
  } catch {
    return null;
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authorizeAdmin(request, undefined, true);
  if (!auth.ok) return auth.response;
  const { context } = auth;
  const { id } = await params;
  const entryId = Number(id);
  if (!Number.isInteger(entryId) || entryId < 1) {
    return response("invalid_entry", "投稿編號不正確。", 400);
  }

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const admin = createAdminClient();
  const { data: entry } = await admin
    .from("entries")
    .select("id,entry_code,character_name")
    .eq("id", entryId)
    .maybeSingle();
  if (!entry) return response("entry_not_found", "找不到投稿，可能已被刪除。", 404);

  const entryLabel = entry.entry_code ?? `#${entry.id}`;
  if (body?.confirmation !== `永久刪除 ${entryLabel}`) {
    return response("confirmation_mismatch", `請輸入「永久刪除 ${entryLabel}」。`, 400);
  }

  const idempotencyKey = String(body?.idempotencyKey ?? "").trim().slice(0, 160);
  if (!idempotencyKey) return response("missing_idempotency_key", "缺少操作識別碼，請重新操作。", 400);
  const { error: guardError } = await admin.from("idempotency_keys").insert({
    key: idempotencyKey,
    actor_profile_id: context.profile.id,
    action_type: "entry_permanent_delete",
  });
  if (guardError) {
    return response(
      guardError.code === "23505" ? "duplicate_request" : "request_guard_failed",
      guardError.code === "23505" ? "這個刪除操作已送出，請重新整理確認結果。" : "安全檢查失敗，作品尚未刪除。",
      guardError.code === "23505" ? 409 : 500,
    );
  }

  const { data, error } = await admin.rpc("admin_permanently_delete_entry", {
    target_entry_id: entryId,
  });
  if (error) {
    await writeAuditLog({
      context,
      actionType: "entry_permanent_delete",
      targetType: "entry",
      targetId: entryId,
      beforeData: entry,
      result: "failure",
      failureReason: error.message,
    });
    return response("entry_delete_failed", "永久刪除失敗，資料庫已取消這次操作。", 500);
  }
  const deleted = data as DeleteResult | null;
  if (!deleted) return response("entry_not_found", "找不到投稿，可能已被刪除。", 404);

  const entryPaths = (deleted.image_urls ?? [])
    .map(storageObjectPath)
    .filter((path): path is string => Boolean(path));
  const [entryStorage, originalStorage] = await Promise.all([
    entryPaths.length
      ? admin.storage.from("cos-entries").remove(entryPaths)
      : Promise.resolve({ error: null }),
    deleted.original_image_path
      ? admin.storage.from("cos-originals").remove([deleted.original_image_path])
      : Promise.resolve({ error: null }),
  ]);
  const storageError = entryStorage.error?.message || originalStorage.error?.message || null;

  await writeAuditLog({
    context,
    actionType: "entry_permanent_delete",
    targetType: "entry",
    targetId: entryId,
    beforeData: deleted,
    afterData: {
      deleted: true,
      storage_objects_requested: entryPaths.length + (deleted.original_image_path ? 1 : 0),
      storage_cleanup_succeeded: !storageError,
    },
    result: storageError ? "failure" : "success",
    failureReason: storageError ?? undefined,
  });

  revalidatePath("/");
  revalidatePath("/admin");
  revalidatePath("/awards");
  revalidatePath("/submit");
  if (storageError) {
    return response(
      "storage_cleanup_failed",
      "投稿與投票已刪除，但圖片檔案清理失敗；操作紀錄已保留，請聯絡系統管理員。",
      500,
    );
  }
  return NextResponse.json({
    ok: true,
    message: `作品 ${entryLabel} 已永久刪除。`,
    deleted: {
      votes: deleted.votes_deleted,
      images: deleted.images_deleted,
      awardAssignments: deleted.award_assignments_deleted,
    },
  });
}
