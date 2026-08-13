/** Just enough RFC 6901 / RFC 6902 to assemble a streamed surface. */

export const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function parsePointer(pointer) {
  if (pointer === "" || pointer === "/") return [];
  if (!pointer.startsWith("/")) throw new Error(`"${pointer}" is not a JSON pointer`);
  return pointer.slice(1).split("/").map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

export function resolvePointer(root, pointer) {
  let node = root;
  for (const token of parsePointer(pointer)) {
    if (Array.isArray(node)) {
      const index = token === "-" ? node.length : Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= node.length) return undefined;
      node = node[index];
    } else if (isRecord(node)) {
      if (!Object.prototype.hasOwnProperty.call(node, token)) return undefined;
      node = node[token];
    } else {
      return undefined;
    }
  }
  return node;
}

export function pointerExists(root, pointer) {
  return resolvePointer(root, pointer) !== undefined;
}

/** Apply one JSON Patch operation in place, returning the (possibly new) root. */
export function applyPatchOperation(root, operation) {
  const tokens = parsePointer(operation.path ?? "");
  if (tokens.length === 0) return operation.op === "remove" ? undefined : operation.value;
  const last = tokens.pop();
  let node = root;
  for (const token of tokens) {
    if (Array.isArray(node)) node = node[Number(token)];
    else if (isRecord(node)) {
      if (!isRecord(node[token]) && !Array.isArray(node[token])) node[token] = {};
      node = node[token];
    } else {
      throw new Error(`patch path ${operation.path} does not exist`);
    }
  }
  if (Array.isArray(node)) {
    const index = last === "-" ? node.length : Number(last);
    if (operation.op === "remove") node.splice(index, 1);
    else if (operation.op === "add") node.splice(index, 0, operation.value);
    else node[index] = operation.value;
    return root;
  }
  if (!isRecord(node)) throw new Error(`patch path ${operation.path} does not address an object`);
  if (operation.op === "remove") delete node[last];
  else node[last] = operation.value;
  return root;
}

export function applyPatch(root, operations) {
  let next = root;
  for (const operation of [].concat(operations ?? [])) {
    if (!operation || typeof operation.op !== "string") continue;
    next = applyPatchOperation(next ?? {}, operation);
  }
  return next;
}

/** Walk every plain object in a value, depth first. */
export function walkRecords(value, visit, path = "") {
  if (Array.isArray(value)) {
    value.forEach((child, index) => walkRecords(child, visit, `${path}/${index}`));
    return;
  }
  if (!isRecord(value)) return;
  visit(value, path);
  for (const [key, child] of Object.entries(value)) {
    walkRecords(child, visit, `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`);
  }
}
