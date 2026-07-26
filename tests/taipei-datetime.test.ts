import assert from "node:assert/strict";
import test from "node:test";
import {
  taipeiInputToIso,
  toTaipeiInput,
} from "../lib/taipei-datetime.ts";

test("Taipei activity times survive a save and reload round trip", () => {
  const input = "2026-08-11T15:59";
  const stored = taipeiInputToIso(input);

  assert.equal(stored, "2026-08-11T07:59:00.000Z");
  assert.equal(toTaipeiInput(stored), input);
});

test("invalid local date values are rejected", () => {
  assert.equal(taipeiInputToIso("2026-08-11 15:59"), "");
  assert.equal(toTaipeiInput("not-a-date"), "");
});
