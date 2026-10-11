#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const tsx = createRequire(import.meta.url).resolve("tsx/cli");
const cli = join(root, "cli.ts");

try {
  execFileSync(process.execPath, [tsx, cli, ...process.argv.slice(2)], { stdio: "inherit" });
} catch (e) {
  process.exit(e.status ?? 1);
}
