/**
 * Step-level expectations - the part that makes a run self-judging.
 *
 * Every expectation here is decidable from things the rig already knows or
 * authored. Nothing asks whether the answer was *good*; that needs a human or
 * a judge model and belongs in a different tool. These ask whether the system
 * did what a working system must do, which is where real regressions live.
 */
import { containsPhrase, wordErrorRate } from "../util/text.mjs";
import { evaluateSurface } from "./surface.mjs";

const result = (name, passed, detail, extra = {}) => ({ name, passed, detail, ...extra });

function assistantTextSince(events, sinceAt) {
  return events
    .filter((item) => item.kind === "assistant.text" && item.at >= sinceAt)
    .map((item) => item.text ?? "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function toolCallsSince(events, sinceAt) {
  return events.filter((item) => item.kind === "tool.call" && item.at >= sinceAt);
}

function parseArguments(call) {
  if (call.arguments === null || call.arguments === undefined) return {};
  if (typeof call.arguments === "object") return call.arguments;
  try { return JSON.parse(call.arguments); } catch { return {}; }
}

function subsetMatches(actual, expected) {
  for (const [key, value] of Object.entries(expected)) {
    const found = actual?.[key];
    if (value instanceof RegExp) {
      if (typeof found !== "string" || !value.test(found)) return false;
    } else if (typeof value === "object" && value !== null) {
      if (!subsetMatches(found, value)) return false;
    } else if (typeof value === "string" && typeof found === "string") {
      if (!containsPhrase(found, value)) return false;
    } else if (found !== value) return false;
  }
  return true;
}

/**
 * Evaluate one step's `expect` block.
 *
 * @param {object} input
 * @param {object} input.expect      the step's expectations
 * @param {object} input.step        step context: spoken text, timestamps
 * @param {Array}  input.events      normalized events for the whole run
 * @param {object} input.surfaces    { latest, byStep } captured surface specs
 * @param {object} input.factState   authoritative state for grounding checks
 * @param {object} input.config      surface oracle config
 */
export function evaluateExpectations({ expect, step, events, surfaces, factState, config = {} }) {
  if (!expect || Object.keys(expect).length === 0) return [];
  const checks = [];
  const since = step.startedAt ?? 0;

  if (expect.heard !== undefined && expect.heard !== false) {
    const options = expect.heard === true ? {} : expect.heard;
    const maxWer = options.maxWordErrorRate ?? 0.34;
    const transcripts = events.filter(
      (item) => item.kind === "user.transcript" && item.final !== false && item.at >= since,
    );
    const heard = transcripts.at(-1)?.text ?? null;
    if (heard === null) {
      checks.push(result("heard", false, "no transcription of the utterance ever arrived", { spoken: step.text }));
    } else {
      const wer = wordErrorRate(step.text, heard);
      checks.push(result("heard", wer <= maxWer,
        wer <= maxWer
          ? `transcribed with word error rate ${wer.toFixed(2)}`
          : `heard "${heard}" but said "${step.text}" (word error rate ${wer.toFixed(2)} > ${maxWer})`,
        { spoken: step.text, heard, wordErrorRate: Number(wer.toFixed(4)) }));
    }
  }

  if (expect.responded !== undefined && expect.responded !== false) {
    const options = expect.responded === true ? {} : expect.responded;
    const modality = options.modality ?? "any";
    const spoke = events.some((item) =>
      item.at >= since && (item.kind === "assistant.audio.start"
        || (item.kind === "assistant.text" && (modality === "any" || item.modality === modality))));
    checks.push(result("responded", spoke, spoke ? "the assistant answered" : "the assistant never answered"));
  }

  if (expect.mentions) {
    const spoken = assistantTextSince(events, since);
    for (const phrase of [].concat(expect.mentions)) {
      const found = containsPhrase(spoken, phrase);
      checks.push(result(`mentions:${phrase}`, found,
        found ? `the answer mentioned "${phrase}"` : `the answer never mentioned "${phrase}"`,
        { assistantText: spoken.slice(0, 400) }));
    }
  }

  if (expect.doesNotMention) {
    const spoken = assistantTextSince(events, since);
    for (const phrase of [].concat(expect.doesNotMention)) {
      const found = containsPhrase(spoken, phrase);
      checks.push(result(`doesNotMention:${phrase}`, !found,
        found ? `the answer mentioned "${phrase}", which it must not` : `"${phrase}" stayed out of the answer`,
        { assistantText: spoken.slice(0, 400) }));
    }
  }

  if (expect.toolCalled) {
    const calls = toolCallsSince(events, since);
    for (const wanted of [].concat(expect.toolCalled)) {
      const name = typeof wanted === "string" ? wanted : wanted.name;
      const matching = calls.filter((call) => call.name === name);
      if (matching.length === 0) {
        checks.push(result(`toolCalled:${name}`, false,
          `"${name}" was never called (called: ${calls.map((call) => call.name).join(", ") || "nothing"})`,
          { calledInstead: calls.map((call) => call.name) }));
        continue;
      }
      const wantedArgs = typeof wanted === "object" ? wanted.argumentsInclude : undefined;
      if (!wantedArgs) {
        checks.push(result(`toolCalled:${name}`, true, `"${name}" was called`, {
          arguments: parseArguments(matching[0]),
        }));
        continue;
      }
      const hit = matching.find((call) => subsetMatches(parseArguments(call), wantedArgs));
      checks.push(result(`toolCalled:${name}`, Boolean(hit),
        hit ? `"${name}" was called with the expected arguments`
          : `"${name}" was called, but never with ${JSON.stringify(wantedArgs)}`,
        { arguments: matching.map(parseArguments) }));
    }
  }

  if (expect.noToolCalled) {
    const calls = toolCallsSince(events, since);
    for (const name of [].concat(expect.noToolCalled)) {
      const called = calls.some((call) => call.name === name);
      checks.push(result(`noToolCalled:${name}`, !called,
        called ? `"${name}" was called and must not have been` : `"${name}" stayed uncalled`));
    }
  }

  if (expect.interrupted) {
    const options = expect.interrupted === true ? {} : expect.interrupted;
    const within = options.withinMs ?? 2_500;
    const stop = events.find((item) => item.kind === "assistant.audio.stop" && item.at >= since);
    const stopped = Boolean(stop) && stop.at - since <= within;
    checks.push(result("interrupted", stopped,
      stop
        ? stopped
          ? `the assistant yielded ${stop.at - since}ms after the barge-in`
          : `the assistant kept talking for ${stop.at - since}ms after the barge-in (budget ${within}ms)`
        : "the assistant never stopped speaking after the barge-in",
      { yieldMs: stop ? stop.at - since : null }));
  }

  if (expect.surface !== undefined && expect.surface !== false) {
    const options = expect.surface === true ? {} : expect.surface;
    const spec = surfaces.latest ?? null;
    if (!spec) {
      checks.push(result("surface", false, "the turn rendered no generative surface at all"));
    } else {
      const evaluation = evaluateSurface({
        spec,
        state: options.state ?? factState,
        config: { ...config, ...options },
      });
      checks.push(result("surface", evaluation.passed,
        evaluation.passed
          ? `surface is grounded and renderable (${evaluation.elementKeys.length} elements)`
          : evaluation.findings.map((item) => `${item.rule}: ${item.detail}`).join(" | "),
        { evaluation }));
      if (options.usesComponents) {
        const types = new Set(Object.values(evaluation.elementTypes));
        for (const component of [].concat(options.usesComponents)) {
          checks.push(result(`surface:uses:${component}`, types.has(component),
            types.has(component)
              ? `the surface used ${component}`
              : `the surface never used ${component} (used: ${[...types].join(", ")})`));
        }
      }
    }
  }

  return checks;
}
