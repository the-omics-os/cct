// Isolated real broker + MCP acceptance. Creates its own HOME/port; never uses
// operator config or a live broker. Run: node --import tsx test-os-inbox-server.ts
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync, existsSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildOsInboxSnapshot, OS_INBOX_MAX_BYTES, OS_INBOX_BODY_BYTES, OS_INBOX_MAX_OFFERED, parseOsInboxReceipt } from "./shared/os-inbox.ts";
import type { PollMessage } from "./shared/types.ts";

const binding = { peerId: "peer", sessionId: "session", producer: "producer" };
const row = (id: number, body = `body-${id}`): PollMessage => ({ message_id: id, pool_id: null, pool_name: null, from_id: "sender", from_name: "Sender", from_cwd: null, from_branch: null, from_summary: null, body, msg_type: "chat", seq: id, created_at: "now" });
const oversized = row(1, "x".repeat(OS_INBOX_BODY_BYTES));
const bounded = buildOsInboxSnapshot(binding, true, [oversized, ...Array.from({ length: 25 }, (_, i) => row(27 - i))], new Set());
assert.equal(bounded.messages.length, 20);
assert.deepEqual(bounded.messages.map((m) => m.message_id), Array.from({ length: 20 }, (_, i) => i + 3));
assert.equal(bounded.remainingDm, 6);
assert.match(bounded.blocked!, /oversized DM IDs: 1/);
assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= OS_INBOX_MAX_BYTES);
const full = new Set(Array.from({ length: OS_INBOX_MAX_OFFERED }, (_, i) => i + 1));
const pressure = buildOsInboxSnapshot(binding, true, [row(1), row(9999)], full);
assert.deepEqual(pressure.messages.map((m) => m.message_id), [1]);
assert.match(pressure.blocked!, /backpressure/);
const bodyLimit = buildOsInboxSnapshot(binding, true, [row(1, "é".repeat(20000)), row(2, "x".repeat(30000)), row(3)], new Set());
assert.deepEqual(bodyLimit.messages.map((m) => m.message_id), [1, 3]);
assert.ok(bodyLimit.messages.reduce((n, m) => n + Buffer.byteLength(JSON.stringify(m.body)), 0) <= OS_INBOX_BODY_BYTES);
const filters = buildOsInboxSnapshot(binding, false, [row(1), { ...row(2), pool_id: "pool" }, { ...row(3), pool_name: "DM" }, { ...row(4), msg_type: "service_event" }, { ...row(5), from_id: "system" }], new Set());
assert.deepEqual(filters.messages.map((m) => m.message_id), [1]);
assert.equal(filters.poolCount, 2);
assert.equal(parseOsInboxReceipt(JSON.stringify({ version: 1, ...binding, consumed: [1, 1] }), binding), null);
assert.equal(parseOsInboxReceipt(JSON.stringify({ version: 1, ...binding, consumed: [Number.MAX_SAFE_INTEGER + 1] }), binding), null);
assert.equal(parseOsInboxReceipt(JSON.stringify({ version: 1, ...binding, consumed: Array.from({ length: 257 }, (_, i) => i + 1) }), binding), null);

const home = mkdtempSync(resolve(tmpdir(), "cct-inbox-server-"));
const dir = resolve(home, ".cct");
mkdirSync(resolve(dir, "pidmaps"), { recursive: true, mode: 0o700 });
const session = `inbox-${process.pid}`;
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
let failAcks = false;
let hangNextPeek = false, hungPeeks = 0;
let failedAcks = 0;
const ackRequests: number[][] = [];
const proxy = createHttpServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks);
  if (req.url === "/message/peek" && hangNextPeek) {
    hangNextPeek = false; hungPeeks++;
    // Deliberately never respond. The client's finite poll deadline must
    // release single-flight polling, not freeze all future inbox snapshots.
    return;
  }
  if (req.url === "/message/read") {
    ackRequests.push(JSON.parse(body.toString()).message_ids);
    if (failAcks) {
      failedAcks++;
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "injected ack failure" }));
      return;
    }
  }
  try {
    const upstream = await fetch(broker + req.url, { method: req.method, headers: { "Content-Type": "application/json" }, body: req.method === "GET" ? undefined : body });
    res.writeHead(upstream.status, { "Content-Type": "application/json" });
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) { res.writeHead(502); res.end(String(error)); }
});
await new Promise<void>((ok) => proxy.listen(0, "127.0.0.1", ok));
const pa = proxy.address();
assert.ok(pa && typeof pa !== "string");
const proxyUrl = `http://127.0.0.1:${pa.port}`;
const env = { PATH: process.env.PATH ?? "", HOME: home, CCT_DIR: dir, CCT_PORT: String(port), CCT_BROKER: broker, CCT_HOST: "127.0.0.1", CCT_RUNTIME: "os", CCT_OS_INBOX_BODY: "1", CCT_TOOL_SURFACE: "compact", PI_OFFLINE: "1", AWS_EC2_METADATA_DISABLED: "true" };
const daemon = spawn(process.execPath, ["--import", "tsx", resolve("broker.ts")], { env, stdio: "ignore" });
const delay = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
async function wait<T>(read: () => T | undefined | Promise<T | undefined>, label: string): Promise<T> {
  for (let i = 0; i < 120; i++) { try { const value = await read(); if (value !== undefined) return value; } catch {} await delay(100); }
  throw new Error(`timeout: ${label}`);
}
async function post(path: string, body: object): Promise<any> {
  const response = await fetch(broker + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await response.json() as any;
  assert.equal(json.ok, true, `${path}: ${json.error}`);
  return json.data;
}
const connections: { client: Client; transport: StdioClientTransport }[] = [];
async function open(bodyDelivery = true) {
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", resolve("server.ts")], env: { ...env, CCT_OS_INBOX_BODY: bodyDelivery ? "1" : "0", CCT_BROKER: proxyUrl }, stderr: "pipe" });
  const client = new Client({ name: "inbox-server-test", version: "1" }, { capabilities: {} });
  connections.push({ client, transport });
  transport.stderr?.on("data", () => undefined);
  await client.connect(transport);
  const status: any = await client.callTool({ name: "cct", arguments: { action: "status" } });
  const id = /^you: ([^/]+)\//.exec(status.content[0].text)?.[1];
  assert.ok(id, JSON.stringify(status));
  return { client, id, transport };
}
try {
  await wait(async () => (await fetch(broker + "/health")).ok ? true : undefined, "private broker");
  const sender = await post("/register", { pid: process.pid, pid_start: String(Date.now()), host_pid: process.pid, host_pid_start: String(Date.now()), runtime: "claude", session_key: `sender-${session}`, cwd: process.cwd(), name: `sender-${session}`, name_is_explicit: true });
  const legacy = await open(false);
  await wait(() => existsSync(resolve(dir, "flags", `${legacy.id}.os-notify`)) ? true : undefined, "legacy metadata without body opt-in");
  await delay(2200);
  assert.equal(existsSync(resolve(dir, "flags", `${legacy.id}.os-inbox`)), false, "legacy servers never publish bodies without opt-in");
  await legacy.client.close(); await legacy.transport.close();
  const first = await open();
  const b = resolve(dir, "pidmaps", `os_${session}`);
  const owner = () => readFileSync(b, "utf8").trim().split("|")[2];
  const feed = resolve(dir, "flags", `${first.id}.os-inbox`);
  const receiptPath = resolve(dir, "flags", `${first.id}.os-receipt`);
  const snapshot = () => JSON.parse(readFileSync(feed, "utf8"));
  const ids = () => snapshot().messages.map((m: PollMessage) => m.message_id);
  const unread = async () => (await post("/message/poll", { peer_id: first.id })).map((m: PollMessage) => m.message_id) as number[];
  const send = async (body: string) => (await post("/message/send", { peer_id: sender.id, peer_secret: sender.secret, to_peer_id: first.id, body })).message_id as number;
  const receipt = (consumed: number[], override = {}) => ({ version: 1, peerId: first.id, sessionId: session, producer: owner(), consumed, ...override });
  const put = (value: unknown) => {
    writeFileSync(receiptPath + ".test-tmp", typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
    renameSync(receiptPath + ".test-tmp", receiptPath);
  };
  const a = await send("actual untruncated DM body 🦞");
  const next = await send("must remain unread after ack of first ID");
  await wait(() => ids().includes(next) ? true : undefined, "body publication");
  assert.equal(snapshot().messages[0].body, "actual untruncated DM body 🦞");
  assert.equal(snapshot().sessionId, session);
  assert.equal(snapshot().producer, owner());
  assert.equal(snapshot().localBroker, true);
  assert.equal(statSync(feed).mode & 0o777, 0o600);
  assert.equal(statSync(resolve(dir, "flags")).mode & 0o777, 0o700);
  const timestamp = snapshot().timestamp;
  await wait(() => snapshot().timestamp > timestamp ? true : undefined, "republish without response");
  assert.deepEqual(await unread(), [a, next], "publication and repeated polling never acknowledge");
  assert.equal(ackRequests.length, 0);
  hangNextPeek = true;
  await wait(() => hungPeeks ? true : undefined, "held poll request");
  await wait(() => !existsSync(feed) ? true : undefined, "finite poll timeout invalidates snapshot");
  await wait(() => ids().includes(next) ? true : undefined, "single-flight worker recovers after stalled HTTP");
  assert.deepEqual(await unread(), [a, next], "timeout cannot acknowledge anything");
  for (const bad of ["{", receipt([a, 999999]), receipt([a], { peerId: "foreign" }), receipt([a], { sessionId: "foreign" }), receipt([a], { producer: "foreign" }), receipt([-1]), receipt([a, a])]) {
    put(bad);
    await delay(2300);
    assert.deepEqual(await unread(), [a, next]);
    assert.equal(ackRequests.length, 0, "invalid receipt rejected wholly before HTTP");
    assert.ok(existsSync(receiptPath), "invalid/foreign receipt left untouched");
  }
  failAcks = true;
  put(receipt([a]));
  await wait(() => failedAcks > 0 ? true : undefined, "injected ack failure");
  assert.deepEqual(await unread(), [a, next]);
  assert.ok(existsSync(receiptPath));
  failAcks = false;
  await wait(async () => (await unread()).includes(a) ? undefined : true, "ack retry exact ID");
  await wait(() => !existsSync(receiptPath) ? true : undefined, "receipt cleared after ack");
  assert.deepEqual(await unread(), [next]);
  assert.ok(ackRequests.every((request) => JSON.stringify(request) === JSON.stringify([a])));
  await wait(() => !ids().includes(a) ? true : undefined, "acked body removed");

  const manual: any = await first.client.callTool({ name: "cct_check_messages", arguments: {} });
  assert.match(manual.content[0].text, /must remain unread/);
  assert.equal(existsSync(feed), false, "manual read immediately invalidates automatic snapshot");
  await wait(() => ids().length === 0 ? true : undefined, "manual deferred-ack suppression");
  assert.deepEqual(await unread(), [next], "manual semantics still deferred");
  const manualNew = await send("new DM while manual deferred ack pending");
  await wait(() => ids().includes(manualNew) ? true : undefined, "only future DM offered");
  assert.deepEqual(ids(), [manualNew]);
  // A failed optional feed write must not hide a successful manual body return.
  rmSync(feed); mkdirSync(feed);
  const diskFailure: any = await first.client.callTool({ name: "cct_check_messages", arguments: {} });
  assert.equal(diskFailure.isError, undefined);
  assert.match(diskFailure.content[0].text, /new DM while manual/);
  rmSync(feed, { recursive: true });
  await first.client.callTool({ name: "cct_check_messages", arguments: {} });
  assert.deepEqual(await unread(), []);

  const own = await send("old producer receipt must not transfer to new owner");
  await wait(() => ids().includes(own) ? true : undefined, "old owner offer");
  const stale = receipt([own]);
  const oldOwner = owner();
  const second = await open();
  assert.equal(second.id, first.id);
  assert.notEqual(owner(), oldOwner);
  put(stale);
  await wait(() => snapshot().producer === owner() && ids().includes(own) ? true : undefined, "new owner publishes body");
  const ackCount = ackRequests.length;
  await delay(2300);
  assert.deepEqual(await unread(), [own]);
  assert.equal(ackRequests.length, ackCount);
  assert.equal(JSON.parse(readFileSync(receiptPath, "utf8")).producer, oldOwner, "new producer does not delete foreign receipt");
  put(receipt([own]));
  await wait(async () => (await unread()).length === 0 ? true : undefined, "new matching receipt accepted");
  await wait(() => !existsSync(receiptPath) ? true : undefined, "new receipt removed");

  const final = await send("cleanup receipt body");
  await wait(() => ids().includes(final) ? true : undefined, "cleanup body offer");
  put(receipt([final]));
  await second.client.close();
  await second.transport.close().catch(() => undefined);
  await wait(async () => (await unread()).length === 0 ? true : undefined, "owner cleanup consumes receipt before unregister");
  const unconsumed = await send("shutdown without receipt is not automatic consumption");
  await wait(() => ids().includes(unconsumed) && snapshot().producer === owner() ? true : undefined, "survivor takes over feed");
  await first.client.close();
  await first.transport.close().catch(() => undefined);
  assert.deepEqual(await unread(), [unconsumed], "automatic offers never enter cleanup's legacy pendingAckIds");
  assert.equal(existsSync(feed), false, "owning publisher cleans feed on shutdown");
  console.log("PASS private real broker/MCP: bodies, permissions, bounded snapshot, no-ack publication/cleanup, malformed/unknown/foreign refusal, exact ack + retry, manual suppression/cache failure, ownership and cleanup receipt");
} finally {
  for (const c of connections.reverse()) { await c.client.close().catch(() => undefined); await c.transport.close().catch(() => undefined); }
  await new Promise<void>((ok) => proxy.close(() => ok()));
  daemon.kill();
  await wait(() => daemon.exitCode !== null ? true : undefined, "broker exit").catch(() => undefined);
  rmSync(home, { recursive: true, force: true });
}
