import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  applyActiveImageRevisions,
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
