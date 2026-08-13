/**
 * Frame -> meaning, one small pure function per provider.
 *
 * The injected tap records raw frames and nothing else, so adding a provider
 * is a mapping function here and never a change to page code. Every preset
 * turns provider frames into the same vocabulary:
 *
 *   session.open · user.speech.start · user.speech.stop · user.transcript
 *   assistant.text · assistant.audio.start · assistant.audio.stop
 *   assistant.done · tool.call · tool.result · surface.spec · surface.patch
 *   error
 *
 * A preset returns an event, an array of events, or null. `matches` is a cheap
 * guard so `auto` mode can run every preset over every frame without noise.
 */

const event = (kind, fields) => ({ kind, ...fields });

/** OpenAI Realtime (WebRTC data channel or WebSocket). */
export const openaiRealtime = {
  name: "openai-realtime",
  matches: (payload) => typeof payload.json?.type === "string" && (
    payload.json.type.startsWith("response.")
    || payload.json.type.startsWith("input_audio_buffer.")
    || payload.json.type.startsWith("output_audio_buffer.")
    || payload.json.type.startsWith("conversation.")
    || payload.json.type === "session.created"
    || payload.json.type === "session.updated"
    || payload.json.type === "error"
  ),
  map(payload) {
    const body = payload.json;
    switch (body.type) {
      case "session.created":
        return event("session.open", { model: body.session?.model ?? null });
      case "input_audio_buffer.speech_started":
        return event("user.speech.start", {});
      case "input_audio_buffer.speech_stopped":
        return event("user.speech.stop", {});
      case "conversation.item.input_audio_transcription.completed":
        return event("user.transcript", { text: body.transcript ?? "", final: true });
      case "conversation.item.input_audio_transcription.delta":
        return event("user.transcript", { text: body.delta ?? "", final: false });
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        return event("assistant.text", { text: body.transcript ?? "", final: true, modality: "audio" });
      case "response.output_text.done":
      case "response.text.done":
        return event("assistant.text", { text: body.text ?? "", final: true, modality: "text" });
      case "output_audio_buffer.started":
        return event("assistant.audio.start", {});
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        return event("assistant.audio.stop", { cleared: body.type.endsWith("cleared") });
      case "response.function_call_arguments.done":
        return event("tool.call", {
          name: body.name ?? null,
          callId: body.call_id ?? null,
          arguments: body.arguments ?? null,
        });
      case "response.done":
        return event("assistant.done", {
          status: body.response?.status ?? null,
          statusDetails: body.response?.status_details ?? null,
        });
      case "error":
        return event("error", {
          code: body.error?.code ?? body.code ?? null,
          message: body.error?.message ?? String(body.message ?? "realtime error"),
        });
      default:
        return null;
    }
  },
};

/** Google Gemini Live (bidiGenerateContent over WebSocket). */
export const geminiLive = {
  name: "gemini-live",
  matches: (payload) => Boolean(
    payload.json?.setupComplete
    || payload.json?.serverContent
    || payload.json?.toolCall
    || payload.json?.goAway,
  ),
  map(payload) {
    const body = payload.json;
    const events = [];
    if (body.setupComplete) events.push(event("session.open", { model: null }));
    const server = body.serverContent;
    if (server) {
      const parts = server.modelTurn?.parts ?? [];
      const text = parts.map((part) => part.text).filter(Boolean).join("");
      if (text) events.push(event("assistant.text", { text, final: false, modality: "text" }));
      if (parts.some((part) => part.inlineData?.mimeType?.startsWith("audio/"))) {
        events.push(event("assistant.audio.start", {}));
      }
      if (server.inputTranscription?.text) {
        events.push(event("user.transcript", { text: server.inputTranscription.text, final: true }));
      }
      if (server.outputTranscription?.text) {
        events.push(event("assistant.text", {
          text: server.outputTranscription.text, final: true, modality: "audio",
        }));
      }
      if (server.interrupted) events.push(event("assistant.audio.stop", { cleared: true }));
      if (server.turnComplete) {
        events.push(event("assistant.audio.stop", { cleared: false }));
        events.push(event("assistant.done", { status: "completed" }));
      }
    }
    for (const call of body.toolCall?.functionCalls ?? []) {
      events.push(event("tool.call", {
        name: call.name ?? null,
        callId: call.id ?? null,
        arguments: call.args === undefined ? null : JSON.stringify(call.args),
      }));
    }
    if (body.goAway) events.push(event("error", { code: "go_away", message: "server is closing the session" }));
    return events.length ? events : null;
  },
};

/** ElevenLabs Conversational AI (WebSocket). */
export const elevenlabsAgent = {
  name: "elevenlabs-agent",
  matches: (payload) => typeof payload.json?.type === "string"
    && ["conversation_initiation_metadata", "user_transcript", "agent_response", "audio", "interruption", "client_tool_call"]
      .includes(payload.json.type),
  map(payload) {
    const body = payload.json;
    switch (body.type) {
      case "conversation_initiation_metadata":
        return event("session.open", { model: null });
      case "user_transcript":
        return event("user.transcript", {
          text: body.user_transcription_event?.user_transcript ?? "", final: true,
        });
      case "agent_response":
        return event("assistant.text", {
          text: body.agent_response_event?.agent_response ?? "", final: true, modality: "audio",
        });
      case "audio":
        return event("assistant.audio.start", {});
      case "interruption":
        return event("assistant.audio.stop", { cleared: true });
      case "client_tool_call":
        return event("tool.call", {
          name: body.client_tool_call?.tool_name ?? null,
          callId: body.client_tool_call?.tool_call_id ?? null,
          arguments: JSON.stringify(body.client_tool_call?.parameters ?? {}),
        });
      default:
        return null;
    }
  },
};

/** Deepgram Voice Agent (WebSocket). */
export const deepgramAgent = {
  name: "deepgram-agent",
  matches: (payload) => typeof payload.json?.type === "string"
    && ["Welcome", "SettingsApplied", "ConversationText", "UserStartedSpeaking", "AgentThinking",
      "AgentStartedSpeaking", "AgentAudioDone", "FunctionCallRequest", "Error"].includes(payload.json.type),
  map(payload) {
    const body = payload.json;
    switch (body.type) {
      case "Welcome":
        return event("session.open", { model: null });
      case "UserStartedSpeaking":
        return event("user.speech.start", {});
      case "ConversationText":
        return body.role === "user"
          ? event("user.transcript", { text: body.content ?? "", final: true })
          : event("assistant.text", { text: body.content ?? "", final: true, modality: "audio" });
      case "AgentStartedSpeaking":
        return event("assistant.audio.start", {});
      case "AgentAudioDone":
        return [event("assistant.audio.stop", { cleared: false }), event("assistant.done", { status: "completed" })];
      case "FunctionCallRequest":
        return (body.functions ?? [{ name: body.function_name, arguments: body.input, id: body.function_call_id }])
          .map((call) => event("tool.call", {
            name: call.name ?? null,
            callId: call.id ?? null,
            arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {}),
          }));
      case "Error":
        return event("error", { code: body.code ?? null, message: body.description ?? "agent error" });
      default:
        return null;
    }
  },
};

/** OpenAI-compatible chat completions over SSE (text chat surfaces). */
export const openaiChatSse = {
  name: "openai-chat-sse",
  matches: (payload) => Array.isArray(payload.json?.choices) && payload.source !== "webrtc",
  map(payload) {
    const choice = payload.json.choices[0] ?? {};
    const delta = choice.delta ?? choice.message ?? {};
    const events = [];
    if (delta.content) {
      events.push(event("assistant.text", { text: delta.content, final: false, modality: "text" }));
    }
    for (const call of delta.tool_calls ?? []) {
      events.push(event("tool.call", {
        name: call.function?.name ?? null,
        callId: call.id ?? null,
        arguments: call.function?.arguments ?? null,
      }));
    }
    if (choice.finish_reason) events.push(event("assistant.done", { status: choice.finish_reason }));
    return events.length ? events : null;
  },
};

/**
 * Vercel AI SDK data stream. Its `data`/`2:` and tool parts are the usual way
 * a React app receives a generative surface, so surface payloads are lifted
 * out here rather than sniffed from the DOM.
 */
export const vercelAiDataStream = {
  name: "vercel-ai-data-stream",
  matches: (payload) => {
    const type = payload.json?.type;
    if (typeof type !== "string") return false;
    return type.startsWith("text-") || type.startsWith("tool-") || type.startsWith("data-")
      || type === "finish" || type === "error";
  },
  map(payload) {
    const body = payload.json;
    if (body.type === "text-delta") {
      return event("assistant.text", { text: body.delta ?? body.text ?? "", final: false, modality: "text" });
    }
    if (body.type === "text-end" || body.type === "finish") {
      return event("assistant.done", { status: body.finishReason ?? "completed" });
    }
    if (body.type === "error") {
      return event("error", { code: body.errorCode ?? null, message: String(body.errorText ?? body.error ?? "stream error") });
    }
    if (body.type.startsWith("tool-input-available") || body.type === "tool-call") {
      return event("tool.call", {
        name: body.toolName ?? null,
        callId: body.toolCallId ?? null,
        arguments: JSON.stringify(body.input ?? body.args ?? {}),
      });
    }
    if (body.type.startsWith("tool-output-available") || body.type === "tool-result") {
      return event("tool.result", {
        name: body.toolName ?? null,
        callId: body.toolCallId ?? null,
        result: body.output ?? body.result ?? null,
      });
    }
    if (body.type.startsWith("data-")) {
      const data = body.data ?? body.value ?? null;
      const kind = body.type.slice("data-".length);
      if (/patch/i.test(kind)) return event("surface.patch", { patch: data, channel: kind });
      return event("surface.spec", { spec: data, channel: kind });
    }
    return null;
  },
};

/**
 * The app's own instrumentation: `window.__vocoso.emit(kind, detail)`.
 * The escape hatch that makes any bespoke transport supportable in one line
 * of application code.
 */
export const appEvents = {
  name: "app-events",
  matches: (payload) => payload.source === "app" && typeof payload.json?.type === "string",
  map(payload) {
    const { type, detail } = payload.json;
    const known = new Set([
      "session.open", "user.speech.start", "user.speech.stop", "user.transcript",
      "assistant.text", "assistant.audio.start", "assistant.audio.stop", "assistant.done",
      "tool.call", "tool.result", "surface.spec", "surface.patch", "error",
    ]);
    if (!known.has(type)) return null;
    return event(type, typeof detail === "object" && detail ? detail : { detail });
  },
};

export const BUILT_IN_PRESETS = {
  "openai-realtime": openaiRealtime,
  "gemini-live": geminiLive,
  "elevenlabs-agent": elevenlabsAgent,
  "deepgram-agent": deepgramAgent,
  "openai-chat-sse": openaiChatSse,
  "vercel-ai-data-stream": vercelAiDataStream,
  "app-events": appEvents,
};

/** Resolve `transport.preset` config into an ordered preset list. */
export function resolvePresets(preset = "auto") {
  if (typeof preset === "function") return [{ name: "custom", matches: () => true, map: preset }];
  const names = preset === "auto" || preset === undefined
    ? Object.keys(BUILT_IN_PRESETS)
    : [].concat(preset);
  return names.map((name) => {
    if (typeof name === "object" && name) return name;
    const found = BUILT_IN_PRESETS[name];
    if (!found) {
      throw new Error(`unknown transport preset "${name}" (built in: ${Object.keys(BUILT_IN_PRESETS).join(", ")})`);
    }
    return found;
  });
}
