import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { normalizeScript, spokenTexts, ScriptError } from "../src/script/parse.mjs";
import { loadConfig, ConfigError } from "../src/config/load.mjs";
import { mergeConfig } from "../src/config/defaults.mjs";

test("a bare string is a spoken step", () => {
  const script = normalizeScript(["hello there"], "smoke");
  assert.equal(script.steps[0].kind, "say");
  assert.equal(script.steps[0].waitForResponse, true);
});

test("barge-in and wait steps normalize", () => {
  const script = normalizeScript({
    name: "s",
    steps: [{ bargeIn: "stop" }, { waitMs: 500 }, { click: "#end" }],
  });
  assert.deepEqual(script.steps.map((step) => step.kind), ["bargeIn", "wait", "click"]);
});

test("a step that does nothing is rejected at parse time, not at run time", () => {
  assert.throws(() => normalizeScript({ steps: [{ mood: "hopeful" }] }), ScriptError);
});

test("every utterance is known before the browser opens", () => {
  const script = normalizeScript({ steps: [{ say: "one" }, { waitMs: 10 }, { bargeIn: "two" }] });
  assert.deepEqual(spokenTexts(script), ["one", "two"]);
});

test("arrays replace rather than merge, so config overrides are predictable", () => {
  const merged = mergeConfig({ a: [1, 2], b: { c: 1, d: 2 } }, { a: [3], b: { d: 9 } });
  assert.deepEqual(merged, { a: [3], b: { c: 1, d: 9 } });
});

test("a config missing its session selector fails with an explanation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vocoso-config-"));
  writeFileSync(join(dir, "vocoso.config.json"), JSON.stringify({ mode: "voice", voice: {} }));
  await assert.rejects(
    () => loadConfig({ configPath: join(dir, "vocoso.config.json") }),
    (error) => error instanceof ConfigError && /voice\.start/.test(error.message),
  );
});

test("self-healing refuses to be enabled without a file scope", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vocoso-config-"));
  writeFileSync(join(dir, "vocoso.config.json"), JSON.stringify({
    mode: "chat",
    chat: { input: "#in", send: "#send" },
    heal: { patch: { enabled: true, paths: [] } },
  }));
  await assert.rejects(
    () => loadConfig({ configPath: join(dir, "vocoso.config.json") }),
    /heal\.patch\.paths/,
  );
});

test("a valid config resolves its report and cache directories", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vocoso-config-"));
  writeFileSync(join(dir, "vocoso.config.json"), JSON.stringify({
    mode: "chat",
    chat: { input: "#in", send: "#send" },
  }));
  const config = await loadConfig({ configPath: join(dir, "vocoso.config.json") });
  assert.equal(config.rootDir, dir);
  assert.equal(config.reportDir, join(dir, "vocoso-reports"));
});
