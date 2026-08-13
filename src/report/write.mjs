/**
 * One directory per run: report.json (everything), summary.md (readable),
 * index.html (screenshots and timeline), plus the screenshots themselves and
 * the app-server log if VoCoSo started one.
 *
 * The report is written even when the run blows up. A failing run's report is
 * the one that matters, and it is exactly the moment a tool is most tempted to
 * exit with a stack trace and nothing else.
 */
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { transcriptFrom } from "../transport/normalize.mjs";
import { deriveTimings } from "../oracle/latency.mjs";

const KEEP_EVENT_KINDS = new Set([
  "session.open", "user.transcript", "assistant.text", "tool.call", "tool.result",
  "assistant.done", "error", "surface.spec", "surface.patch",
]);

export function assembleReport(input) {
  const {
    config, script, startedAt, runDir, mode, collector, observed,
    driver, checks, evidence, surfaces, verification, recoveries,
  } = input;

  const events = collector?.events ?? [];
  const timings = deriveTimings(driver?.utterances ?? [], events);
  const peakOutputLevel = (collector?.outputLevelHistory ?? []).reduce(
    (highest, sample) => Math.max(highest, sample.level), 0,
  );

  return {
    tool: "vocoso",
    version: input.version,
    script: script.name,
    mode,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    runDir,
    passed: verification.passed,

    config: {
      baseUrl: config.app.baseUrl,
      path: config.app.path,
      preset: collector?.presetNames ?? [],
      tts: input.ttsSummary ?? null,
      transport: { speakingThreshold: config.transport.speakingThreshold },
      heal: { recover: config.heal.recover.enabled, patch: config.heal.patch.enabled },
    },

    verification,
    checks: checks ?? [],
    evidence: evidence ?? [],
    recoveries: recoveries ?? [],

    utterances: driver?.utterances ?? [],
    turns: transcriptFrom(events),
    timings,

    surfaces: {
      versions: (surfaces?.versions ?? []).map((version) => ({
        at: version.at, source: version.source, operations: version.operations ?? null,
      })),
      latest: surfaces?.latest ?? null,
      count: surfaces?.versions?.length ?? 0,
    },

    transport: {
      presets: collector?.presetNames ?? [],
      presetHits: collector?.presetHits ?? {},
      finalState: collector?.state?.() ?? {},
      peakOutputLevel,
      unmatched: (collector?.unmatched ?? []).slice(0, 40),
      events: events.filter((item) => KEEP_EVENT_KINDS.has(item.kind)),
      eventCounts: (collector?.state?.() ?? {}).counts ?? {},
      frameCount: collector?.frames?.length ?? 0,
    },

    observed: {
      httpFailures: observed?.httpFailures ?? [],
      networkFailures: observed?.networkFailures ?? [],
      pageErrors: observed?.pageErrors ?? [],
      console: (observed?.console ?? []).slice(-150),
    },

    screenshots: (driver?.screenshots ?? []).map((path) => basename(path)),
    logTail: (input.logger?.tail ?? []).slice(-300),
  };
}

const tick = (passed) => (passed ? "PASS" : "FAIL");

export function summaryMarkdown(report, findings) {
  const lines = [
    `# ${report.script} - ${report.passed ? "PASSED" : "FAILED"}`,
    "",
    `- mode: **${report.mode}**`,
    `- app: ${report.config.baseUrl}${report.config.path}`,
    `- duration: ${(report.durationMs / 1000).toFixed(1)}s`,
    `- transport: ${Object.entries(report.transport.presetHits).map(([name, hits]) => `${name} (${hits})`).join(", ") || "nothing recognised"}`,
    "",
    "## Stages",
    "",
    ...Object.entries(report.verification.stages).map(([stage, passed]) => `- ${tick(passed)} ${stage}`),
  ];

  if (report.checks.length) {
    lines.push("", "## Expectations", "");
    for (const check of report.checks) lines.push(`- ${tick(check.passed)} \`${check.name}\` - ${check.detail}`);
  }
  if (report.evidence.length) {
    lines.push("", "## Evidence", "");
    for (const item of report.evidence) lines.push(`- ${tick(item.passed)} \`${item.name}\` (${item.kind}) - ${item.detail ?? "satisfied"}`);
  }
  if (report.turns.length) {
    lines.push("", "## Conversation", "");
    for (const turn of report.turns) {
      if (turn.userText) lines.push(`**user:** ${turn.userText}`, "");
      if (turn.assistantText) lines.push(`**assistant:** ${turn.assistantText}`, "");
      for (const tool of turn.tools) lines.push(`> called \`${tool.name}\`(${String(tool.arguments ?? "").slice(0, 200)})`, "");
    }
  }
  const summary = report.timings.summary;
  if (summary.speechEndToAssistantAudioMs.count || summary.speechEndToAssistantTextMs.count) {
    lines.push("", "## Latency", "", "| metric | p50 | p95 | max |", "| --- | --- | --- | --- |");
    for (const [metric, value] of Object.entries(summary)) {
      if (!value.count) continue;
      lines.push(`| ${metric} | ${value.p50} | ${value.p95} | ${value.max} |`);
    }
  }
  if (report.recoveries.length) {
    lines.push("", "## Recoveries", "");
    for (const item of report.recoveries) lines.push(`- ${item.strategy}: ${item.reason} -> ${item.outcome}`);
  }
  if (findings?.length) {
    lines.push("", "## Diagnosis", "");
    for (const item of findings) {
      lines.push(`### ${item.title}`, "", `- code: \`${item.code}\` · fault: **${item.fault}** · confidence: ${item.confidence}`, "");
      lines.push("```", String(item.observed ?? ""), "```", "", item.cause, "");
      for (const fix of item.fix) lines.push(`- fix: ${fix}`);
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

const escapeHtml = (value) => String(value ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function summaryHtml(report, findings) {
  const rows = report.checks.map((check) =>
    `<tr class="${check.passed ? "ok" : "bad"}"><td>${check.passed ? "PASS" : "FAIL"}</td>` +
    `<td><code>${escapeHtml(check.name)}</code></td><td>${escapeHtml(check.detail)}</td></tr>`).join("");
  const turns = report.turns.map((turn) => `
    <div class="turn">
      ${turn.userText ? `<p class="user"><b>user</b> ${escapeHtml(turn.userText)}</p>` : ""}
      ${turn.assistantText ? `<p class="assistant"><b>assistant</b> ${escapeHtml(turn.assistantText)}</p>` : ""}
      ${turn.tools.map((tool) => `<p class="tool">${escapeHtml(tool.name)}(${escapeHtml(String(tool.arguments ?? "").slice(0, 300))})</p>`).join("")}
    </div>`).join("");
  const shots = report.screenshots.map((name) =>
    `<figure><img src="${escapeHtml(name)}" loading="lazy" alt="${escapeHtml(name)}"><figcaption>${escapeHtml(name)}</figcaption></figure>`).join("");
  const diagnosis = (findings ?? []).map((item) => `
    <article class="finding">
      <h3>${escapeHtml(item.title)}</h3>
      <p class="meta"><code>${escapeHtml(item.code)}</code> · fault: <b>${escapeHtml(item.fault)}</b> · ${escapeHtml(item.confidence)}</p>
      <pre>${escapeHtml(item.observed)}</pre>
      <p>${escapeHtml(item.cause)}</p>
      <ul>${item.fix.map((fix) => `<li>${escapeHtml(fix)}</li>`).join("")}</ul>
    </article>`).join("");

  return `<!doctype html>
<meta charset="utf-8">
<title>vocoso - ${escapeHtml(report.script)}</title>
<style>
  :root { color-scheme: light dark; --ok: #1a7f37; --bad: #cf222e; --line: color-mix(in srgb, currentColor 15%, transparent); }
  body { font: 15px/1.55 ui-sans-serif, system-ui, sans-serif; margin: 0 auto; max-width: 62rem; padding: 2rem 1.25rem 6rem; }
  h1 { margin-bottom: .25rem; }
  .verdict { font-weight: 700; color: ${report.passed ? "var(--ok)" : "var(--bad)"}; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border-bottom: 1px solid var(--line); padding: .4rem .5rem; text-align: left; vertical-align: top; }
  tr.ok td:first-child { color: var(--ok); font-weight: 600; }
  tr.bad td:first-child { color: var(--bad); font-weight: 600; }
  .turn { border-left: 3px solid var(--line); padding-left: .85rem; margin: .75rem 0; }
  .tool { font-family: ui-monospace, monospace; font-size: .85em; opacity: .75; }
  figure { margin: 0; }
  .shots { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 1rem; }
  .shots img { width: 100%; border: 1px solid var(--line); border-radius: 6px; }
  figcaption { font-size: .78em; opacity: .7; }
  pre { overflow-x: auto; background: color-mix(in srgb, currentColor 6%, transparent); padding: .6rem; border-radius: 6px; }
  .finding { border: 1px solid var(--line); border-radius: 8px; padding: .25rem 1rem 1rem; margin: 1rem 0; }
</style>
<h1>${escapeHtml(report.script)}</h1>
<p class="verdict">${report.passed ? "PASSED" : "FAILED"}</p>
<p>${escapeHtml(report.mode)} · ${escapeHtml(report.config.baseUrl + report.config.path)} · ${(report.durationMs / 1000).toFixed(1)}s</p>
${diagnosis ? `<h2>Diagnosis</h2>${diagnosis}` : ""}
<h2>Expectations</h2>
<table><tbody>${rows || "<tr><td colspan=3>no expectations declared</td></tr>"}</tbody></table>
<h2>Conversation</h2>
${turns || "<p>nothing was transcribed</p>"}
<h2>Screenshots</h2>
<div class="shots">${shots}</div>
`;
}

export function writeReport(runDir, report, findings) {
  const jsonPath = join(runDir, "report.json");
  writeFileSync(jsonPath, JSON.stringify({ ...report, diagnosis: findings ?? [] }, null, 2));
  writeFileSync(join(runDir, "summary.md"), summaryMarkdown(report, findings));
  writeFileSync(join(runDir, "index.html"), summaryHtml(report, findings));
  return jsonPath;
}
