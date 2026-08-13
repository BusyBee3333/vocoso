/**
 * Raw frames -> normalized conversation events.
 *
 * Frames arrive as whatever the wire carried: one JSON object, a batch of SSE
 * `data:` lines, NDJSON, or an AI-SDK `0:"..."` prefixed line. They are split
 * into payloads here so presets only ever see one message at a time.
 */

const AI_SDK_LINE = /^([0-9a-z]+):(.*)$/s;

function tryJson(text) {
  const trimmed = text.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** Split one recorded frame into zero or more single-message payloads. */
export function framePayloads(frame) {
  const base = { at: frame.at, source: frame.source, dir: frame.dir, meta: frame.meta ?? null };
  const text = typeof frame.data === "string" ? frame.data : String(frame.data ?? "");
  if (text.startsWith("[binary") || text.startsWith("[blob")) {
    return [{ ...base, json: undefined, text, binary: true }];
  }

  const direct = tryJson(text);
  if (direct !== undefined) return [{ ...base, json: direct, text }];

  const payloads = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line === "[DONE]") continue;
    if (line.startsWith("data:")) {
      const body = line.slice(5).trim();
      if (!body || body === "[DONE]") continue;
      payloads.push({ ...base, json: tryJson(body), text: body });
      continue;
    }
    if (line.startsWith("event:") || line.startsWith("id:") || line.startsWith(":")) continue;
    const sdk = AI_SDK_LINE.exec(line);
    if (sdk && tryJson(sdk[2]) !== undefined) {
      payloads.push({ ...base, json: tryJson(sdk[2]), text: sdk[2], streamPrefix: sdk[1] });
      continue;
    }
    const json = tryJson(line);
    if (json !== undefined) payloads.push({ ...base, json, text: line });
  }
  return payloads.length ? payloads : [{ ...base, json: undefined, text }];
}

const identityOf = (item) =>
  `${item.at}|${item.kind}|${item.text ?? ""}|${item.name ?? ""}|${item.arguments ?? ""}`;

/**
 * Map frames through every preset and return a deduplicated, time-ordered
 * event list. Running all presets is deliberate: `auto` mode then works on an
 * app whose transport the operator never had to identify, and two presets
 * agreeing on the same frame collapses to one event rather than double-counting.
 */
export function normalizeFrames(frames, presets, { unmatchedLimit = 200 } = {}) {
  const events = [];
  const seen = new Set();
  const unmatched = [];
  const presetHits = {};

  for (const frame of frames) {
    for (const payload of framePayloads(frame)) {
      let matched = false;
      for (const preset of presets) {
        let produced;
        try {
          if (!preset.matches(payload)) continue;
          produced = preset.map(payload);
        } catch (error) {
          produced = { kind: "error", code: "preset_failure", message: `${preset.name}: ${error.message}` };
        }
        if (!produced) continue;
        for (const item of [].concat(produced)) {
          const record = {
            at: payload.at,
            dir: payload.dir,
            source: payload.source,
            preset: preset.name,
            ...item,
          };
          const identity = identityOf(record);
          if (seen.has(identity)) continue;
          seen.add(identity);
          events.push(record);
          matched = true;
          presetHits[preset.name] = (presetHits[preset.name] ?? 0) + 1;
        }
      }
      if (!matched && payload.dir === "in" && !payload.binary && unmatched.length < unmatchedLimit) {
        unmatched.push({ at: payload.at, source: payload.source, sample: payload.text.slice(0, 300) });
      }
    }
  }

  events.sort((left, right) => left.at - right.at);
  return { events, unmatched, presetHits };
}

/** Collapse streaming text deltas into whole utterances, in order. */
export function transcriptFrom(events) {
  const turns = [];
  let current = null;
  const flush = () => {
    if (current && (current.userText || current.assistantText || current.tools.length)) turns.push(current);
    current = null;
  };
  for (const item of events) {
    if (item.kind === "user.transcript" && item.final !== false) {
      flush();
      current = { at: item.at, userText: item.text ?? "", assistantText: "", tools: [] };
    } else if (item.kind === "assistant.text") {
      if (!current) current = { at: item.at, userText: "", assistantText: "", tools: [] };
      if (item.final === false) current.assistantText += item.text ?? "";
      else current.assistantText = [current.assistantText, item.text].filter(Boolean).join(" ").trim();
    } else if (item.kind === "tool.call") {
      if (!current) current = { at: item.at, userText: "", assistantText: "", tools: [] };
      current.tools.push({ name: item.name, arguments: item.arguments, callId: item.callId ?? null });
    } else if (item.kind === "tool.result") {
      if (current) {
        const target = current.tools.find((tool) => tool.callId && tool.callId === item.callId);
        if (target) target.result = item.result;
      }
    }
  }
  flush();
  return turns;
}
