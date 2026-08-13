/**
 * The conversation script: a short list of things to say and what must be
 * true afterwards. JSON so a non-programmer can write one; .mjs when the
 * expectations want real functions.
 */
import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export class ScriptError extends Error {}

const STEP_KINDS = ["say", "bargeIn", "type", "waitMs", "click", "expect", "note", "reload"];

function normalizeStep(step, index) {
  if (typeof step === "string") return { kind: "say", text: step, index, waitForResponse: true, expect: {} };
  if (!step || typeof step !== "object") throw new ScriptError(`step ${index} is not an object`);

  const present = STEP_KINDS.filter((kind) => step[kind] !== undefined);
  const primary = present.find((kind) => kind !== "expect" && kind !== "note") ?? (step.expect ? "expect" : null);
  if (!primary) {
    throw new ScriptError(`step ${index} does nothing (expected one of: ${STEP_KINDS.join(", ")})`);
  }

  const common = {
    index,
    note: step.note ?? null,
    skip: Boolean(step.skip),
    expect: step.expect ?? {},
    screenshot: step.screenshot !== false,
  };

  switch (primary) {
    case "say":
    case "type":
      return {
        ...common,
        kind: "say",
        text: String(step.say ?? step.type),
        waitForResponse: step.waitForResponse !== false,
        responseTimeoutMs: step.responseTimeoutMs,
        thenWaitMs: step.thenWaitMs ?? 0,
      };
    case "bargeIn":
      return {
        ...common,
        kind: "bargeIn",
        text: String(step.bargeIn),
        maxWaitMs: step.maxWaitMs ?? 25_000,
        responseTimeoutMs: step.responseTimeoutMs,
      };
    case "waitMs":
      return { ...common, kind: "wait", waitMs: Number(step.waitMs) };
    case "click":
      return { ...common, kind: "click", selector: String(step.click) };
    case "reload":
      return { ...common, kind: "reload" };
    default:
      return { ...common, kind: "assert" };
  }
}

export function normalizeScript(raw, fallbackName) {
  if (Array.isArray(raw)) raw = { steps: raw };
  if (!raw || !Array.isArray(raw.steps)) {
    throw new ScriptError("a script must be an array of steps, or { name, steps: [...] }");
  }
  const steps = raw.steps.map(normalizeStep);
  if (steps.length === 0) throw new ScriptError("a script needs at least one step");
  return {
    name: raw.name ?? fallbackName ?? "conversation",
    description: raw.description ?? null,
    tags: raw.tags ?? [],
    // Per-script overrides merged over the file config at run time.
    config: raw.config ?? {},
    steps,
  };
}

export async function loadScript(path) {
  const absolute = resolve(path);
  const fallbackName = basename(absolute, extname(absolute));
  if (extname(absolute) === ".json") {
    return normalizeScript(JSON.parse(await readFile(absolute, "utf8")), fallbackName);
  }
  const module = await import(pathToFileURL(absolute).href);
  const raw = module.default ?? module.script ?? module;
  return normalizeScript(typeof raw === "function" ? await raw() : raw, fallbackName);
}

/** Every utterance in a script, so clips can be synthesized before the browser opens. */
export const spokenTexts = (script) =>
  script.steps.filter((step) => step.kind === "say" || step.kind === "bargeIn").map((step) => step.text);
