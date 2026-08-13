import type { SurfaceOracleConfig, SurfaceEvaluation } from "./index.d.ts";

export declare class GroundingError extends Error {
  evaluation: SurfaceEvaluation;
  findings: SurfaceEvaluation["findings"];
}

/** Evaluate without throwing. */
export declare function checkGrounded(
  spec: unknown, state: unknown, config?: SurfaceOracleConfig,
): SurfaceEvaluation;

/** Throw a GroundingError unless every gate you configured passes. */
export declare function assertGrounded(
  spec: unknown, state: unknown, config?: SurfaceOracleConfig,
): SurfaceEvaluation;

/** Ignore layout; only fail when a value on screen was typed rather than referenced. */
export declare function assertNoRetypedFacts(
  spec: unknown, state: unknown, config?: SurfaceOracleConfig,
): SurfaceEvaluation;

/** A revision must keep the element keys it already showed. */
export declare function assertStableAmendment(
  previous: unknown, next: unknown, config?: SurfaceOracleConfig,
): { passed: boolean; findings: Array<{ rule: string; detail: string }>; retained: string[]; removed: string[] };

type MatcherResult = { pass: boolean; message: () => string; actual?: unknown };

export declare const toBeGrounded: (
  received: unknown, state: unknown, config?: SurfaceOracleConfig,
) => MatcherResult;
export declare const toHaveNoRetypedFacts: (
  received: unknown, state: unknown, config?: SurfaceOracleConfig,
) => MatcherResult;
export declare const toBeAStableAmendmentOf: (
  received: unknown, previous: unknown, config?: SurfaceOracleConfig,
) => MatcherResult;

declare global {
  namespace jest {
    interface Matchers<R> {
      toBeGrounded(state: unknown, config?: SurfaceOracleConfig): R;
      toHaveNoRetypedFacts(state: unknown, config?: SurfaceOracleConfig): R;
      toBeAStableAmendmentOf(previous: unknown, config?: SurfaceOracleConfig): R;
    }
  }
}
