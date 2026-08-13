/**
 * Getting hold of the surface the model just composed, and of the facts it
 * was entitled to put on it.
 *
 * Three sources, because generative UI arrives three ways in the wild:
 *   events     - a spec or JSON-patch stream on the transport (the common case)
 *   expression - the app already keeps it somewhere on `window`
 *   response   - it comes back whole in an HTTP response body
 */
import { applyPatch, resolvePointer } from "./pointer.mjs";

/** Rebuild surfaces from `surface.spec` / `surface.patch` events, in order. */
export function surfacesFromEvents(events) {
  const versions = [];
  let current = null;
  for (const item of events) {
    if (item.kind === "surface.spec") {
      current = structuredClone(item.spec ?? null);
      versions.push({ at: item.at, spec: current, source: "spec" });
    } else if (item.kind === "surface.patch") {
      const operations = [].concat(item.patch ?? []);
      current = applyPatch(current ? structuredClone(current) : {}, operations);
      versions.push({ at: item.at, spec: current, source: "patch", operations: operations.length });
    }
  }
  return versions;
}

export async function captureSurfaces({ page, config, events, observed }) {
  const capture = config.surfaces?.capture ?? { from: "events" };
  const sources = [].concat(capture.from ?? "events");
  const versions = [];

  if (sources.includes("events")) versions.push(...surfacesFromEvents(events));

  if (sources.includes("expression") && capture.expression && page) {
    // Passed as an expression string rather than compiled in-page: a strict
    // Content-Security-Policy blocks `new Function`, and plenty of the apps
    // worth testing have one.
    const value = await page.evaluate(capture.expression).catch(() => null);
    if (value) versions.push({ at: Date.now(), spec: value, source: "expression" });
  }

  if (sources.includes("response")) {
    for (const captured of observed?.capturedResponses ?? []) {
      const spec = capture.at ? resolvePointer(captured.body, capture.at) : captured.body;
      if (spec !== undefined && spec !== null) {
        versions.push({ at: captured.at, spec, source: "response", url: captured.url });
      }
    }
  }

  versions.sort((left, right) => left.at - right.at);
  return { versions, latest: versions.at(-1)?.spec ?? null };
}

/**
 * The authoritative state a surface is allowed to draw from.
 *
 * By default that is exactly the tool results of this run: the model may show
 * what the system returned and nothing else. Configure `facts.from` to point
 * at evidence or a custom collector when your surfaces bind to a store the
 * transport never carried.
 */
export function collectFactState({ config, events, evidence }) {
  const source = config.facts?.from ?? "tool-results";
  if (typeof source === "function") return source({ events, evidence, config });

  if (source === "evidence") {
    return Object.fromEntries((evidence ?? []).map((item) => [item.name, item.value]));
  }
  if (source === "none") return undefined;

  const results = [];
  for (const item of events) {
    if (item.kind !== "tool.result") continue;
    results.push({ name: item.name ?? null, callId: item.callId ?? null, result: item.result });
  }
  // Tool *calls* carry the arguments the model chose, which are never facts;
  // only results are. Keeping them separate is the whole point of the check.
  return { results };
}
