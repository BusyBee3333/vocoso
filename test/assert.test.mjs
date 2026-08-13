import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertGrounded, assertNoRetypedFacts, assertStableAmendment,
  checkGrounded, GroundingError, toBeGrounded,
} from "../src/assert.mjs";

const STATE = { results: [{ result: { name: "Priya Raman", id: "contact-4417" } }] };

const spec = (label) => ({
  root: "f",
  elements: {
    f: { type: "ResponseFrame", props: {} },
    who: { type: "Field", props: { label, value: { $state: "/results/0/result/name" } } },
  },
});

test("a grounded surface passes and returns its evaluation", () => {
  const outcome = assertGrounded(spec("Name"), STATE, { catalog: null });
  assert.equal(outcome.passed, true);
});

test("a retyped fact throws a GroundingError naming the value", () => {
  assert.throws(
    () => assertGrounded(spec("Name: Priya Raman"), STATE, { catalog: null }),
    (error) => error instanceof GroundingError && /Priya Raman/.test(error.message),
  );
});

test("assertNoRetypedFacts ignores layout rules you have not configured", () => {
  const unknownComponent = spec("Name");
  unknownComponent.elements.chart = { type: "PieChart", props: {} };
  // assertGrounded with a catalog would fail this; the narrow assertion does not.
  assert.throws(() => assertGrounded(unknownComponent, STATE, { catalog: ["ResponseFrame", "Field"] }));
  assert.doesNotThrow(() => assertNoRetypedFacts(unknownComponent, STATE));
});

test("checkGrounded reports without throwing", () => {
  const outcome = checkGrounded(spec("Name: Priya Raman"), STATE, { catalog: null });
  assert.equal(outcome.passed, false);
  assert.equal(outcome.findings[0].rule, "grounding");
});

test("an amendment that drops a key is rejected", () => {
  const before = spec("Name");
  const after = spec("Name");
  delete after.elements.who;
  assert.throws(() => assertStableAmendment(before, after), GroundingError);
  assert.doesNotThrow(() => assertStableAmendment(before, spec("Name (updated)")));
});

test("the vitest/jest matcher reports pass and message", () => {
  const good = toBeGrounded(spec("Name"), STATE, { catalog: null });
  assert.equal(good.pass, true);
  const bad = toBeGrounded(spec("Name: Priya Raman"), STATE, { catalog: null });
  assert.equal(bad.pass, false);
  assert.match(bad.message(), /retypes the authoritative value/);
});
