import type { SubmissionImageRecord } from "@/lib/types";

export type SubmissionEditGrant = {
  id: string;
  entry_id: number;
  grantee_profile_id: string;
  allowed_positions: number[];
  allowed_image_ids: number[];
  allow_add_images: boolean;
  allow_replace_original: boolean;
  allow_reorder_images: boolean;
  allow_remove_images: boolean;
  reason: string | null;
  expires_at: string;
  is_active: boolean;
  revoked_at: string | null;
  created_at: string;
};

export type EntryImageRevision = {
  id: number;
  entry_id: number;
  image_id: number;
  display_storage_path: string;
  crop_x: number;
  crop_y: number;
  zoom: number;
  rotation: number;
  aspect_ratio: string;
  is_active: boolean;
  created_at: string;
};

export type EntryImageDisplaySetting = {
  image_id: number;
  entry_id: number;
  display_position: number;
  is_hidden: boolean;
};

export function isGrantUsable(
  grant: SubmissionEditGrant | null | undefined,
  now = Date.now(),
) {
  return Boolean(
    grant
    && grant.is_active
    && !grant.revoked_at
    && Number.isFinite(Date.parse(grant.expires_at))
    && Date.parse(grant.expires_at) > now,
  );
}

export function applyActiveImageRevisions<
  T extends SubmissionImageRecord & { entry_id?: number },
>(
  images: T[],
  revisions: EntryImageRevision[] | null | undefined,
): T[] {
  const activeByImage = new Map(
    (revisions ?? [])
      .filter((revision) => revision.is_active)
      .map((revision) => [revision.image_id, revision]),
  );
  return images.map((image) => {
    const revision = activeByImage.get(image.id);
    if (!revision) return image;
    return {
      ...image,
      storage_path: revision.display_storage_path,
      crop_x: revision.crop_x,
      crop_y: revision.crop_y,
      zoom: revision.zoom,
      rotation: revision.rotation,
      aspect_ratio: revision.aspect_ratio,
    };
  });
}

export function applyImageDisplaySettings<
  T extends SubmissionImageRecord & { entry_id?: number },
>(
  images: T[],
  settings: EntryImageDisplaySetting[] | null | undefined,
): T[] {
  const settingByImage = new Map(
    (settings ?? []).map((setting) => [setting.image_id, setting]),
  );
  return images
    .filter((image) => !settingByImage.get(image.id)?.is_hidden)
    .map((image) => ({
      ...image,
      position: settingByImage.get(image.id)?.display_position ?? image.position,
    }))
    .sort((left, right) => left.position - right.position || left.id - right.id);
}
