/**
 * Timing derived from things the rig authored or observed directly.
 *
 * The two numbers that decide whether a voice product feels alive:
 *   speechEndToTranscript      - how long until the system knew what was said
 *   speechEndToAssistantAudio  - how long until the user heard anything back
 *
 * Both are measured from the moment the injected clip stopped playing, which
 * is the closest thing to "the user stopped talking" that exists.
 */

const percentile = (values, fraction) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
};

export function deriveTimings(utterances, events) {
  const perUtterance = utterances.map((utterance) => {
    const spokeEnd = utterance.endedAt ?? null;
    if (!spokeEnd) return { text: utterance.text, clipMs: utterance.durationMs ?? null };
    const transcriptAt = events.find(
      (item) => item.kind === "user.transcript" && item.final !== false && item.at >= spokeEnd - 500,
    )?.at ?? null;
    const audioAt = events.find(
      (item) => item.kind === "assistant.audio.start" && item.at >= spokeEnd,
    )?.at ?? null;
    const textAt = events.find(
      (item) => item.kind === "assistant.text" && item.at >= spokeEnd,
    )?.at ?? null;
    const doneAt = events.find(
      (item) => item.kind === "assistant.done" && item.at >= spokeEnd,
    )?.at ?? null;
    return {
      text: utterance.text,
      clipMs: utterance.durationMs ?? null,
      speechEndToTranscriptMs: transcriptAt ? transcriptAt - spokeEnd : null,
      speechEndToAssistantAudioMs: audioAt ? audioAt - spokeEnd : null,
      speechEndToAssistantTextMs: textAt ? textAt - spokeEnd : null,
      speechEndToTurnDoneMs: doneAt ? doneAt - spokeEnd : null,
    };
  });

  const summarize = (key) => {
    const values = perUtterance.map((item) => item[key]).filter((value) => typeof value === "number");
    return values.length
      ? { count: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: Math.max(...values) }
      : { count: 0, p50: null, p95: null, max: null };
  };

  return {
    perUtterance,
    summary: {
      speechEndToTranscriptMs: summarize("speechEndToTranscriptMs"),
      speechEndToAssistantAudioMs: summarize("speechEndToAssistantAudioMs"),
      speechEndToAssistantTextMs: summarize("speechEndToAssistantTextMs"),
      speechEndToTurnDoneMs: summarize("speechEndToTurnDoneMs"),
    },
  };
}

/** Apply the configured latency budgets. Each budget is `{ p50, p95, max }` in ms. */
export function checkLatencyGates(timings, budgets) {
  if (!budgets) return [];
  const checks = [];
  for (const [metric, budget] of Object.entries(budgets)) {
    const measured = timings.summary[metric];
    if (!measured || measured.count === 0) {
      checks.push({ name: `latency:${metric}`, passed: false, detail: `${metric} was never measured` });
      continue;
    }
    for (const [statistic, limit] of Object.entries(budget)) {
      const value = measured[statistic];
      if (typeof limit !== "number" || value === null) continue;
      checks.push({
        name: `latency:${metric}.${statistic}`,
        passed: value <= limit,
        detail: `${statistic} ${value}ms against a ${limit}ms budget`,
        value,
        limit,
      });
    }
  }
  return checks;
}
