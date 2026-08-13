# Changelog

## 0.1.0

First public release.

- Self-driving voice conversations through a controllable fake microphone:
  per-turn utterances, real silence between them, and mid-reply barge-in.
- Text chat driver with the same expectations and the same oracles.
- Transport tap over WebRTC data channels, WebSockets, EventSource, and
  streaming fetch, with presets for OpenAI Realtime, Gemini Live, ElevenLabs,
  Deepgram, OpenAI-compatible chat SSE, and the Vercel AI SDK data stream.
  `auto` runs them all and de-duplicates.
- Output loudness metering, so "is the assistant speaking" is answered from
  audio energy and not only from provider events.
- Generative-surface oracle: catalog, root type, grounding (facts referenced
  rather than retyped), reference resolution, state-write firewall, operation
  descriptors, and amendment key stability. Usable standalone via
  `vocoso check`.
- Evidence checks over HTTP, shell commands, files, or your own function.
- Latency budgets measured from the end of the injected clip.
- In-run recovery with a maintenance log, and flapping reported as a finding.
- Rule-based diagnosis that names the fault as rig, app, or external.
- Opt-in LLM patch proposal, scoped, dirty-tree-refusing, propose-by-default,
  self-reverting when the patch does not fix the run.
- `vocoso doctor`: proves the audio path with no app and no API key.
- Bundled demo assistant with switchable defects.
