/** Hosted OpenAI speech. Costs money per clip, so the cache matters most here. */
import { writeFileSync } from "node:fs";

export const openaiTts = {
  name: "openai",
  defaultVoice: "alloy",
  fallbackVoices: ["verse"],
  available: () => Boolean(process.env.OPENAI_API_KEY),
  unavailableHint: "Set OPENAI_API_KEY to use the hosted 'openai' TTS provider.",
  async synthesize({ text, outPath, voice, options = {} }) {
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: options.model ?? "gpt-4o-mini-tts",
        voice,
        input: text,
        // WAV keeps the browser-side decode dependency-free.
        response_format: "wav",
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
    if (!response.ok) {
      throw new Error(`openai speech responded ${response.status}: ${(await response.text()).slice(0, 400)}`);
    }
    writeFileSync(outPath, Buffer.from(await response.arrayBuffer()));
  },
};
