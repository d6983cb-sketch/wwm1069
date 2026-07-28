export type AnnouncementAudience = "all" | "participants" | "submitters" | "admins" | "player";

export function canViewAnnouncement(
  announcement: { audience: string; target_profile_id: string | null },
  viewer: {
    profileId: string;
    isDisqualified: boolean;
    isAdmin: boolean;
    hasSubmission: boolean;
  },
) {
  if (announcement.audience === "all") return true;
  if (announcement.audience === "player") return announcement.target_profile_id === viewer.profileId;
  if (announcement.audience === "admins") return viewer.isAdmin;
  if (announcement.audience === "submitters") return viewer.hasSubmission;
  if (announcement.audience === "participants") return !viewer.isDisqualified;
  return false;
}
