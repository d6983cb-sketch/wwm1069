import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  calculateHuntProgress,
  calculateHuntRanking,
  canShowHuntAnswerPhotos,
  canShowHuntPlayerPhotos,
  canShowHuntRanking,
  hasReachedHuntPhotoRevealTime,
  isHuntOpen,
  type HuntEventRecord,
} from "../lib/hunt.ts";
import { classifyHuntMatches, fetchHuntAiWith429Retry, finalizeHuntVisionDecision, HUNT_AI_MAX_429_RETRIES, parseHuntVerificationText, withHuntAiQueue } from "../lib/hunt-ai.ts";

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
  photo_reveal_at: null,
  reveal_player_photos: false,
  reveal_answer_photos: false,
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
    verification: null,
  });
  assert.equal(classifyHuntMatches([
    { target_number: 1, similarity: 0.84 },
    { target_number: 2, similarity: 0.82 },
  ], 0.78, 0.04).status, "uncertain");
});

test("whole-image similarity alone cannot create a provisional match", () => {
  const candidates = [
    { targetNumber: 15, similarity: 0.875387 },
    { targetNumber: 13, similarity: 0.832598 },
    { targetNumber: 11, similarity: 0.829507 },
  ];
  const rejected = finalizeHuntVisionDecision(candidates, {
    matchedTargetNumber: 15,
    objectVisible: false,
    samePhysicalLocation: false,
    confidence: 0.88,
    reason: "只有相似的遊戲場景，找不到藏物標記。",
  });
  assert.equal(rejected.status, "uncertain");
  assert.equal(rejected.targetNumber, null);
});

test("visual verification must see the object, confirm the location, and reach 90 percent", () => {
  const candidates = [{ targetNumber: 15, similarity: 0.934583 }];
  const accepted = finalizeHuntVisionDecision(candidates, {
    matchedTargetNumber: 15,
    objectVisible: true,
    samePhysicalLocation: true,
    confidence: 0.96,
    reason: "藏物與牆面、屋簷位置一致。",
  });
  assert.equal(accepted.status, "matched");
  assert.equal(accepted.targetNumber, 15);
  assert.equal(accepted.similarity, 0.934583);

  const unknownTarget = finalizeHuntVisionDecision(candidates, {
    ...accepted.verification!,
    matchedTargetNumber: 14,
  });
  assert.equal(unknownTarget.status, "uncertain");
});

test("visual verification safely accepts schema-shaped JSON5-like output", () => {
  assert.deepEqual(parseHuntVerificationText(`{
    matchedTargetNumber: 15,
    objectVisible: true,
    samePhysicalLocation: true,
    confidence: 0.96,
    reason: '藏物與固定建築位置一致'
  }`), {
    matchedTargetNumber: 15,
    objectVisible: true,
    samePhysicalLocation: true,
    confidence: 0.96,
    reason: "藏物與固定建築位置一致",
  });
  assert.deepEqual(parseHuntVerificationText(`{
    matched_target_number: 'H015',
    object_visible: 'YES',
    same_location: '是',
    confidence_score: '96%',
    explanation: '固定建築位置一致'
  }`), {
    matchedTargetNumber: 15,
    objectVisible: true,
    samePhysicalLocation: true,
    confidence: 0.96,
    reason: "固定建築位置一致",
  });
  assert.throws(() => parseHuntVerificationText("not structured output"), /hunt_ai_invalid_verification_json_target_confidence_visible_location/);
});

test("hunt AI retries exactly three times after HTTP 429", async () => {
  let calls = 0;
  const delays: number[] = [];
  const response = await fetchHuntAiWith429Retry("https://example.test", {}, {
    fetcher: async () => {
      calls += 1;
      return new Response(null, { status: calls <= HUNT_AI_MAX_429_RETRIES ? 429 : 200 });
    },
    sleep: async (milliseconds) => { delays.push(milliseconds); },
    random: () => 0,
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 4);
  assert.deepEqual(delays, [1_000, 2_000, 4_000]);
});

test("hunt AI queue runs recognition jobs one at a time", async () => {
  const events: string[] = [];
  let releaseFirst = () => {};
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = withHuntAiQueue(async () => {
    events.push("first:start");
    await firstGate;
    events.push("first:end");
  });
  const second = withHuntAiQueue(async () => {
    events.push("second:start");
    events.push("second:end");
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  try {
    assert.deepEqual(events, ["first:start"]);
  } finally {
    releaseFirst();
  }
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
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

test("player and answer photos remain hidden until the configured reveal instant", () => {
  const scheduled = {
    ...event,
    photo_reveal_at: "2026-08-20T12:00:00.000Z",
    reveal_player_photos: true,
    reveal_answer_photos: true,
  };
  assert.equal(hasReachedHuntPhotoRevealTime(scheduled, Date.parse("2026-08-20T11:59:59.000Z")), false);
  assert.equal(canShowHuntPlayerPhotos(scheduled, Date.parse("2026-08-20T11:59:59.000Z")), false);
  assert.equal(canShowHuntAnswerPhotos(scheduled, Date.parse("2026-08-20T11:59:59.000Z")), false);
  assert.equal(canShowHuntPlayerPhotos(scheduled, Date.parse("2026-08-20T12:00:00.000Z")), true);
  assert.equal(canShowHuntAnswerPhotos(scheduled, Date.parse("2026-08-20T12:00:00.000Z")), true);
  assert.equal(canShowHuntAnswerPhotos({ ...scheduled, reveal_answer_photos: false }, Date.parse("2026-08-20T12:00:00.000Z")), false);
});

test("hunt photo reveal migration is additive and never changes existing submissions or Storage", () => {
  const migration = fs.readFileSync(
    path.join(process.cwd(), "supabase/migrations/20260815160000_hunt_photo_reveal_schedule.sql"),
    "utf8",
  );
  assert.match(migration, /add column if not exists photo_reveal_at timestamptz/i);
  assert.match(migration, /add column if not exists reveal_player_photos boolean not null default false/i);
  assert.match(migration, /add column if not exists reveal_answer_photos boolean not null default false/i);
  assert.doesNotMatch(migration, /\b(drop|truncate|delete|update)\b/i);
  assert.doesNotMatch(migration, /storage\.objects/i);
});

test("public hunt page creates private signed URLs only after server-side reveal checks", () => {
  const page = fs.readFileSync(path.join(process.cwd(), "app/hunt/page.tsx"), "utf8");
  assert.match(page, /if \(event && canShowHuntPlayerPhotos\(event\)\)/);
  assert.match(page, /if \(event && canShowHuntAnswerPhotos\(event\)\)/);
  assert.match(page, /\.eq\("status", "correct"\)/);
  assert.match(page, /storage\.from\("hunt-proofs"\)\.createSignedUrl/);
  assert.match(page, /storage\.from\("hunt-references"\)\.createSignedUrl/);
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

test("hunt visual verification migration only adds nullable metadata", () => {
  const migration = fs.readFileSync(
    path.join(process.cwd(), "supabase/migrations/20260815180000_hunt_visual_verification.sql"),
    "utf8",
  );
  assert.match(migration, /add column if not exists auto_verification jsonb/i);
  assert.match(migration, /add column if not exists auto_verification_confidence real/i);
  assert.match(migration, /add column if not exists auto_verification_model text/i);
  assert.doesNotMatch(migration, /\b(drop|truncate|delete|update|insert)\b/i);
  assert.doesNotMatch(migration, /storage\.objects/i);
});

test("admins can reprocess a hunt proof without replacing the proof or manual review", () => {
  const route = fs.readFileSync(path.join(process.cwd(), "app/api/admin/hunt/route.ts"), "utf8");
  const block = route.slice(route.indexOf('if (type === "hunt_submission_reprocess")'), route.indexOf('if (type === "hunt_review")'));
  assert.match(block, /storage\.from\("hunt-proofs"\)\.download\(before\.image_path\)/);
  assert.match(block, /recognizeHuntImage/);
  assert.match(block, /auto_verification:/);
  assert.doesNotMatch(block, /storage\.from\("hunt-proofs"\)\.(remove|upload)/);
  assert.doesNotMatch(block, /\b(status|matched_target_number|image_path|file_hash):/);
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

test("administrators can edit a reference point and append helper images without replacing its label", () => {
  const route = fs.readFileSync(
    path.join(process.cwd(), "app/api/admin/hunt/route.ts"),
    "utf8",
  );
  const client = fs.readFileSync(
    path.join(process.cwd(), "app/admin/hunt/HuntAdminClient.tsx"),
    "utf8",
  );
  assert.match(route, /type === "hunt_reference_point_update"/);
  assert.match(route, /actionType: "hunt_reference_point_update"/);
  assert.match(route, /\.\.\.\(label \? \{ label \} : \{\}\)/);
  assert.match(client, /新增照片並建立索引/);
  assert.match(client, /不會覆蓋原有照片/);
  assert.match(client, /saveReferencePoint/);
  assert.match(client, /function ReferenceImagePicker/);
  assert.match(client, /URL\.createObjectURL/);
  assert.match(client, /replaceInputFiles\(inputRef\.current, next\)/);
  assert.match(client, /準備上傳的參考圖預覽/);
});

test("hunt uploads check exact duplicates before creating Storage objects", () => {
  const route = fs.readFileSync(
    path.join(process.cwd(), "app/api/hunt/submissions/route.ts"),
    "utf8",
  );
  const client = fs.readFileSync(
    path.join(process.cwd(), "app/hunt/HuntClient.tsx"),
    "utf8",
  );
  assert.match(route, /export async function PUT/);
  assert.match(route, /\.eq\("file_hash", fileHash\)/);
  assert.match(client, /method: "PUT"/);
  assert.ok(
    client.indexOf('method: "PUT"') < client.indexOf('storage.from("hunt-proofs").upload'),
    "duplicate preflight must run before uploading the proof",
  );
});

test("hunt reference hashes are additive and cannot change existing images", () => {
  const migration = fs.readFileSync(
    path.join(process.cwd(), "supabase/migrations/20260815170000_hunt_reference_content_hash.sql"),
    "utf8",
  );
  const route = fs.readFileSync(
    path.join(process.cwd(), "app/api/admin/hunt/route.ts"),
    "utf8",
  );
  const client = fs.readFileSync(
    path.join(process.cwd(), "app/admin/hunt/HuntAdminClient.tsx"),
    "utf8",
  );
  assert.match(migration, /add column if not exists content_sha256 text/i);
  assert.match(migration, /unique index if not exists hunt_reference_images_point_content_sha256_uidx/i);
  assert.doesNotMatch(migration, /\b(delete|truncate|update|drop table|drop column)\b/i);
  assert.match(route, /\.eq\("content_sha256", fileHash\)/);
  assert.match(route, /content_sha256: fileHash/);
  assert.match(client, /sha256File\(file\)/);
  assert.match(client, /fileHash/);
});
