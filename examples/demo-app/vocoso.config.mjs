/**
 * Config for the bundled demo assistant. This is a complete, working example:
 * every field is one you would fill in for your own app.
 */
export default {
  mode: "chat",
  reportDir: "reports",

  app: {
    baseUrl: process.env.DEMO_URL ?? "http://localhost:4321",
    path: process.env.DEMO_PATH ?? "/",
    start: {
      command: ["node", new URL("./server.mjs", import.meta.url).pathname],
      readyPath: "/",
      readyTimeoutMs: 20_000,
    },
  },

  chat: {
    input: '[data-testid="composer"]',
    send: '[data-testid="send"]',
    assistantMessage: '[data-role="assistant"]',
  },

  // The demo streams Vercel-AI-SDK-shaped parts over SSE; "auto" finds them
  // without being told, which is what you want on day one.
  transport: { preset: "auto" },

  surfaces: {
    capture: { from: "events" },
    catalog: ["ResponseFrame", "Field", "Action", "Text"],
    requireRootType: "ResponseFrame",
    authoritativePathPrefixes: ["/results"],
    operations: [{ id: "calendar.add", version: 1 }],
    actionableTypes: ["Action"],
  },

  // Facts default to this run's tool results: the model may show what the
  // system returned and nothing else.
  facts: { from: "tool-results" },

  evidence: [
    {
      name: "reservation-readable",
      kind: "http",
      url: "/api/reservations",
      at: "/items/0/confirmation",
      waitMs: 5_000,
      satisfied: (value) => typeof value === "string" && value.startsWith("NGS-"),
    },
  ],

  gates: { requireAllExpectations: true },
};
