# Contributing

Thanks for looking. The most useful contributions, roughly in order:

1. **A transport preset for a provider VoCoSo does not know yet.** About thirty lines.
2. **A diagnosis rule** for a failure you hit that the report explained badly.
3. **A TTS provider** for a platform that is awkward today.
4. Bug reports with a `report.json` attached — it holds everything needed to reproduce.

## Setup

```sh
npm install
npx playwright install chromium
npm test                    # unit tests, no browser, no network
npx vocoso doctor           # audio path, browser only
npx vocoso run examples/demo-app/scripts/books-a-table.json -c examples/demo-app/vocoso.config.mjs
```

There is no build step and no transpiler. Source is plain ESM JavaScript with
JSDoc; types live in `types/index.d.ts` and are maintained by hand.

## Adding a transport preset

Presets never touch page code. The injected tap records raw frames; a preset is
a pure function from one message to VoCoSo's vocabulary.

1. Capture real frames. Run against your provider once and read
   `report.json` → `transport.unmatched` — those samples are exactly what your
   preset must map.
2. Add it to `src/transport/presets.mjs`:

```js
export const myProvider = {
  name: "my-provider",
  matches: (payload) => typeof payload.json?.event === "string",
  map(payload) {
    switch (payload.json.event) {
      case "stt.final": return { kind: "user.transcript", text: payload.json.text, final: true };
      case "tts.start": return { kind: "assistant.audio.start" };
      default: return null;
    }
  },
};
```

3. Register it in `BUILT_IN_PRESETS`.
4. Add a test in `test/transport.test.mjs` using the `frame()` helper. Feed it
   the frames you captured, assert the event kinds.

`matches` should be cheap and specific: `auto` mode runs every preset over every
frame, and a greedy matcher makes another provider's run noisy.

Keep the vocabulary as it is. Presets translate; they do not extend. If a
provider genuinely exposes something no kind covers, open an issue first — a new
kind means every oracle has to decide what to do with it.

## Adding a diagnosis rule

`src/heal/diagnose.mjs` is a flat list of rules over the assembled report. A good
rule:

- **fires only when it is right.** A false diagnosis is worse than none; it sends
  someone to the wrong file.
- **names the fault** as `rig`, `app`, or `external`. This decides whether the
  self-healing step is even allowed to look at it.
- **quotes what was observed** verbatim. Never paraphrase an error.
- **gives a fix that is a next action**, not a restatement of the problem.

Add a case to `test/diagnose.test.mjs` with a minimal report shape.

## Style

- ESM, `.mjs`, Node ≥ 20.11. No dependencies in `src/` — that constraint is
  load-bearing, since this installs into other people's test suites.
- Comment *why*, not *what*. Most comments here exist because something failed
  in a surprising way once; keep that shape.
- Anything a user reads — a log line, a finding, an error — is a sentence written
  for someone who is tired. Say what happened and what to do.

## Tests

`npm test` must pass with no browser and no network. Anything needing Chromium
goes in the demo-app example and runs in the `e2e` CI job.

## Releasing

Maintainers: bump `version` in `package.json` and `VERSION` in `src/run.mjs`
(they are asserted equal in CI), tag, and publish.
