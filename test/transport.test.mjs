import assert from "node:assert/strict";
import { test } from "node:test";

import { framePayloads, normalizeFrames, transcriptFrom } from "../src/transport/normalize.mjs";
import { resolvePresets } from "../src/transport/presets.mjs";
import { frame } from "./helpers.mjs";

const all = resolvePresets("auto");

test("splits an SSE batch into one payload per message", () => {
  const payloads = framePayloads(frame(
    'data: {"a":1}\n\ndata: {"a":2}\n\ndata: [DONE]\n', { source: "fetch-stream" },
  ));
  assert.equal(payloads.length, 2);
  assert.deepEqual(payloads.map((item) => item.json.a), [1, 2]);
});

test("reads an AI SDK prefixed stream line", () => {
  const payloads = framePayloads(frame('2:{"type":"data-surface","data":{"root":"a"}}', { source: "fetch-stream" }));
  assert.equal(payloads[0].json.type, "data-surface");
});

test("maps an OpenAI Realtime conversation", () => {
  const { events } = normalizeFrames([
    frame({ type: "session.created", session: { model: "gpt-realtime" } }, { at: 1 }),
    frame({ type: "input_audio_buffer.speech_started" }, { at: 2 }),
    frame({ type: "conversation.item.input_audio_transcription.completed", transcript: "book a table" }, { at: 3 }),
    frame({ type: "output_audio_buffer.started" }, { at: 4 }),
    frame({ type: "response.function_call_arguments.done", name: "book", arguments: '{"size":2}' }, { at: 5 }),
    frame({ type: "response.output_audio_transcript.done", transcript: "Booked for two." }, { at: 6 }),
    frame({ type: "output_audio_buffer.stopped" }, { at: 7 }),
    frame({ type: "response.done", response: { status: "completed" } }, { at: 8 }),
  ], all);
  assert.deepEqual(events.map((item) => item.kind), [
    "session.open", "user.speech.start", "user.transcript", "assistant.audio.start",
    "tool.call", "assistant.text", "assistant.audio.stop", "assistant.done",
  ]);
});

test("maps a Gemini Live turn", () => {
  const { events } = normalizeFrames([
    frame({ setupComplete: {} }, { source: "websocket", at: 1 }),
    frame({ serverContent: { outputTranscription: { text: "Sure." }, turnComplete: true } }, { source: "websocket", at: 2 }),
    frame({ toolCall: { functionCalls: [{ name: "lookup", args: { id: 7 } }] } }, { source: "websocket", at: 3 }),
  ], all);
  const kinds = events.map((item) => item.kind);
  assert.ok(kinds.includes("session.open"));
  assert.ok(kinds.includes("assistant.text"));
  assert.ok(kinds.includes("tool.call"));
});

test("surfaces the frames no preset understood, which is the actionable part", () => {
  const { events, unmatched } = normalizeFrames(
    [frame({ kind: "something.bespoke", payload: 1 })], all,
  );
  assert.equal(events.length, 0);
  assert.equal(unmatched.length, 1);
  assert.match(unmatched[0].sample, /something.bespoke/);
});

test("an app can emit semantic events directly", () => {
  const { events } = normalizeFrames([
    frame({ type: "assistant.text", detail: { text: "hello", final: true } }, { source: "app" }),
  ], all);
  assert.equal(events[0].kind, "assistant.text");
  assert.equal(events[0].text, "hello");
});

test("two presets agreeing on one frame produce one event", () => {
  const { events } = normalizeFrames([frame({ type: "error", error: { message: "nope" } })], all);
  assert.equal(events.filter((item) => item.kind === "error").length, 1);
});

test("streaming deltas collapse into whole turns", () => {
  const turns = transcriptFrom([
    { at: 1, kind: "user.transcript", text: "hi", final: true },
    { at: 2, kind: "assistant.text", text: "Hel", final: false },
    { at: 3, kind: "assistant.text", text: "lo.", final: false },
    { at: 4, kind: "tool.call", name: "greet", arguments: "{}", callId: "c1" },
    { at: 5, kind: "tool.result", callId: "c1", result: { ok: true } },
  ]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].assistantText, "Hello.");
  assert.deepEqual(turns[0].tools[0].result, { ok: true });
});
