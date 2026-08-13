/**
 * Programmatic API.
 *
 * Everything the CLI does is available here, so VoCoSo can run inside your
 * existing test runner instead of beside it:
 *
 *   import { loadConfig, loadScript, runScript } from "vocoso";
 *   const { report } = await runScript({
 *     config: await loadConfig(),
 *     script: await loadScript("vocoso/first-conversation.json"),
 *   });
 *   assert(report.passed);
 *
 * The surface oracle is also useful entirely on its own, with no browser and
 * no model - point `evaluateSurface` at a spec your app already produced.
 */
export { defineConfig, loadConfig, findConfigFile, ConfigError } from "./config/load.mjs";
export { DEFAULT_CONFIG, mergeConfig } from "./config/defaults.mjs";
export { loadScript, normalizeScript, spokenTexts, ScriptError } from "./script/parse.mjs";
export { runScript, VERSION } from "./run.mjs";
export { doctor } from "./doctor.mjs";

export { evaluateSurface, evaluateAmendment, authoritativeFacts, extractElements } from "./oracle/surface.mjs";
export { evaluateExpectations } from "./oracle/expectations.mjs";
export { checkEvidence, checkAllEvidence } from "./oracle/evidence.mjs";
export { deriveTimings, checkLatencyGates } from "./oracle/latency.mjs";
export { captureSurfaces, collectFactState, surfacesFromEvents } from "./oracle/capture.mjs";

export { normalizeFrames, framePayloads, transcriptFrom } from "./transport/normalize.mjs";
export { BUILT_IN_PRESETS, resolvePresets } from "./transport/presets.mjs";
export { createCollector } from "./transport/collect.mjs";

export { createSpeechSynthesizer, resolveProvider, BUILT_IN_TTS } from "./audio/tts.mjs";
export { measureWavFile, validateSpeechClip, parseWav } from "./audio/wav.mjs";

export { diagnose, formatDiagnosis } from "./heal/diagnose.mjs";
export { proposePatch } from "./heal/patch.mjs";
export { Recoverer } from "./heal/recover.mjs";

export { assembleReport, writeReport, summaryMarkdown, summaryHtml } from "./report/write.mjs";
export { createLogger, silentLogger } from "./util/log.mjs";
export { wordErrorRate, normalizeForCompare, containsPhrase } from "./util/text.mjs";
export { RUNTIME_SCRIPT } from "./page/inject.mjs";
