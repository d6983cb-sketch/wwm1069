import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { calculateHuntRanking, canShowHuntRanking, isHuntOpen, type HuntEventRecord } from "../lib/hunt.ts";

const event: HuntEventRecord = {
  id: "hunt-1",
  title: "找找物品在哪裡",
  description: null,
  target_image_path: "/images/hunt-target.webp",
  show_target_image: false,
  total_targets: 10,
  starts_at: "2026-08-12T00:00:00.000Z",
  ends_at: "2026-08-20T00:00:00.000Z",
  status: "open",
  leaderboard_mode: "hidden",
};

test("hunt opens only during the configured open window", () => {
  assert.equal(isHuntOpen(event, Date.parse("2026-08-13T00:00:00.000Z")), true);
  assert.equal(isHuntOpen(event, Date.parse("2026-08-21T00:00:00.000Z")), false);
  assert.equal(isHuntOpen({ ...event, status: "closed" }, Date.parse("2026-08-13T00:00:00.000Z")), false);
});

test("hidden ranking stays hidden until results are published", () => {
  assert.equal(canShowHuntRanking(event), false);
  assert.equal(canShowHuntRanking({ ...event, leaderboard_mode: "live" }), true);
  assert.equal(canShowHuntRanking({ ...event, status: "results_published" }), true);
});

test("ranking counts only correct finds and favors the earlier reached count", () => {
  const ranking = calculateHuntRanking([
    { profile_id: "a", status: "correct", submitted_at: "2026-08-12T01:00:00Z" },
    { profile_id: "a", status: "correct", submitted_at: "2026-08-12T02:00:00Z" },
    { profile_id: "b", status: "correct", submitted_at: "2026-08-12T01:30:00Z" },
    { profile_id: "b", status: "correct", submitted_at: "2026-08-12T03:00:00Z" },
    { profile_id: "b", status: "duplicate", submitted_at: "2026-08-12T03:10:00Z" },
  ], [
    { id: "a", nickname: "甲" },
    { id: "b", nickname: "乙" },
  ]);
  assert.deepEqual(ranking.map((row) => [row.nickname, row.correctCount, row.rank]), [
    ["甲", 2, 1],
    ["乙", 2, 2],
  ]);
  assert.equal(ranking[0].reachedAt, "2026-08-12T02:00:00Z");
});

test("hunt migration is additive and cannot remove existing Cos data", () => {
  const migration = fs.readFileSync(
    path.join(process.cwd(), "supabase/migrations/20260812133000_hunt_event_module.sql"),
    "utf8",
  );
  assert.doesNotMatch(migration, /\b(drop|truncate)\s+table\b/i);
  assert.doesNotMatch(migration, /\bdelete\s+from\s+public\.(entries|entry_images|votes|profiles)\b/i);
  assert.doesNotMatch(migration, /\bupdate\s+public\.(entries|entry_images|votes|profiles)\b/i);
  assert.match(migration, /on delete restrict/i);
  assert.match(migration, /alter table public\.hunt_events enable row level security/i);
  assert.match(migration, /alter table public\.hunt_submissions enable row level security/i);
});
