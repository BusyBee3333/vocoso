/** Files written by `vocoso init`. Kept as strings so init needs no assets. */

export const STARTER_CONFIG = `import { defineConfig } from "vocoso";

export default defineConfig({
  // "voice" drives a spoken session through a fake microphone.
  // "chat" types into your composer. Start with chat: it is faster and free.
  mode: "voice",

  app: {
    baseUrl: "http://localhost:3000",
    path: "/assistant",

    // Optional. If something is already listening on baseUrl, VoCoSo attaches
    // to it and never starts anything.
    // start: { command: "npm run dev", readyPath: "/", readyTimeoutMs: 180000 },

    // Your app almost certainly needs a signed-in session. Capture one with:
    //   npx playwright open --save-storage=auth.json http://localhost:3000
    // auth: { storageState: "auth.json" },
  },

  // Selectors for the controls that open a live voice session.
  voice: {
    enter: '[data-testid="voice-mode-toggle"]', // optional: switch into voice mode
    start: '[data-testid="voice-start"]',       // required: opens the session
    stop: '[data-testid="voice-stop"]',         // optional: ends it politely
    statusSelector: '[data-testid="voice-start"]',
    statusAttribute: "data-status",
    liveStatuses: ["listening", "speaking", "thinking"],
    deadStatuses: ["idle", "error"],
  },

  // Selectors for text chat (mode: "chat").
  chat: {
    input: '[data-testid="composer"]',
    send: '[data-testid="send"]',
    assistantMessage: '[data-role="assistant"]',
  },

  // "auto" tries every built-in provider mapping. Pin it once you know yours:
  // openai-realtime | gemini-live | elevenlabs-agent | deepgram-agent
  // openai-chat-sse | vercel-ai-data-stream | app-events
  transport: { preset: "auto" },

  // How utterances are spoken. "auto" picks the best available on this machine.
  tts: { provider: "auto" },

  // The generative-surface oracle. Leave the catalog null until you are ready:
  // every other check still runs.
  surfaces: {
    capture: { from: "events" },
    // catalog: ["Card", "Text", "Table", "Action"],
    // requireRootType: "ResponseFrame",
    // operations: [{ id: "contacts.create", version: 1 }],
  },

  // Did the app actually change? This is the check a transcript cannot make.
  evidence: [
    // {
    //   name: "contact-created",
    //   kind: "http",
    //   url: "/api/contacts?limit=1",
    //   at: "/items/0/name",
    //   waitMs: 15000,
    //   satisfied: (value) => typeof value === "string" && value.length > 0,
    // },
  ],

  gates: {
    requireAllExpectations: true,
    // latency: { speechEndToAssistantAudioMs: { p95: 2500 } },
  },

  // Opt-in self-healing. Off until you scope it to files you are happy for a
  // model to edit, and it proposes rather than applies until you say otherwise.
  heal: {
    recover: { enabled: true },
    patch: {
      enabled: false,
      provider: "anthropic",
      paths: ["src/**"],
      apply: false,
    },
  },
});
`;

export const STARTER_SCRIPT = JSON.stringify({
  name: "first-conversation",
  description: "A smoke test: can it hear me, answer me, and act?",
  steps: [
    {
      say: "Hi there. Can you hear me?",
      expect: { heard: true, responded: true },
    },
    {
      say: "What can you help me with?",
      expect: { heard: true, responded: true },
      thenWaitMs: 1000,
    },
    {
      bargeIn: "Actually, hold on.",
      note: "Interrupt mid-answer: the assistant must stop talking.",
      expect: { interrupted: { withinMs: 2500 } },
    },
  ],
}, null, 2) + "\n";
