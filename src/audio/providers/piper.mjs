/** Piper: offline neural TTS. Natural enough to exercise real ASR behaviour. */
import { spawnSync } from "node:child_process";

export const piper = {
  name: "piper",
  // Piper selects a voice by model path, so there is no useful text default.
  defaultVoice: "",
  fallbackVoices: [],
  available: () => spawnSync("piper", ["--help"], { encoding: "utf8" }).status === 0,
  unavailableHint:
    "Install piper (https://github.com/rhasspy/piper) and set tts.model to a downloaded .onnx voice.",
  synthesize({ text, outPath, options = {} }) {
    if (!options.model) {
      throw new Error("piper needs tts.options.model pointing at a .onnx voice file");
    }
    const result = spawnSync(
      "piper",
      ["--model", options.model, "--output_file", outPath],
      { input: text, encoding: "utf8" },
    );
    if (result.status !== 0) throw new Error(`piper exited ${result.status}: ${result.stderr}`);
  },
};
