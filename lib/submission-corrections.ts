import type { SubmissionImageRecord } from "@/lib/types";

export type SubmissionEditGrant = {
  id: string;
  entry_id: number;
  grantee_profile_id: string;
  allowed_positions: number[];
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
