// Real broker + two independent os MCP processes sharing one session/B pidmap.
// Run with a private allowlisted HOME/CCT_DIR; never contacts a live broker.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const dir = process.env.CCT_DIR;
assert.ok(dir && process.env.HOME && dir.startsWith(process.env.HOME + "/"), "requires private HOME/CCT_DIR");
mkdirSync(resolve(dir, "pidmaps"), { recursive: true, mode: 0o700 });
const session = `sibling-${process.pid}`;
// The real os host may be several tsx wrappers above this test. Reproduce the
// server's host resolution, but place the marker ONLY inside our private dir.
let hostPid = process.pid;
for (let pid = process.pid, depth = 0; pid > 1 && depth < 8; depth++) {
  const name = spawnSync("ps", ["-o", "comm=", "-p", String(pid)]).stdout.toString().trim();
  if (name === "os" || name.endsWith("/os")) { hostPid = pid; break; }
  const parent = Number(spawnSync("ps", ["-o", "ppid=", "-p", String(pid)]).stdout.toString().trim());
  if (!parent || parent === pid) break;
  pid = parent;
}
writeFileSync(resolve(dir, "pidmaps", `os_session_${hostPid}`), session);
const listener = createServer();
await new Promise<void>((ok) => listener.listen(0, "127.0.0.1", ok));
const address = listener.address();
assert.ok(address && typeof address !== "string");
const port = address.port;
await new Promise<void>((ok) => listener.close(() => ok()));
const broker = `http://127.0.0.1:${port}`;
// The first sibling alone connects through a test-owned proxy. Fail only its
// checker peek while the second sibling keeps polling the real broker.
let failFirstPeek = false;
const proxy = createHttpServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (failFirstPeek && req.url === "/message/peek") {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "injected checker peek failure" }));
    return;
  }
  try {
    const upstream = await fetch(broker + req.url, {
      method: req.method, headers: { "Content-Type": "application/json" },
      body: req.method === "GET" ? undefined : Buffer.concat(chunks),
    });
    res.writeHead(upstream.status, { "Content-Type": "application/json" });
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    res.writeHead(502); res.end(String(error));
  }
});
await new Promise<void>((ok) => proxy.listen(0, "127.0.0.1", ok));
const proxyAddress = proxy.address();
assert.ok(proxyAddress && typeof proxyAddress !== "string");
const firstBroker = `http://127.0.0.1:${proxyAddress.port}`;
const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME, CCT_DIR: dir, CCT_PORT: String(port), CCT_BROKER: broker, CCT_HOST: "127.0.0.1", PI_OFFLINE: "1", AWS_EC2_METADATA_DISABLED: "true", CCT_RUNTIME: "os", CCT_TOOL_SURFACE: "compact" };
const daemon = spawn(process.execPath, ["--import", "tsx", resolve("broker.ts")], { env, stdio: "ignore" });
const delay = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const wait = async <T>(read: () => T | undefined | Promise<T | undefined>, label: string, attempts = 100): Promise<T> => {
  for (let i = 0; i < attempts; i++) { try { const value = await read(); if (value !== undefined) return value; } catch {} await delay(100); }
  throw new Error(`timeout: ${label}`);
};
const post = async (path: string, body: object) => {
  const result = await fetch(broker + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await result.json() as any;
  assert.equal(json.ok, true, `${path}: ${json.error}`);
  return json.data;
};
const connections: { client: Client; transport: StdioClientTransport }[] = [];
const open = async (brokerUrl: string | null = broker) => {
  const childEnv: Record<string, string> = { ...env };
  if (brokerUrl === null) delete childEnv.CCT_BROKER;
  else childEnv.CCT_BROKER = brokerUrl;
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", resolve("server.ts")], env: childEnv });
  const client = new Client({ name: "sibling-regression", version: "1" }, { capabilities: {} });
  connections.push({ client, transport });
  await client.connect(transport);
  const status: any = await client.callTool({ name: "cct", arguments: { action: "status" } });
  const header = String(status.content[0].text);
  const id = /^you: ([^/]+)\//.exec(header)?.[1];
  assert.ok(id, header);
  return { client, id };
};
const check = async (client: Client) => await client.callTool({ name: "cct_check_messages", arguments: {} }) as any;
try {
  await wait(async () => { if (daemon.exitCode !== null) return; const health = await fetch(broker + "/health"); return health.ok ? true : undefined; }, "broker health");
  const sender = await post("/register", { pid: process.pid, pid_start: String(Date.now()), host_pid: process.pid, host_pid_start: String(Date.now()), runtime: "claude", session_key: `sender-${session}`, cwd: process.cwd(), name: `sender-${session}`, name_is_explicit: true });
  const first = await open(firstBroker);
  await delay(250);
  const second = await open();
  const b = await wait(() => {
    const file = readdirSync(resolve(dir, "pidmaps")).find((name) => name === `os_${session}` || name.startsWith("os-host_"));
    return file ? resolve(dir, "pidmaps", file) : undefined;
  }, "shared os B marker");
  assert.equal(b, resolve(dir, "pidmaps", `os_${session}`), "both siblings resolved stable os session marker");
  assert.equal(first.id, second.id, "two actual MCP connections deduplicate to one peer");
  const metaPath = resolve(dir, "flags", `${first.id}.os-notify`);
  const owner = () => readFileSync(b, "utf8").trim().split("|")[2];
  const marker = () => readFileSync(b, "utf8").trim();
  const metadata = () => JSON.parse(readFileSync(metaPath, "utf8"));
  await post("/message/send", { peer_id: sender.id, peer_secret: sender.secret, to_peer_id: first.id, body: "sibling-message-A" });
  const firstNotice = await wait(() => { const m = metadata(); return m.count === 1 && m.producer === owner() ? m : undefined; }, "owner notice");
  assert.equal(firstNotice.localBroker, true, "proxy loopback URL is local");
  assert.match(marker().split("|")[3] ?? "", /\S+/, "B records verifiable process start time");
  await delay(4500);
  assert.equal(metadata().producer, owner(), "old producer cannot overwrite sidecar after staggered polls");
  assert.equal(metadata().maxId, firstNotice.maxId);
  // A failed check by the older, non-owning sibling cannot claim B or change
  // the already-notified episode. Its proxy is isolated from the live broker.
  const priorOwner = owner();
  const priorMeta = metadata();
  failFirstPeek = true;
  const failed = await check(first.client);
  failFirstPeek = false;
  assert.equal(failed.isError, true, JSON.stringify(failed));
  await delay(2500); // both siblings get another poll, including recovered proxy
  assert.equal(owner(), priorOwner, "failed checker must not transfer B");
  const afterFailure = metadata();
  assert.equal(afterFailure.producer, priorMeta.producer, "failed checker must not change sidecar producer");
  assert.equal(afterFailure.readGeneration, priorMeta.readGeneration, "failed checker must not rearm episode");
  assert.equal(afterFailure.maxDmId, priorMeta.maxDmId);
  const result = await check(first.client); // successful transfer B ownership
  assert.match(result.content[0].text, /sibling-message-A/);
  const checkerOwner = owner();
  assert.notEqual(checkerOwner, firstNotice.producer, "checker-owning older sibling reclaimed B");
  const readMeta = await wait(() => { const m = metadata(); return m.producer === checkerOwner && m.count === 0 && m.readGeneration >= 1 ? m : undefined; }, "checker-owned read generation");
  await delay(4500);
  assert.equal(metadata().producer, checkerOwner, "nonowner never republishes previously returned DM");
  assert.equal(metadata().count, 0, "pending ack from checker excludes delivered body");
  assert.equal(metadata().readGeneration, readMeta.readGeneration);
  // Force a sidecar rename failure after a successful broker peek. The checker
  // must return the body, not install a hidden ack and return isError.
  await post("/message/send", { peer_id: sender.id, peer_secret: sender.secret, to_peer_id: first.id, body: "sibling-message-B" });
  rmSync(metaPath, { force: true }); mkdirSync(metaPath);
  const flagPath = resolve(dir, "flags", `${first.id}.unread`);
  rmSync(flagPath, { force: true }); mkdirSync(flagPath);
  const diskFailure = await check(first.client);
  assert.equal(diskFailure.isError, undefined, JSON.stringify(diskFailure));
  assert.match(diskFailure.content[0].text, /sibling-message-B/, "cache failure cannot hide fetched body");
  rmSync(metaPath, { recursive: true, force: true });
  rmSync(flagPath, { recursive: true, force: true });
  await check(first.client); // acknowledge the previously returned B before recovery scenarios
  // A missing sidecar is not a lease expiry: the live owner may be stalled.
  // Recreate it using the owner's next poll; the nonowner must not claim B.
  const liveOwner = owner();
  await delay(4500);
  assert.equal(owner(), liveOwner, "live owner is never stolen when sidecar disappears");
  await wait(() => metadata().producer === liveOwner ? true : undefined, "live owner republished sidecar");
  const stalledPid = Number(liveOwner.split("-")[0]);
  process.kill(stalledPid, "SIGSTOP");
  try {
    rmSync(metaPath);
    await delay(4500);
    assert.equal(owner(), liveOwner, "SIGSTOP-stalled live owner cannot be stolen without a sidecar");
  } finally {
    process.kill(stalledPid, "SIGCONT");
  }
  await wait(() => metadata().producer === liveOwner ? true : undefined, "resumed live owner republished");
  // Legacy/unknown ownership is deliberately fail-closed, even if a sidecar
  // vanishes. The old owner cannot publish under the temporary unknown B.
  const originalB = marker();
  writeFileSync(b, originalB.split("|").slice(0, 3).join("|"));
  rmSync(metaPath);
  await delay(4500);
  assert.equal(marker().split("|").length, 3, "unknown legacy owner cannot be seized");
  writeFileSync(b, originalB);
  await wait(() => metadata().producer === liveOwner ? true : undefined, "restored owner republished");
  // A recycled live PID with a mismatching start belongs to a departed owner.
  // A survivor may claim it, whereas an unverified current PID must not.
  const fake = `${process.pid}-00000000-0000-4000-8000-000000000001`;
  const liveStart = spawnSync("ps", ["-o", "lstart=", "-p", String(process.pid)]).stdout.toString().trim().replace(/\s+/g, "_");
  assert.ok(liveStart);
  writeFileSync(b, `${first.id}|${second.id}|${fake}|${liveStart}`);
  rmSync(metaPath);
  await delay(4500);
  assert.equal(owner(), fake, "matching live PID/start cannot be stolen despite missing sidecar");
  writeFileSync(b, `${first.id}|${second.id}|${fake}|unknown-start`);
  await wait(() => owner() !== fake ? true : undefined, "reused PID takeover");
  const recoveredFromReuse = owner();
  await wait(() => metadata().producer === recoveredFromReuse ? true : undefined, "reused PID sidecar");
  // Fresh siblings become the candidate survivors. Closing the B owner must
  // recover without any checker or reconnect and must deliver a NEW DM.
  const third = await open();
  const fourth = await open();
  assert.equal(third.id, first.id);
  assert.equal(fourth.id, first.id);
  const departedOwner = owner();
  assert.notEqual(departedOwner, recoveredFromReuse);
  const last = connections[connections.length - 1];
  await last.client.close();
  await last.transport.close().catch(() => undefined);
  await post("/message/send", { peer_id: sender.id, peer_secret: sender.secret, to_peer_id: first.id, body: "post-owner-departure" });
  const recovered = await wait(() => {
    const m = metadata();
    return owner() !== departedOwner && m.producer === owner() && m.count === 1 && m.maxDmId > 0 ? m : undefined;
  }, "survivor automatic takeover and new DM", 160);
  assert.equal(recovered.localBroker, true);
  const winner = owner();
  await delay(5000); // all three surviving 2s loops must converge, not flip
  assert.equal(owner(), winner, "multiple survivors converge on one live owner");
  assert.equal(metadata().producer, winner);
  // The host has no CCT_BROKER in these two child environments. Locality must
  // follow the server's resolved config, not the environment or DNS result.
  const configPath = resolve(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ broker: `http://localhost:${port}` }));
  await open(null);
  await wait(() => metadata().localBroker === true && metadata().producer === owner() ? true : undefined, "config localhost is local");
  writeFileSync(configPath, JSON.stringify({ broker: `http://localhost.:${port}` }));
  await open(null);
  await wait(() => metadata().localBroker === false && metadata().producer === owner() ? true : undefined, "config nonexact hostname is remote even when DNS resolves locally");
  console.log("PASS sibling failure/cache, resolved local/remote metadata, stalled/legacy/reused owner, dead owner auto-takeover and three-survivor convergence");
} finally {
  for (const connection of connections.reverse()) {
    await connection.client.close().catch(() => undefined);
    await connection.transport.close().catch(() => undefined);
  }
  await new Promise<void>((ok) => proxy.close(() => ok()));
  daemon.kill();
  await wait(() => daemon.exitCode !== null ? true : undefined, "owned broker exit", 50).catch(() => undefined);
  rmSync(resolve(dir, "pidmaps", `os_session_${hostPid}`), { force: true });
}
