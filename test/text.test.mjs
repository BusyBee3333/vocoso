import assert from "node:assert/strict";
import { test } from "node:test";

import { containsPhrase, normalizeForCompare, wordErrorRate } from "../src/util/text.mjs";

test("punctuation and casing are not transcription errors", () => {
  assert.equal(wordErrorRate("Book me a table, please.", "book me a table please"), 0);
});

test("spoken numbers normalize to digits", () => {
  assert.deepEqual(normalizeForCompare("call me at four"), ["call", "me", "at", "4"]);
  assert.equal(wordErrorRate("send it to unit four", "send it to unit 4"), 0);
});

test("a real mishearing scores above zero", () => {
  const rate = wordErrorRate("add Priya to the follow up list", "add prea to the fallow up list");
  assert.ok(rate > 0.2, `expected a meaningful error rate, got ${rate}`);
});

test("empty transcript is a total miss, not a pass", () => {
  assert.equal(wordErrorRate("anything at all", ""), 1);
});

test("containsPhrase ignores formatting", () => {
  assert.equal(containsPhrase("Your table is booked for 7pm.", "table is booked"), true);
  assert.equal(containsPhrase("Nothing was booked", "table is booked"), false);
});
