/**
 * Opt-in self-healing: turn a diagnosis into a reviewable patch.
 *
 * This is the only part of VoCoSo that can touch your source, so it is fenced
 * on every side:
 *
 *   - off unless heal.patch.enabled AND the run was started with --heal,
 *   - scoped to heal.patch.paths, which has no default,
 *   - refuses to run on a dirty tree, so `git diff` afterwards is exactly what
 *     the model changed and nothing else,
 *   - proposes by default: the patch is written to the report and printed. It
 *     is only applied when heal.patch.apply is true,
 *   - when it does apply, it re-runs the failing script and reverts itself if
 *     the run is not green,
 *   - never stages, never commits, never pushes.
 *
 * It also declines the findings it should decline. A 429 from a provider and a
 * wrong selector in your own config are not defects in your application, and a
 * model asked to "fix" them will happily invent something.
 */
import { execFile } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";

import { resolvePatchProvider } from "./providers.mjs";

const run = promisify(execFile);

const MAX_FILE_BYTES = 120_000;
const MAX_TOTAL_BYTES = 400_000;

const SYSTEM = `You repair defects in a codebase from a failing conversational-AI test report.

Rules:
- Reply with a single unified diff and nothing else. No prose, no fences, no explanation.
- The diff must apply with \`git apply -p1\` against the files shown.
- Only modify files that were shown to you.
- Make the smallest change that addresses the diagnosed cause. Do not refactor,
  reformat, rename, or "improve" anything you were not asked about.
- If the report does not contain enough evidence to make a correct change,
  reply with exactly: INSUFFICIENT EVIDENCE
- Never weaken, delete, or skip a test or an assertion to make a run pass.`;

async function git(args, cwd) {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

async function assertRepoUsable(cwd, { requireCleanTree }) {
  try {
    await git(["rev-parse", "--is-inside-work-tree"], cwd);
  } catch {
    throw new Error("self-healing needs a git repository - it relies on git to apply and revert its own patch");
  }
  if (!requireCleanTree) return;
  const status = (await git(["status", "--porcelain"], cwd)).trim();
  if (status) {
    throw new Error(
      "the working tree has uncommitted changes. Self-healing refuses to run on a dirty tree so that " +
      "`git diff` afterwards is exactly what it changed. Commit or stash first, or set " +
      "heal.patch.requireCleanTree: false.",
    );
  }
}

/** Files inside the configured scope, newest-mentioned first, under a size cap. */
async function gatherSources({ cwd, paths, hints }) {
  const tracked = (await git(["ls-files", "--", ...paths], cwd)).split("\n").filter(Boolean);
  const hintWords = hints.flatMap((hint) => String(hint).toLowerCase().split(/[^a-z0-9]+/)).filter((word) => word.length > 3);
  const scored = tracked.map((path) => {
    const lower = path.toLowerCase();
    const score = hintWords.reduce((total, word) => total + (lower.includes(word) ? 1 : 0), 0);
    return { path, score };
  }).sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));

  const files = [];
  let total = 0;
  for (const { path } of scored) {
    let size;
    try { size = statSync(join(cwd, path)).size; } catch { continue; }
    if (size > MAX_FILE_BYTES) continue;
    if (total + size > MAX_TOTAL_BYTES) break;
    files.push({ path, content: readFileSync(join(cwd, path), "utf8") });
    total += size;
  }
  return files;
}

function buildPrompt({ findings, files, run: report }) {
  const sections = [
    "# Failing run",
    `script: ${report.script}`,
    `mode: ${report.mode}`,
    "",
    "# Diagnosis",
    ...findings.map((item, index) => [
      `## ${index + 1}. ${item.title} (${item.code})`,
      `Observed:\n${item.observed}`,
      `Likely cause: ${item.cause}`,
      item.fix.length ? `Suggested direction:\n- ${item.fix.join("\n- ")}` : "",
    ].filter(Boolean).join("\n")),
    "",
    "# Failed checks",
    ...(report.checks ?? []).filter((check) => !check.passed).map((check) => `- ${check.name}: ${check.detail}`),
    "",
    "# Conversation",
    ...(report.turns ?? []).slice(0, 12).map((turn) =>
      `user: ${turn.userText}\nassistant: ${turn.assistantText}` +
      (turn.tools?.length ? `\ntools: ${turn.tools.map((tool) => tool.name).join(", ")}` : "")),
    "",
    "# Files in scope",
    ...files.map((file) => `--- ${file.path} ---\n${file.content}`),
    "",
    "Produce the unified diff now.",
  ];
  return sections.join("\n");
}

function extractDiff(text) {
  const trimmed = text.trim();
  if (trimmed === "INSUFFICIENT EVIDENCE") return null;
  const fenced = /```(?:diff|patch)?\n([\s\S]*?)```/.exec(trimmed);
  const body = (fenced ? fenced[1] : trimmed).trim();
  return /^(diff --git|--- )/m.test(body) ? `${body}\n` : null;
}

function touchedFiles(diff) {
  return [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1].trim());
}

/**
 * @param {object} input
 * @param {Array}  input.findings   diagnosis output
 * @param {object} input.run        the assembled report
 * @param {object} input.config     resolved vocoso config
 * @param {object} input.logger
 * @param {Function} [input.verify] re-runs the script; resolves to { passed }
 */
export async function proposePatch({ findings, run: report, config, logger, verify }) {
  const patchConfig = config.heal?.patch ?? {};
  const cwd = patchConfig.cwd ?? config.rootDir;

  const actionable = findings.filter((item) => item.fault === "app");
  if (actionable.length === 0) {
    const reason = findings.length
      ? `every finding is a ${[...new Set(findings.map((item) => item.fault))].join("/")} fault - ` +
        "nothing in your application to change"
      : "nothing failed";
    logger.info("heal", `no patch attempted: ${reason}`);
    return { attempted: false, reason };
  }

  await assertRepoUsable(cwd, { requireCleanTree: patchConfig.requireCleanTree !== false });
  const provider = resolvePatchProvider(patchConfig);
  const files = await gatherSources({
    cwd,
    paths: patchConfig.paths,
    hints: actionable.flatMap((item) => item.sourceHint ?? []).concat(actionable.map((item) => item.title)),
  });
  if (files.length === 0) {
    return { attempted: false, reason: `heal.patch.paths matched no tracked files under ${cwd}` };
  }
  logger.heal("heal", `asking ${provider.name} to repair ${actionable.length} finding(s) across ${files.length} file(s)`);

  const answer = await provider.call({
    system: SYSTEM,
    prompt: buildPrompt({ findings: actionable, files, run: report }),
    model: patchConfig.model,
    apiKey: provider.apiKey,
    timeoutMs: patchConfig.timeoutMs,
  });
  const diff = extractDiff(answer);
  if (!diff) {
    logger.warn("heal", "the model declined to patch: not enough evidence in the report");
    return { attempted: true, applied: false, reason: "model returned no diff", raw: answer.slice(0, 2_000) };
  }

  const allowed = new Set(files.map((file) => file.path));
  const outside = touchedFiles(diff).filter((path) => !allowed.has(relative(cwd, join(cwd, path))));
  if (outside.length) {
    return {
      attempted: true,
      applied: false,
      diff,
      reason: `the patch touches files outside the scope it was given: ${outside.join(", ")}`,
    };
  }

  const patchPath = join(report.runDir, "proposed.patch");
  writeFileSync(patchPath, diff);
  logger.heal("heal", `patch written to ${patchPath}`);

  try {
    await git(["apply", "--check", "-p1", patchPath], cwd);
  } catch (error) {
    return { attempted: true, applied: false, diff, patchPath, reason: `the patch does not apply: ${error.message}` };
  }

  if (!patchConfig.apply) {
    logger.info("heal", "heal.patch.apply is false - proposing only. Review it, then: git apply " + patchPath);
    return { attempted: true, applied: false, diff, patchPath, reason: "proposal mode" };
  }

  await git(["apply", "-p1", patchPath], cwd);
  logger.heal("heal", "patch applied to the working tree");

  if (!verify) {
    return { attempted: true, applied: true, verified: null, diff, patchPath };
  }

  logger.heal("heal", "re-running the script to see whether the patch actually fixed it");
  const verification = await verify();
  if (verification.passed) {
    logger.pass("heal", "the patch holds - leaving it in the working tree for you to review");
    return { attempted: true, applied: true, verified: true, diff, patchPath, verification };
  }
  await git(["apply", "-R", "-p1", patchPath], cwd);
  logger.warn("heal", "the patch did not fix the run; reverted. The proposal is kept for you to read.");
  return { attempted: true, applied: false, verified: false, diff, patchPath, verification };
}
