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

test("new server-only tables explicitly grant service_role access", async () => {
  const migration = await readFile("supabase/migration-production-expansion.sql", "utf8");
  assert.match(migration, /public\.awards[\s\S]*public\.idempotency_keys[\s\S]*to service_role;/);
  assert.match(migration, /public\.audit_logs_id_seq[\s\S]*to service_role;/);
  assert.doesNotMatch(migration, /to (?:anon|authenticated)\s*;/);
});

test("rank award migration cannot rewrite production entries or votes", async () => {
  const migration = await readFile("supabase/migration-award-ranking.sql", "utf8");
  assert.match(migration, /add column if not exists ranking_position integer/i);
  assert.match(migration, /earliest_reached_votes/);
  assert.doesNotMatch(migration, /\b(?:delete|update|insert)\s+(?:from|into)?\s*public\.(?:entries|votes)/i);
  assert.doesNotMatch(migration, /\b(?:drop table|truncate)\b/i);
});

test("hardening migration preserves canonical contest data and blocks cascade deletion", async () => {
  const migration = await readFile("supabase/migration-production-hardening.sql", "utf8");
  assert.doesNotMatch(migration, /\b(?:drop\s+table|truncate)\b/i);
  assert.doesNotMatch(migration, /\b(?:delete|update)\s+(?:from\s+)?public\.(?:entries|votes|profiles|entry_images)/i);
  assert.match(migration, /ON DELETE RESTRICT/i);
  assert.match(migration, /not ev\.voting_locked/);
  assert.match(migration, /ev\.voting_override <> 'closed'/);
  assert.match(migration, /revoke all on table[\s\S]*from anon, authenticated;/);
});

test("submission failure cleanup checks database references before deleting storage", async () => {
  const source = await readFile("app/api/submissions/route.ts", "utf8");
  assert.match(source, /removeUnreferencedUploads/);
  assert.match(source, /\.from\("entry_images"\)[\s\S]*\.in\("storage_path", publicUrls\)/);
  assert.match(source, /\.from\("entries"\)[\s\S]*\.eq\("original_image_path", originalPath\)/);
});

test("image crop migration is presentation-only and preserves canonical data", async () => {
  const migration = await readFile(
    new URL("../supabase/migrations/20260729193000_submission_image_crops.sql", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(migration, /^\s*(?:delete\s+from|update|truncate|drop\s+table)\s+public\.(?:entries|votes|profiles|entry_images)\b/im);
  assert.doesNotMatch(migration, /storage\.objects\s+(?:set|delete|update)/i);
  assert.match(migration, /add column if not exists crop_x/i);
  assert.match(migration, /revoke update on table public\.entry_images from anon, authenticated/i);
});

test("all public submission images use the shared crop-aware component", async () => {
  const carousel = await readFile(new URL("../app/components/ImageCarousel.tsx", import.meta.url), "utf8");
  const awards = await readFile(new URL("../app/awards/page.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(carousel, /SubmissionImage/);
  assert.match(awards, /SubmissionImage/);
  assert.match(css, /\.submission-image\{[^}]*aspect-ratio:4\/5/);
});

test("crop API limits updates to crop columns and records an audit log", async () => {
  const source = await readFile(
    new URL("../app/api/submissions/images/crop/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /submission_image_crop_update/);
  assert.match(source, /allow_admin_crop_after_submission/);
  assert.doesNotMatch(source, /\.from\("votes"\)\.(?:update|delete|insert)/);
  assert.doesNotMatch(source, /storage\.(?:from|remove|upload)/);
});
