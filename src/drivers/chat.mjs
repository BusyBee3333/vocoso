/**
 * The text-chat driver.
 *
 * Same contract as the voice driver, minus the audio: type a turn, wait for
 * the answer to finish streaming, and let the same expectations and the same
 * surface oracle judge the result. Most generative-surface bugs reproduce in
 * text far faster and far cheaper than in voice, so this is usually where a
 * regression suite should live - with the voice script proving the audio path
 * on top.
 */
import { join } from "node:path";

import { sleep, until } from "../util/wait.mjs";
import { Recoverer } from "../heal/recover.mjs";

export function createChatDriver({ page, config, collector, observed, logger, runDir }) {
  const chat = config.chat;
  const url = new URL(config.app.path ?? "/", config.app.baseUrl).toString();
  const screenshots = [];
  const utterances = [];

  async function messageCount() {
    if (!chat.assistantMessage) return 0;
    return page.locator(chat.assistantMessage).count().catch(() => 0);
  }

  const session = {
    url,
    async diagnoseLiveness() {
      const present = await page.locator(chat.input).count().catch(() => 0);
      return present > 0
        ? { live: true, reason: "the composer is on the page" }
        : { live: false, reason: "the message composer is gone from the page" };
    },
    async ensureLive() {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.app.readyTimeoutMs });
      await page.locator(chat.input).waitFor({ state: "visible", timeout: 60_000 });
    },
    async open() {
      const probe = await page.request.get(url, { timeout: 20_000 }).catch(() => null);
      if (!probe || probe.status() >= 400) {
        throw Object.assign(new Error(
          `${url} ${probe ? `answered ${probe.status()}` : "did not answer within 20s"}`,
        ), { code: "PAGE_UNHEALTHY" });
      }
      logger.step("chat", `opening ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.app.readyTimeoutMs });
      if (typeof config.hooks?.beforeSession === "function") {
        await config.hooks.beforeSession({ page, config, logger });
      }
      await page.locator(chat.input).waitFor({ state: "visible", timeout: 60_000 });
      logger.pass("chat", "the composer is ready");
    },
    async close() {},
  };

  const recoverer = new Recoverer({ config, logger, page, collector, session });

  async function screenshot(name) {
    const path = join(runDir, `${String(screenshots.length + 1).padStart(2, "0")}-${name}.png`);
    try {
      await page.screenshot({ path, fullPage: config.browser.fullPageScreenshots ?? false });
      screenshots.push(path);
    } catch { /* a closed page just loses its last frame */ }
    return path;
  }

  async function send(text) {
    const ready = await recoverer.ensureReadyToSpeak();
    if (!ready.ok) throw Object.assign(new Error(`cannot send: ${ready.reason}`), { code: "CHAT_NOT_READY" });
    logger.step("say", `"${text}"`);
    const input = page.locator(chat.input);
    await input.click({ timeout: 15_000 });
    await input.fill("");
    await input.type(text, { delay: config.chat.typeDelayMs ?? 0 });
    const record = { text, startedAt: Date.now(), heard: text };
    utterances.push(record);
    if (chat.send) await page.locator(chat.send).click({ timeout: 15_000 });
    else await input.press("Enter");
    record.endedAt = Date.now();
    return record;
  }

  /**
   * "Finished streaming" without a vendor-specific done event: either the app
   * marks it (chat.doneWhen), or a new assistant message has appeared and the
   * transport has been quiet long enough to be finished rather than slow.
   */
  async function waitForAnswer(baselineMessages, baseline, timeoutMs) {
    if (chat.doneWhen) {
      const done = await until(
        () => page.locator(chat.doneWhen).count().catch(() => 0),
        (count) => count > 0,
        { timeoutMs, pollMs: 250 },
      );
      return { started: done.ok, settled: done.ok };
    }
    const doneBefore = baseline.counts["assistant.done"] ?? 0;
    const appeared = await until(
      async () => ({ messages: await messageCount(), state: await collector.drain() }),
      ({ messages, state }) => messages > baselineMessages
        || (state.counts["assistant.text"] ?? 0) > (baseline.counts["assistant.text"] ?? 0)
        || (state.counts["assistant.done"] ?? 0) > doneBefore,
      { timeoutMs, pollMs: 250 },
    );
    const settled = await until(
      () => collector.drain(),
      (state) => (state.counts["assistant.done"] ?? 0) > doneBefore
        || (state.lastFrameAt > 0 && Date.now() - state.lastFrameAt > chat.quietMs),
      { timeoutMs, pollMs: 250 },
    );
    return { started: appeared.ok, settled: settled.ok };
  }

  async function runStep(step) {
    const startedAt = Date.now();
    const baseline = await collector.drain();
    const baselineMessages = await messageCount();

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
      case "bargeIn":
        // Text has no barge-in; sending during a stream is the closest analogue
        // and is a real product behaviour worth exercising.
        await send(step.text);
        await waitForAnswer(baselineMessages, baseline, step.responseTimeoutMs ?? chat.responseTimeoutMs);
        break;
      case "say":
      default: {
        await send(step.text);
        if (step.waitForResponse) {
          const answer = await waitForAnswer(
            baselineMessages, baseline, step.responseTimeoutMs ?? chat.responseTimeoutMs,
          );
          if (!answer.started) logger.warn("say", "no answer arrived in time");
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
      await screenshot("chat-open");
    },
    async finish() {
      await sleep(chat.quietMs);
      await screenshot("final");
      await collector.drain();
    },
  };
}
