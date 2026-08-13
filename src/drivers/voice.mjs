/**
 * The voice driver: hold a real spoken conversation with the app, alone.
 *
 * Utterances are synthesized, injected into the page's controllable
 * microphone one at a time, and confirmed heard by the far side's own
 * transcription before the next step runs. That confirmation is what makes
 * the run self-checking rather than hopeful: the rig wrote the sentence, so
 * it knows what the transcript should say.
 */
import { join } from "node:path";

import { sleep, until } from "../util/wait.mjs";
import { Recoverer } from "../heal/recover.mjs";

const LIVE_ENOUGH_MS = 20_000;

export function createVoiceSession({ page, config, collector, observed, logger }) {
  const voice = config.voice;
  const url = new URL(config.app.path ?? "/", config.app.baseUrl).toString();

  async function statusOf() {
    if (!voice.statusSelector) return null;
    return page.locator(voice.statusSelector)
      .getAttribute(voice.statusAttribute, { timeout: 2_000 })
      .catch(() => null);
  }

  /**
   * Live means three things agree: the app's own status control, a microphone
   * the app is actually holding, and a transport that has carried something.
   * Any one alone lies - a status attribute can say "listening" over a dead
   * peer connection, and frames keep arriving for a while after the mic dies.
   */
  async function diagnoseLiveness(state) {
    const status = await statusOf();
    if (status !== null && voice.deadStatuses.includes(status)) {
      return { live: false, reason: `the session control reports "${status}"`, status };
    }
    if (status === null && voice.statusSelector) {
      return { live: false, reason: "the session control is not on the page any more", status: null };
    }
    if (state.micStreams === 0) {
      return { live: false, reason: "the app is not holding a microphone stream", status };
    }
    if (state.frameCount === 0) {
      return { live: false, reason: "the transport has never carried a frame", status };
    }
    return { live: true, reason: "live", status };
  }

  async function pressUntilLive() {
    const start = page.locator(voice.start);
    await start.waitFor({ state: "visible", timeout: 30_000 });
    const before = (await collector.drain()).frameCount;

    for (let attempt = 1; attempt <= voice.connectAttempts; attempt += 1) {
      const status = await statusOf();
      if (status === null || voice.deadStatuses.includes(status)) {
        await start.click();
        logger.step("voice", `pressed ${voice.start} (attempt ${attempt})`);
      }
      if (voice.statusSelector) {
        await until(statusOf, (value) => value !== null && !voice.deadStatuses.includes(value)
          && value !== "connecting", { timeoutMs: voice.connectTimeoutMs, pollMs: 300 });
      }
      const live = await until(
        () => collector.drain(),
        (state) => state.frameCount > before && state.micStreams > 0,
        { timeoutMs: LIVE_ENOUGH_MS, pollMs: 300 },
      );
      if (live.ok) {
        logger.pass("voice", `session is live (${live.value.frameCount} frames, ${live.value.micStreams} mic stream(s))`);
        return;
      }
      const failures = observed.httpFailures.slice(-3);
      logger.warn("voice", `attempt ${attempt} did not come up: frames=${live.value.frameCount} ` +
        `mics=${live.value.micStreams}${failures.length ? ` recent HTTP failures: ${JSON.stringify(failures)}` : ""}`);
      if (attempt === voice.connectAttempts) {
        const visible = await page.evaluate(() => document.body.innerText.slice(0, 1_500)).catch(() => "");
        throw Object.assign(new Error(
          `the voice session never came up after ${attempt} attempts. ` +
          `Last HTTP failures: ${JSON.stringify(failures)}. Page text: ${visible.slice(0, 400)}`,
        ), { code: "SESSION_NOT_LIVE", httpFailures: failures });
      }
      await sleep(3_000 * attempt);
    }
  }

  async function enterLiveMode() {
    if (!voice.enter) return;
    const toggle = page.locator(voice.enter);
    await toggle.waitFor({ state: "visible", timeout: 60_000 });
    const pressed = await toggle.getAttribute("aria-pressed").catch(() => null);
    if (pressed !== "true") {
      await toggle.click();
      logger.step("voice", `entered live mode via ${voice.enter}`);
    }
  }

  async function open() {
    // A wedged dev server answers API routes while the page hangs forever.
    // Twenty seconds of probing beats a three-minute navigation timeout with
    // no diagnosis attached.
    const probe = await page.request.get(url, { timeout: 20_000 }).catch(() => null);
    if (!probe || probe.status() >= 400) {
      throw Object.assign(new Error(
        `${url} ${probe ? `answered ${probe.status()}` : "did not answer within 20s"} - ` +
        "the app is up but this page is not usable.",
      ), { code: "PAGE_UNHEALTHY" });
    }
    logger.step("voice", `opening ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.app.readyTimeoutMs });
    if (typeof config.hooks?.beforeSession === "function") {
      await config.hooks.beforeSession({ page, config, logger });
    }
    await enterLiveMode();
    await pressUntilLive();
  }

  async function ensureLive() {
    const status = await statusOf();
    if (voice.enter && status === null) await enterLiveMode();
    await pressUntilLive();
  }

  async function close() {
    if (!voice.stop) return;
    const stop = page.locator(voice.stop);
    if (await stop.isVisible().catch(() => false)) {
      await stop.click().catch(() => {});
      logger.step("voice", "ended the session");
    }
  }

  return { open, ensureLive, close, diagnoseLiveness, statusOf, url };
}

export function createVoiceDriver({ page, config, collector, observed, logger, speech, runDir }) {
  const session = createVoiceSession({ page, config, collector, observed, logger });
  const recoverer = new Recoverer({ config, logger, page, collector, session });
  const screenshots = [];
  const utterances = [];

  async function screenshot(name) {
    const path = join(runDir, `${String(screenshots.length + 1).padStart(2, "0")}-${name}.png`);
    try {
      await page.screenshot({ path });
      screenshots.push(path);
    } catch { /* a closed page just loses its last frame */ }
    return path;
  }

  async function inject(text) {
    const clip = await speech.base64For(text);
    return { clip, timing: await page.evaluate((wav) => window.__vocosoSpeak(wav), clip.base64) };
  }

  async function speak(text) {
    const ready = await recoverer.ensureReadyToSpeak();
    if (!ready.ok) {
      throw Object.assign(new Error(`cannot speak: ${ready.reason}`), { code: "SESSION_NOT_LIVE" });
    }
    const before = await collector.drain();
    logger.step("say", `"${text}"`);

    let spoken;
    try {
      spoken = await inject(text);
    } catch (error) {
      spoken = await recoverer.retrySpeech(() => inject(text), text, error);
    }

    const record = {
      text,
      startedAt: spoken.timing.startedAt,
      endedAt: spoken.timing.endedAt,
      durationMs: spoken.timing.durationMs,
      clip: { path: spoken.clip.path, cached: spoken.clip.cached, voice: spoken.clip.voice, rms: spoken.clip.measured.rms },
      heard: null,
    };
    utterances.push(record);

    const baseline = before.counts["user.transcript"] ?? 0;
    const heard = await until(
      () => collector.drain(),
      (state) => (state.counts["user.transcript"] ?? 0) > baseline,
      { timeoutMs: config.timeouts.transcript, pollMs: 250 },
    );
    if (heard.ok) {
      record.heard = collector.events
        .filter((item) => item.kind === "user.transcript" && item.final !== false)
        .at(-1)?.text ?? null;
      logger.info("heard", `"${record.heard}"`);
    } else {
      record.notTranscribed = true;
      logger.warn("heard", `no transcription arrived within ${config.timeouts.transcript}ms`);
    }
    return record;
  }

  /**
   * Wait out the assistant's turn: it starts (audio energy or a provider
   * event), then goes quiet and stays quiet. Quiet-for-a-while rather than a
   * single stop event, because half the providers emit no stop event at all.
   */
  async function waitForTurnEnd(baseline, timeoutMs) {
    const doneBefore = baseline.counts["assistant.done"] ?? 0;
    const started = await until(
      () => collector.drain(),
      (state) => state.speaking.speaking || (state.counts["assistant.done"] ?? 0) > doneBefore,
      { timeoutMs: Math.min(timeoutMs, 45_000), pollMs: 150 },
    );
    const settled = await until(
      () => collector.drain(),
      (state) => !state.speaking.speaking
        && state.lastFrameAt > 0
        && Date.now() - state.lastFrameAt > config.timeouts.settle,
      { timeoutMs, pollMs: 250 },
    );
    return { started: started.ok, settled: settled.ok, waitedMs: started.waitedMs + settled.waitedMs };
  }

  async function runStep(step) {
    const startedAt = Date.now();
    const baseline = await collector.drain();

    switch (step.kind) {
      case "wait":
        await sleep(step.waitMs);
        break;

      case "click":
        await page.locator(step.selector).click({ timeout: 15_000 });
        break;

      case "reload":
        await recoverer.recoverPage("the script asked for a reload");
        break;

      case "assert":
        await collector.drain();
        break;

      case "bargeIn": {
        const speaking = await until(
          () => collector.drain(),
          (state) => state.speaking.speaking,
          { timeoutMs: step.maxWaitMs, pollMs: 100 },
        );
        if (!speaking.ok) {
          logger.warn("barge", "the assistant never started speaking; interrupting silence instead");
        }
        const record = await speak(step.text);
        record.bargeIn = true;
        record.assistantWasSpeaking = speaking.ok;
        await waitForTurnEnd(baseline, step.responseTimeoutMs ?? config.timeouts.response);
        break;
      }

      case "say":
      default: {
        await speak(step.text);
        if (step.waitForResponse) {
          const turn = await waitForTurnEnd(baseline, step.responseTimeoutMs ?? config.timeouts.response);
          if (!turn.started) {
            logger.warn("say", `no reply within ${step.responseTimeoutMs ?? config.timeouts.response}ms`);
            await recoverer.recoverIfTransportSilent({ sinceAt: startedAt });
          }
        }
        if (step.thenWaitMs) await sleep(step.thenWaitMs);
        break;
      }
    }

    if (step.screenshot) await screenshot(`step${step.index + 1}-${step.kind}`);
    await collector.drain();
    return { startedAt, endedAt: Date.now(), text: step.text ?? null };
  }

  return {
    session,
    recoverer,
    screenshots,
    utterances,
    screenshot,
    runStep,
    async open() {
      await session.open();
      await screenshot("session-open");
    },
    async finish() {
      // Debounced saves and background persistence land after the last word.
      await sleep(config.timeouts.settle * 2);
      await screenshot("final");
      await session.close();
      await sleep(1_500);
      await collector.drain();
    },
  };
}
