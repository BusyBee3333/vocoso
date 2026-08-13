/**
 * Start (or attach to) the application under test.
 *
 * Attaching to something already running is the default when the port answers,
 * because a cold dev-server start dwarfs the conversation it exists to serve.
 * When VoCoSo does start the server it owns the whole process group, so a
 * crashed run never leaves an orphan holding the port.
 */
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { sleep } from "../util/wait.mjs";

async function probe(url, timeoutMs = 4_000) {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    return response.status;
  } catch {
    return null;
  }
}

export async function startOrAttachApp(config, logger, runDir) {
  const readyUrl = new URL(config.app.start?.readyPath ?? config.app.path ?? "/", config.app.baseUrl).toString();
  const existing = await probe(readyUrl);
  if (existing !== null) {
    logger.info("app", `attached to the server already answering ${readyUrl} (${existing})`);
    return { attached: true, stop: async () => {}, logPath: null };
  }
  if (!config.app.start?.command) {
    throw Object.assign(
      new Error(`nothing is answering ${readyUrl} and app.start.command is not configured`),
      { code: "APP_UNREACHABLE" },
    );
  }

  const { command, cwd, env = {}, readyTimeoutMs = config.app.readyTimeoutMs } = config.app.start;
  const logPath = join(runDir, "app-server.log");
  mkdirSync(dirname(logPath), { recursive: true });
  const logStream = createWriteStream(logPath, { flags: "a" });
  const argv = Array.isArray(command) ? command : ["/bin/sh", "-c", command];

  logger.step("app", `starting: ${Array.isArray(command) ? command.join(" ") : command}`);
  const child = spawn(argv[0], argv.slice(1), {
    cwd: cwd ?? config.rootDir,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);

  let exited = null;
  child.on("exit", (code, signal) => { exited = { code, signal }; });

  const stop = async () => {
    if (exited) return;
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* group already gone */ }
    for (let waited = 0; waited < 8_000 && !exited; waited += 250) await sleep(250);
    if (!exited) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* group already gone */ }
    }
    logStream.end();
  };

  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    if (exited) {
      await stop();
      throw Object.assign(
        new Error(`the app server exited (${exited.code ?? exited.signal}) before answering ${readyUrl}. See ${logPath}`),
        { code: "APP_START_FAILED", logPath },
      );
    }
    if ((await probe(readyUrl)) !== null) {
      logger.pass("app", `ready at ${readyUrl}`);
      return { attached: false, stop, logPath, pid: child.pid };
    }
    await sleep(1_000);
  }
  await stop();
  throw Object.assign(
    new Error(`the app server never answered ${readyUrl} within ${readyTimeoutMs}ms. See ${logPath}`),
    { code: "APP_START_TIMEOUT", logPath },
  );
}
