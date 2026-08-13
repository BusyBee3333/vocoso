/**
 * In-run recovery: keep the conversation alive through the breakages that are
 * the rig's problem, not the product's.
 *
 * The distinction matters more than it sounds. A dev server hot-reloading
 * mid-run tears the microphone down; a page that navigates loses the injected
 * tap; a transport reconnects and the first utterance lands in the gap. None
 * of those are defects in the thing under test, and a rig that reports them as
 * failures trains its owner to ignore it. So they are repaired, counted, and
 * printed - visible enough that a *pattern* of recoveries is itself a finding,
 * quiet enough that one does not fail the run.
 *
 * Every repair is recorded with what was observed, what was done, and whether
 * it worked, so `recoveries[]` in the report reads as a maintenance log.
 */
import { sleep, until } from "../util/wait.mjs";

export class Recoverer {
  constructor({ config, logger, page, collector, session }) {
    this.config = config;
    this.logger = logger;
    this.page = page;
    this.collector = collector;
    this.session = session; // { ensureLive(reason) } supplied by the driver
    this.records = [];
    this.limit = config.heal?.recover?.maxPerRun ?? 6;
    this.enabled = config.heal?.recover?.enabled !== false;
  }

  get count() { return this.records.length; }

  get exhausted() { return this.count >= this.limit; }

  record(strategy, reason, outcome, detail) {
    const entry = { at: Date.now(), strategy, reason, outcome, detail: detail ?? null };
    this.records.push(entry);
    const line = `${strategy}: ${reason} -> ${outcome}`;
    if (outcome === "repaired") this.logger.heal("recover", line);
    else this.logger.warn("recover", line);
    return entry;
  }

  /**
   * Before every utterance: is there still a live session to speak into?
   * Cheap enough to run unconditionally, and it converts the most common
   * mid-run breakage from a three-minute timeout into a two-second repair.
   */
  async ensureReadyToSpeak() {
    if (!this.enabled) return { ok: true, repaired: false };
    const state = await this.collector.drain();
    const diagnosis = await this.session.diagnoseLiveness(state);
    if (diagnosis.live) return { ok: true, repaired: false };
    if (this.exhausted) {
      this.record("session-restore", diagnosis.reason, "gave-up",
        `already recovered ${this.count} times this run (heal.recover.maxPerRun)`);
      return { ok: false, repaired: false, reason: diagnosis.reason };
    }
    try {
      await this.session.ensureLive(diagnosis.reason);
      this.record("session-restore", diagnosis.reason, "repaired");
      return { ok: true, repaired: true };
    } catch (error) {
      this.record("session-restore", diagnosis.reason, "failed", String(error.message ?? error).slice(0, 400));
      return { ok: false, repaired: false, reason: diagnosis.reason, error };
    }
  }

  /**
   * The microphone can disappear between the liveness check and the clip -
   * a teardown race no amount of pre-checking closes. One replay is enough;
   * a second failure is a real defect worth reporting.
   */
  async retrySpeech(speak, text, error) {
    if (!this.enabled || this.exhausted) throw error;
    if (!/no live microphone stream|Target closed|Execution context was destroyed/i.test(String(error?.message ?? error))) {
      throw error;
    }
    this.record("speech-replay", `mic vanished mid-utterance ("${text.slice(0, 40)}")`, "retrying");
    await this.session.ensureLive("mic vanished mid-utterance");
    const outcome = await speak();
    this.record("speech-replay", `replayed "${text.slice(0, 40)}"`, "repaired");
    return outcome;
  }

  /**
   * The page went away (navigation, crash, hot reload of the shell). The tap
   * is an init script, so a reload restores it; the session then has to be
   * re-entered from scratch.
   */
  async recoverPage(reason) {
    if (!this.enabled || this.exhausted) return false;
    this.record("page-reload", reason, "retrying");
    try {
      await this.page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      await this.session.ensureLive("page reloaded");
      this.record("page-reload", reason, "repaired");
      return true;
    } catch (error) {
      this.record("page-reload", reason, "failed", String(error.message ?? error).slice(0, 400));
      return false;
    }
  }

  /**
   * A 429 is the one API failure worth waiting out rather than reporting:
   * the request is correct and the answer is "later".
   */
  async backOffIfRateLimited(observed) {
    const recent = observed.httpFailures.filter(
      (failure) => failure.status === 429 && Date.now() - failure.at < 30_000,
    );
    if (recent.length === 0 || !this.enabled || this.exhausted) return false;
    const waitMs = Math.min(30_000, 4_000 * recent.length);
    this.record("rate-limit-backoff", `${recent.length} recent 429 response(s)`, "retrying", `waiting ${waitMs}ms`);
    await sleep(waitMs);
    this.record("rate-limit-backoff", `waited ${waitMs}ms`, "repaired");
    return true;
  }

  /**
   * Silence where a reply should be. Distinguishing "the transport died" from
   * "the model is slow" is the whole game: only the first is repairable, and
   * repairing the second would hide a real latency regression.
   */
  async recoverIfTransportSilent({ sinceAt, quietMs = 20_000 }) {
    if (!this.enabled || this.exhausted) return false;
    const state = await this.collector.drain();
    const lastActivity = Math.max(state.lastFrameAt, state.lastEventAt);
    if (lastActivity > sinceAt) return false;
    if (Date.now() - sinceAt < quietMs) return false;
    const diagnosis = await this.session.diagnoseLiveness(state);
    if (diagnosis.live) {
      // Transport is up and simply has nothing to say. That is a product
      // observation, not something to repair.
      this.record("transport-silence", `no frames for ${quietMs}ms but the session is live`, "not-a-rig-fault");
      return false;
    }
    return (await this.ensureReadyToSpeak()).repaired;
  }

  /** Wait for the page to be usable again after any repair. */
  async settle(ms = 750) {
    await sleep(ms);
    await this.collector.drain();
  }

  /** Have the last few utterances all needed repair? That is its own finding. */
  get flapping() {
    const recent = this.records.filter((entry) => Date.now() - entry.at < 120_000);
    return recent.filter((entry) => entry.outcome === "repaired").length >= 3;
  }
}

/** Wait for a selector's attribute to leave a set of values. */
export async function waitForStatusChange(page, selector, attribute, notIn, timeoutMs) {
  return until(
    () => page.locator(selector).getAttribute(attribute, { timeout: 2_000 }).catch(() => null),
    (value) => value !== null && !notIn.includes(value),
    { timeoutMs, pollMs: 250 },
  );
}
