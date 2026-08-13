import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateExpectations } from "../src/oracle/expectations.mjs";

const step = { startedAt: 100, text: "book a table for two" };
const base = [
  { at: 110, kind: "user.transcript", text: "book a table for two", final: true },
  { at: 150, kind: "assistant.audio.start" },
  { at: 160, kind: "tool.call", name: "reservations.create", arguments: '{"size":2,"name":"Priya"}' },
  { at: 200, kind: "assistant.text", text: "Booked for two at seven.", final: true, modality: "audio" },
];
const surfaces = { latest: null, versions: [] };

const run = (expect, events = base) =>
  evaluateExpectations({ expect, step, events, surfaces, factState: {}, config: {} });

test("a faithful transcription passes the heard check", () => {
  const [check] = run({ heard: true });
  assert.equal(check.passed, true);
  assert.equal(check.wordErrorRate, 0);
});

test("a mishearing fails and reports both sides", () => {
  const [check] = run({ heard: true }, [
    { at: 110, kind: "user.transcript", text: "book a stable for you", final: true },
  ]);
  assert.equal(check.passed, false);
  assert.match(check.detail, /but said/);
});

test("no transcription at all is a distinct failure", () => {
  const [check] = run({ heard: true }, []);
  assert.equal(check.passed, false);
  assert.match(check.detail, /ever arrived/);
});

test("tool expectations can require argument content", () => {
  const [ok] = run({ toolCalled: [{ name: "reservations.create", argumentsInclude: { size: 2 } }] });
  assert.equal(ok.passed, true);
  const [bad] = run({ toolCalled: [{ name: "reservations.create", argumentsInclude: { size: 4 } }] });
  assert.equal(bad.passed, false);
});

test("a missing tool names what was called instead", () => {
  const [check] = run({ toolCalled: "reservations.cancel" });
  assert.equal(check.passed, false);
  assert.match(check.detail, /reservations\.create/);
});

test("negative expectations catch a tool that must not fire", () => {
  const [check] = run({ noToolCalled: "reservations.create" });
  assert.equal(check.passed, false);
});

test("barge-in is judged on how fast the assistant yields", () => {
  const [fast] = run({ interrupted: { withinMs: 1_000 } }, [
    ...base, { at: 700, kind: "assistant.audio.stop", cleared: true },
  ]);
  assert.equal(fast.passed, true);
  const [slow] = run({ interrupted: { withinMs: 200 } }, [
    ...base, { at: 5_000, kind: "assistant.audio.stop", cleared: true },
  ]);
  assert.equal(slow.passed, false);
  assert.match(slow.detail, /kept talking/);
});

test("a turn with no surface fails a surface expectation loudly", () => {
  const [check] = run({ surface: true });
  assert.equal(check.passed, false);
  assert.match(check.detail, /no generative surface/);
});

test("mentions and doesNotMention read the assistant's own words", () => {
  const [mentions] = run({ mentions: "booked for two" });
  assert.equal(mentions.passed, true);
  const [absent] = run({ doesNotMention: "credit card" });
  assert.equal(absent.passed, true);
});
