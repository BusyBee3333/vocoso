/**
 * The command line. Five verbs:
 *
 *   run     hold the conversation and judge it
 *   doctor  prove the rig works, with no app and no API key
 *   check   run the surface oracle over a saved spec, offline
 *   explain re-print the diagnosis from any past report
 *   init    write a starter config and script
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { loadConfig } from "./config/load.mjs";
import { loadScript } from "./script/parse.mjs";
import { runScript, VERSION } from "./run.mjs";
import { doctor } from "./doctor.mjs";
import { evaluateSurface } from "./oracle/surface.mjs";
import { diagnose, formatDiagnosis } from "./heal/diagnose.mjs";
import { createLogger } from "./util/log.mjs";
import { STARTER_CONFIG, STARTER_SCRIPT } from "./templates.mjs";

const USAGE = `vocoso ${VERSION} - self-driving tests for voice and chat AI

  vocoso run <script...> [options]   hold the conversations and judge them
  vocoso doctor                      prove the rig can speak and hear itself
  vocoso check <spec.json> [--state s.json]  run the surface oracle offline
  vocoso explain <report.json>       re-print the diagnosis for a past run
  vocoso init                        write a starter config and script

Options
  -c, --config <path>   config file (default: nearest vocoso.config.mjs)
      --mode <m>        voice | chat, overriding the config
      --headed          watch the browser
      --base-url <url>  app under test
      --preset <name>   transport preset (repeatable; default auto)
      --heal            on failure, ask a model to propose a patch
      --json            print the report as JSON on stdout
  -v, --verbose         debug logging
  -q, --quiet           only print failures
  -h, --help            this text
`;

function parseArgs(argv) {
  const options = { positional: [], presets: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "-c": case "--config": options.configPath = argv[++index]; break;
      case "--mode": options.mode = argv[++index]; break;
      case "--base-url": options.baseUrl = argv[++index]; break;
      case "--preset": options.presets.push(argv[++index]); break;
      case "--state": options.statePath = argv[++index]; break;
      case "--headed": options.headed = true; break;
      case "--heal": options.heal = true; break;
      case "--json": options.json = true; break;
      case "-v": case "--verbose": options.verbose = true; break;
      case "-q": case "--quiet": options.quiet = true; break;
      case "-h": case "--help": options.help = true; break;
      default:
        if (argument.startsWith("-")) throw new Error(`unknown option: ${argument}`);
        options.positional.push(argument);
    }
  }
  return options;
}

function overridesFrom(options) {
  const overrides = {};
  if (options.mode) overrides.mode = options.mode;
  if (options.baseUrl) overrides.app = { baseUrl: options.baseUrl };
  if (options.headed) overrides.browser = { headless: false };
  if (options.presets.length) overrides.transport = { preset: options.presets };
  return overrides;
}

async function commandRun(options, logger) {
  const scripts = options.positional.slice(1);
  if (scripts.length === 0) throw new Error("vocoso run needs at least one script path");
  const config = await loadConfig({ configPath: options.configPath, overrides: overridesFrom(options) });

  const outcomes = [];
  for (const path of scripts) {
    const script = await loadScript(path);
    const outcome = await runScript({ config, script, logger, heal: options.heal });
    outcomes.push(outcome);

    logger.info("run", "-".repeat(56));
    for (const [stage, passed] of Object.entries(outcome.report.verification.stages)) {
      // Spell the verdict out: colour alone is invisible in a CI log.
      logger[passed ? "pass" : "fail"]("stage", `${passed ? "PASS" : "FAIL"}  ${stage}`);
    }
    const failed = outcome.report.checks.filter((check) => !check.passed);
    logger.info("run", `${outcome.report.checks.length - failed.length}/${outcome.report.checks.length} expectations met`);
    if (outcome.findings.length) {
      console.log(`\n${formatDiagnosis(outcome.findings)}\n`);
    }
    logger.info("run", `report: ${outcome.reportPath}`);
    logger[outcome.report.passed ? "pass" : "fail"]("run", `${script.name}: ${outcome.report.passed ? "PASSED" : "FAILED"}`);
  }

  if (options.json) {
    console.log(JSON.stringify(outcomes.map((outcome) => outcome.report), null, 2));
  }
  return outcomes.every((outcome) => outcome.report.passed) ? 0 : 1;
}

async function commandDoctor(options, logger) {
  const config = await loadConfig({ configPath: options.configPath, overrides: overridesFrom(options) })
    .catch(async (error) => {
      // The doctor must work before a config exists - that is half its value.
      logger.warn("doctor", `no usable config (${error.message.replace(/\s+/g, " ").slice(0, 200)}); using defaults`);
      const { DEFAULT_CONFIG } = await import("./config/defaults.mjs");
      return { ...DEFAULT_CONFIG, rootDir: process.cwd(), cacheDir: resolve(process.cwd(), ".vocoso") };
    });
  const result = await doctor(config, logger);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  return result.passed ? 0 : 1;
}

async function commandCheck(options, logger) {
  const specPath = options.positional[1];
  if (!specPath) throw new Error("vocoso check needs a spec JSON file");
  const spec = JSON.parse(readFileSync(resolve(specPath), "utf8"));
  const state = options.statePath ? JSON.parse(readFileSync(resolve(options.statePath), "utf8")) : undefined;
  const config = await loadConfig({ configPath: options.configPath }).catch(() => ({ surfaces: {} }));
  const evaluation = evaluateSurface({ spec, state, config: config.surfaces ?? {} });

  if (options.json) {
    console.log(JSON.stringify(evaluation, null, 2));
  } else {
    logger.info("check", `${evaluation.elementKeys.length} element(s), ${evaluation.factsConsidered} authoritative fact(s)`);
    for (const item of evaluation.findings) logger.fail("check", `${item.rule}: ${item.detail}`);
    logger[evaluation.passed ? "pass" : "fail"]("check", evaluation.passed
      ? "the surface is grounded and renderable"
      : `${evaluation.findings.length} finding(s)`);
  }
  return evaluation.passed ? 0 : 1;
}

function commandExplain(options, logger) {
  const reportPath = options.positional[1];
  if (!reportPath) throw new Error("vocoso explain needs a report.json path");
  const report = JSON.parse(readFileSync(resolve(reportPath), "utf8"));
  const findings = report.diagnosis?.length ? report.diagnosis : diagnose(report);
  console.log(formatDiagnosis(findings));
  logger.info("explain", `${findings.length} finding(s) from ${basename(reportPath)}`);
  return findings.length === 0 ? 0 : 1;
}

function commandInit(options, logger) {
  const cwd = process.cwd();
  const configPath = join(cwd, "vocoso.config.mjs");
  const scriptDir = join(cwd, "vocoso");
  const scriptPath = join(scriptDir, "first-conversation.json");

  if (existsSync(configPath)) {
    logger.warn("init", `${configPath} already exists; leaving it alone`);
  } else {
    writeFileSync(configPath, STARTER_CONFIG);
    logger.pass("init", `wrote ${configPath}`);
  }
  mkdirSync(scriptDir, { recursive: true });
  if (existsSync(scriptPath)) {
    logger.warn("init", `${scriptPath} already exists; leaving it alone`);
  } else {
    writeFileSync(scriptPath, STARTER_SCRIPT);
    logger.pass("init", `wrote ${scriptPath}`);
  }
  console.log([
    "",
    "Next:",
    "  1. npm i -D playwright && npx playwright install chromium",
    "  2. edit vocoso.config.mjs - the selectors for your assistant",
    "  3. npx vocoso doctor        (proves the rig works, no app needed)",
    "  4. npx vocoso run vocoso/first-conversation.json --headed",
    "",
  ].join("\n"));
  return 0;
}

export async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    return 64;
  }
  const command = options.positional[0];
  if (options.help || !command) {
    console.log(USAGE);
    return options.help ? 0 : 64;
  }
  const logger = createLogger({ verbose: options.verbose, quiet: options.quiet });

  try {
    switch (command) {
      case "run": return await commandRun(options, logger);
      case "doctor": return await commandDoctor(options, logger);
      case "check": return await commandCheck(options, logger);
      case "explain": return commandExplain(options, logger);
      case "init": return commandInit(options, logger);
      default:
        console.error(`unknown command "${command}"\n\n${USAGE}`);
        return 64;
    }
  } catch (error) {
    logger.fail("vocoso", String(error?.message ?? error));
    if (options.verbose && error?.stack) console.error(error.stack);
    return 70;
  }
}
