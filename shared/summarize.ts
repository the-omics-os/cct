import { basename } from "node:path";
import { spawnSync } from "node:child_process";

export async function generateSummary(cwd: string): Promise<string> {
  let gitRoot = cwd;
  let branch = "unknown";
  const recentFiles: string[] = [];

  try {
    const out = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd }).stdout?.toString().trim() ?? "";
    if (out) gitRoot = out;
  } catch {}

  try {
    const out = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd }).stdout?.toString().trim() ?? "";
    if (out) branch = out;
  } catch {}

  try {
    const out = spawnSync("git", ["diff", "--name-only", "HEAD~3"], { cwd }).stdout?.toString().trim() ?? "";
    for (const line of out.split("\n")) {
      if (line.trim() && recentFiles.length < 3) {
        recentFiles.push(line.trim());
      }
    }
  } catch {}

  const project = basename(gitRoot);
  const filesStr = recentFiles.length > 0
    ? `: recently touched ${recentFiles.join(", ")}`
    : "";

  return `Working on ${project} (${branch})${filesStr}`;
}
