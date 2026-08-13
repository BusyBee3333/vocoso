/**
 * Text comparison for the "did the far side hear what we said" oracle.
 *
 * This is the one place a self-driving conversation test gets a free oracle:
 * the rig authored the utterance, so the ASR transcript can be scored against
 * ground truth without a human. Scoring is word error rate over normalized
 * tokens - punctuation, casing, and spoken-number rewrites are not defects.
 */

const NUMBER_WORDS = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
};

export function normalizeForCompare(input) {
  return String(input ?? "")
    .toLocaleLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9'\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => NUMBER_WORDS[token] ?? token)
    .map((token) => token.replace(/^(\d+)(st|nd|rd|th)$/, "$1"));
}

/** Levenshtein distance over token arrays. */
export function tokenDistance(left, right) {
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[right.length];
}

/** Word error rate in [0, 1+]; 0 means the transcript matched what we spoke. */
export function wordErrorRate(spoken, heard) {
  const reference = normalizeForCompare(spoken);
  const hypothesis = normalizeForCompare(heard);
  if (reference.length === 0) return hypothesis.length === 0 ? 0 : 1;
  return tokenDistance(reference, hypothesis) / reference.length;
}

/** Case/space-insensitive containment, for loose expectations. */
export function containsPhrase(haystack, needle) {
  return normalizeForCompare(haystack).join(" ").includes(normalizeForCompare(needle).join(" "));
}
