/**
 * Browser, context, authentication, and page instrumentation.
 *
 * Playwright is a peer dependency rather than a hard one: the surface oracle
 * and report tooling are useful with no browser at all, and CI images that
 * only run those should not pay for Chromium.
 */
import { createRequire } from "node:module";

import { RUNTIME_SCRIPT } from "../page/inject.mjs";

function loadPlaywright(rootDir) {
  const require = createRequire(`${rootDir}/package.json`);
  try {
    return require("playwright");
  } catch {
    try {
      return require("playwright-core");
    } catch {
      throw Object.assign(
        new Error("playwright is not installed. Run: npm i -D playwright && npx playwright install chromium"),
        { code: "PLAYWRIGHT_MISSING" },
      );
    }
  }
}

async function applyAuth(context, page, config, logger) {
  const auth = config.app.auth;
  if (!auth) return;
  if (auth.cookies?.length) {
    await context.addCookies(auth.cookies.map((cookie) => ({
      sameSite: "Lax",
      url: cookie.url ?? config.app.baseUrl,
      ...cookie,
    })));
    logger.debug("auth", `installed ${auth.cookies.length} cookie(s)`);
  }
  if (auth.headers) {
    await context.setExtraHTTPHeaders(auth.headers);
    logger.debug("auth", `set ${Object.keys(auth.headers).length} extra header(s)`);
  }
  if (auth.localStorage) {
    await context.addInitScript((entries) => {
      for (const [key, value] of Object.entries(entries)) {
        try { window.localStorage.setItem(key, value); } catch { /* storage disabled */ }
      }
    }, auth.localStorage);
  }
  if (typeof auth.script === "function") {
    await auth.script({ context, page, config });
    logger.debug("auth", "ran the custom auth script");
  }
}

export async function openBrowser(config, logger) {
  const playwright = loadPlaywright(config.rootDir);
  const engine = playwright[config.browser.engine ?? "chromium"];
  const browser = await engine.launch({
    headless: config.browser.headless,
    slowMo: config.browser.slowMo,
    channel: config.browser.channel,
    args: config.browser.args,
  });
  const context = await browser.newContext({
    viewport: config.browser.viewport,
    storageState: config.app.auth?.storageState,
    permissions: config.browser.permissions,
    baseURL: config.app.baseUrl,
  });
  if (config.browser.permissions?.length) {
    await context.grantPermissions(config.browser.permissions, { origin: config.app.baseUrl }).catch(() => {});
  }
  await context.addInitScript(RUNTIME_SCRIPT);
  const page = await context.newPage();
  await applyAuth(context, page, config, logger);
  return { playwright, browser, context, page };
}

/**
 * Watch the page for the things a failure report always wants and never has:
 * console output, uncaught errors, failed requests, and the response bodies
 * of the API calls the conversation depended on.
 */
export function observePage(page, config, observed) {
  page.on("console", (message) => {
    if (observed.console.length < 3_000) {
      observed.console.push({ at: Date.now(), type: message.type(), text: message.text().slice(0, 1_000) });
    }
  });
  page.on("pageerror", (error) => {
    observed.pageErrors.push({ at: Date.now(), message: String(error?.stack ?? error).slice(0, 2_000) });
  });
  page.on("requestfailed", (request) => {
    observed.networkFailures.push({
      at: Date.now(),
      url: request.url().slice(0, 400),
      method: request.method(),
      failure: request.failure()?.errorText ?? "unknown",
    });
  });
  page.on("response", async (response) => {
    const url = response.url();
    const status = response.status();
    if (status >= 400) {
      let body = "";
      try { body = (await response.text()).slice(0, 800); } catch { /* body already consumed or gone */ }
      observed.httpFailures.push({ at: Date.now(), url: url.slice(0, 400), status, body });
    }
    for (const matcher of config.surfaces?.capture?.responses ?? []) {
      if (!url.includes(matcher.url)) continue;
      try {
        observed.capturedResponses.push({ at: Date.now(), url: url.slice(0, 400), body: await response.json() });
      } catch { /* not JSON; nothing to capture */ }
    }
  });
}
