# VoCoSo

[![ci](https://github.com/BusyBee3333/vocoso/actions/workflows/ci.yml/badge.svg)](https://github.com/BusyBee3333/vocoso/actions/workflows/ci.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![node](https://img.shields.io/badge/node-%E2%89%A520.11-brightgreen.svg)](package.json)

**Vo**ice · **Co**nversation · **So**urce-of-truth — self-driving tests for voice and chat AI, including the generative surfaces they draw.

VoCoSo holds a real, multi-turn conversation with your assistant, with no human in the loop: it synthesizes speech into a microphone your app genuinely opens, listens to the transport, watches the audio come back out, judges the UI the model composed, checks that your system actually changed, and — when something breaks — tells you what broke, whose fault it is, and what to change.

MIT licensed. Zero runtime dependencies. Playwright is an optional peer.

```sh
npm i -D vocoso playwright && npx playwright install chromium
npx vocoso init
npx vocoso doctor      # proves the rig works. No app, no API key, ~5 seconds.
npx vocoso run vocoso/first-conversation.json
```

---

## The problem

Testing a conversational AI has an oracle problem: there is no expected output. Two different answers can both be right, two different layouts can both be good, and the model will phrase it differently tomorrow. So most teams end up with a suite of `expect(response).toContain("booked")` — which passes when the product is broken, fails when the product is fine, and gets deleted after a month.

VoCoSo doesn't try to judge whether the answer was *good*. It judges whether the system did what a working system must do. Every one of those is decidable without a human, because the rig either authored the input or can read the ground truth:

| Question | How it is decided, with no human and no judge model |
| --- | --- |
| Did it hear me? | The rig wrote the sentence. Score the transcript against it by word error rate. |
| Did it answer? | Provider events **and** measured audio energy at the output. |
| Did it yield when interrupted? | Speak mid-reply; time how long the output stays loud. |
| Did it call the right tool, with the right arguments? | Read the tool call off the transport. |
| Is every fact on screen real? | Every rendered value must be a **reference** into authoritative state, never a literal the model retyped. |
| Is every button real? | Every control must be a descriptor of an operation your server actually exposes, at the right version, with referenced inputs. |
| Did anything actually happen? | Read your own API, database, or log after the conversation ends. |
| Was it fast enough? | Measured from the moment the injected clip stopped playing. |

## The idea worth stealing

If you only take one thing from this repo, take the **grounding check**.

A model that composes UI can put a fact on screen two ways. It can *bind* to the value your tool returned:

```json
{ "type": "Field", "props": { "label": "Restaurant", "value": { "$state": "/results/0/result/restaurant" } } }
```

Or it can *type it out*:

```json
{ "type": "Field", "props": { "label": "Restaurant: Northgate Supper Club" } }
```

Both render identically. A screenshot test passes. A human reviewing it sees the right name. The second one is still broken — the value is now a string the model produced rather than a value from your system, and the moment the reservation changes, the UI will confidently show the old one. That class of bug is invisible to every conventional test and obvious to a checker that knows what the tool returned:

```
FAIL  surface: grounding: where.label retypes the authoritative value
      "Northgate Supper Club" instead of binding to it
```

You can run this check on its own, offline, with no browser and no model, against any spec your app already produces:

```sh
npx vocoso check surface.json --state tool-results.json
```

## See it work in 30 seconds

The repo ships a ~200-line fake assistant with switchable defects. No API key, no account, no model calls.

```sh
git clone https://github.com/BusyBee3333/vocoso && cd vocoso
npm i && npx playwright install chromium

npx vocoso run examples/demo-app/scripts/books-a-table.json -c examples/demo-app/vocoso.config.mjs
npx vocoso run examples/demo-app/scripts/catches-a-bug.json -c examples/demo-app/vocoso.config.mjs
```

The second run fails, for the right reason, with a fix attached. See [`examples/demo-app`](examples/demo-app) for the full list of defects you can switch on (`?bug=grounding`, `catalog`, `phantom`, `literal`, `silent`).

## How the voice path works

Chromium's `--use-file-for-fake-audio-capture` loops one file for the whole browser lifetime. That is enough for a single canned utterance and useless for a conversation: no per-turn speech, no silence between turns, no barge-in.

VoCoSo overrides `getUserMedia` instead and hands your app a `MediaStreamAudioDestinationNode` it controls. A zero-amplitude constant source keeps the track producing silent frames, so server-side voice-activity detection hears a live, quiet microphone rather than a dead one. Utterances are decoded into that stream one at a time — which is what makes multi-turn conversations and mid-reply interruptions possible.

Coming back the other way, "is the assistant speaking?" is answered **two** ways: from provider events when they exist, and from actual audio energy metered off `<audio>` elements, WebRTC tracks, and anything routed to an `AudioContext` destination. That second path is why VoCoSo can drive a provider it has never seen — and why it catches the failure where the events claim speech that never reached a speaker:

```
FAIL  DEAD_AIR: audio was announced but no sound was ever measured
```

`vocoso doctor` proves this whole path against an `AnalyserNode`, with no app involved, so an audio problem never gets misdiagnosed as an app problem.

## Transport support

The injected tap records raw frames from WebRTC data channels, WebSockets, `EventSource`, and streaming `fetch` — and nothing else. All interpretation happens in Node, as small pure functions, so adding a provider is a mapping and never a change to page code.

Built in: **OpenAI Realtime** · **Gemini Live** · **ElevenLabs Conversational AI** · **Deepgram Voice Agent** · **OpenAI-compatible chat SSE** · **Vercel AI SDK data stream** · **your own events**.

`transport.preset` defaults to `"auto"`, which runs every mapping and de-duplicates — so it usually works before you have told it anything. If your transport is bespoke, one line in your app is enough:

```js
window.__vocoso?.emit("assistant.text", { text, final: true });
```

And if nothing matches, VoCoSo says so precisely, with samples of the frames it did not understand — rather than reporting silence:

```
[rig] PRESET_UNMATCHED: 42 frames, 0 recognised events
      unmatched: {"kind":"bespoke.turn.delta", ...}
```

## Self-healing

Three layers, in increasing order of how much you have to trust it.

**1. Recovery (on by default).** Sessions die for reasons that are not defects in your product: a dev server hot-reloads and tears down the audio hook, a page navigates and loses the tap, a transport reconnects between turns. VoCoSo repairs those and keeps going, recording each one. A run that needed three repairs still reports them — because *flapping* is itself a finding:

```
SESSION_FLAPPING: the session had to be re-established 4 times
```

**2. Diagnosis (on by default).** Every failure is run through a rule table that answers three questions instead of one: what was observed, what most likely causes it, and what to change. Each finding is tagged `rig` / `app` / `external`, which is the single most useful bit when a suite goes red at 2am.

```
1. [app] The assistant produced words but no audible speech  (NO_ASSISTANT_AUDIO, likely)
   observed: 3 assistant text event(s), 0 audio starts, 0 metered outputs
   cause:    The model answered and the client never played it: a muted element,
             a stream attached to the wrong element, or blocked autoplay.
   fix:      Check where the remote audio track is attached and whether that element is playing.
   fix:      This is the failure users describe as "it hears me but I hear nothing".
```

**3. Patching (off by default, opt-in twice).** With `heal.patch.enabled` in config *and* `--heal` on the command line, VoCoSo sends the diagnosis and the in-scope source to a model and asks for a unified diff. It is fenced on every side: scoped to `heal.patch.paths` (no default), refuses to run on a dirty tree, **proposes** rather than applies unless you set `apply: true`, and when it does apply it re-runs the failing script and reverts itself if the run is not green. It never stages, never commits, never pushes. It also declines findings it should decline — a provider 429 and a wrong selector in your own config are not defects in your application.

```js
heal: {
  patch: {
    enabled: true,
    provider: "anthropic",     // or "openai", or your own function
    paths: ["src/prompts/**", "src/surfaces/**"],
    apply: false,              // write the patch; you review and apply it
  },
}
```

## Configuration

`vocoso init` writes a commented starter. The full reference is in [`docs/configuration.md`](docs/configuration.md), and [`types/index.d.ts`](types/index.d.ts) gives you autocomplete in `vocoso.config.mjs`.

```js
import { defineConfig } from "vocoso";

export default defineConfig({
  mode: "voice",
  app: {
    baseUrl: "http://localhost:3000",
    path: "/assistant",
    auth: { storageState: "auth.json" },
  },
  voice: {
    enter: '[data-testid="voice-mode-toggle"]',
    start: '[data-testid="voice-start"]',
    statusSelector: '[data-testid="voice-start"]',
    liveStatuses: ["listening", "speaking", "thinking"],
    deadStatuses: ["idle", "error"],
  },
  surfaces: {
    catalog: ["ResponseFrame", "Field", "Table", "Action"],
    requireRootType: "ResponseFrame",
    authoritativePathPrefixes: ["/results"],
    operations: [{ id: "calendar.add", version: 1 }],
  },
  evidence: [{
    name: "reservation-created",
    kind: "http",
    url: "/api/reservations?limit=1",
    at: "/items/0/confirmation",
    satisfied: (value) => typeof value === "string",
  }],
});
```

## Conversation scripts

JSON so a non-engineer can write one; `.mjs` when the expectations want real functions.

```json
{
  "name": "books-a-table",
  "steps": [
    {
      "say": "Can you find me a table for two on Friday?",
      "expect": {
        "heard": true,
        "toolCalled": [{ "name": "reservations.search", "argumentsInclude": { "partySize": 2 } }],
        "surface": { "usesComponents": ["Field", "Action"] }
      }
    },
    {
      "bargeIn": "Actually, make it four.",
      "note": "Interrupt mid-answer; it must yield within 2.5s.",
      "expect": { "interrupted": { "withinMs": 2500 } }
    }
  ]
}
```

## Speech

`tts.provider: "auto"` picks the best backend available on the machine: pre-recorded clips → macOS `say` → Piper → espeak-ng → hosted OpenAI. Clips are cached by content, so a suite costs nothing to re-run.

Every clip is **measured before it is trusted**, and this matters more than it sounds. Every TTS backend can fail silently: the process exits 0 and writes a well-formed file containing nothing audible. Cache one of those and the rig speaks nothing forever while reporting success. VoCoSo checks both duration against word count *and* real signal energy, and refuses to cache — or keep — a clip that measures as silence.

## Reports

One directory per run, written even when the run blows up:

```
vocoso-reports/books-a-table-2026-08-13T09-14-02/
  report.json       everything: events, turns, timings, surfaces, checks, diagnosis
  summary.md        readable, diffable, pasteable into an issue
  index.html        screenshots, conversation, findings
  01-chat-open.png  …
  proposed.patch    if --heal ran
```

`vocoso explain <report.json>` re-prints the diagnosis for any past run.

## Programmatic use

```js
import { loadConfig, loadScript, runScript, evaluateSurface } from "vocoso";

const { report } = await runScript({
  config: await loadConfig(),
  script: await loadScript("vocoso/books-a-table.json"),
});
assert(report.passed);

// The surface oracle is useful entirely on its own — no browser, no model.
const outcome = evaluateSurface({ spec, state: toolResults, config: { catalog } });
```

## What this is not

- **Not a quality judge.** It will not tell you the answer was unhelpful, rude, or wrong-but-plausible. That needs a human or a judge model. Use an eval framework for that, and VoCoSo for whether the machinery works.
- **Not a load tester.** One conversation at a time, on purpose.
- **Not a mock.** It drives your real app against your real provider. Live runs cost real tokens. `vocoso check` and the unit tests cost nothing.
- **Not a replacement for a production canary.** A local run cannot prove your deployed release works.

## Contributing

New transport presets are the most valuable contribution and the easiest: a preset is one `matches` and one `map`, about thirty lines, with a test that feeds it recorded frames. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

Extracted and generalized from a private voice-copilot QA rig, where it earned its two hardest lessons: never trust a TTS exit code, and never trust a single signal for "is it speaking".

MIT © Jake Shore
