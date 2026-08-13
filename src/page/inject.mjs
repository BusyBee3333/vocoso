/**
 * Everything VoCoSo installs into the page before app code runs.
 *
 * Three capabilities, all provider-agnostic:
 *
 *   1. A controllable microphone. `getUserMedia` returns a stream the rig
 *      writes into, so utterances can be played one at a time, with real
 *      silence between them, and a barge-in can land in the middle of the
 *      assistant's reply. Chromium's --use-file-for-fake-audio-capture cannot
 *      do any of that: it loops a single file for the browser's lifetime.
 *
 *   2. A transport tap. Realtime frames are recorded in both directions from
 *      WebRTC data channels, WebSockets, EventSource, and streaming fetch
 *      responses. The tap stays deliberately dumb - it records raw frames and
 *      lets Node decide what they mean - so supporting a new provider is a
 *      mapping function, never a change to injected code.
 *
 *   3. An output loudness meter. "Is the assistant speaking right now?" is
 *      answered from actual audio energy rather than from a vendor event, by
 *      metering both <audio>/<video> elements and anything routed to an
 *      AudioContext destination. That is what makes barge-in timing and
 *      dead-air detection work for a provider VoCoSo has never seen.
 */

export const RUNTIME_SCRIPT = String.raw`(() => {
  if (window.__vocoso) return;
  const MAX_FRAMES = 20000;
  const rig = {
    frames: [],
    dropped: 0,
    micStreams: 0,
    userMediaCalls: 0,
    speakLog: [],
    errors: [],
    startedAt: Date.now(),
  };
  window.__vocoso = rig;

  const record = (source, dir, data, meta) => {
    try {
      if (rig.frames.length >= MAX_FRAMES) { rig.dropped += 1; return; }
      let payload = data;
      if (typeof payload !== "string") {
        if (payload instanceof ArrayBuffer) payload = "[binary " + payload.byteLength + "B]";
        else if (ArrayBuffer.isView(payload)) payload = "[binary " + payload.byteLength + "B]";
        else if (payload instanceof Blob) payload = "[blob " + payload.size + "B]";
        else payload = String(payload);
      }
      if (payload.length > 200000) payload = payload.slice(0, 200000) + "...[truncated]";
      rig.frames.push({ at: Date.now(), source, dir, data: payload, meta: meta || null });
    } catch (error) {
      rig.errors.push(String(error));
    }
  };
  // Apps can publish their own semantic events; they arrive in the same log.
  rig.emit = (type, detail) => record("app", "in", JSON.stringify({ type, detail }), null);

  // ---- 1. controllable microphone ---------------------------------------
  const audio = { ctx: null, destinations: new Set(), playing: 0 };
  const ensureCtx = () => {
    if (!audio.ctx) audio.ctx = new AudioContext();
    if (audio.ctx.state === "suspended") audio.ctx.resume().catch(() => {});
    return audio.ctx;
  };

  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    const realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (!constraints || !constraints.audio) return realGetUserMedia(constraints);
      rig.userMediaCalls += 1;
      const ctx = ensureCtx();
      const destination = ctx.createMediaStreamDestination();
      audio.destinations.add(destination);
      rig.micStreams = audio.destinations.size;
      // A constant source at zero keeps the track emitting silent frames, so
      // server-side voice activity detection hears a live, quiet microphone
      // rather than a dead one.
      const silence = ctx.createConstantSource();
      silence.offset.value = 0;
      silence.connect(destination);
      silence.start();
      const track = destination.stream.getAudioTracks()[0];
      const stopTrack = track.stop.bind(track);
      track.stop = () => {
        audio.destinations.delete(destination);
        rig.micStreams = audio.destinations.size;
        try { silence.stop(); } catch (error) { /* already stopped */ }
        stopTrack();
      };
      return destination.stream;
    };
  }

  window.__vocosoMicStreams = () => audio.destinations.size;

  window.__vocosoSpeak = (base64Wav) => new Promise((resolve, reject) => {
    try {
      const ctx = ensureCtx();
      const bytes = Uint8Array.from(atob(base64Wav), (character) => character.charCodeAt(0));
      ctx.decodeAudioData(bytes.buffer, async (buffer) => {
        // The app may be mid-reconnect: it stops the old track before the new
        // getUserMedia resolves. Give a fresh stream a moment to register
        // rather than failing the utterance on that race.
        const deadline = Date.now() + 8000;
        while (audio.destinations.size === 0 && Date.now() < deadline) {
          await new Promise((tick) => setTimeout(tick, 200));
        }
        if (audio.destinations.size === 0) {
          reject(new Error("no live microphone stream to speak into"));
          return;
        }
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        for (const destination of audio.destinations) source.connect(destination);
        const entry = { startedAt: Date.now(), durationMs: Math.round(buffer.duration * 1000) };
        rig.speakLog.push(entry);
        audio.playing += 1;
        source.onended = () => {
          audio.playing -= 1;
          entry.endedAt = Date.now();
          resolve(entry);
        };
        source.start();
      }, (error) => reject(new Error("decodeAudioData failed: " + error)));
    } catch (error) {
      reject(error);
    }
  });
  window.__vocosoMicBusy = () => audio.playing > 0;

  // ---- 2. transport tap --------------------------------------------------
  if (window.RTCPeerConnection) {
    const createDataChannel = RTCPeerConnection.prototype.createDataChannel;
    RTCPeerConnection.prototype.createDataChannel = function (...args) {
      const channel = createDataChannel.apply(this, args);
      try {
        const label = channel.label || "datachannel";
        channel.addEventListener("message", (message) => record("webrtc", "in", message.data, { label }));
        const send = channel.send.bind(channel);
        channel.send = (data) => { record("webrtc", "out", data, { label }); return send(data); };
      } catch (error) { rig.errors.push(String(error)); }
      return channel;
    };
    // Some SDKs receive a channel rather than creating one.
    const setRemote = RTCPeerConnection.prototype.setRemoteDescription;
    RTCPeerConnection.prototype.setRemoteDescription = function (...args) {
      try {
        this.addEventListener("datachannel", (event) => {
          const channel = event.channel;
          const label = channel.label || "datachannel";
          channel.addEventListener("message", (message) => record("webrtc", "in", message.data, { label }));
        }, { once: false });
      } catch (error) { rig.errors.push(String(error)); }
      return setRemote.apply(this, args);
    };
  }

  if (window.WebSocket) {
    const NativeWebSocket = window.WebSocket;
    const Wrapped = function (url, protocols) {
      const socket = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
      const meta = { url: String(url).slice(0, 300) };
      record("websocket", "meta", JSON.stringify({ event: "open-attempt", url: meta.url }), meta);
      socket.addEventListener("message", (message) => record("websocket", "in", message.data, meta));
      socket.addEventListener("close", (event) => record(
        "websocket", "meta", JSON.stringify({ event: "close", code: event.code, reason: event.reason }), meta,
      ));
      const send = socket.send.bind(socket);
      socket.send = (data) => { record("websocket", "out", data, meta); return send(data); };
      return socket;
    };
    Wrapped.prototype = NativeWebSocket.prototype;
    for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Wrapped[key] = NativeWebSocket[key];
    window.WebSocket = Wrapped;
  }

  if (window.EventSource) {
    const NativeEventSource = window.EventSource;
    const Wrapped = function (url, init) {
      const source = new NativeEventSource(url, init);
      const meta = { url: String(url).slice(0, 300) };
      source.addEventListener("message", (event) => record("sse", "in", event.data, meta));
      return source;
    };
    Wrapped.prototype = NativeEventSource.prototype;
    window.EventSource = Wrapped;
  }

  // Streaming fetch (the usual transport for chat completions and generative
  // surface patches). The body is tapped by tee-ing it, so the app still reads
  // exactly what it would have read.
  const nativeFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    const response = await nativeFetch.call(this, input, init);
    try {
      const type = response.headers.get("content-type") || "";
      const streaming = type.includes("event-stream") || type.includes("x-ndjson") || type.includes("stream");
      if (response.body && streaming) {
        const [appCopy, rigCopy] = response.body.tee();
        const reader = rigCopy.getReader();
        const decoder = new TextDecoder();
        const meta = { url: String(url).slice(0, 300) };
        (async () => {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            record("fetch-stream", "in", decoder.decode(chunk.value, { stream: true }), meta);
          }
        })().catch((error) => rig.errors.push(String(error)));
        return new Response(appCopy, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
    } catch (error) { rig.errors.push(String(error)); }
    return response;
  };

  // ---- 3. output loudness meter ------------------------------------------
  const meters = new Set();
  const meterCtx = () => {
    if (!audio.meterCtx) audio.meterCtx = new AudioContext();
    if (audio.meterCtx.state === "suspended") audio.meterCtx.resume().catch(() => {});
    return audio.meterCtx;
  };
  const attachStreamMeter = (stream) => {
    try {
      if (!stream || !stream.getAudioTracks || stream.getAudioTracks().length === 0) return;
      const ctx = meterCtx();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      meters.add(analyser);
    } catch (error) { rig.errors.push(String(error)); }
  };

  if (window.RTCPeerConnection) {
    const NativePeerConnection = window.RTCPeerConnection;
    const WrappedPeer = function (...args) {
      const peer = new NativePeerConnection(...args);
      peer.addEventListener("track", (event) => {
        if (event.track && event.track.kind === "audio") attachStreamMeter(event.streams[0] || new MediaStream([event.track]));
      });
      return peer;
    };
    WrappedPeer.prototype = NativePeerConnection.prototype;
    window.RTCPeerConnection = WrappedPeer;
  }

  // Media elements: covers <audio src=blob:...> and srcObject playback.
  try {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "srcObject");
    if (descriptor && descriptor.set) {
      Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
        ...descriptor,
        set(value) { attachStreamMeter(value); return descriptor.set.call(this, value); },
      });
    }
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      try {
        if (!this.__vocosoMetered && !this.srcObject) {
          this.__vocosoMetered = true;
          const ctx = meterCtx();
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 1024;
          const source = ctx.createMediaElementSource(this);
          source.connect(analyser);
          source.connect(ctx.destination);
          meters.add(analyser);
        }
      } catch (error) { rig.errors.push(String(error)); }
      return play.apply(this, args);
    };
  } catch (error) { rig.errors.push(String(error)); }

  // Web Audio playback: anything connected to a context destination is also
  // routed through an analyser, which catches PCM-over-WebSocket players.
  try {
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (target, ...rest) {
      try {
        if (target && target.context && target === target.context.destination && !this.__vocosoTapped) {
          this.__vocosoTapped = true;
          const analyser = target.context.createAnalyser();
          analyser.fftSize = 1024;
          connect.call(this, analyser);
          meters.add(analyser);
        }
      } catch (error) { rig.errors.push(String(error)); }
      return connect.call(this, target, ...rest);
    };
  } catch (error) { rig.errors.push(String(error)); }

  window.__vocosoOutputLevel = () => {
    let loudest = 0;
    for (const analyser of meters) {
      try {
        const data = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(data);
        let sum = 0;
        for (let index = 0; index < data.length; index += 1) sum += data[index] * data[index];
        const rms = Math.sqrt(sum / data.length);
        if (rms > loudest) loudest = rms;
      } catch (error) { /* a torn-down analyser contributes nothing */ }
    }
    return loudest;
  };
  window.__vocosoMeterCount = () => meters.size;

  // ---- drain -------------------------------------------------------------
  window.__vocosoDrain = (cursor) => {
    const from = Math.max(0, Number(cursor) || 0);
    return {
      cursor: rig.frames.length,
      dropped: rig.dropped,
      frames: rig.frames.slice(from),
      micStreams: audio.destinations.size,
      userMediaCalls: rig.userMediaCalls,
      micBusy: audio.playing > 0,
      outputLevel: window.__vocosoOutputLevel(),
      meterCount: meters.size,
      errors: rig.errors.slice(-20),
    };
  };
})();`;
