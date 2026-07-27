export const BUILTIN_ADMIN_DISCORD_IDS = new Set([
  "1530036118006009929",
  "405757579432558592",
  "827363719566458931",
]);

export function configuredAdminDiscordIds() {
  const configured = (process.env.ADMIN_DISCORD_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set([...BUILTIN_ADMIN_DISCORD_IDS, ...configured]);
}

export function isConfiguredAdmin(discordId: unknown) {
  return configuredAdminDiscordIds().has(String(discordId ?? "").trim());
}
