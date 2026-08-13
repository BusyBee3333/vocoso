/**
 * Minimal RIFF/WAVE reader.
 *
 * Every TTS backend this tool supports can fail *silently*: the process exits
 * 0 and writes a well-formed file containing nothing audible. macOS `say` does
 * it with premium voices from background processes; espeak does it when a
 * voice package is missing; hosted TTS does it when a request is truncated.
 * A rig that caches one of those "speaks" nothing for the rest of its life
 * while reporting success, so every clip is measured before it is trusted:
 * duration from the header, and real signal energy from the samples.
 */
import { readFileSync } from "node:fs";

const RIFF = 0x52494646; // "RIFF"
const WAVE = 0x57415645; // "WAVE"

export class WavError extends Error {}

/** Parse a WAV buffer into { sampleRate, channels, bitsPerSample, format, data }. */
export function parseWav(buffer) {
  if (buffer.length < 12) throw new WavError("file is too small to be a WAV");
  if (buffer.readUInt32BE(0) !== RIFF || buffer.readUInt32BE(8) !== WAVE) {
    throw new WavError("not a RIFF/WAVE file");
  }
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = buffer.subarray(offset + 8, Math.min(offset + 8 + size, buffer.length));
    if (id === "fmt ") {
      fmt = {
        format: body.readUInt16LE(0),
        channels: body.readUInt16LE(2),
        sampleRate: body.readUInt32LE(4),
        bitsPerSample: body.readUInt16LE(14),
      };
    } else if (id === "data") {
      data = body;
    }
    offset += 8 + size + (size % 2);
  }
  if (!fmt) throw new WavError("no fmt chunk");
  if (!data) throw new WavError("no data chunk");
  return { ...fmt, data };
}

/** Decode PCM samples to normalized floats in [-1, 1]. */
export function toFloatSamples(wav) {
  const { data, bitsPerSample, format } = wav;
  const out = [];
  if (format === 3 && bitsPerSample === 32) {
    for (let i = 0; i + 4 <= data.length; i += 4) out.push(data.readFloatLE(i));
    return out;
  }
  if (format !== 1 && format !== 0xfffe) {
    throw new WavError(`unsupported WAV format tag ${format} (want PCM or IEEE float)`);
  }
  const bytes = bitsPerSample / 8;
  const scale = 2 ** (bitsPerSample - 1);
  for (let i = 0; i + bytes <= data.length; i += bytes) {
    if (bitsPerSample === 8) out.push((data.readUInt8(i) - 128) / 128);
    else if (bitsPerSample === 16) out.push(data.readInt16LE(i) / scale);
    else if (bitsPerSample === 24) {
      const value = data.readUInt8(i) | (data.readUInt8(i + 1) << 8) | (data.readInt8(i + 2) << 16);
      out.push(value / scale);
    } else if (bitsPerSample === 32) out.push(data.readInt32LE(i) / scale);
    else throw new WavError(`unsupported bit depth ${bitsPerSample}`);
  }
  return out;
}

/**
 * Measure a clip: duration, overall RMS, and peak.
 *
 * `rms` is what separates "a full-length file of digital silence" from real
 * speech; duration alone cannot. Speech from any normal TTS lands well above
 * 0.01; true silence is exactly 0 and a near-silent artefact sits under 1e-4.
 */
export function measureWavFile(path) {
  const wav = parseWav(readFileSync(path));
  const frames = wav.data.length / (wav.channels * (wav.bitsPerSample / 8));
  const seconds = frames / wav.sampleRate;
  const samples = toFloatSamples(wav);
  let sumSquares = 0;
  let peak = 0;
  for (const sample of samples) {
    sumSquares += sample * sample;
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
  }
  const rms = samples.length ? Math.sqrt(sumSquares / samples.length) : 0;
  return {
    seconds,
    rms,
    peak,
    sampleRate: wav.sampleRate,
    channels: wav.channels,
    bitsPerSample: wav.bitsPerSample,
    sampleCount: samples.length,
  };
}

/**
 * Is this clip plausibly the given text spoken aloud?
 *
 * Fast speech runs about five words a second, so half that rate is the floor
 * below which a clip is a synthesis failure rather than a brisk reading.
 */
export function validateSpeechClip(path, text, { minRms = 0.005 } = {}) {
  const measured = measureWavFile(path);
  const words = String(text).trim().split(/\s+/).filter(Boolean).length;
  const minSeconds = Math.max(0.35, words * 0.1);
  const problems = [];
  if (measured.seconds < minSeconds) {
    problems.push(
      `clip is ${measured.seconds.toFixed(3)}s but ${words} word(s) need at least ${minSeconds.toFixed(2)}s`,
    );
  }
  if (measured.rms < minRms) {
    problems.push(`clip carries no audible signal (rms ${measured.rms.toExponential(2)} < ${minRms})`);
  }
  return { ok: problems.length === 0, problems, measured };
}
