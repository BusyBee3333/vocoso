import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { measureWavFile, parseWav, validateSpeechClip } from "../src/audio/wav.mjs";
import { makeWav, writeWav } from "./helpers.mjs";

const scratch = mkdtempSync(join(tmpdir(), "vocoso-audio-"));

test("parses a WAV header without assuming a sample rate", () => {
  const wav = parseWav(makeWav({ sampleRate: 16_000 }));
  assert.equal(wav.sampleRate, 16_000);
  assert.equal(wav.channels, 1);
  assert.equal(wav.bitsPerSample, 16);
});

test("measures duration and signal energy", () => {
  const path = writeWav(join(scratch, "tone.wav"), { seconds: 2, amplitude: 0.5 });
  const measured = measureWavFile(path);
  assert.ok(Math.abs(measured.seconds - 2) < 0.01, `expected ~2s, got ${measured.seconds}`);
  assert.ok(measured.rms > 0.3, `expected real energy, got ${measured.rms}`);
});

test("accepts a clip that plausibly contains the text", () => {
  const path = writeWav(join(scratch, "speech.wav"), { seconds: 1.5 });
  const check = validateSpeechClip(path, "hello there how are you");
  assert.equal(check.ok, true, check.problems.join("; "));
});

test("rejects a full-length clip of digital silence", () => {
  // The failure mode that matters: the file is the right length, so a
  // duration-only check passes it and every later run speaks nothing.
  const path = writeWav(join(scratch, "silent.wav"), { seconds: 3, amplitude: 0 });
  const check = validateSpeechClip(path, "hello there how are you");
  assert.equal(check.ok, false);
  assert.match(check.problems.join(" "), /no audible signal/);
});

test("rejects a header-only clip", () => {
  const path = writeWav(join(scratch, "stub.wav"), { seconds: 0.005 });
  const check = validateSpeechClip(path, "this sentence is definitely longer than five milliseconds");
  assert.equal(check.ok, false);
  assert.match(check.problems.join(" "), /at least/);
});
