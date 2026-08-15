import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  applyActiveImageRevisions,
  applyImageDisplaySettings,
  isGrantUsable,
  type EntryImageRevision,
  type SubmissionEditGrant,
} from "../lib/submission-corrections.ts";

const baselineImage = {
  id: 11,
  entry_id: 7,
  storage_path: "https://example.test/original.webp",
  position: 2,
  crop_x: 0,
  crop_y: 0,
  zoom: 1,
  rotation: 0,
  aspect_ratio: "4/3",
};

test("active correction revisions replace presentation only", () => {
  const revision: EntryImageRevision = {
    id: 90,
    entry_id: 7,
    image_id: 11,
    display_storage_path: "https://example.test/replacement.webp",
    crop_x: 8,
    crop_y: -4,
    zoom: 1.3,
    rotation: 0,
    aspect_ratio: "4/3",
    is_active: true,
    created_at: "2026-07-31T00:00:00.000Z",
  };
  const [displayed] = applyActiveImageRevisions([baselineImage], [revision]);
  assert.equal(displayed.storage_path, revision.display_storage_path);
  assert.equal(displayed.position, baselineImage.position);
  assert.equal(displayed.entry_id, baselineImage.entry_id);
  assert.equal(baselineImage.storage_path, "https://example.test/original.webp");
});

test("inactive revisions cannot change the displayed image", () => {
  const [displayed] = applyActiveImageRevisions([baselineImage], [{
    id: 90,
    entry_id: 7,
    image_id: 11,
    display_storage_path: "https://example.test/replacement.webp",
    crop_x: 8,
    crop_y: -4,
    zoom: 1.3,
    rotation: 0,
    aspect_ratio: "4/3",
    is_active: false,
    created_at: "2026-07-31T00:00:00.000Z",
  }]);
  assert.equal(displayed.storage_path, baselineImage.storage_path);
});

test("correction grant must be active, unrevoked, and unexpired", () => {
  const grant: SubmissionEditGrant = {
    id: "grant",
    entry_id: 7,
    grantee_profile_id: "player",
    allowed_positions: [2],
    allowed_image_ids: [11],
    allow_add_images: false,
    allow_replace_original: false,
    allow_reorder_images: false,
    allow_remove_images: false,
    reason: null,
    expires_at: "2026-08-02T00:00:00.000Z",
    is_active: true,
    revoked_at: null,
    created_at: "2026-07-31T00:00:00.000Z",
  };
  assert.equal(isGrantUsable(grant, Date.parse("2026-08-01T00:00:00.000Z")), true);
  assert.equal(isGrantUsable({ ...grant, revoked_at: "2026-08-01T00:00:00.000Z" }, Date.parse("2026-08-01T00:00:00.000Z")), false);
  assert.equal(isGrantUsable(grant, Date.parse("2026-08-03T00:00:00.000Z")), false);
});

test("display settings can reorder and hide without changing baseline image rows", () => {
  const secondImage = { ...baselineImage, id: 12, position: 1 };
  const displayed = applyImageDisplaySettings(
    [baselineImage, secondImage],
    [
      { image_id: 11, entry_id: 7, display_position: 1, is_hidden: false },
      { image_id: 12, entry_id: 7, display_position: 2, is_hidden: true },
    ],
  );
  assert.deepEqual(displayed.map((image) => image.id), [11]);
  assert.equal(displayed[0].position, 1);
  assert.equal(baselineImage.position, 2);
  assert.equal(secondImage.position, 1);
});

test("media correction migration preserves old files and canonical contest records", () => {
  const migration = readFileSync(
    new URL("../supabase/migrations/20260731170000_extend_submission_media_corrections.sql", import.meta.url),
    "utf8",
  ).toLowerCase();
  for (const forbidden of [
    "drop table",
    "truncate",
    "on delete cascade",
    "delete from public.entries",
    "delete from public.votes",
    "update public.entries",
    "update public.votes",
    "update public.entry_images",
  ]) {
    assert.equal(migration.includes(forbidden), false, `migration contains ${forbidden}`);
  }
  assert.match(migration, /entry_original_image_revisions/);
  assert.match(migration, /entry_image_display_settings/);
  assert.match(migration, /allow_add_images/);
  assert.match(migration, /allow_replace_original/);
  assert.match(migration, /allow_reorder_images/);
  assert.match(migration, /allow_remove_images/);
});

test("correction migration is append-only for canonical contest data", () => {
  const migration = readFileSync(
    new URL("../supabase/migrations/20260731090000_submission_correction_grants.sql", import.meta.url),
    "utf8",
  ).toLowerCase();
  for (const forbidden of [
    "drop table",
    "truncate",
    "on delete cascade",
    "delete from public.entries",
    "delete from public.votes",
    "update public.entries",
    "update public.votes",
    "update public.entry_images",
  ]) {
    assert.equal(migration.includes(forbidden), false, `migration contains ${forbidden}`);
  }
  assert.match(migration, /enable row level security/);
  assert.match(migration, /grant execute .* to service_role/);
  assert.match(migration, /revoke all .* from authenticated/);
});

test("Cos submission eligibility is checked before any image upload", () => {
  const route = readFileSync(
    new URL("../app/api/submissions/route.ts", import.meta.url),
    "utf8",
  );
  const client = readFileSync(
    new URL("../app/submit/SubmitForm.tsx", import.meta.url),
    "utf8",
  );
  assert.match(route, /export async function PUT/);
  assert.match(route, /你已經投稿過，不需要再次上傳照片/);
  assert.ok(
    client.indexOf('method: "PUT"') < client.indexOf('storage.from("cos-originals").upload'),
    "submission preflight must run before uploading files",
  );
});
