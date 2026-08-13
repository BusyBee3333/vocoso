/**
 * Grounding assertions for the test suite you already run.
 *
 * The oracle needs no browser, no API key, no config, and no model — it is a
 * pure function over the spec your model produced and the tool results it was
 * given. So it does not need to be a test runner. It needs to be one line
 * inside vitest, jest, or node:test:
 *
 *   import { toBeGrounded } from "vocoso/assert";
 *   expect.extend({ toBeGrounded });
 *   expect(spec).toBeGrounded(toolResults, { catalog });
 *
 * or, with no matcher machinery at all:
 *
 *   import { assertGrounded } from "vocoso/assert";
 *   assertGrounded(spec, toolResults, { catalog });
 */
import { evaluateSurface, evaluateAmendment } from "./oracle/surface.mjs";

/** Rules that are about provenance rather than presentation. */
const GROUNDING_RULES = new Set([
  "grounding",
  "reference-unresolved",
  "reference-scope",
  "write-firewall",
  "action-literal",
]);

function describe(findings, { limit = 12 } = {}) {
  const shown = findings.slice(0, limit).map((item) => `  - ${item.rule}: ${item.detail}`);
  if (findings.length > limit) shown.push(`  ...and ${findings.length - limit} more`);
  return shown.join("\n");
}

export class GroundingError extends Error {
  constructor(message, evaluation) {
    super(message);
    this.name = "GroundingError";
    this.evaluation = evaluation;
    this.findings = evaluation.findings;
  }
}

/**
 * Every fact the surface shows must be a reference into `state`, every
 * reference must resolve, and the surface must not write its own source of
 * truth. Presentation rules (catalog, root type, operation contracts) are
 * checked too when you configure them, and ignored when you do not.
 *
 * @param {unknown} spec   the surface the model produced
 * @param {unknown} state  the authoritative state it was given (usually tool results)
 * @param {object} [config] surface oracle config; see docs/configuration.md
 */
export function checkGrounded(spec, state, config = {}) {
  return evaluateSurface({ spec, state, config });
}

export function assertGrounded(spec, state, config = {}) {
  const evaluation = checkGrounded(spec, state, config);
  if (evaluation.passed) return evaluation;
  throw new GroundingError(
    `The generated surface is not grounded in the data it was given ` +
    `(${evaluation.findings.length} finding(s) across ${evaluation.elementKeys.length} elements):\n` +
    describe(evaluation.findings),
    evaluation,
  );
}

/**
 * The narrow assertion: ignore layout entirely and only ask whether any value
 * on screen was typed by the model rather than referenced. Use this when you
 * have not yet declared a catalog or an operation registry.
 */
export function assertNoRetypedFacts(spec, state, config = {}) {
  const evaluation = checkGrounded(spec, state, { ...config, catalog: null, requireRootType: null });
  const leaks = evaluation.findings.filter((item) => item.rule === "grounding");
  if (leaks.length === 0) return evaluation;
  throw new GroundingError(
    `The surface retyped ${leaks.length} value(s) it should have referenced:\n${describe(leaks)}`,
    { ...evaluation, findings: leaks },
  );
}

/**
 * A revision must keep the keys it already showed. A rebuilt tree makes the
 * whole answer flash and throws away focus, scroll, and anything the user had
 * already typed into it.
 */
export function assertStableAmendment(previous, next, config = {}) {
  const evaluation = evaluateAmendment(previous, next, config);
  if (evaluation.passed) return evaluation;
  throw new GroundingError(
    `The amended surface did not keep its element keys:\n${describe(evaluation.findings)}`,
    evaluation,
  );
}

const matcher = (name, run) => function (received, state, config = {}) {
  let evaluation;
  try {
    evaluation = run(received, state, config);
  } catch (error) {
    if (!(error instanceof GroundingError)) throw error;
    return {
      pass: false,
      message: () => error.message,
      actual: error.findings,
    };
  }
  return {
    pass: true,
    message: () => `expected the surface to fail ${name}, but every value on it was referenced`,
    actual: evaluation.findings,
  };
};

/**
 * vitest / jest matchers. Register with:
 *   expect.extend({ toBeGrounded, toHaveNoRetypedFacts, toBeAStableAmendmentOf });
 */
export const toBeGrounded = matcher("toBeGrounded", assertGrounded);
export const toHaveNoRetypedFacts = matcher("toHaveNoRetypedFacts", assertNoRetypedFacts);
export const toBeAStableAmendmentOf = function (received, previous, config = {}) {
  try {
    assertStableAmendment(previous, received, config);
  } catch (error) {
    if (!(error instanceof GroundingError)) throw error;
    return { pass: false, message: () => error.message, actual: error.findings };
  }
  return { pass: true, message: () => "expected the amendment to be unstable, but every key survived" };
};

export { GROUNDING_RULES, evaluateSurface, evaluateAmendment };
