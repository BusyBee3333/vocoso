/**
 * The two model calls the patch step can make. Deliberately tiny: no SDKs, no
 * streaming, one request, text in and text out. VoCoSo stays a zero-dependency
 * package and nothing here runs unless self-healing is explicitly switched on.
 */

const MAX_TOKENS = 8_000;

async function anthropic({ system, prompt, model, apiKey, timeoutMs }) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: model ?? "claude-sonnet-5",
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(timeoutMs ?? 180_000),
  });
  if (!response.ok) {
    throw new Error(`anthropic responded ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
  const body = await response.json();
  return (body.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("");
}

async function openai({ system, prompt, model, apiKey, timeoutMs }) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: model ?? "gpt-5.1",
      max_completion_tokens: MAX_TOKENS,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs ?? 180_000),
  });
  if (!response.ok) {
    throw new Error(`openai responded ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
  const body = await response.json();
  return body.choices?.[0]?.message?.content ?? "";
}

export const PATCH_PROVIDERS = { anthropic, openai };

export function resolvePatchProvider(config) {
  if (typeof config.provider === "function") return { call: config.provider, name: "custom", apiKey: null };
  const name = config.provider ?? "anthropic";
  const call = PATCH_PROVIDERS[name];
  if (!call) throw new Error(`unknown heal.patch.provider "${name}" (built in: anthropic, openai)`);
  const apiKey = config.apiKey
    ?? process.env[name === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"];
  if (!apiKey) {
    throw new Error(
      `self-healing needs an API key: set ${name === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"} ` +
      "or heal.patch.apiKey.",
    );
  }
  return { call, name, apiKey };
}
