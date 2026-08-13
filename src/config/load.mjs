/** Find, load, merge, and sanity-check a vocoso config. */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { DEFAULT_CONFIG, mergeConfig } from "./defaults.mjs";

const CANDIDATES = [
  "vocoso.config.mjs",
  "vocoso.config.js",
  "vocoso.config.json",
  ".vocosorc.json",
];

export function findConfigFile(cwd = process.cwd()) {
  let directory = resolve(cwd);
  for (;;) {
    for (const candidate of CANDIDATES) {
      const path = resolve(directory, candidate);
      if (existsSync(path)) return path;
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

export class ConfigError extends Error {}

function validate(config) {
  const problems = [];
  if (!config.app?.baseUrl) problems.push("app.baseUrl is required");
  if (!["voice", "chat"].includes(config.mode)) problems.push(`mode must be "voice" or "chat" (got ${config.mode})`);
  if (config.mode === "voice" && !config.voice?.start) {
    problems.push("voice.start must be a selector for the control that opens the live session");
  }
  if (config.mode === "chat" && (!config.chat?.input || !config.chat?.send)) {
    problems.push("chat.input and chat.send selectors are required in chat mode");
  }
  if (config.heal?.patch?.enabled && (config.heal.patch.paths ?? []).length === 0) {
    problems.push("heal.patch.enabled requires heal.patch.paths - VoCoSo will not edit files you have not scoped");
  }
  for (const [index, check] of (config.evidence ?? []).entries()) {
    if (!check?.name) problems.push(`evidence[${index}] needs a name`);
    if (!["http", "command", "file", "custom"].includes(check?.kind)) {
      problems.push(`evidence[${index}].kind must be http, command, file, or custom`);
    }
  }
  if (problems.length) {
    throw new ConfigError(`config is not usable:\n  - ${problems.join("\n  - ")}`);
  }
}

export async function loadConfig({ configPath, cwd = process.cwd(), overrides = {} } = {}) {
  const path = configPath
    ? (isAbsolute(configPath) ? configPath : resolve(cwd, configPath))
    : findConfigFile(cwd);
  if (configPath && !existsSync(path)) throw new ConfigError(`config not found: ${path}`);

  let loaded = {};
  if (path) {
    if (path.endsWith(".json")) {
      loaded = JSON.parse(await readFile(path, "utf8"));
    } else {
      const module = await import(pathToFileURL(path).href);
      loaded = module.default ?? module.config ?? module;
    }
    if (typeof loaded === "function") loaded = await loaded({ cwd, env: process.env });
  }

  const root = path ? dirname(path) : resolve(cwd);
  const config = mergeConfig(mergeConfig(DEFAULT_CONFIG, loaded), overrides);
  config.configPath = path;
  config.rootDir = root;
  config.reportDir = isAbsolute(config.reportDir) ? config.reportDir : resolve(root, config.reportDir);
  config.cacheDir = isAbsolute(config.cacheDir) ? config.cacheDir : resolve(root, config.cacheDir);
  validate(config);
  return config;
}

/** Config helper re-exported for editor types; identity at runtime. */
export const defineConfig = (config) => config;
