/**
 * VoCoSo - self-driving tests for voice and chat AI that render generative
 * surfaces. These types exist mainly so your editor can autocomplete
 * vocoso.config.mjs; the runtime is plain ESM JavaScript.
 */

export type Mode = "voice" | "chat";

export type TransportPresetName =
  | "openai-realtime"
  | "gemini-live"
  | "elevenlabs-agent"
  | "deepgram-agent"
  | "openai-chat-sse"
  | "vercel-ai-data-stream"
  | "app-events";

/** One message the tap recorded, already split out of any batch. */
export interface FramePayload {
  at: number;
  source: "webrtc" | "websocket" | "sse" | "fetch-stream" | "app";
  dir: "in" | "out" | "meta";
  json?: unknown;
  text: string;
  meta?: Record<string, unknown> | null;
}

export type EventKind =
  | "session.open"
  | "user.speech.start"
  | "user.speech.stop"
  | "user.transcript"
  | "assistant.text"
  | "assistant.audio.start"
  | "assistant.audio.stop"
  | "assistant.done"
  | "tool.call"
  | "tool.result"
  | "surface.spec"
  | "surface.patch"
  | "error";

export interface ConversationEvent {
  at: number;
  kind: EventKind;
  preset: string;
  source: string;
  dir: string;
  text?: string;
  final?: boolean;
  modality?: "audio" | "text";
  name?: string | null;
  callId?: string | null;
  arguments?: string | null;
  result?: unknown;
  spec?: unknown;
  patch?: unknown;
  code?: string | null;
  message?: string;
  status?: string | null;
}

export interface TransportPreset {
  name: string;
  matches(payload: FramePayload): boolean;
  map(payload: FramePayload): object | object[] | null;
}

export interface TtsProvider {
  name: string;
  defaultVoice: string;
  fallbackVoices: string[];
  available(options?: Record<string, unknown>): boolean;
  unavailableHint: string;
  synthesize(input: {
    text: string;
    outPath: string;
    voice: string;
    options: Record<string, unknown>;
  }): void | Promise<void>;
}

export interface EvidenceCheck {
  name: string;
  kind: "http" | "command" | "file" | "custom";
  /** http */
  url?: string | ((context: EvidenceContext) => string);
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** command: a string run through sh, or an argv array */
  command?: string | string[] | ((context: EvidenceContext) => string | string[]);
  cwd?: string;
  env?: Record<string, string>;
  /** file */
  path?: string;
  /** custom */
  read?: (context: EvidenceContext) => unknown | Promise<unknown>;
  /** JSON pointer applied to whatever was read, before `satisfied` */
  at?: string;
  /** Defaults to "something non-empty came back". */
  satisfied?: (value: unknown, context: EvidenceContext) => boolean;
  waitMs?: number;
  pollMs?: number;
  timeoutMs?: number;
}

export interface EvidenceContext {
  baseUrl: string;
  cwd: string;
  headers?: Record<string, string>;
  startedAt: number;
  events: ConversationEvent[];
  config: ResolvedConfig;
}

export interface SurfaceOracleConfig {
  /** Where the elements live. "auto" finds anything with a string `type`. */
  elementsPointer?: string;
  rootPointer?: string;
  typeKey?: string;
  propsKey?: string;
  childrenKey?: string;
  /** Components the host actually renders. Null disables the check. */
  catalog?: string[] | null;
  requireRootType?: string | null;
  /** Fail a surface that offers no server-bound control. */
  requireAction?: boolean;
  /** Keys that denote a reference to state, e.g. `{ $state: "/results/0" }`. */
  referenceForms?: string[];
  /** Keys that denote a write. A generated surface should have none. */
  writeForms?: string[];
  forbiddenWritePaths?: string[];
  /** References must start with one of these, if given. */
  authoritativePathPrefixes?: string[];
  /** Props whose strings are user-visible prose, and so must not carry facts. */
  proseProps?: string[];
  minFactLength?: number;
  operations?: Array<string | { id: string; version?: unknown; requiredInputs?: string[] }>;
  actionableTypes?: string[];
  /** Rule names to downgrade to informational. */
  ignoreRules?: string[];
  action?: {
    prop?: string;
    kindKey?: string;
    operationKind?: string;
    operationKey?: string;
    versionKey?: string;
    inputKey?: string;
  };
  capture?: {
    from?: Array<"events" | "expression" | "response"> | "events" | "expression" | "response";
    /** JS evaluated in the page, e.g. "window.__myApp.lastSpec" */
    expression?: string;
    /** Response URLs to capture, for `from: "response"` */
    responses?: Array<{ url: string }>;
    /** JSON pointer into the captured body */
    at?: string;
  };
}

export interface StepExpectations {
  /** The transcript must match what the rig spoke. */
  heard?: boolean | { maxWordErrorRate?: number };
  responded?: boolean | { modality?: "audio" | "text" | "any" };
  mentions?: string | string[];
  doesNotMention?: string | string[];
  toolCalled?: string | Array<string | { name: string; argumentsInclude?: Record<string, unknown> }>;
  noToolCalled?: string | string[];
  /** After a barge-in: the assistant must stop speaking within the budget. */
  interrupted?: boolean | { withinMs?: number };
  surface?: boolean | (SurfaceOracleConfig & {
    state?: unknown;
    usesComponents?: string | string[];
  });
}

export type Step =
  | string
  | { say: string; expect?: StepExpectations; waitForResponse?: boolean; thenWaitMs?: number; responseTimeoutMs?: number; note?: string; skip?: boolean; screenshot?: boolean }
  | { type: string; expect?: StepExpectations; waitForResponse?: boolean; thenWaitMs?: number; responseTimeoutMs?: number; note?: string; skip?: boolean }
  | { bargeIn: string; maxWaitMs?: number; responseTimeoutMs?: number; expect?: StepExpectations; note?: string; skip?: boolean }
  | { waitMs: number; expect?: StepExpectations; note?: string; skip?: boolean }
  | { click: string; expect?: StepExpectations; note?: string; skip?: boolean }
  | { reload: true; note?: string; skip?: boolean }
  | { expect: StepExpectations; note?: string; skip?: boolean };

export interface ConversationScript {
  name?: string;
  description?: string;
  tags?: string[];
  /** Config overrides applied to this script only. */
  config?: Partial<VocosoConfig>;
  steps: Step[];
}

export interface VocosoConfig {
  name?: string;
  mode?: Mode;
  reportDir?: string;
  cacheDir?: string;

  app?: {
    baseUrl: string;
    path?: string;
    readyTimeoutMs?: number;
    start?: {
      command: string | string[];
      cwd?: string;
      env?: Record<string, string>;
      readyPath?: string;
      readyTimeoutMs?: number;
    } | null;
    auth?: {
      cookies?: Array<Record<string, unknown>>;
      storageState?: string;
      headers?: Record<string, string>;
      localStorage?: Record<string, string>;
      script?: (input: { context: unknown; page: unknown; config: ResolvedConfig }) => unknown;
    } | null;
  };

  browser?: {
    engine?: "chromium" | "firefox" | "webkit";
    headless?: boolean;
    slowMo?: number;
    channel?: string;
    viewport?: { width: number; height: number };
    permissions?: string[];
    args?: string[];
    fullPageScreenshots?: boolean;
  };

  voice?: {
    /** Optional control that switches the UI into voice mode first. */
    enter?: string | null;
    /** Required: the control that opens the live session. */
    start?: string | null;
    stop?: string | null;
    statusSelector?: string | null;
    statusAttribute?: string;
    liveStatuses?: string[];
    deadStatuses?: string[];
    connectTimeoutMs?: number;
    connectAttempts?: number;
  };

  chat?: {
    input?: string | null;
    send?: string | null;
    message?: string | null;
    assistantMessage?: string | null;
    /** Selector that appears when a reply has finished streaming. */
    doneWhen?: string | null;
    quietMs?: number;
    responseTimeoutMs?: number;
    typeDelayMs?: number;
  };

  transport?: {
    preset?: TransportPresetName | TransportPresetName[] | TransportPreset[] | "auto"
      | ((payload: FramePayload) => object | object[] | null);
    /** Output RMS above which the assistant counts as speaking. */
    speakingThreshold?: number;
  };

  tts?: {
    provider?: "auto" | "say" | "espeak" | "piper" | "openai" | "prerecorded" | TtsProvider;
    voice?: string;
    fallbackVoices?: string[];
    options?: Record<string, unknown>;
    minRms?: number;
  };

  surfaces?: SurfaceOracleConfig;

  facts?: {
    from?: "tool-results" | "evidence" | "none"
      | ((input: { events: ConversationEvent[]; evidence: unknown[]; config: ResolvedConfig }) => unknown);
  };

  evidence?: EvidenceCheck[];

  gates?: {
    requireAllExpectations?: boolean;
    maxUnmatchedFrames?: number | null;
    latency?: Partial<Record<
      "speechEndToTranscriptMs" | "speechEndToAssistantAudioMs"
      | "speechEndToAssistantTextMs" | "speechEndToTurnDoneMs",
      { p50?: number; p95?: number; max?: number }
    >> | null;
  };

  heal?: {
    recover?: { enabled?: boolean; maxPerRun?: number };
    patch?: {
      enabled?: boolean;
      provider?: "anthropic" | "openai" | ((input: {
        system: string; prompt: string; model?: string; apiKey: string; timeoutMs?: number;
      }) => Promise<string>);
      model?: string | null;
      apiKey?: string;
      /** Required when enabled. Globs, relative to the repo root. */
      paths?: string[];
      cwd?: string;
      maxAttempts?: number;
      /** false (default) writes the patch for review; true applies and verifies. */
      apply?: boolean;
      requireCleanTree?: boolean;
      timeoutMs?: number;
    };
  };

  timeouts?: { transcript?: number; response?: number; settle?: number };

  hooks?: {
    beforeSession?: (input: { page: unknown; config: ResolvedConfig; logger: unknown }) => unknown;
    afterStep?: (input: { step: unknown; outcome: unknown; checks: CheckResult[]; page: unknown; config: ResolvedConfig }) => unknown;
    afterRun?: (input: { report: RunReport; findings: Finding[]; healing: unknown; config: ResolvedConfig }) => unknown;
  };
}

export type ResolvedConfig = VocosoConfig & { rootDir: string; configPath: string | null };

export interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
  step?: number;
  [extra: string]: unknown;
}

export interface Finding {
  code: string;
  title: string;
  fault: "rig" | "app" | "external" | "unknown";
  confidence: "certain" | "likely" | "possible";
  observed: string;
  cause: string;
  fix: string[];
  sourceHint?: string[];
}

export interface SurfaceEvaluation {
  passed: boolean;
  findings: Array<{ rule: string; detail: string; [extra: string]: unknown }>;
  suppressed: Array<{ rule: string; detail: string }>;
  elementKeys: string[];
  elementTypes: Record<string, string>;
  operations: string[];
  factsConsidered: number;
}

export interface RunReport {
  tool: "vocoso";
  version: string;
  script: string;
  mode: Mode;
  passed: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  runDir: string;
  verification: {
    passed: boolean;
    stages: Record<string, boolean>;
    blockedAt: string | null;
    blocked: { code: string | null; message: string; stack: string } | null;
  };
  checks: CheckResult[];
  evidence: Array<{ name: string; kind: string; passed: boolean; detail: string | null; value: unknown }>;
  recoveries: Array<{ at: number; strategy: string; reason: string; outcome: string; detail: string | null }>;
  utterances: Array<{ text: string; heard: string | null; durationMs: number; clip: unknown }>;
  turns: Array<{ userText: string; assistantText: string; tools: Array<{ name: string; arguments: string }> }>;
  timings: unknown;
  surfaces: { versions: unknown[]; latest: unknown; count: number };
  transport: unknown;
  observed: unknown;
  screenshots: string[];
  diagnosis?: Finding[];
}

export declare function defineConfig(config: VocosoConfig): VocosoConfig;
export declare function loadConfig(options?: {
  configPath?: string; cwd?: string; overrides?: Partial<VocosoConfig>;
}): Promise<ResolvedConfig>;
export declare function findConfigFile(cwd?: string): string | null;
export declare function loadScript(path: string): Promise<Required<ConversationScript>>;
export declare function normalizeScript(raw: ConversationScript | Step[], fallbackName?: string): Required<ConversationScript>;
export declare function runScript(input: {
  config: ResolvedConfig; script: ConversationScript; logger?: unknown; heal?: boolean;
}): Promise<{ report: RunReport; findings: Finding[]; healing: unknown; reportPath: string; runDir: string }>;
export declare function doctor(config: ResolvedConfig, logger?: unknown): Promise<{
  passed: boolean; results: Array<{ name: string; passed: boolean; detail: string }>;
}>;

export declare function evaluateSurface(input: {
  spec: unknown; state?: unknown; config?: SurfaceOracleConfig;
}): SurfaceEvaluation;
export declare function evaluateAmendment(previous: unknown, next: unknown, config?: SurfaceOracleConfig): {
  passed: boolean; findings: Array<{ rule: string; detail: string }>; retained: string[]; removed: string[];
};
export declare function authoritativeFacts(state: unknown, options?: { minFactLength?: number }): string[];
export declare function diagnose(report: RunReport): Finding[];
export declare function formatDiagnosis(findings: Finding[]): string;
export declare function wordErrorRate(spoken: string, heard: string): number;
export declare function normalizeFrames(frames: unknown[], presets: TransportPreset[]): {
  events: ConversationEvent[]; unmatched: Array<{ at: number; source: string; sample: string }>; presetHits: Record<string, number>;
};
export declare const BUILT_IN_PRESETS: Record<TransportPresetName, TransportPreset>;
export declare const VERSION: string;
