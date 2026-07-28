import assert from "node:assert/strict";
import test from "node:test";
import { canShowAwards, isVotingOpen, type EventRecord } from "../lib/types.ts";

const event: EventRecord = {
  id: "event",
  title: "活動",
  submission_starts_at: "2026-07-01T00:00:00.000Z",
  submission_ends_at: "2026-07-02T00:00:00.000Z",
  voting_starts_at: "2026-07-03T00:00:00.000Z",
  voting_ends_at: "2026-07-04T00:00:00.000Z",
  submissions_locked: false,
  voting_locked: false,
  voting_override: "auto",
  leaderboard_mode: "hidden",
};

test("voting lock overrides explicit voting status", () => {
  assert.equal(isVotingOpen({ ...event, status: "voting_open", voting_locked: true }), false);
});

test("closed voting override overrides explicit voting status", () => {
  assert.equal(isVotingOpen({ ...event, status: "voting_open", voting_override: "closed" }), false);
});

test("automatic schedule opens only inside its voting window", () => {
  assert.equal(isVotingOpen(event, Date.parse("2026-07-03T12:00:00.000Z")), true);
  assert.equal(isVotingOpen(event, Date.parse("2026-07-04T00:01:00.000Z")), false);
});

test("archived results remain viewable", () => {
  assert.equal(canShowAwards({ ...event, status: "archived" }), true);
});
