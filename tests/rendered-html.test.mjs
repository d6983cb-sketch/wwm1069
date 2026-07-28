import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("the only server-forced super administrator is the requested Discord ID", async () => {
  const source = await readFile(new URL("lib/admin-access.ts", root), "utf8");
  assert.match(source, /SUPER_ADMIN_DISCORD_ID\s*=\s*"635371564979716106"/);
  assert.doesNotMatch(source, /1530036118006009929|405757579432558592|827363719566458931/);
});
test("the production expansion migration contains no destructive table or data reset", async () => {
  const source = await readFile(new URL("supabase/migration-production-expansion.sql", root), "utf8");
  assert.doesNotMatch(source, /\b(?:drop\s+table|truncate)\b/i);
  assert.doesNotMatch(source, /delete\s+from\s+public\.(?:entries|votes|profiles|entry_images)/i);
  assert.match(source, /references public\.entries\(id\) on delete restrict/i);
  assert.match(source, /where discord_id = '827363719566458931'/);
  assert.match(source, /set nickname = '久惟'/);
});

test("audit cleanup is scoped by age and cannot target production records", async () => {
  const source = await readFile(new URL("app/api/cron/audit-cleanup/route.ts", root), "utf8");
  assert.match(source, /\.from\("audit_logs"\)\.delete\(\)/);
  assert.match(source, /\.lt\("created_at", cutoff\)/);
  assert.doesNotMatch(source, /\.from\("(?:entries|votes|profiles|entry_images)"\)\.delete\(\)/);
});
