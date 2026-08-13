/**
 * A deliberately small assistant, so VoCoSo can be seen working in about
 * thirty seconds with no API key and no account.
 *
 * It streams the same shapes a real app streams - text deltas, a tool call, a
 * tool result, and a generative surface - over Server-Sent Events, which is
 * what the transport tap picks up.
 *
 * The interesting part is the query string. `?bug=` makes it produce, on
 * demand, each of the failures the surface oracle exists to catch:
 *
 *   ?bug=grounding  the surface retypes a value instead of binding to it
 *   ?bug=catalog    it uses a component the host cannot render
 *   ?bug=phantom    it binds to a field that does not exist in the result
 *   ?bug=literal    it hardcodes an operation input the model invented
 *   ?bug=silent     it answers in words and never calls the tool
 *
 * Run it: node examples/demo-app/server.mjs
 */
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 4321);

const RESERVATION = {
  restaurant: "Northgate Supper Club",
  time: "Friday 7:30pm",
  partySize: 2,
  confirmation: "NGS-4417",
};

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>Demo assistant</title>
<style>
  body { font: 15px/1.6 ui-sans-serif, system-ui, sans-serif; max-width: 44rem; margin: 2rem auto; padding: 0 1rem; }
  #log { min-height: 12rem; }
  .msg { padding: .5rem .75rem; border-radius: .5rem; margin: .5rem 0; }
  .msg[data-role="user"] { background: #eef3ff; }
  .msg[data-role="assistant"] { background: #f4f4f5; }
  .surface { border: 1px solid #ddd; border-radius: .5rem; padding: .75rem; margin-top: .5rem; }
  form { display: flex; gap: .5rem; }
  input { flex: 1; padding: .5rem; }
</style>
<h1>Demo assistant</h1>
<div id="log"></div>
<form id="composer">
  <input data-testid="composer" autocomplete="off" placeholder="Ask for a table...">
  <button data-testid="send" type="submit">Send</button>
</form>
<script type="module">
  const log = document.querySelector("#log");
  const add = (role, text) => {
    const node = document.createElement("div");
    node.className = "msg";
    node.dataset.role = role;
    node.textContent = text;
    log.append(node);
    return node;
  };
  const renderSurface = (spec) => {
    const box = document.createElement("div");
    box.className = "surface";
    box.dataset.testid = "surface";
    for (const [key, element] of Object.entries(spec.elements ?? {})) {
      const line = document.createElement("div");
      line.dataset.element = key;
      line.textContent = element.type + ": " + JSON.stringify(element.props ?? {});
      box.append(line);
    }
    log.append(box);
  };

  document.querySelector("#composer").addEventListener("submit", async (submitEvent) => {
    submitEvent.preventDefault();
    const input = document.querySelector('[data-testid="composer"]');
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    add("user", text);
    const bubble = add("assistant", "");
    const response = await fetch("/api/chat" + location.search, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const parts = buffer.split("\\n\\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data:")) continue;
        const payload = JSON.parse(line.slice(5).trim());
        if (payload.type === "text-delta") bubble.textContent += payload.delta;
        if (payload.type === "data-surface") renderSurface(payload.data);
        if (payload.type === "finish") bubble.dataset.done = "true";
      }
    }
  });
</script>
`;

function surfaceFor(bug) {
  const spec = {
    root: "frame",
    elements: {
      frame: { type: "ResponseFrame", props: { children: ["where", "when", "confirm"] } },
      where: { type: "Field", props: { label: "Restaurant", value: { $state: "/results/0/result/restaurant" } } },
      when: { type: "Field", props: { label: "Time", value: { $state: "/results/0/result/time" } } },
      confirm: {
        type: "Action",
        props: {
          label: "Add to calendar",
          action: {
            kind: "operation",
            operationId: "calendar.add",
            operationVersion: 1,
            input: { reference: { $state: "/results/0/result/confirmation" } },
          },
        },
      },
    },
  };
  if (bug === "grounding") spec.elements.where.props.label = `Restaurant: ${RESERVATION.restaurant}`;
  if (bug === "catalog") spec.elements.map = { type: "MapView", props: { center: "here" } };
  if (bug === "phantom") spec.elements.when.props.value = { $state: "/results/0/result/tableNumber" };
  if (bug === "literal") spec.elements.confirm.props.action.input.reference = RESERVATION.confirmation;
  return spec;
}

const sse = (response, payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function chat(request, response, bug) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  for (const word of ["Checking", " availability", " now."]) {
    sse(response, { type: "text-delta", delta: word });
    await sleep(60);
  }

  if (bug !== "silent") {
    sse(response, {
      type: "tool-input-available",
      toolCallId: "call_1",
      toolName: "reservations.search",
      input: { partySize: RESERVATION.partySize },
    });
    await sleep(120);
    sse(response, {
      type: "tool-output-available",
      toolCallId: "call_1",
      toolName: "reservations.search",
      output: RESERVATION,
    });
    await sleep(60);
    sse(response, { type: "data-surface", data: surfaceFor(bug) });
  }

  for (const word of [" I", " found", " one", " table."]) {
    sse(response, { type: "text-delta", delta: word });
    await sleep(60);
  }
  sse(response, { type: "finish", finishReason: "stop" });
  response.end();
}

createServer(async (request, response) => {
  const url = new URL(request.url, `http://localhost:${PORT}`);
  if (url.pathname === "/api/chat" && request.method === "POST") {
    await chat(request, response, url.searchParams.get("bug"));
    return;
  }
  if (url.pathname === "/api/reservations") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ items: [RESERVATION] }));
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(PAGE);
}).listen(PORT, () => {
  console.log(`demo assistant on http://localhost:${PORT}`);
  console.log("try http://localhost:4321/?bug=grounding to watch the oracle catch a real defect");
});
