import assert from "node:assert/strict";
import { test } from "node:test";

import { diagnose, formatDiagnosis } from "../src/heal/diagnose.mjs";

const baseRun = {
  mode: "voice",
  script: "s",
  config: { transport: { speakingThreshold: 0.01 } },
  verification: { stages: {}, blocked: null },
  observed: { httpFailures: [] },
  transport: { finalState: { counts: {}, frameCount: 0, eventCount: 0, micStreams: 0 }, unmatched: [], peakOutputLevel: 0 },
  utterances: [],
  checks: [],
  recoveries: [],
};

const withRun = (patch) => diagnose({ ...baseRun, ...patch });

test("frames with no recognised events point at the preset, not the product", () => {
  const findings = withRun({
    transport: {
      finalState: { counts: {}, frameCount: 42, eventCount: 0, micStreams: 1 },
      unmatched: [{ source: "websocket", sample: '{"kind":"bespoke"}' }],
      peakOutputLevel: 0,
    },
  });
  const found = findings.find((item) => item.code === "PRESET_UNMATCHED");
  assert.ok(found);
  assert.equal(found.fault, "rig");
  assert.match(found.observed, /bespoke/);
});

test("a 429 is named as a billing boundary, not a broken transport", () => {
  const findings = withRun({
    observed: { httpFailures: [{ status: 429, url: "https://api.openai.com/v1/realtime/calls", body: "no credits" }] },
  });
  const found = findings.find((item) => item.code === "RATE_LIMITED");
  assert.ok(found);
  assert.equal(found.fault, "external");
});

test("words without audio is reported as a playback defect", () => {
  const findings = withRun({
    transport: {
      finalState: { counts: { "assistant.text": 3 }, frameCount: 20, eventCount: 3, micStreams: 1, meterCount: 0 },
      unmatched: [], peakOutputLevel: 0,
    },
  });
  const found = findings.find((item) => item.code === "NO_ASSISTANT_AUDIO");
  assert.ok(found);
  assert.equal(found.fault, "app");
});

test("announced audio that never made a sound is caught by the meter", () => {
  const findings = withRun({
    transport: {
      finalState: { counts: { "assistant.audio.start": 2, "assistant.text": 1 }, frameCount: 10, eventCount: 3, micStreams: 1 },
      unmatched: [], peakOutputLevel: 0.0000001,
    },
  });
  assert.ok(findings.some((item) => item.code === "DEAD_AIR"));
});

test("speaking into a session that never transcribed is split by whether the app held the mic", () => {
  const held = withRun({
    utterances: [{ text: "hi" }],
    transport: { finalState: { counts: {}, frameCount: 12, eventCount: 2, micStreams: 1 }, unmatched: [], peakOutputLevel: 0 },
  }).find((item) => item.code === "NOT_HEARD");
  assert.equal(held.fault, "app");

  const notHeld = withRun({
    utterances: [{ text: "hi" }],
    transport: { finalState: { counts: {}, frameCount: 0, eventCount: 0, micStreams: 0 }, unmatched: [], peakOutputLevel: 0 },
  }).find((item) => item.code === "NOT_HEARD");
  assert.equal(notHeld.fault, "rig");
});

test("a grounding failure becomes a prompt-level finding", () => {
  const findings = withRun({
    checks: [{
      name: "surface",
      passed: false,
      evaluation: { findings: [{ rule: "grounding", detail: "card.title retypes \"Priya Raman\"" }] },
    }],
  });
  const found = findings.find((item) => item.code === "SURFACE_UNGROUNDED");
  assert.ok(found);
  assert.ok(found.fix.length > 0);
});

test("repeated recoveries are themselves a finding", () => {
  const findings = withRun({
    recoveries: Array.from({ length: 3 }, () => ({ outcome: "repaired", strategy: "session-restore", reason: "mic gone" })),
  });
  assert.ok(findings.some((item) => item.code === "SESSION_FLAPPING"));
});

test("a clean run diagnoses nothing", () => {
  assert.deepEqual(withRun({}), []);
  assert.match(formatDiagnosis([]), /nothing failed/);
});
