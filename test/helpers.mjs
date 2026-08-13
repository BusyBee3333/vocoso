import { writeFileSync } from "node:fs";

/** Build a 16-bit mono WAV buffer from a sample generator. */
export function makeWav({ seconds = 1, sampleRate = 24_000, amplitude = 0.3 } = {}) {
  const frames = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(frames * 2);
  for (let index = 0; index < frames; index += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * amplitude * 32767);
    data.writeInt16LE(value, index * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export function writeWav(path, options) {
  writeFileSync(path, makeWav(options));
  return path;
}

/** A recorded frame as the injected tap would produce it. */
export const frame = (data, { source = "webrtc", dir = "in", at = 1_000 } = {}) => ({
  at, source, dir, data: typeof data === "string" ? data : JSON.stringify(data), meta: null,
});
