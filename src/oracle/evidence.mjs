/**
 * Did the app actually do the thing?
 *
 * A conversation can look perfect on the wire and change nothing. Evidence
 * checks read the application's own stores after the fact - its API, its
 * database, its log - and are the difference between "the model said it
 * created the contact" and "the contact exists".
 *
 * Four kinds, all dependency free, so this stays a devDependency-of-one:
 *   http    - authenticated GET/POST against your own API
 *   command - any shell command whose stdout is JSON (psql -At, sqlite3 -json,
 *             a prisma script, kubectl, whatever you already have)
 *   file    - a JSON or JSONL file the app writes
 *   custom  - a function in your config, for everything else
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

import { resolvePointer } from "./pointer.mjs";
import { until } from "../util/wait.mjs";

const run = promisify(execFile);

async function readHttp(check, context) {
  const url = new URL(typeof check.url === "function" ? check.url(context) : check.url, context.baseUrl).toString();
  const response = await fetch(url, {
    method: check.method ?? "GET",
    headers: { Accept: "application/json", ...(context.headers ?? {}), ...(check.headers ?? {}) },
    body: check.body === undefined ? undefined : JSON.stringify(
      typeof check.body === "function" ? check.body(context) : check.body,
    ),
    signal: AbortSignal.timeout(check.timeoutMs ?? 20_000),
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  if (!response.ok) {
    const error = new Error(`${url} responded ${response.status}: ${text.slice(0, 300)}`);
    error.status = response.status;
    throw error;
  }
  return json ?? text;
}

async function readCommand(check, context) {
  const argv = (typeof check.command === "function" ? check.command(context) : check.command);
  const [file, ...args] = Array.isArray(argv) ? argv : ["/bin/sh", "-c", argv];
  const { stdout } = await run(file, args, {
    cwd: check.cwd ?? context.cwd,
    env: { ...process.env, ...(check.env ?? {}) },
    timeout: check.timeoutMs ?? 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { /* fall through to lines */ }
  const lines = trimmed.split("\n").map((line) => {
    try { return JSON.parse(line); } catch { return line; }
  });
  return lines.length === 1 ? lines[0] : lines;
}

function readFile(check) {
  const text = readFileSync(check.path, "utf8");
  if (check.path.endsWith(".jsonl")) {
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }
  return JSON.parse(text);
}

async function readOnce(check, context) {
  switch (check.kind) {
    case "http": return readHttp(check, context);
    case "command": return readCommand(check, context);
    case "file": return readFile(check);
    case "custom": return check.read(context);
    default: throw new Error(`unknown evidence kind "${check.kind}"`);
  }
}

/** Default satisfaction test: something came back, and it is not empty. */
function defaultSatisfied(value) {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

/**
 * Read one evidence source until it satisfies the check.
 *
 * Polling rather than a single read is not politeness - writes land after the
 * conversation ends (debounced saves, queues, background jobs), so a single
 * read right after the last utterance reliably reports a false negative.
 */
export async function checkEvidence(check, context) {
  const startedAt = Date.now();
  let lastError = null;
  const probe = async () => {
    try {
      const value = await readOnce(check, context);
      lastError = null;
      return check.at ? resolvePointer(value, check.at) : value;
    } catch (error) {
      lastError = error;
      return undefined;
    }
  };
  const satisfied = check.satisfied ?? defaultSatisfied;
  const outcome = await until(probe, (value) => {
    try { return Boolean(satisfied(value, context)); } catch { return false; }
  }, { timeoutMs: check.waitMs ?? 15_000, pollMs: check.pollMs ?? 750 });

  return {
    name: check.name,
    kind: check.kind,
    passed: outcome.ok,
    waitedMs: Date.now() - startedAt,
    value: outcome.value === undefined ? null : outcome.value,
    error: lastError ? String(lastError.message ?? lastError).slice(0, 600) : null,
    detail: outcome.ok
      ? null
      : lastError
        ? `evidence "${check.name}" could not be read: ${String(lastError.message ?? lastError).slice(0, 300)}`
        : `evidence "${check.name}" was never satisfied within ${check.waitMs ?? 15_000}ms`,
  };
}

export async function checkAllEvidence(checks, context) {
  const results = [];
  for (const check of checks ?? []) results.push(await checkEvidence(check, context));
  return results;
}
