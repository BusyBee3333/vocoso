/**
 * Drains the page-side frame log into Node and keeps a normalized view of the
 * conversation so far. Everything a step needs to make a decision - was that
 * heard, is the assistant speaking, did a tool fire - is answered from here.
 */
import { resolvePresets } from "./presets.mjs";
import { normalizeFrames } from "./normalize.mjs";

export function createCollector(page, { preset = "auto", speakingThreshold = 0.01 } = {}) {
  const presets = resolvePresets(preset);
  const frames = [];
  let cursor = 0;
  let snapshot = {
    micStreams: 0, userMediaCalls: 0, micBusy: false,
    outputLevel: 0, meterCount: 0, dropped: 0, errors: [],
  };
  let normalized = { events: [], unmatched: [], presetHits: {} };
  const outputLevelHistory = [];

  async function drain() {
    const drained = await page
      .evaluate((from) => (window.__vocosoDrain ? window.__vocosoDrain(from) : null), cursor)
      .catch(() => null);
    if (!drained) return state();
    cursor = drained.cursor;
    frames.push(...drained.frames);
    snapshot = {
      micStreams: drained.micStreams,
      userMediaCalls: drained.userMediaCalls,
      micBusy: drained.micBusy,
      outputLevel: drained.outputLevel,
      meterCount: drained.meterCount,
      dropped: drained.dropped,
      errors: drained.errors,
    };
    outputLevelHistory.push({ at: Date.now(), level: drained.outputLevel });
    if (outputLevelHistory.length > 5000) outputLevelHistory.shift();
    if (drained.frames.length) normalized = normalizeFrames(frames, presets);
    return state();
  }

  function counts() {
    const tally = {};
    for (const item of normalized.events) tally[item.kind] = (tally[item.kind] ?? 0) + 1;
    return tally;
  }

  /**
   * "Is the assistant speaking?" answered two ways, on purpose. A provider
   * event is precise when it exists; measured loudness works for providers
   * VoCoSo has never seen, and catches the case the events claim speech that
   * never reached a speaker.
   */
  function assistantSpeaking() {
    const byMeter = snapshot.outputLevel > speakingThreshold;
    let byEvent = false;
    for (const item of normalized.events) {
      if (item.kind === "assistant.audio.start") byEvent = true;
      else if (item.kind === "assistant.audio.stop") byEvent = false;
    }
    return { speaking: byMeter || byEvent, byMeter, byEvent, level: snapshot.outputLevel };
  }

  function state() {
    return {
      frameCount: frames.length,
      eventCount: normalized.events.length,
      counts: counts(),
      lastEventAt: normalized.events.at(-1)?.at ?? 0,
      lastFrameAt: frames.at(-1)?.at ?? 0,
      speaking: assistantSpeaking(),
      ...snapshot,
    };
  }

  return {
    drain,
    state,
    get frames() { return frames; },
    get events() { return normalized.events; },
    get unmatched() { return normalized.unmatched; },
    get presetHits() { return normalized.presetHits; },
    get outputLevelHistory() { return outputLevelHistory; },
    presetNames: presets.map((item) => item.name),
  };
}
