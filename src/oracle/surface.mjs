/**
 * The generative-surface oracle.
 *
 * The hard problem with a model that composes its own UI is that there is no
 * expected output to diff against - two different layouts can both be right.
 * So this does not judge the layout. It judges the *provenance* of everything
 * on it, which is decidable without a human:
 *
 *   - every component is one the host actually renders (catalog),
 *   - every fact shown is a reference into authoritative state, never a
 *     literal the model retyped from a tool result (grounding),
 *   - every reference resolves against that state (no phantom bindings),
 *   - the surface reads state and never writes it (write firewall),
 *   - every control is a descriptor of a real server operation, at the right
 *     version, whose inputs are references rather than invented values,
 *   - and an amended surface keeps its element keys, so the UI updates in
 *     place instead of flashing away and rebuilding.
 *
 * A surface that passes all six is one whose worst failure mode is being ugly.
 * A surface that fails grounding is one that will confidently show a number
 * that never came from your system - which is the failure that matters.
 */
import { isRecord, resolvePointer, walkRecords } from "./pointer.mjs";

const DEFAULTS = {
  elementsPointer: "auto",
  rootPointer: "/root",
  typeKey: "type",
  propsKey: "props",
  childrenKey: "children",
  referenceForms: ["$state", "$ref", "$item", "$bind", "$path"],
  writeForms: ["$bindState", "$setState", "$write"],
  forbiddenWritePaths: ["/data", "/runtime", "/state"],
  authoritativePathPrefixes: [],
  // Paths that hold the user's in-progress input rather than system facts.
  // A reference into one of these is correct and *cannot* resolve at compose
  // time - the user has not typed anything yet - so it is never a phantom.
  draftPathPrefixes: ["/draft", "/ui", "/local"],
  proseProps: [
    "title", "label", "text", "description", "placeholder", "empty",
    "caption", "subtitle", "heading", "summary", "helpText", "submitLabel",
  ],
  minFactLength: 6,
  // "data-like" (default) protects only values that look like data rather than
  // vocabulary; "any" protects every string over minFactLength. See
  // looksLikeData() for why the default is not "any".
  factShape: "data-like",
  action: {
    prop: "action",
    kindKey: "kind",
    operationKind: "operation",
    operationKey: "operationId",
    versionKey: "operationVersion",
    inputKey: "input",
  },
};

const finding = (rule, detail, extra = {}) => ({ rule, detail, ...extra });

/** Locate the element map in a spec whose shape VoCoSo was not told about. */
export function extractElements(spec, config) {
  const pointer = config.elementsPointer ?? DEFAULTS.elementsPointer;
  const typeKey = config.typeKey ?? DEFAULTS.typeKey;
  if (pointer !== "auto") {
    const found = resolvePointer(spec, pointer);
    if (Array.isArray(found)) return Object.fromEntries(found.map((item, index) => [String(index), item]));
    return isRecord(found) ? found : {};
  }
  // Auto mode: anything with a string `type` is an element, keyed by its
  // own key when it lives in a map and by its path otherwise. This is what
  // lets the oracle run against a spec format it has never seen.
  const elements = {};
  const record = resolvePointer(spec, "/elements");
  if (isRecord(record) && Object.values(record).some((value) => isRecord(value) && typeof value[typeKey] === "string")) {
    return record;
  }
  walkRecords(spec, (node, path) => {
    if (typeof node[typeKey] === "string") elements[path || "/"] = node;
  });
  return elements;
}

function elementType(element, config) {
  const typeKey = config.typeKey ?? DEFAULTS.typeKey;
  return isRecord(element) && typeof element[typeKey] === "string" ? element[typeKey] : "";
}

function elementProps(element, config) {
  const propsKey = config.propsKey ?? DEFAULTS.propsKey;
  if (!isRecord(element)) return {};
  const nested = element[propsKey];
  return isRecord(nested) ? nested : element;
}

/** Every reference expression in the spec, with the path it points at. */
export function collectReferences(spec, config) {
  const forms = config.referenceForms ?? DEFAULTS.referenceForms;
  const references = [];
  walkRecords(spec, (node, path) => {
    for (const form of forms) {
      if (typeof node[form] === "string") references.push({ form, target: node[form], at: path });
    }
  });
  return references;
}

/** Every write expression - a generated surface should not have any. */
export function collectWrites(spec, config) {
  const forms = config.writeForms ?? DEFAULTS.writeForms;
  const forbidden = config.forbiddenWritePaths ?? DEFAULTS.forbiddenWritePaths;
  const writes = [];
  if (isRecord(spec)) {
    for (const path of forbidden) {
      const key = path.replace(/^\//, "");
      if (key && Object.prototype.hasOwnProperty.call(spec, key)) {
        writes.push({ form: "root-key", target: path, at: "/" });
      }
    }
  }
  walkRecords(spec, (node, at) => {
    for (const form of forms) {
      const target = node[form];
      if (typeof target !== "string") continue;
      if (forbidden.some((prefix) => target === prefix || target.startsWith(`${prefix}/`))) {
        writes.push({ form, target, at });
      }
    }
  });
  return writes;
}

/**
 * Does this value look like *data*, or like *vocabulary*?
 *
 * This distinction decides whether the grounding check is usable as a gate.
 * Authoritative state is full of ordinary words - "contact", "pipeline",
 * "Complete", "activity" - that are also the correct English for a heading or
 * a button. Protecting those means flagging "Contacts" in a panel title as a
 * retyped fact, which is wrong and, worse, trains people to ignore the check.
 *
 * Real data almost always carries a marker that ordinary prose does not: a
 * digit, an identifier separator, an address-like structure, or simply enough
 * length that coincidence is implausible. Requiring one of those keeps every
 * identifier, code, price, date, address, phone number, email, and proper
 * noun phrase, and drops the dictionary.
 *
 * The cost is real and worth naming: a single-word value that genuinely was
 * retyped - a status of "Complete" written into a label - is not caught. Set
 * `factShape: "any"` when your facts are single words and you would rather
 * have the false positives.
 */
export function looksLikeData(value) {
  const text = String(value).trim();
  if (/\d/.test(text)) return true;                       // ids, prices, dates, counts
  if (/[_/@]|[a-z0-9]-[a-z0-9]|\w\.\w/i.test(text)) return true; // slugs, emails, paths, hosts
  if (text.length >= 20) return true;                      // too long to collide by accident
  // Two or more capitalised words: a proper noun phrase, not a UI word.
  const capitalised = text.split(/\s+/).filter((word) => /^[A-Z]/.test(word));
  return capitalised.length >= 2;
}

/**
 * Strings from authoritative state that a surface must reference rather than
 * retype. Short values are excluded - "3" in a label is a coincidence, a
 * 14-character address is not - and so, by default, are values that read as
 * vocabulary rather than data.
 */
export function authoritativeFacts(state, {
  minFactLength = DEFAULTS.minFactLength,
  factShape = DEFAULTS.factShape,
} = {}) {
  const facts = new Set();
  const keep = (text) => {
    if (text.length < minFactLength) return;
    if (factShape !== "any" && !looksLikeData(text)) return;
    facts.add(text);
  };
  const collect = (value) => {
    if (Array.isArray(value)) { value.forEach(collect); return; }
    if (!isRecord(value)) return;
    for (const child of Object.values(value)) {
      if (typeof child === "string") keep(child.trim());
      else if (typeof child === "number") keep(String(child));
      else collect(child);
    }
  };
  collect(state);
  return [...facts].sort((left, right) => right.length - left.length);
}

function checkCatalog(elements, config) {
  if (!config.catalog || config.catalog.length === 0) return [];
  const allowed = new Set(config.catalog);
  return Object.entries(elements)
    .map(([key, element]) => [key, elementType(element, config)])
    .filter(([, type]) => !allowed.has(type))
    .map(([key, type]) => finding("catalog", `${key}: "${type || "(no type)"}" is not a component this host renders`, {
      element: key, type,
    }));
}

function checkRoot(spec, elements, config) {
  if (!config.requireRootType) return [];
  const rootKey = resolvePointer(spec, config.rootPointer ?? DEFAULTS.rootPointer);
  const rootElement = typeof rootKey === "string" ? elements[rootKey] : null;
  const type = elementType(rootElement, config);
  if (type === config.requireRootType) return [];
  return [finding("root", `root must be ${config.requireRootType}, found "${type || "(missing)"}"`, {
    element: typeof rootKey === "string" ? rootKey : null,
  })];
}

function checkReferences(spec, state, config) {
  const prefixes = config.authoritativePathPrefixes ?? DEFAULTS.authoritativePathPrefixes;
  const draftPrefixes = config.draftPathPrefixes ?? DEFAULTS.draftPathPrefixes;
  const findings = [];
  for (const reference of collectReferences(spec, config)) {
    if (!reference.target.startsWith("/")) continue; // relative item refs resolve at render time
    // A binding to the user's own draft input is the correct way to route what
    // they typed into an operation. It has nothing to resolve against yet.
    if (draftPrefixes.some((prefix) => reference.target === prefix
      || reference.target.startsWith(`${prefix}/`))) continue;
    if (prefixes.length && !prefixes.some((prefix) => reference.target.startsWith(prefix))) {
      findings.push(finding("reference-scope", `${reference.at}: ${reference.form} "${reference.target}" is outside the authoritative state`, reference));
      continue;
    }
    if (state !== undefined && resolvePointer(state, reference.target) === undefined) {
      findings.push(finding("reference-unresolved", `${reference.at}: ${reference.form} "${reference.target}" does not resolve against the result state`, reference));
    }
  }
  return findings;
}

/**
 * Substring containment, but only on word boundaries: "contact" must not match
 * inside "contacted", and a fact must appear as itself rather than as a
 * fragment of a longer word.
 */
function containsFact(haystack, fact) {
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(fact, from);
    if (at === -1) return false;
    const before = at === 0 ? "" : haystack[at - 1];
    const after = haystack[at + fact.length] ?? "";
    const wordish = /[a-z0-9]/;
    const startsClean = !wordish.test(before) || !wordish.test(fact[0]);
    const endsClean = !wordish.test(after) || !wordish.test(fact[fact.length - 1]);
    if (startsClean && endsClean) return true;
    from = at + 1;
  }
}

function checkGrounding(elements, facts, config) {
  const proseProps = new Set(config.proseProps ?? DEFAULTS.proseProps);
  const findings = [];
  for (const [key, element] of Object.entries(elements)) {
    const props = elementProps(element, config);
    for (const [prop, value] of Object.entries(props)) {
      if (!proseProps.has(prop) || typeof value !== "string") continue;
      const haystack = value.toLocaleLowerCase();
      for (const fact of facts) {
        if (containsFact(haystack, fact.toLocaleLowerCase())) {
          findings.push(finding("grounding", `${key}.${prop} retypes the authoritative value "${fact}" instead of binding to it`, {
            element: key, prop, fact,
          }));
          break;
        }
      }
    }
  }
  return findings;
}

function checkActions(elements, config) {
  const actionConfig = { ...DEFAULTS.action, ...(config.action ?? {}) };
  const registry = new Map(
    (config.operations ?? []).map((operation) =>
      (typeof operation === "string" ? [operation, { id: operation }] : [operation.id, operation])),
  );
  const forms = config.referenceForms ?? DEFAULTS.referenceForms;
  const findings = [];
  const used = [];

  for (const [key, element] of Object.entries(elements)) {
    const props = elementProps(element, config);
    const action = props[actionConfig.prop];
    if (!isRecord(action)) continue;
    if (action[actionConfig.kindKey] && action[actionConfig.kindKey] !== actionConfig.operationKind) continue;
    const type = elementType(element, config);
    if (config.actionableTypes?.length && !config.actionableTypes.includes(type)) {
      findings.push(finding("action-host", `${key}: a ${type} cannot carry a server operation`, { element: key, type }));
    }
    const operationId = action[actionConfig.operationKey];
    if (typeof operationId !== "string" || !operationId) {
      findings.push(finding("action-id", `${key}: action has no ${actionConfig.operationKey}`, { element: key }));
      continue;
    }
    used.push(operationId);
    const contract = registry.get(operationId);
    if (registry.size && !contract) {
      findings.push(finding("action-unknown", `${key}: "${operationId}" is not an operation this server exposes`, {
        element: key, operationId,
      }));
      continue;
    }
    if (contract?.version !== undefined && action[actionConfig.versionKey] !== contract.version) {
      findings.push(finding("action-version", `${key}: ${operationId} pinned to version ${String(action[actionConfig.versionKey])}, server exposes ${String(contract.version)}`, {
        element: key, operationId,
      }));
    }
    const input = action[actionConfig.inputKey];
    if (input === undefined) continue;
    if (!isRecord(input)) {
      findings.push(finding("action-input", `${key}: ${operationId} input is not an object of references`, { element: key, operationId }));
      continue;
    }
    for (const [name, expression] of Object.entries(input)) {
      if (!isRecord(expression)) {
        findings.push(finding("action-literal", `${key}: ${operationId}.${name} is a literal the model invented, not a reference`, {
          element: key, operationId, input: name,
        }));
        continue;
      }
      const keys = Object.keys(expression);
      if (keys.length !== 1 || !forms.includes(keys[0])) {
        findings.push(finding("action-literal", `${key}: ${operationId}.${name} is not a single ${forms.join("/")} reference`, {
          element: key, operationId, input: name,
        }));
      }
    }
    for (const required of contract?.requiredInputs ?? []) {
      if (!isRecord(input) || input[required] === undefined) {
        findings.push(finding("action-missing-input", `${key}: ${operationId} is missing required input "${required}"`, {
          element: key, operationId, input: required,
        }));
      }
    }
  }
  return { findings, used };
}

/**
 * Evaluate one surface against one authoritative state.
 *
 * `state` is normally the tool results of the turn that produced the surface -
 * the only facts the model was entitled to show.
 */
export function evaluateSurface({ spec, state, config = {} }) {
  const merged = { ...DEFAULTS, ...config, action: { ...DEFAULTS.action, ...(config.action ?? {}) } };
  const elements = extractElements(spec, merged);
  const facts = authoritativeFacts(state, merged);
  const actions = checkActions(elements, merged);

  const findings = [
    ...checkCatalog(elements, merged),
    ...checkRoot(spec, elements, merged),
    ...collectWrites(spec, merged).map((write) =>
      finding("write-firewall", `${write.at}: surface writes authoritative state at "${write.target}"`, write)),
    ...checkReferences(spec, state, merged),
    ...checkGrounding(elements, facts, merged),
    ...actions.findings,
  ];

  if (merged.requireAction && actions.used.length === 0) {
    findings.push(finding("action-absent", "the surface offers no server-bound control, so nothing on it can be acted on"));
  }

  const ignored = new Set(merged.ignoreRules ?? []);
  const kept = findings.filter((item) => !ignored.has(item.rule));

  return {
    passed: kept.length === 0,
    findings: kept,
    suppressed: findings.filter((item) => ignored.has(item.rule)),
    elementKeys: Object.keys(elements).sort(),
    elementTypes: Object.fromEntries(Object.entries(elements).map(([key, element]) => [key, elementType(element, merged)])),
    operations: actions.used,
    factsConsidered: facts.length,
  };
}

/**
 * Amendment stability: when the model revises a surface, the keys it already
 * showed must survive. A rebuilt tree makes the whole answer flash and throws
 * away focus, scroll, and any input the user had already typed.
 */
export function evaluateAmendment(previous, next, config = {}) {
  const merged = { ...DEFAULTS, ...config };
  const before = extractElements(previous, merged);
  const after = extractElements(next, merged);
  const findings = [];
  const retained = [];
  const removed = [];

  const beforeRoot = resolvePointer(previous, merged.rootPointer);
  const afterRoot = resolvePointer(next, merged.rootPointer);
  if (beforeRoot !== undefined && beforeRoot !== afterRoot) {
    findings.push(finding("amendment-root", `root key changed ${String(beforeRoot)} -> ${String(afterRoot)}`));
  }
  for (const [key, element] of Object.entries(before)) {
    if (!(key in after)) {
      removed.push(key);
      findings.push(finding("amendment-removed", `element "${key}" disappeared in the amendment`, { element: key }));
      continue;
    }
    retained.push(key);
    const wasType = elementType(element, merged);
    const isType = elementType(after[key], merged);
    if (wasType !== isType) {
      findings.push(finding("amendment-retyped", `element "${key}" changed ${wasType} -> ${isType}`, { element: key }));
    }
  }
  return { passed: findings.length === 0, findings, retained, removed };
}
