/**
 * One conversation, end to end.
 *
 * Order matters here. Clips are synthesized before the browser opens, so a
 * broken TTS install costs two seconds instead of a browser launch and a model
 * session. The app is probed before it is navigated, so "your server is down"
 * never arrives disguised as "the selector was not found". Evidence is read
 * after the conversation ends rather than during it, because the writes that
 * matter land after the last word.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { createSpeechSynthesizer } from "./audio/tts.mjs";
import { startOrAttachApp } from "./app/server.mjs";
import { openBrowser, observePage } from "./app/browser.mjs";
import { createCollector } from "./transport/collect.mjs";
import { createVoiceDriver } from "./drivers/voice.mjs";
import { createChatDriver } from "./drivers/chat.mjs";
import { spokenTexts } from "./script/parse.mjs";
import { evaluateExpectations } from "./oracle/expectations.mjs";
import { captureSurfaces, collectFactState } from "./oracle/capture.mjs";
import { checkAllEvidence } from "./oracle/evidence.mjs";
import { checkLatencyGates, deriveTimings } from "./oracle/latency.mjs";
import { diagnose } from "./heal/diagnose.mjs";
import { proposePatch } from "./heal/patch.mjs";
import { assembleReport, writeReport } from "./report/write.mjs";
import { createLogger } from "./util/log.mjs";
import { mergeConfig } from "./config/defaults.mjs";

export const VERSION = "0.1.0";

const STAGES = [
  "appReady", "pageOpened", "sessionLive", "utteranceHeard",
  "assistantResponded", "expectationsMet", "evidenceSatisfied",
];

const timestampSlug = (date) => date.toISOString().replace(/[:.]/g, "-").slice(0, 19);

export async function runScript({ config: baseConfig, script, logger = createLogger(), heal = false }) {
  const config = mergeConfig(baseConfig, script.config ?? {});
  const startedAt = Date.now();
  const runDir = join(config.reportDir, `${script.name}-${timestampSlug(new Date(startedAt))}`);
  mkdirSync(runDir, { recursive: true });
  logger.info("run", `${script.name} (${config.mode}) -> ${runDir}`);

  const verification = {
    passed: false,
    stages: Object.fromEntries(STAGES.map((stage) => [stage, false])),
    blockedAt: null,
    blocked: null,
  };
  const observed = {
    console: [], pageErrors: [], httpFailures: [], networkFailures: [], capturedResponses: [],
  };

  let app = null;
  let browser = null;
  let collector = null;
  let driver = null;
  let speech = null;
  let ttsSummary = null;
  const checks = [];
  let evidence = [];
  let surfaces = { versions: [], latest: null };

  const cleanup = async () => {
    try { if (browser) await browser.browser.close(); } catch { /* already closed */ }
    try { if (app && !config.keepApp) await app.stop(); } catch { /* already stopped */ }
  };

  try {
    // ---- speech first: a silent TTS install is cheap to find and expensive
    // to discover halfway through a paid session.
    if (config.mode === "voice") {
      speech = createSpeechSynthesizer(config.tts, join(config.cacheDir, "tts"));
      const texts = [...new Set(spokenTexts(script))];
      logger.step("tts", `rendering ${texts.length} utterance(s) with ${speech.provider}`);
      let cached = 0;
      for (const text of texts) {
        const clip = await speech.speechFor(text);
        if (clip.cached) cached += 1;
      }
      ttsSummary = { provider: speech.provider, voices: speech.voices, clips: texts.length, cached };
      logger.pass("tts", `${texts.length} clip(s) ready (${cached} from cache)`);
    }

    app = await startOrAttachApp(config, logger, runDir);
    verification.stages.appReady = true;

    browser = await openBrowser(config, logger);
    observePage(browser.page, config, observed);
    collector = createCollector(browser.page, config.transport);

    driver = config.mode === "voice"
      ? createVoiceDriver({ page: browser.page, config, collector, observed, logger, speech, runDir })
      : createChatDriver({ page: browser.page, config, collector, observed, logger, runDir });

    await driver.open();
    verification.stages.pageOpened = true;
    verification.stages.sessionLive = true;

    // ---- the conversation -------------------------------------------------
    for (const step of script.steps) {
      if (step.skip) {
        logger.info("step", `${step.index + 1}/${script.steps.length} skipped`);
        continue;
      }
      logger.info("step", `${step.index + 1}/${script.steps.length} ${step.kind}${step.note ? ` - ${step.note}` : ""}`);
      const outcome = await driver.runStep(step);

      surfaces = await captureSurfaces({ page: browser.page, config, events: collector.events, observed });
      const factState = collectFactState({ config, events: collector.events, evidence });
      const stepChecks = evaluateExpectations({
        expect: step.expect,
        step: { ...outcome, text: step.text ?? outcome.text },
        events: collector.events,
        surfaces,
        factState,
        config: config.surfaces,
      });
      for (const check of stepChecks) {
        checks.push({ ...check, step: step.index + 1 });
        logger[check.passed ? "pass" : "fail"]("check",
          `${check.passed ? "PASS" : "FAIL"}  step ${step.index + 1} ${check.name}: ${check.detail}`);
      }
      if (typeof config.hooks?.afterStep === "function") {
        await config.hooks.afterStep({ step, outcome, checks: stepChecks, page: browser.page, config });
      }
    }

    await driver.finish();

    const finalState = await collector.drain();
    verification.stages.utteranceHeard = (finalState.counts["user.transcript"] ?? 0) > 0
      || config.mode === "chat";
    verification.stages.assistantResponded =
      (finalState.counts["assistant.text"] ?? 0) > 0 || (finalState.counts["assistant.audio.start"] ?? 0) > 0;

    // ---- after the fact ---------------------------------------------------
    surfaces = await captureSurfaces({ page: browser.page, config, events: collector.events, observed });
    evidence = await checkAllEvidence(config.evidence, {
      baseUrl: config.app.baseUrl,
      cwd: config.rootDir,
      headers: config.app.auth?.headers,
      startedAt,
      events: collector.events,
      config,
    });
    for (const item of evidence) {
      checks.push({ name: `evidence:${item.name}`, passed: item.passed, detail: item.detail ?? "satisfied" });
      logger[item.passed ? "pass" : "fail"]("evidence",
        `${item.passed ? "PASS" : "FAIL"}  ${item.name}: ${item.detail ?? "satisfied"}`);
    }

    const timings = deriveTimings(driver.utterances, collector.events);
    for (const gate of checkLatencyGates(timings, config.gates.latency)) {
      checks.push(gate);
      logger[gate.passed ? "pass" : "fail"]("latency",
        `${gate.passed ? "PASS" : "FAIL"}  ${gate.name}: ${gate.detail}`);
    }

    if (config.gates.maxUnmatchedFrames !== null && collector.unmatched.length > config.gates.maxUnmatchedFrames) {
      checks.push({
        name: "transport:unmatched",
        passed: false,
        detail: `${collector.unmatched.length} frames were not understood by any preset ` +
          `(gates.maxUnmatchedFrames is ${config.gates.maxUnmatchedFrames})`,
      });
    }

    verification.stages.evidenceSatisfied = evidence.every((item) => item.passed);
    verification.stages.expectationsMet = config.gates.requireAllExpectations
      ? checks.every((check) => check.passed)
      : true;
  } catch (error) {
    verification.blockedAt = STAGES.find((stage) => !verification.stages[stage]) ?? "unknown";
    verification.blocked = {
      code: error?.code ?? null,
      message: String(error?.message ?? error).slice(0, 4_000),
      stack: String(error?.stack ?? "").slice(0, 4_000),
      logPath: error?.logPath ?? null,
    };
    logger.fail("run", `blocked at ${verification.blockedAt}: ${verification.blocked.message.split("\n")[0]}`);
    if (browser?.page) {
      await browser.page.screenshot({ path: join(runDir, "blocked.png") }).catch(() => {});
    }
  }

  verification.passed = Object.values(verification.stages).every(Boolean) && !verification.blocked;

  const report = assembleReport({
    version: VERSION, config, script, startedAt, runDir, mode: config.mode,
    collector, observed, driver, checks, evidence, surfaces, verification,
    recoveries: driver?.recoverer?.records ?? [],
    ttsSummary, logger,
  });
  const findings = diagnose(report);
  const reportPath = writeReport(runDir, report, findings);

  await cleanup();

  let healing = null;
  if (heal && !verification.passed && config.heal?.patch?.enabled) {
    healing = await proposePatch({
      findings,
      run: report,
      config,
      logger,
      verify: config.heal.patch.apply
        ? async () => {
            const rerun = await runScript({ config: baseConfig, script, logger, heal: false });
            return { passed: rerun.report.passed, reportPath: rerun.reportPath };
          }
        : null,
    }).catch((error) => {
      logger.fail("heal", String(error.message ?? error));
      return { attempted: false, error: String(error.message ?? error) };
    });
  }

  if (typeof config.hooks?.afterRun === "function") {
    await config.hooks.afterRun({ report, findings, healing, config });
  }

  return { report, findings, healing, reportPath, runDir, logger };
}
