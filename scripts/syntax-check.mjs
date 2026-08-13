/** Parse every source file. A cheap stand-in for a linter with no dependencies. */
import { readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const roots = ["src", "bin", "test", "scripts", "examples"];
const files = [];
const walk = (directory) => {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (path.endsWith(".mjs")) files.push(path);
  }
};
for (const root of roots) walk(new URL(`../${root}`, import.meta.url).pathname);

for (const file of files) execFileSync(process.execPath, ["--check", file]);
console.log(`${files.length} files parse`);
