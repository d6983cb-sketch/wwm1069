import assert from "node:assert/strict";
import test from "node:test";
import { calculateAwardRanking } from "../lib/award-ranking.ts";

const entries = [
  { id: 1, created_at: "2026-07-20T00:00:00.000Z" },
  { id: 2, created_at: "2026-07-21T00:00:00.000Z" },
  { id: 3, created_at: "2026-07-22T00:00:00.000Z" },
];

test("rank awards follow vote totals", () => {
  const ranking = calculateAwardRanking(entries, [
    { entry_id: 1, created_at: "2026-07-25T01:00:00.000Z" },
    { entry_id: 2, created_at: "2026-07-25T01:01:00.000Z" },
    { entry_id: 2, created_at: "2026-07-25T01:02:00.000Z" },
  ], "joint");

  assert.deepEqual(ranking.map(({ entryId, rank, votes }) => ({ entryId, rank, votes })), [
    { entryId: 2, rank: 1, votes: 2 },
    { entryId: 1, rank: 2, votes: 1 },
    { entryId: 3, rank: 3, votes: 0 },
  ]);
});

test("earliest reached vote total wins an equal-vote tie", () => {
  const ranking = calculateAwardRanking(entries.slice(0, 2), [
    { entry_id: 1, created_at: "2026-07-25T01:00:00.000Z" },
    { entry_id: 1, created_at: "2026-07-25T01:02:00.000Z" },
    { entry_id: 2, created_at: "2026-07-25T00:30:00.000Z" },
    { entry_id: 2, created_at: "2026-07-25T01:01:00.000Z" },
  ], "earliest_reached_votes");

  assert.equal(ranking[0].entryId, 2);
  assert.equal(ranking[0].rank, 1);
  assert.equal(ranking[1].entryId, 1);
  assert.equal(ranking[1].rank, 2);
});

test("joint ties retain the same rank", () => {
  const ranking = calculateAwardRanking(entries.slice(0, 2), [], "joint");
  assert.deepEqual(ranking.map(({ rank }) => rank), [1, 1]);
  assert.ok(ranking.every(({ hasEqualVotes }) => hasEqualVotes));
});
