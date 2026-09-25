import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const port = Number(process.env.CCT_TERMINATE_TEST_PORT ?? 17905);
const dir = await mkdtemp(join(tmpdir(), "cct-compact-terminate-"));
const cctDir = join(dir, "cct");
const brokerUrl = `http://127.0.0.1:${port}`;
const baseEnv = { ...process.env, HOME: dir, CCT_DIR: cctDir, CCT_PORT: String(port), CCT_BROKER: brokerUrl, CCT_TOKEN: "" };
const loader = resolve("node_modules/tsx/dist/loader.mjs");
const broker = spawn(process.execPath, ["--import", loader, resolve("broker.ts")], { cwd: dir, env: baseEnv, stdio: "ignore" });
let transport: StdioClientTransport | undefined;
let client: Client | undefined;
try {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    try { if ((await fetch(`${brokerUrl}/health`)).ok) break; } catch {}
    await delay(100);
  }
  assert.equal((await fetch(`${brokerUrl}/health`)).status, 200, "isolated broker did not start");
  const ready = join(dir, "fake-host.pid");
  const terminated = join(dir, "fake-host.terminated");
  const fakeHost = join(dir, "fake-host.mjs");
  await writeFile(fakeHost, `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
process.title='os';
const ready=${JSON.stringify(ready)}; const terminated=${JSON.stringify(terminated)};
writeFileSync(ready,String(process.pid));
const child=spawn(${JSON.stringify(process.execPath)},['--import',${JSON.stringify(loader)},${JSON.stringify(resolve("server.ts"))}],{stdio:'inherit',env:process.env});
process.on('SIGTERM',()=>{writeFileSync(terminated,String(process.pid));child.kill('SIGTERM');setTimeout(()=>process.exit(0),250).unref();});
child.on('exit',()=>process.exit(0));
`);
  const env = { ...baseEnv, CCT_RUNTIME: "os", CCT_TOOL_SURFACE: "compact" };
  transport = new StdioClientTransport({ command: process.execPath, args: [fakeHost], cwd: dir, env });
  client = new Client({ name: "compact-terminate-acceptance", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  const fakePid = Number(await readFile(ready, "utf8"));
  assert.ok(fakePid > 1 && fakePid !== process.pid, "termination target must be a distinct fake host process");
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name), ["cct_check_messages", "cct"]);
  const cctTool = listed.tools.find((tool) => tool.name === "cct");
  assert.match(cctTool?.description ?? "", /Warning: this kills this agent's host session\./);
  const db = new DatabaseSync(join(cctDir, "cct.db"));
  const row = db.prepare("SELECT host_pid, runtime FROM peers WHERE status='active' AND runtime='os' ORDER BY last_seen DESC LIMIT 1").get() as { host_pid: number; runtime: string } | undefined;
  assert.equal(row?.host_pid, fakePid, "server's detected host PID must be our fake process");
  assert.equal(row?.runtime, "os");
  const call = client.callTool({ name: "cct", arguments: { action: "terminate", reason: "isolated acceptance fake-host termination" } });
  await Promise.race([call.then(() => undefined, () => undefined), delay(1500)]);
  const termEnd = Date.now() + 5000;
  while (Date.now() < termEnd) {
    try { if ((await readFile(terminated, "utf8")) === String(fakePid)) break; } catch {}
    await delay(50);
  }
  assert.equal(await readFile(terminated, "utf8"), String(fakePid), "terminate did not signal the fake host target");
  assert.equal(process.pid, process.pid, "test orchestrator remains alive");
  console.log(JSON.stringify({ passed: true, fakeHostPid: fakePid, detectedHostPid: row?.host_pid, callerPid: process.pid, warning: cctTool?.description, evidence: dir }, null, 2));
  db.close();
} finally {
  await client?.close().catch(() => undefined);
  await transport?.close().catch(() => undefined);
  if (broker.exitCode === null) { broker.kill("SIGTERM"); await new Promise<void>((resolveDone) => broker.once("exit", () => resolveDone())); }
  await rm(dir, { recursive: true, force: true });
}
