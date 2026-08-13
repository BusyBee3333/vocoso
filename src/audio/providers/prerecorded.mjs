/**
 * Play human-recorded clips instead of synthesizing.
 *
 * The most faithful input a rig can offer: real voices, real room noise, real
 * accents. Each utterance maps to `<dir>/<slug>.wav`; the slug comes from the
 * script text, so recordings can be dropped in over time and anything missing
 * falls back to the configured synthesis provider.
 */
import { existsSync, copyFileSync, readdirSync } from "node:fs";
import { join, parse } from "node:path";

export const slugify = (text) =>
  String(text)
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

export const prerecorded = {
  name: "prerecorded",
  defaultVoice: "",
  fallbackVoices: [],
  available: (options = {}) => Boolean(options.dir) && existsSync(options.dir),
  unavailableHint: "Set tts.options.dir to a directory of .wav clips.",
  synthesize({ text, outPath, options = {} }) {
    const direct = join(options.dir, `${slugify(text)}.wav`);
    if (existsSync(direct)) {
      copyFileSync(direct, outPath);
      return;
    }
    const available = existsSync(options.dir)
      ? readdirSync(options.dir).filter((file) => parse(file).ext === ".wav").map((file) => parse(file).name)
      : [];
    throw new Error(
      `no recording for "${text}" (looked for ${slugify(text)}.wav). ` +
      `Available: ${available.slice(0, 12).join(", ") || "none"}`,
    );
  },
};
