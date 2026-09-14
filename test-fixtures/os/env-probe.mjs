import fs from "node:fs";
import { execFileSync } from "node:child_process";
export function record(kind, extra = {}) {
  const marker = JSON.parse(fs.readFileSync(process.env.PROBE_MARKER, "utf8").toString() || "{}");
  const values = Object.fromEntries(["CCT_RUNTIME", "AI_AGENT", "PI_PACKAGE_DIR", "PI_CODING_AGENT_DIR", "OS_CODING_AGENT_DIR", "CODEX_HOME"].map(k => [k, process.env[k] ?? null]));
  const session = Object.fromEntries(["PI_SESSION_ID", "PI_SESSION_FILE", "OS_SESSION_ID"].map(k => [k, { present: Object.hasOwn(process.env, k), equalsSessionId: !!process.env[k] && process.env[k] === marker.sessionId, equalsSessionFile: !!process.env[k] && process.env[k] === marker.sessionFile }]));
  const ancestry = [];
  let pid = process.pid;
  for (let i = 0; i < 6 && pid > 1; i++) {
    try {
      const line = execFileSync("/bin/ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8" }).trim();
      const match = line.match(/^(\d+)\s+(.+)$/);
      if (!match) break;
      ancestry.push({ pid, ppid: Number(match[1]), comm: match[2] });
      pid = Number(match[1]);
    } catch { break; }
  }
  const result = { kind, timestamp: Date.now(), pid: process.pid, ppid: process.ppid, cwd: process.cwd(), values, session, envKeyCount: Object.keys(process.env).length, ancestry, ...extra };
  fs.appendFileSync(process.env.PROBE_LOG, JSON.stringify(result) + "\n");
}
if (process.argv[2] === "bash") record("bash");
