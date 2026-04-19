import { basename } from "node:path";

export async function generateSummary(cwd: string): Promise<string> {
  let gitRoot = cwd;
  let branch = "unknown";
  const recentFiles: string[] = [];

  try {
    const rootProc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const rootOut = await new Response(rootProc.stdout).text();
    if (rootOut.trim()) gitRoot = rootOut.trim();
  } catch {}

  try {
    const branchProc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const branchOut = await new Response(branchProc.stdout).text();
    if (branchOut.trim()) branch = branchOut.trim();
  } catch {}

  try {
    const diffProc = Bun.spawn(["git", "diff", "--name-only", "HEAD~3"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const diffOut = await new Response(diffProc.stdout).text();
    for (const line of diffOut.trim().split("\n")) {
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
