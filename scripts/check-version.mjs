/** package.json version and the version stamped into reports must agree. */
import { readFileSync } from "node:fs";

import { VERSION } from "../src/run.mjs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (pkg.version !== VERSION) {
  console.error(`package.json says ${pkg.version}, src/run.mjs says ${VERSION}`);
  process.exit(1);
}
console.log(`version ${VERSION} is consistent`);
