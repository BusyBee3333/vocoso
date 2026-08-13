/** macOS `say`. Present on every Mac; no install, no network, no cost. */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const BINARY = "/usr/bin/say";

/**
 * Always name a voice explicitly. The system default is often a premium
 * neural voice that intermittently synthesizes nothing when driven from a
 * background process - `say` still exits 0 and writes a header-only file.
 * The classic voices render reliably everywhere, so they are the defaults
 * and the fallback chain.
 */
export const say = {
  name: "say",
  defaultVoice: "Samantha",
  fallbackVoices: ["Alex", "Daniel"],
  available: () => process.platform === "darwin" && existsSync(BINARY),
  unavailableHint: "`say` is macOS-only. Use tts.provider 'espeak' or 'piper' on Linux, or 'openai'.",
  synthesize({ text, outPath, voice }) {
    const result = spawnSync(
      BINARY,
      ["-v", voice, "-o", outPath, "--data-format=LEI16@24000", text],
      { encoding: "utf8" },
    );
    if (result.error) throw new Error(`say could not start: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`say (voice ${voice}) exited ${result.status}: ${result.stderr}`);
  },
};
