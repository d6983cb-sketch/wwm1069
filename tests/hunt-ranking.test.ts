import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { calculateHuntProgress, calculateHuntRanking, canShowHuntRanking, isHuntOpen, type HuntEventRecord } from "../lib/hunt.ts";
import { classifyHuntMatches } from "../lib/hunt-ai.ts";

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
  auto_match_enabled: false,
  auto_match_threshold: 0.78,
  auto_match_margin: 0.04,
};

test("hunt opens only during the configured open window", () => {
  assert.equal(isHuntOpen(event, Date.parse("2026-08-13T00:00:00.000Z")), true);
  assert.equal(isHuntOpen(event, Date.parse("2026-08-21T00:00:00.000Z")), false);
  assert.equal(isHuntOpen({ ...event, status: "closed" }, Date.parse("2026-08-13T00:00:00.000Z")), false);
});

test("automatic matching requires both threshold and a clear lead", () => {
  assert.deepEqual(classifyHuntMatches([
    { target_number: 1, similarity: 0.86 },
    { target_number: 2, similarity: 0.75 },
  ], 0.78, 0.04), {
    status: "matched",
    targetNumber: 1,
    similarity: 0.86,
    candidates: [{ targetNumber: 1, similarity: 0.86 }, { targetNumber: 2, similarity: 0.75 }],
  });
  assert.equal(classifyHuntMatches([
    { target_number: 1, similarity: 0.84 },
    { target_number: 2, similarity: 0.82 },
  ], 0.78, 0.04).status, "uncertain");
});

test("provisional count is distinct and never replaces manual truth", () => {
  assert.deepEqual(calculateHuntProgress([
    { status: "correct", matched_target_number: 1, auto_status: "matched", auto_match_target_number: 1 },
    { status: "pending", matched_target_number: null, auto_status: "matched", auto_match_target_number: 2 },
    { status: "pending", matched_target_number: null, auto_status: "matched", auto_match_target_number: 2 },
    { status: "incorrect", matched_target_number: null, auto_status: "matched", auto_match_target_number: 3 },
  ]), { confirmedCount: 1, provisionalCount: 2 });
});

test("hidden ranking stays hidden until results are published", () => {
  assert.equal(canShowHuntRanking(event), false);
  assert.equal(canShowHuntRanking({ ...event, leaderboard_mode: "live" }), true);
  assert.equal(canShowHuntRanking({ ...event, status: "results_published" }), true);
});

test("hunt AI migration is additive and keeps all existing proofs and Cos data", () => {
  const migration = fs.readFileSync(
    path.join(process.cwd(), "supabase/migrations/20260815143000_hunt_ai_recognition.sql"),
    "utf8",
  );
  assert.doesNotMatch(migration, /\btruncate\b/i);
  assert.doesNotMatch(migration, /\bdelete\s+from\b/i);
  assert.doesNotMatch(migration, /\bdrop\s+(table|column)\b/i);
  assert.doesNotMatch(migration, /\bupdate\s+public\.(entries|entry_images|votes|profiles|hunt_submissions)\b/i);
  assert.match(migration, /references public\.hunt_events\(id\) on delete restrict/i);
  assert.match(migration, /references public\.hunt_reference_points\(id\) on delete restrict/i);
  assert.match(migration, /alter table public\.hunt_reference_points enable row level security/i);
  assert.match(migration, /revoke all on table public\.hunt_reference_images from anon, authenticated/i);
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

test("players can delete only their own unconfirmed hunt submissions while the hunt is open", () => {
  const route = fs.readFileSync(
    path.join(process.cwd(), "app/api/hunt/submissions/route.ts"),
    "utf8",
  );
  const client = fs.readFileSync(
    path.join(process.cwd(), "app/hunt/HuntClient.tsx"),
    "utf8",
  );
  assert.match(route, /export async function DELETE/);
  assert.match(route, /submission\.profile_id !== user\.id/);
  assert.match(route, /!isHuntOpen\(event as HuntEventRecord\)/);
  assert.match(route, /submission\.status === "correct"/);
  assert.match(route, /\.eq\("profile_id", user\.id\)/);
  assert.match(route, /\.neq\("status", "correct"\)/);
  assert.match(route, /storage\.from\("hunt-proofs"\)\.remove/);
  assert.match(client, /刪除這筆錯誤投稿/);
  assert.match(client, /method: "DELETE"/);
});
