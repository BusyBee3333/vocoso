/**
 * `vocoso doctor` - prove the rig itself works before blaming the product.
 *
 * The audio injection path is tested against nothing but an AnalyserNode: a
 * clip is synthesized, played into the fake microphone, and read back out of
 * the stream the app *would* have received. If silence goes in, that is a TTS
 * or browser problem and no amount of staring at the application will show it.
 *
 * This costs nothing, needs no API key, and takes about five seconds.
 */
import { createServer } from "node:http";

import { createSpeechSynthesizer, resolveProvider } from "./audio/tts.mjs";
import { openBrowser } from "./app/browser.mjs";
import { join } from "node:path";

const PROBE_TEXT = "Testing, one two three. The rig can hear itself.";

async function localPage() {
  const server = createServer((_, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>vocoso doctor</title><body>vocoso doctor</body>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

export async function doctor(config, logger) {
  const results = [];
  const record = (name, passed, detail) => {
    results.push({ name, passed, detail });
    logger[passed ? "pass" : "fail"]("doctor", `${name}: ${detail}`);
    return passed;
  };

  record("node", true, `${process.version} on ${process.platform}/${process.arch}`);

  let speech = null;
  try {
    const provider = resolveProvider(config.tts);
    speech = createSpeechSynthesizer(config.tts, join(config.cacheDir, "tts"));
    record("tts.provider", true, `${provider.name} (voices: ${speech.voices.join(", ") || "default"})`);
  } catch (error) {
    record("tts.provider", false, error.message);
    return { passed: false, results };
  }

  let clip;
  try {
    clip = await speech.speechFor(PROBE_TEXT);
    record("tts.render", true,
      `${clip.measured.seconds.toFixed(2)}s, rms ${clip.measured.rms.toFixed(4)}, ` +
      `${clip.measured.sampleRate}Hz${clip.cached ? " (cached)" : ""}`);
  } catch (error) {
    record("tts.render", false, error.message);
    return { passed: false, results };
  }

  const { server, url } = await localPage();
  let browser = null;
  try {
    // The doctor drives a throwaway localhost page, which is a secure context
    // (about:blank is not, and getUserMedia refuses there).
    browser = await openBrowser({ ...config, app: { ...config.app, baseUrl: url } }, logger);
    record("browser", true, `${config.browser.engine ?? "chromium"} launched`);
    await browser.context.grantPermissions(["microphone"], { origin: url }).catch(() => {});
    await browser.page.goto(url);

    const measurement = await browser.page.evaluate(async (base64Wav) => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const context = new AudioContext();
      await context.resume();
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      context.createMediaStreamSource(stream).connect(analyser);
      const data = new Float32Array(analyser.fftSize);
      const rms = () => {
        analyser.getFloatTimeDomainData(data);
        let sum = 0;
        for (let index = 0; index < data.length; index += 1) sum += data[index] * data[index];
        return Math.sqrt(sum / data.length);
      };
      // Peak over a window, not a single reading: speech has gaps, and a
      // one-shot sample lands in one about a third of the time.
      const peakOver = async (ms) => {
        let peak = 0;
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          peak = Math.max(peak, rms());
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        return peak;
      };
      const silence = await peakOver(400);
      const speaking = window.__vocosoSpeak(base64Wav);
      const loud = await peakOver(1_800);
      await speaking;
      return { silence, loud, micStreams: window.__vocosoMicStreams(), calls: window.__vocoso.userMediaCalls };
    }, (await speech.base64For(PROBE_TEXT)).base64);

    record("mic.override", measurement.calls > 0,
      `the page requested a microphone ${measurement.calls} time(s), ${measurement.micStreams} stream(s) live`);
    record("mic.silence", measurement.silence < 0.001,
      `idle stream peaks at ${measurement.silence.toExponential(2)} - a live microphone that is quiet, not a dead track`);
    record("mic.injection", measurement.loud > 0.005,
      `injected speech peaks at ${measurement.loud.toFixed(4)} where the app reads the stream`);
  } catch (error) {
    record("browser", false, error.message);
  } finally {
    try { if (browser) await browser.browser.close(); } catch { /* already closed */ }
    server.close();
  }

  const passed = results.every((item) => item.passed);
  logger[passed ? "pass" : "fail"]("doctor", passed
    ? "the rig can speak and hear itself - any failure from here is the application's"
    : "the rig itself is not healthy; fix the failures above before reading any run report");
  return { passed, results };
}
