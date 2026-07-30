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
  assert.match(css, /--submission-image-ratio:4\/3/);
  assert.match(css, /\.submission-image\{[^}]*aspect-ratio:var\(--submission-image-ratio\)/);
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

test("mobile submission success remains on the submission page", async () => {
  const form = await readFile(new URL("../app/submit/SubmitForm.tsx", import.meta.url), "utf8");
  assert.match(form, /router\.replace\("\/submit\?submitted=1"\)/);
  assert.doesNotMatch(form, /location\.href\s*=\s*"\/\?submitted=1"/);
});

test("every Discord login requests the email required by Supabase Auth", async () => {
  const home = await readFile(new URL("../app/components/HomeClient.tsx", import.meta.url), "utf8");
  const header = await readFile(new URL("../app/components/SiteHeader.tsx", import.meta.url), "utf8");
  for (const source of [home, header]) {
    assert.match(source, /provider:\s*"discord"/);
    assert.match(source, /scopes:\s*"identify email guilds"/);
    assert.doesNotMatch(source, /scopes:\s*"identify guilds"/);
  }
});

test("AI background originals are appended to the public entry gallery with a signed URL", async () => {
  const entryPage = await readFile(new URL("../app/entry/[id]/page.tsx", import.meta.url), "utf8");
  const carousel = await readFile(new URL("../app/components/ImageCarousel.tsx", import.meta.url), "utf8");
  assert.match(entryPage, /\.from\("cos-originals"\)\.createSignedUrl\(entry\.original_image_path,\s*60 \* 60\)/);
  assert.match(entryPage, /label:\s*"AI 合成前原圖"/);
  assert.match(entryPage, /images=\{galleryImages\}/);
  assert.doesNotMatch(entryPage, /\.from\("cos-originals"\)\.getPublicUrl/);
  assert.match(carousel, /carousel-badge/);
});

test("permanent deletion is super-admin-only and requires typed confirmation", async () => {
  const route = await readFile(
    new URL("../app/api/admin/entries/[id]/route.ts", import.meta.url),
    "utf8",
  );
  const migration = await readFile(
    new URL("../supabase/migrations/20260729203000_admin_permanent_entry_delete.sql", import.meta.url),
    "utf8",
  );
  assert.match(route, /authorizeAdmin\(request,\s*undefined,\s*true\)/);
  assert.match(route, /body\?\.confirmation !== `永久刪除 \$\{entryLabel\}`/);
  assert.match(route, /admin\.storage\.from\("cos-entries"\)\.remove/);
  assert.match(migration, /security invoker/i);
  assert.match(migration, /revoke all on function public\.admin_permanently_delete_entry\(bigint\) from authenticated/i);
  assert.match(migration, /delete from public\.votes[\s\S]*delete from public\.vote_history[\s\S]*delete from public\.entry_images[\s\S]*delete from public\.entries/i);
  assert.doesNotMatch(migration, /delete from storage\.objects/i);
});
