/** Everything VoCoSo assumes when a config leaves it out. */

export const DEFAULT_CONFIG = {
  name: "vocoso",
  mode: "voice",
  reportDir: "vocoso-reports",
  cacheDir: ".vocoso",

  app: {
    baseUrl: "http://localhost:3000",
    path: "/",
    start: null,
    auth: null,
    readyTimeoutMs: 180_000,
  },

  browser: {
    headless: true,
    slowMo: 0,
    viewport: { width: 1440, height: 900 },
    permissions: ["microphone"],
    args: [
      // Grant the mic without a prompt, and let audio start without a click:
      // the rig has no user gesture to offer.
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  },

  voice: {
    enter: null,
    start: null,
    stop: null,
    statusSelector: null,
    statusAttribute: "data-status",
    liveStatuses: ["listening", "live", "connected", "speaking", "thinking", "active"],
    deadStatuses: ["idle", "error", "disconnected", "off"],
    connectTimeoutMs: 60_000,
    connectAttempts: 3,
  },

  chat: {
    input: null,
    send: null,
    message: null,
    assistantMessage: null,
    quietMs: 1_500,
    responseTimeoutMs: 90_000,
  },

  transport: {
    preset: "auto",
    speakingThreshold: 0.01,
  },

  tts: {
    provider: "auto",
    voice: undefined,
    options: {},
    minRms: 0.005,
  },

  surfaces: {
    capture: { from: "events" },
    catalog: null,
    requireRootType: null,
    requireAction: false,
    operations: [],
    actionableTypes: [],
    ignoreRules: [],
  },

  facts: { from: "tool-results" },

  evidence: [],

  gates: {
    requireAllExpectations: true,
    maxUnmatchedFrames: null,
    latency: null,
  },

  heal: {
    recover: {
      enabled: true,
      maxPerRun: 6,
    },
    patch: {
      enabled: false,
      provider: "anthropic",
      model: null,
      paths: [],
      maxAttempts: 2,
      apply: false,
      requireCleanTree: true,
    },
  },

  timeouts: {
    transcript: 25_000,
    response: 90_000,
    settle: 1_500,
  },
};

/** Deep merge that treats arrays as replacements, which is what config wants. */
export function mergeConfig(base, override) {
  if (override === undefined || override === null) return base;
  if (Array.isArray(base) || Array.isArray(override)) return override;
  if (typeof base !== "object" || typeof override !== "object" || base === null) return override;
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = key in base ? mergeConfig(base[key], value) : value;
  }
  return merged;
}
