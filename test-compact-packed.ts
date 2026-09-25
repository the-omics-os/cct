import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const port = Number(process.env.CCT_PACK_TEST_PORT ?? 17906);
const dir = await mkdtemp(join(tmpdir(), "cct-compact-packed-"));
const packageDir = join(dir, "package");
const brokerUrl = `http://127.0.0.1:${port}`;
const cctDir = join(dir, "cct");
const envBase = { ...process.env, HOME: dir, CCT_DIR: cctDir, CCT_PORT: String(port), CCT_BROKER: brokerUrl, CCT_TOKEN: "" };
const broker = spawn(process.execPath, ["--import", resolve("node_modules/tsx/dist/loader.mjs"), resolve("broker.ts")], { cwd: dir, env: envBase, stdio: "ignore" });
let transport: StdioClientTransport | undefined;
let client: Client | undefined;
try {
  execFileSync("npm", ["pack", "--pack-destination", dir], { cwd: process.cwd(), stdio: "pipe" });
  const tgz = (await import("node:fs/promises")).readdir(dir).then((files) => files.find((f) => f.endsWith(".tgz"))!);
  const artifact = join(dir, await tgz);
  const listing = execFileSync("tar", ["-tzf", artifact], { encoding: "utf8" }).split("\n").filter(Boolean);
  for (const file of ["package/server.ts", "package/cli.ts", "package/os-extension.ts", "package/shared/compact.ts", "package/shared/constants.ts"]) {
    assert.ok(listing.includes(file), `packed artifact is missing ${file}`);
  }
  execFileSync("tar", ["-xzf", artifact, "-C", dir]);
  await symlink(resolve("node_modules"), join(packageDir, "node_modules"), "dir");
  const end = Date.now() + 10000;
  while (Date.now() < end) { try { if ((await fetch(`${brokerUrl}/health`)).ok) break; } catch {} await delay(100); }
  assert.equal((await fetch(`${brokerUrl}/health`)).status, 200);
  const env = { ...envBase, CCT_RUNTIME: "os", CCT_TOOL_SURFACE: "compact" };
  transport = new StdioClientTransport({ command: process.execPath, args: ["--import", resolve("node_modules/tsx/dist/loader.mjs"), join(packageDir, "server.ts")], cwd: packageDir, env });
  client = new Client({ name: "packed-compact-acceptance", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), ["cct_check_messages", "cct"]);
  const status: any = await client.callTool({ name: "cct", arguments: { action: "status" } });
  const identity = /^you: ([^/]+)\/([^ ]+)/m.exec(String((status.content?.[0] as { text?: string })?.text ?? ""));
  if (!identity) throw new Error("packed cct status did not return its identity");
  const db = await import("node:sqlite");
  const connection = new db.DatabaseSync(join(cctDir, "cct.db"));
  const peer = connection.prepare("SELECT id, secret FROM peers WHERE id=? AND status='active'").get(identity[1]) as { id: string; secret: string };
  const now = String(Date.now());
  const sender = await fetch(`${brokerUrl}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pid: process.pid, pid_start: now, host_pid: process.pid, host_pid_start: now, runtime: "claude", session_key: `packed-sender-${now}`, cwd: dir, name: `packed-sender-${now}`, name_is_explicit: true }) }).then((r) => r.json()) as any;
  const body = { peer_id: sender.data.id, peer_secret: sender.data.secret, to_peer_id: peer.id, body: "packed-artifact-check-message" };
  const sent = await fetch(`${brokerUrl}/message/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()) as any;
  assert.equal(sent.ok, true, sent.error);
  let checked: any;
  for (let attempt = 0; attempt < 30; attempt++) {
    checked = await client.callTool({ name: "cct_check_messages", arguments: {} });
    const output = String((checked.content?.[0] as { text?: string })?.text ?? "");
    if (output.includes("packed-artifact-check-message")) break;
    await delay(100);
  }
  assert.match(String((checked.content?.[0] as { text?: string })?.text ?? ""), /packed-artifact-check-message/);
  console.log(JSON.stringify({ passed: true, package_files: ["server.ts", "cli.ts", "os-extension.ts", "shared/compact.ts", "shared/constants.ts"], tool_list: tools.tools.map((tool) => tool.name), message_read_from_packed_server: true }, null, 2));
  connection.close();
} finally {
  await client?.close().catch(() => undefined);
  await transport?.close().catch(() => undefined);
  if (broker.exitCode === null) { broker.kill("SIGTERM"); await new Promise<void>((done) => broker.once("exit", () => done())); }
  await rm(dir, { recursive: true, force: true });
}
