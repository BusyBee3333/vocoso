import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateAmendment, evaluateSurface, authoritativeFacts } from "../src/oracle/surface.mjs";

const STATE = {
  results: [{
    name: "contacts.search",
    result: { name: "Priya Raman", email: "priya@northgate.example", city: "Providence" },
  }],
};

const CONFIG = {
  elementsPointer: "/elements",
  rootPointer: "/root",
  catalog: ["ResponseFrame", "Text", "Field", "Action"],
  requireRootType: "ResponseFrame",
  authoritativePathPrefixes: ["/results"],
  operations: [{ id: "contacts.email", version: 2, requiredInputs: ["to"] }],
  actionableTypes: ["Action"],
};

const groundedSpec = {
  root: "frame",
  elements: {
    frame: { type: "ResponseFrame", props: { children: ["who", "mail"] } },
    who: { type: "Field", props: { label: "Name", value: { $state: "/results/0/result/name" } } },
    mail: {
      type: "Action",
      props: {
        label: "Email them",
        action: {
          kind: "operation",
          operationId: "contacts.email",
          operationVersion: 2,
          input: { to: { $state: "/results/0/result/email" } },
        },
      },
    },
  },
};

test("a grounded surface passes every gate", () => {
  const outcome = evaluateSurface({ spec: groundedSpec, state: STATE, config: CONFIG });
  assert.equal(outcome.passed, true, outcome.findings.map((item) => item.detail).join("\n"));
  assert.deepEqual(outcome.operations, ["contacts.email"]);
});

test("catches a fact retyped into prose instead of bound", () => {
  // The failure that renders perfectly and goes quietly wrong later.
  const spec = structuredClone(groundedSpec);
  spec.elements.who.props.label = "Name: Priya Raman";
  const outcome = evaluateSurface({ spec, state: STATE, config: CONFIG });
  assert.equal(outcome.passed, false);
  assert.ok(outcome.findings.some((item) => item.rule === "grounding" && item.fact === "Priya Raman"));
});

test("catches a binding to a path that does not exist", () => {
  const spec = structuredClone(groundedSpec);
  spec.elements.who.props.value = { $state: "/results/0/result/phone" };
  const outcome = evaluateSurface({ spec, state: STATE, config: CONFIG });
  assert.ok(outcome.findings.some((item) => item.rule === "reference-unresolved"));
});

test("catches a component the host cannot render", () => {
  const spec = structuredClone(groundedSpec);
  spec.elements.chart = { type: "PieChart", props: {} };
  const outcome = evaluateSurface({ spec, state: STATE, config: CONFIG });
  assert.ok(outcome.findings.some((item) => item.rule === "catalog" && item.type === "PieChart"));
});

test("catches a surface that writes authoritative state", () => {
  const spec = structuredClone(groundedSpec);
  spec.elements.who.props.value = { $bindState: "/data/contact/name" };
  const outcome = evaluateSurface({
    spec, state: STATE, config: { ...CONFIG, authoritativePathPrefixes: [] },
  });
  assert.ok(outcome.findings.some((item) => item.rule === "write-firewall"));
});

test("catches an invented literal in an operation input", () => {
  const spec = structuredClone(groundedSpec);
  spec.elements.mail.props.action.input.to = "priya@northgate.example";
  const outcome = evaluateSurface({ spec, state: STATE, config: CONFIG });
  assert.ok(outcome.findings.some((item) => item.rule === "action-literal"));
});

test("catches an operation pinned to the wrong version", () => {
  const spec = structuredClone(groundedSpec);
  spec.elements.mail.props.action.operationVersion = 1;
  const outcome = evaluateSurface({ spec, state: STATE, config: CONFIG });
  assert.ok(outcome.findings.some((item) => item.rule === "action-version"));
});

test("catches an unknown operation", () => {
  const spec = structuredClone(groundedSpec);
  spec.elements.mail.props.action.operationId = "contacts.delete";
  const outcome = evaluateSurface({ spec, state: STATE, config: CONFIG });
  assert.ok(outcome.findings.some((item) => item.rule === "action-unknown"));
});

test("finds elements in a spec whose shape was never configured", () => {
  const nested = {
    view: { type: "Panel", props: { title: "Results" }, children: [{ type: "Row", props: {} }] },
  };
  const outcome = evaluateSurface({ spec: nested, state: {}, config: { catalog: ["Panel"] } });
  const types = Object.values(outcome.elementTypes);
  assert.ok(types.includes("Panel") && types.includes("Row"));
  assert.ok(outcome.findings.some((item) => item.rule === "catalog" && item.type === "Row"));
});

test("amendments must keep their element keys", () => {
  const amended = structuredClone(groundedSpec);
  delete amended.elements.mail;
  amended.elements.mail2 = groundedSpec.elements.mail;
  const outcome = evaluateAmendment(groundedSpec, amended, CONFIG);
  assert.equal(outcome.passed, false);
  assert.deepEqual(outcome.removed, ["mail"]);
});

test("short values are not treated as facts", () => {
  const facts = authoritativeFacts({ a: { b: "hi", c: "Providence" } });
  assert.deepEqual(facts, ["Providence"]);
});
