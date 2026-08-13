/**
 * Text to a validated speech clip, cached by content.
 *
 * Two rules earn their place here, both learned from silent failures:
 *   1. Never trust the exit code. Measure the clip and reject silence.
 *   2. Never cache what was not measured, and evict a cache entry that stops
 *      measuring well - one poisoned file otherwise makes every later run
 *      "speak" nothing while reporting success.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { validateSpeechClip } from "./wav.mjs";
import { say } from "./providers/say.mjs";
import { espeak } from "./providers/espeak.mjs";
import { piper } from "./providers/piper.mjs";
import { openaiTts } from "./providers/openai-tts.mjs";
import { prerecorded } from "./providers/prerecorded.mjs";

export const BUILT_IN_TTS = { say, espeak, piper, openai: openaiTts, prerecorded };

/** Pick a provider that can actually run here, so config never has to be OS-specific. */
export function resolveProvider(config = {}) {
  if (typeof config.provider === "object" && config.provider) return config.provider;
  if (config.provider && config.provider !== "auto") {
    const provider = BUILT_IN_TTS[config.provider];
    if (!provider) {
      throw new Error(
        `unknown tts.provider "${config.provider}" (built in: ${Object.keys(BUILT_IN_TTS).join(", ")})`,
      );
    }
    if (!provider.available(config.options ?? {})) throw new Error(provider.unavailableHint);
    return provider;
  }
  const order = [prerecorded, say, piper, espeak, openaiTts];
  const found = order.find((provider) => provider.available(config.options ?? {}));
  if (found) return found;
  throw new Error(
    "no usable TTS provider found. Install espeak-ng or piper, run on macOS, " +
    "set OPENAI_API_KEY, or point tts.options.dir at recorded clips.",
  );
}

export function createSpeechSynthesizer(config = {}, cacheDir) {
  const provider = resolveProvider(config);
  const voices = [
    config.voice ?? provider.defaultVoice,
    ...(config.fallbackVoices ?? provider.fallbackVoices ?? []),
  ].filter((voice) => voice !== undefined);
  mkdirSync(cacheDir, { recursive: true });

  /** @returns {Promise<{path: string, cached: boolean, measured: object, voice: string}>} */
  async function speechFor(text) {
    const key = createHash("sha1")
      .update(`${provider.name}|${voices[0] ?? ""}|${JSON.stringify(config.options ?? {})}|${text}`)
      .digest("hex")
      .slice(0, 20);
    const path = join(cacheDir, `${key}.wav`);

    if (existsSync(path)) {
      const check = validateSpeechClip(path, text, { minRms: config.minRms });
      if (check.ok) return { path, cached: true, measured: check.measured, voice: voices[0] ?? "" };
      // A cache entry that no longer measures well is poison, not a shortcut.
      try { unlinkSync(path); } catch { /* it is going to be rewritten anyway */ }
    }

    const attempts = [];
    for (const voice of voices.length ? voices : [""]) {
      // The scratch file keeps the .wav extension: several backends (macOS
      // `say` among them) pick the container from the extension and refuse to
      // write anything they do not recognise.
      const scratch = join(cacheDir, `${key}.part.wav`);
      try {
        await provider.synthesize({ text, outPath: scratch, voice, options: config.options ?? {} });
        const check = validateSpeechClip(scratch, text, { minRms: config.minRms });
        if (check.ok) {
          renameSync(scratch, path);
          return { path, cached: false, measured: check.measured, voice };
        }
        attempts.push(`${provider.name}/${voice || "default"}: ${check.problems.join("; ")}`);
      } catch (error) {
        attempts.push(`${provider.name}/${voice || "default"}: ${error.message}`);
      } finally {
        try { if (existsSync(scratch)) unlinkSync(scratch); } catch { /* nothing worth keeping */ }
      }
    }
    const error = new Error(
      `TTS could not render "${text}".\n  ${attempts.join("\n  ")}`,
    );
    error.code = "TTS_SILENT";
    error.attempts = attempts;
    throw error;
  }

  return {
    provider: provider.name,
    voices,
    speechFor,
    async base64For(text) {
      const clip = await speechFor(text);
      return { ...clip, base64: readFileSync(clip.path).toString("base64") };
    },
  };
}
