/**
 * Turn a failed run into a diagnosis.
 *
 * A test that only reports "expected true, got false" makes its owner do the
 * hard part twice. Every rule here answers three questions instead: what was
 * observed, what most likely causes that, and what to change. Each finding is
 * also tagged with whether the fault looks like the rig's configuration or the
 * product itself - the single most useful bit when a suite goes red, and the
 * one a bare assertion never carries.
 *
 * These rules are also the input to the optional patch step: a finding with a
 * concrete `fix` and a `sourceHint` is something a model can act on, and one
 * without is something it should be kept away from.
 */
import { readFileSync } from "node:fs";

const finding = (input) => ({
  confidence: "likely",
  fault: "unknown",
  fix: [],
  ...input,
});

const tailOf = (path, lines = 40) => {
  try {
    return readFileSync(path, "utf8").split("\n").slice(-lines).join("\n");
  } catch {
    return null;
  }
};

const statusesIn = (failures, predicate) => failures.filter((failure) => predicate(failure.status));

/**
 * @param {object} run  the assembled report (see report/write.mjs)
 * @returns {Array<object>} findings, most actionable first
 */
export function diagnose(run) {
  const findings = [];
  const observed = run.observed ?? {};
  const httpFailures = observed.httpFailures ?? [];
  const state = run.transport?.finalState ?? {};
  const counts = state.counts ?? {};
  const blocked = run.verification?.blocked;

  // ---- infrastructure ----------------------------------------------------
  if (blocked?.code === "PLAYWRIGHT_MISSING") {
    findings.push(finding({
      code: "PLAYWRIGHT_MISSING",
      fault: "rig",
      confidence: "certain",
      title: "Playwright is not installed",
      observed: blocked.message,
      cause: "VoCoSo drives a real browser and keeps Playwright as an optional peer dependency.",
      fix: ["npm i -D playwright", "npx playwright install chromium"],
    }));
  }

  if (/Executable doesn't exist|playwright install/i.test(blocked?.message ?? "")) {
    findings.push(finding({
      code: "BROWSER_MISSING",
      fault: "rig",
      confidence: "certain",
      title: "Playwright is installed but its browser binary is not",
      observed: blocked.message.split("\n")[0],
      cause: "Installing the playwright package does not download browsers; that is a separate step.",
      fix: ["npx playwright install chromium"],
    }));
  }

  if (["APP_UNREACHABLE", "APP_START_FAILED", "APP_START_TIMEOUT"].includes(blocked?.code)) {
    findings.push(finding({
      code: blocked.code,
      fault: "rig",
      confidence: "certain",
      title: "The application under test never came up",
      observed: blocked.message,
      cause: blocked.code === "APP_UNREACHABLE"
        ? "Nothing was listening, and app.start.command is not configured."
        : "The configured start command exited or never answered the ready path.",
      detail: blocked.logPath ? tailOf(blocked.logPath) : null,
      fix: [
        "Start the app yourself and re-run - VoCoSo attaches to a server that is already up.",
        "Or set app.start.command and app.start.readyPath in vocoso.config.mjs.",
      ],
    }));
  }

  if (blocked?.code === "PAGE_UNHEALTHY") {
    findings.push(finding({
      code: "PAGE_UNHEALTHY",
      fault: "app",
      title: "The server answers, but the page under test does not",
      observed: blocked.message,
      cause: "A long-lived dev server can wedge on page rendering while API routes keep responding.",
      fix: ["Restart the dev server.", "Check app.path points at the page that hosts the assistant."],
    }));
  }

  // ---- authentication and quota -----------------------------------------
  const unauthorized = statusesIn(httpFailures, (status) => status === 401 || status === 403);
  if (unauthorized.length) {
    findings.push(finding({
      code: "AUTH_REJECTED",
      fault: "rig",
      confidence: "certain",
      title: "The app rejected the rig's credentials",
      observed: unauthorized.slice(0, 3).map((failure) => `${failure.status} ${failure.url}`).join("\n"),
      cause: "app.auth did not produce a session the app accepts.",
      fix: [
        "Check app.auth.cookies / storageState / headers against a real signed-in session.",
        "Capture one with: npx playwright open --save-storage=auth.json <your app>",
      ],
    }));
  }

  const throttled = statusesIn(httpFailures, (status) => status === 429);
  if (throttled.length) {
    findings.push(finding({
      code: "RATE_LIMITED",
      fault: "external",
      confidence: "certain",
      title: "The model provider throttled or refused on billing",
      observed: throttled.slice(0, 3).map((failure) => `429 ${failure.url}: ${failure.body?.slice(0, 200)}`).join("\n"),
      cause: "Ephemeral key minting usually succeeds at zero balance; the provider enforces at call setup instead, which is why this looks like a transport failure.",
      fix: ["Add credit to the provider account, or point the run at a funded key.", "Re-run: no code change is needed."],
    }));
  }

  const serverErrors = statusesIn(httpFailures, (status) => status >= 500);
  if (serverErrors.length) {
    findings.push(finding({
      code: "SERVER_ERROR",
      fault: "app",
      confidence: "certain",
      title: "The app's own API returned 5xx during the conversation",
      observed: serverErrors.slice(0, 3).map((failure) => `${failure.status} ${failure.url}: ${failure.body?.slice(0, 300)}`).join("\n"),
      cause: "A route the assistant depends on failed. This is a product defect, not a rig one.",
      sourceHint: serverErrors.slice(0, 3).map((failure) => failure.url),
      fix: ["Read the server log around the timestamps above.", "Reproduce the failing route directly with curl."],
    }));
  }

  // ---- transport ---------------------------------------------------------
  if (state.frameCount > 0 && state.eventCount === 0) {
    findings.push(finding({
      code: "PRESET_UNMATCHED",
      fault: "rig",
      confidence: "certain",
      title: "The transport carried traffic VoCoSo could not interpret",
      observed: `${state.frameCount} frames, 0 recognised events. Unmatched samples:\n` +
        (run.transport?.unmatched ?? []).slice(0, 3).map((item) => `  ${item.source}: ${item.sample}`).join("\n"),
      cause: "None of the built-in presets recognise this provider's message shape.",
      fix: [
        "Set transport.preset to the provider you use, or pass a mapping function.",
        "Or emit semantic events from the app: window.__vocoso?.emit('assistant.text', { text }).",
        "The unmatched samples in the report are exactly what a new preset must map.",
      ],
    }));
  }

  if (blocked?.code === "SESSION_NOT_LIVE" && !unauthorized.length && !throttled.length && !serverErrors.length) {
    findings.push(finding({
      code: "SESSION_SELECTOR",
      fault: "rig",
      title: "The session control was pressed but nothing came up",
      observed: blocked.message,
      cause: "Usually voice.start points at the wrong element, or the app needs voice.enter clicked first.",
      fix: [
        "Re-run with --headed to watch what the click actually does.",
        "Confirm voice.start, voice.enter, and voice.statusSelector against the live DOM.",
      ],
    }));
  }

  // ---- audio path --------------------------------------------------------
  const spoke = (run.utterances ?? []).length;
  if (run.mode === "voice" && spoke > 0 && !counts["user.transcript"]) {
    const micHeld = state.micStreams > 0;
    findings.push(finding({
      code: "NOT_HEARD",
      fault: micHeld ? "app" : "rig",
      title: "Utterances were played but nothing was ever transcribed",
      observed: `${spoke} utterance(s) injected, ${state.micStreams} microphone stream(s) held by the app, ` +
        `${state.frameCount} transport frames`,
      cause: micHeld
        ? "The app holds the rig's microphone, so the audio left the page. Either transcription is switched off, or the far side is not receiving the track."
        : "The app never called getUserMedia, so the utterances went nowhere. The session probably was not really open.",
      fix: micHeld
        ? [
            "Confirm input transcription is enabled in your session configuration.",
            "Run `vocoso doctor` to prove the audio injection path independently of the app.",
          ]
        : ["Check that pressing voice.start actually opens the microphone.", "Re-run with --headed."],
    }));
  }

  if (counts["assistant.text"] && !counts["assistant.audio.start"] && run.mode === "voice") {
    findings.push(finding({
      code: "NO_ASSISTANT_AUDIO",
      fault: "app",
      title: "The assistant produced words but no audible speech",
      observed: `${counts["assistant.text"]} assistant text event(s), 0 audio starts, ` +
        `${state.meterCount ?? 0} metered output(s)`,
      cause: "The model answered and the client never played it: a muted element, a stream attached to the wrong element, or playback blocked by autoplay policy.",
      fix: [
        "Check where the remote audio track is attached and whether that element is playing.",
        "This is the failure users describe as 'it hears me but I hear nothing'.",
      ],
    }));
  }

  const everLoud = (run.transport?.peakOutputLevel ?? 0) > (run.config?.transport?.speakingThreshold ?? 0.01);
  if (counts["assistant.audio.start"] && !everLoud && run.mode === "voice") {
    findings.push(finding({
      code: "DEAD_AIR",
      fault: "app",
      title: "Audio was announced but no sound was ever measured",
      observed: `peak output level ${(run.transport?.peakOutputLevel ?? 0).toExponential(2)} never crossed the speaking threshold`,
      cause: "The provider says it is speaking, but nothing reached an output. Silent frames, a zeroed gain node, or a detached element.",
      fix: [
        "Meter the element you attach the remote track to in the browser and compare.",
        "An event-only check would have called this run green - the loudness meter is why it did not.",
      ],
    }));
  }

  // ---- oracle results ----------------------------------------------------
  const failedChecks = (run.checks ?? []).filter((check) => !check.passed);
  const surfaceFailures = failedChecks.filter((check) => check.name === "surface" && check.evaluation);
  for (const check of surfaceFailures) {
    const rules = new Set(check.evaluation.findings.map((item) => item.rule));
    if (rules.has("grounding")) {
      findings.push(finding({
        code: "SURFACE_UNGROUNDED",
        fault: "app",
        confidence: "certain",
        title: "The surface retyped authoritative values instead of binding to them",
        observed: check.evaluation.findings.filter((item) => item.rule === "grounding")
          .map((item) => `  ${item.detail}`).join("\n"),
        cause: "The model copied a tool result into prose. It renders correctly today and silently goes stale or wrong the moment the underlying value changes.",
        sourceHint: ["the system prompt that describes how to reference state"],
        fix: [
          "Make the prompt state the rule explicitly: facts are referenced, never written.",
          "Give the model a worked example of the reference form next to a counter-example.",
        ],
      }));
    }
    if (rules.has("catalog")) {
      findings.push(finding({
        code: "SURFACE_UNKNOWN_COMPONENT",
        fault: "app",
        confidence: "certain",
        title: "The surface used components the host cannot render",
        observed: check.evaluation.findings.filter((item) => item.rule === "catalog")
          .map((item) => `  ${item.detail}`).join("\n"),
        cause: "The catalog the model is told about has drifted from the catalog the renderer implements.",
        sourceHint: ["the component catalog", "the system prompt's component list"],
        fix: [
          "Generate the prompt's component list from the renderer's catalog so they cannot diverge.",
          "Or add the components to the renderer if the model is asking for something reasonable.",
        ],
      }));
    }
    if (rules.has("reference-unresolved")) {
      findings.push(finding({
        code: "SURFACE_PHANTOM_REFERENCE",
        fault: "app",
        title: "The surface bound to state paths that do not exist",
        observed: check.evaluation.findings.filter((item) => item.rule === "reference-unresolved")
          .map((item) => `  ${item.detail}`).join("\n"),
        cause: "The model guessed at the shape of the result rather than reading it. Those bindings render as blanks.",
        fix: [
          "Show the model the actual result shape (a schema or a sample) before it composes.",
          "Fail closed in the renderer so a phantom binding is visible in development.",
        ],
      }));
    }
    if (rules.has("write-firewall")) {
      findings.push(finding({
        code: "SURFACE_WRITES_STATE",
        fault: "app",
        confidence: "certain",
        title: "The generated surface writes authoritative state",
        observed: check.evaluation.findings.filter((item) => item.rule === "write-firewall")
          .map((item) => `  ${item.detail}`).join("\n"),
        cause: "A surface that can write its own source of truth can fabricate facts and then cite them.",
        fix: ["Reject these patches in the renderer, not only in the prompt."],
      }));
    }
  }

  for (const check of failedChecks.filter((item) => item.name.startsWith("toolCalled:"))) {
    findings.push(finding({
      code: "TOOL_NOT_CALLED",
      fault: "app",
      title: `The assistant never called ${check.name.slice("toolCalled:".length)}`,
      observed: check.detail,
      cause: "Either the tool was not offered in this session, its description does not match how people ask, or the model answered from memory instead.",
      fix: [
        "Confirm the tool is in the session's tool list at the moment of the turn.",
        "Compare the utterance with the tool description - most misses are description mismatches, not model failures.",
      ],
    }));
  }

  for (const check of failedChecks.filter((item) => item.name.startsWith("evidence:"))) {
    findings.push(finding({
      code: "NOT_PERSISTED",
      fault: "app",
      title: `Nothing was persisted for ${check.name.slice("evidence:".length)}`,
      observed: check.detail,
      cause: "The conversation happened and the system state did not change. This is the failure that a transcript-only test cannot see.",
      fix: [
        "Check the write path for the tool the assistant called.",
        "If the write is asynchronous, raise this evidence check's waitMs before assuming a defect.",
      ],
    }));
  }

  for (const check of failedChecks.filter((item) => item.name.startsWith("latency:"))) {
    findings.push(finding({
      code: "LATENCY_BUDGET",
      fault: "app",
      title: `Latency budget exceeded: ${check.name.slice("latency:".length)}`,
      observed: check.detail,
      cause: "Slower than the budget the config declares.",
      fix: ["Compare against the previous report in the same directory - VoCoSo keeps them all."],
    }));
  }

  // ---- rig health --------------------------------------------------------
  const repaired = (run.recoveries ?? []).filter((item) => item.outcome === "repaired");
  if (repaired.length >= 3) {
    findings.push(finding({
      code: "SESSION_FLAPPING",
      fault: "app",
      title: `The session had to be re-established ${repaired.length} times`,
      observed: repaired.map((item) => `  ${item.strategy}: ${item.reason}`).join("\n"),
      cause: "Recovery kept the run alive, but a session that dies this often in a quiet room will die in front of users. Common causes: dev-server hot reload tearing down the audio hook, or an unmount cleanup that runs on every render.",
      fix: [
        "Run against a production build to rule out hot reload.",
        "If it still flaps, the teardown is in the app's own lifecycle handling.",
      ],
    }));
  }

  if (blocked && findings.length === 0) {
    findings.push(finding({
      code: "BLOCKED",
      fault: "unknown",
      title: `The run stopped at "${run.verification?.blockedAt ?? "an unknown stage"}"`,
      observed: blocked.message,
      cause: "No diagnostic rule matched this failure.",
      fix: ["The full report holds the transport frames, console tail, and screenshots for this moment."],
    }));
  }

  const order = { certain: 0, likely: 1, possible: 2 };
  return findings.sort((left, right) => (order[left.confidence] ?? 3) - (order[right.confidence] ?? 3));
}

/** One-line-per-finding rendering for the terminal. */
export function formatDiagnosis(findings) {
  if (findings.length === 0) return "No diagnosis: nothing failed.";
  return findings.map((item, index) => {
    const lines = [
      `${index + 1}. [${item.fault}] ${item.title}  (${item.code}, ${item.confidence})`,
      `   observed: ${String(item.observed ?? "").split("\n").join("\n             ")}`,
      `   cause:    ${item.cause}`,
    ];
    for (const fix of item.fix) lines.push(`   fix:      ${fix}`);
    return lines.join("\n");
  }).join("\n\n");
}
