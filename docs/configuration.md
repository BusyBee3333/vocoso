# Configuration reference

`vocoso.config.mjs` (or `.js` / `.json` / `.vocosorc.json`) is found by walking
up from the working directory. Every field below is optional unless marked
**required**. `types/index.d.ts` gives you autocomplete for all of it.

```js
import { defineConfig } from "vocoso";
export default defineConfig({ /* ... */ });
```

A config may also export a function — `({ cwd, env }) => config` — which is the
clean way to switch base URLs per environment.

---

## Top level

| field | default | meaning |
| --- | --- | --- |
| `mode` | `"voice"` | `"voice"` drives a spoken session; `"chat"` types into a composer. |
| `reportDir` | `"vocoso-reports"` | One directory per run is created inside. |
| `cacheDir` | `".vocoso"` | Synthesized clips live here. Safe to delete; safe to commit if you want reproducible audio. |

## `app`

| field | default | meaning |
| --- | --- | --- |
| `baseUrl` | `http://localhost:3000` | **Required.** Where your app is. |
| `path` | `"/"` | The page that hosts the assistant. |
| `readyTimeoutMs` | `180000` | Navigation budget. |
| `start` | `null` | How to start the app. Omit it and VoCoSo requires something to already be listening. |
| `auth` | `null` | How to be signed in. |

**`app.start`** is only used when nothing answers `baseUrl` — an already-running
server is always reused, because a cold start dwarfs the conversation.

```js
start: {
  command: "npm run dev",         // or ["node", "server.mjs"]
  cwd: "./",
  env: { DATABASE_URL: "..." },
  readyPath: "/",
  readyTimeoutMs: 180000,
}
```

VoCoSo owns the whole process group, so a crashed run never orphans a server on
the port. Output goes to `app-server.log` in the run directory, and its tail is
quoted in the diagnosis when the server fails to come up.

**`app.auth`** — pick whichever fits:

```js
auth: {
  storageState: "auth.json",           // npx playwright open --save-storage=auth.json <url>
  cookies: [{ name: "session", value: "...", url: "http://localhost:3000" }],
  headers: { Authorization: "Bearer ..." },
  localStorage: { "feature-flags": "{\"voice\":true}" },
  script: async ({ page, context, config }) => { /* anything else */ },
}
```

If the app rejects these, the diagnosis says `AUTH_REJECTED` and quotes the 401
rather than blaming a selector.

## `browser`

`engine` (`chromium` | `firefox` | `webkit`), `headless` (default `true`,
`--headed` overrides), `slowMo`, `channel`, `viewport`, `permissions` (default
`["microphone"]`), `args`, `fullPageScreenshots`.

The default args grant the microphone without a prompt and allow audio to start
without a user gesture — the rig has no gesture to offer.

## `voice`

| field | meaning |
| --- | --- |
| `start` | **Required in voice mode.** The control that opens the live session. |
| `enter` | Optional control that switches the UI into voice mode first. Clicked only when its `aria-pressed` is not `"true"`. |
| `stop` | Optional control that ends the session politely at the end of a run. |
| `statusSelector` / `statusAttribute` | Where the app publishes session state. Default attribute `data-status`. |
| `liveStatuses` / `deadStatuses` | Which values mean up and down. |
| `connectAttempts` | Default `3`. A slow transport is worth more than one press before declaring the stack broken. |

**Liveness is three signals agreeing**: the status control, a microphone the app
is actually holding, and a transport that has carried a frame. Any one alone
lies — a status attribute can say `listening` over a dead peer connection.

## `chat`

`input` and `send` are **required** in chat mode. `assistantMessage` lets
VoCoSo count replies; `doneWhen` is a selector that appears when streaming has
finished, and is the most reliable signal if your app exposes one. Otherwise a
reply is finished when a new message has appeared and the transport has been
quiet for `quietMs` (default 1500).

## `transport`

```js
transport: {
  preset: "auto",           // or a name, an array of names, or a function
  speakingThreshold: 0.01,  // output RMS above which the assistant counts as speaking
}
```

Names: `openai-realtime`, `gemini-live`, `elevenlabs-agent`, `deepgram-agent`,
`openai-chat-sse`, `vercel-ai-data-stream`, `app-events`.

`"auto"` runs every preset and de-duplicates, so it usually works before you
have told it anything. Pin it once you know yours: a pinned preset makes an
unmatched frame a *finding* rather than a shrug.

For a bespoke transport, one line in your app beats writing a preset:

```js
window.__vocoso?.emit("assistant.text", { text, final: true });
window.__vocoso?.emit("tool.call", { name, arguments: JSON.stringify(args) });
window.__vocoso?.emit("surface.spec", { spec });
```

## `tts`

```js
tts: {
  provider: "auto",   // prerecorded | say | piper | espeak | openai | your object
  voice: "Samantha",
  fallbackVoices: ["Alex"],
  options: { dir: "./recordings" },   // prerecorded
  minRms: 0.005,
}
```

`"auto"` prefers recordings, then macOS `say`, Piper, espeak-ng, and hosted
OpenAI last. Clips are cached by content hash of provider + voice + options +
text, so changing a voice does not silently reuse the old audio.

Every clip is measured before it is used and before it is cached: duration
against word count, and real signal energy. A clip that measures as silence is
never cached and never played, because one poisoned cache entry otherwise makes
every later run speak nothing while reporting success.

`prerecorded` maps an utterance to `<dir>/<slugified-text>.wav`, so real human
recordings can be dropped in over time.

## `surfaces`

The generative-surface oracle. Everything here is optional; each field switches
on one check.

```js
surfaces: {
  capture: { from: "events" },              // events | expression | response
  elementsPointer: "auto",                  // "auto" finds anything with a string `type`
  rootPointer: "/root",
  typeKey: "type",
  propsKey: "props",

  catalog: ["ResponseFrame", "Field", "Action"],   // null disables
  requireRootType: "ResponseFrame",
  requireAction: false,

  referenceForms: ["$state", "$ref", "$item"],     // how your specs denote a binding
  writeForms: ["$bindState"],
  forbiddenWritePaths: ["/data", "/runtime", "/state"],
  authoritativePathPrefixes: ["/results"],

  proseProps: ["title", "label", "text", "description"],
  minFactLength: 6,

  operations: [{ id: "calendar.add", version: 1, requiredInputs: ["reference"] }],
  actionableTypes: ["Action", "Input"],

  ignoreRules: [],   // rule names to downgrade to informational
}
```

### Capture

- `from: "events"` — the spec or a JSON-patch stream arrives on the transport.
  Patches are applied in order, so the oracle sees the assembled surface.
- `from: "expression"` — the app already keeps it somewhere:
  `capture: { from: "expression", expression: "window.__app.lastSpec" }`.
- `from: "response"` — it comes back whole in an HTTP body:
  `capture: { from: "response", responses: [{ url: "/api/chat" }], at: "/surface" }`.

### The rules, and what each one is protecting you from

| rule | fires when | why it matters |
| --- | --- | --- |
| `catalog` | a component is not in `catalog` | The prompt's component list has drifted from the renderer's. Renders as a blank. |
| `root` | the root is not `requireRootType` | Layout contract broken. |
| `grounding` | a prose prop contains an authoritative value verbatim | **The important one.** The model retyped a fact instead of binding it. Renders perfectly; goes stale silently. |
| `reference-unresolved` | a binding does not resolve against the state | The model guessed the result shape. Renders as a blank. |
| `reference-scope` | a binding points outside `authoritativePathPrefixes` | It is reading something it was not given. |
| `write-firewall` | the spec writes authoritative state | A surface that can write its own source of truth can fabricate a fact and then cite it. |
| `action-unknown` / `action-version` | the operation is not in `operations`, or the version is wrong | The button will 404 or hit the wrong contract. |
| `action-literal` | an operation input is a literal, not a reference | The model invented the argument it is about to submit. |
| `action-host` | a non-actionable component carries an operation | A control the user cannot reach, or one they can reach by accident. |
| `amendment-removed` / `amendment-retyped` | a revision dropped or retyped an element key | The UI rebuilds instead of updating: focus, scroll, and typed input are lost. |

## `facts`

What the surface is allowed to draw from.

- `"tool-results"` (default) — this run's tool results, shaped as
  `{ results: [{ name, callId, result }] }`. References look like
  `/results/0/result/...`.
- `"evidence"` — the evidence results, keyed by name.
- `"none"` — skip grounding and resolution checks.
- a function — `({ events, evidence, config }) => state`.

## `evidence`

Did the app actually do the thing? Read after the conversation, with polling —
the writes that matter usually land after the last word.

```js
evidence: [
  { name: "reservation-created", kind: "http", url: "/api/reservations?limit=1",
    at: "/items/0/confirmation", waitMs: 15000,
    satisfied: (value) => typeof value === "string" },

  { name: "row-written", kind: "command",
    command: "psql -At -c \"select count(*) from reservations\" | head -1",
    satisfied: (value) => Number(value) > 0 },

  { name: "audit-log", kind: "file", path: "./tmp/audit.jsonl",
    satisfied: (rows) => rows.some((row) => row.action === "reservation.create") },

  { name: "anything", kind: "custom", read: async () => myClient.check() },
]
```

`kind: "command"` covers databases without VoCoSo taking a driver dependency:
anything whose stdout is JSON or JSONL works, including `psql -At`,
`sqlite3 -json`, and a prisma script.

## `gates`

```js
gates: {
  requireAllExpectations: true,
  maxUnmatchedFrames: null,   // set a number once your preset is pinned
  latency: {
    speechEndToAssistantAudioMs: { p50: 1200, p95: 2500 },
    speechEndToTranscriptMs: { p95: 900 },
  },
}
```

Latency is measured from the moment the injected clip stopped playing, which is
the closest thing to "the user stopped talking" that exists.

## `heal`

```js
heal: {
  recover: { enabled: true, maxPerRun: 6 },
  patch: {
    enabled: false,
    provider: "anthropic",       // "openai", or ({ system, prompt, model, apiKey }) => Promise<string>
    model: null,                 // provider default
    apiKey: undefined,           // else ANTHROPIC_API_KEY / OPENAI_API_KEY
    paths: [],                   // required when enabled; no default, on purpose
    apply: false,                // false proposes; true applies, verifies, and reverts on failure
    requireCleanTree: true,
    maxAttempts: 2,
  },
}
```

Patching also needs `--heal` on the command line. Both, every time: a config
that quietly edits source on CI is not something to enable by accident.

## `hooks`

```js
hooks: {
  beforeSession: async ({ page, config, logger }) => {},          // seed data, dismiss a modal
  afterStep: async ({ step, outcome, checks, page }) => {},
  afterRun: async ({ report, findings, healing }) => {},          // post to Slack, write a badge
}
```

## `timeouts`

`transcript` (25000), `response` (90000), `settle` (1500). `settle` is how long
the transport must be quiet before a turn counts as finished — raise it for a
model that pauses mid-answer.
