/** espeak-ng: the dependable Linux/CI voice. Robotic, but it always renders. */
import { spawnSync } from "node:child_process";

const probe = (binary) => spawnSync(binary, ["--version"], { encoding: "utf8" }).status === 0;

function binaryName() {
  if (probe("espeak-ng")) return "espeak-ng";
  if (probe("espeak")) return "espeak";
  return null;
}

export const espeak = {
  name: "espeak",
  defaultVoice: "en-us",
  fallbackVoices: ["en"],
  available: () => binaryName() !== null,
  unavailableHint: "Install espeak-ng (apt install espeak-ng / brew install espeak-ng).",
  synthesize({ text, outPath, voice, options = {} }) {
    const binary = binaryName();
    if (!binary) throw new Error("espeak-ng is not installed");
    const result = spawnSync(
      binary,
      ["-v", voice, "-s", String(options.wordsPerMinute ?? 165), "-w", outPath, text],
      { encoding: "utf8" },
    );
    if (result.status !== 0) throw new Error(`${binary} exited ${result.status}: ${result.stderr}`);
  },
};
