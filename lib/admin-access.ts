export const SUPER_ADMIN_DISCORD_ID = "635371564979716106";

export const ADMIN_PERMISSIONS = [
  "player_manager",
  "eligibility_manager",
  "submission_viewer",
  "submission_manager",
  "event_manager",
  "award_manager",
  "award_assigner",
  "announcement_manager",
  "report_viewer",
  "statistics_viewer",
  "audit_viewer",
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];
export type AdminPermissions = Partial<Record<AdminPermission, boolean>>;

export function isSuperAdminDiscordId(discordId: unknown) {
  return String(discordId ?? "").trim() === SUPER_ADMIN_DISCORD_ID;
}
// Kept as a compatibility alias for the profile creation route. No environment
// variable or previously hard-coded account can become the super administrator.
export function isConfiguredAdmin(discordId: unknown) {
  return isSuperAdminDiscordId(discordId);
}
