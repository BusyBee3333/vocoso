/** Small async helpers used by every driver. */

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll `probe` until `predicate` is satisfied or the deadline passes.
 * Always returns the last observed value, so a failed wait is still evidence.
 */
export async function until(probe, predicate, { timeoutMs = 30_000, pollMs = 250 } = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let value = await probe();
  for (;;) {
    if (predicate(value)) return { ok: true, value, waitedMs: Date.now() - startedAt };
    if (Date.now() >= deadline) return { ok: false, value, waitedMs: Date.now() - startedAt };
    await sleep(pollMs);
    value = await probe();
  }
}

/** Run `task`, retrying on rejection with linear backoff. */
export async function retry(task, { attempts = 3, backoffMs = 1_000, onRetry } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      onRetry?.(error, attempt);
      await sleep(backoffMs * attempt);
    }
  }
  throw lastError;
}

/** Reject with a named error if `promise` outlives `timeoutMs`. */
export async function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
