// Real isolated broker + real MCP servers (os and claude runtimes). Proves the server's
// flag writer and the footer reader agree on actual broker output: a real pool named DM,
// pool names with delimiters, and no stale pool summary after cct_check_messages.
// The claude run covers non-os polling, which is paused during a pending ack and so
// keeps a bad summary until the next read. Private HOME/CCT_DIR/port; never a live broker.
// Run: npx tsx test-os-footer-broker.ts
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { identityView, renderFooter, unreadView } from "./shared/os-footer.ts";
import { parseUnreadFlag } from "./shared/unread-flag.ts";

type Runtime = "os" | "claude";
const delay = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
async function wait<T>(read: () => T | undefined | Promise<T | undefined>, label: string, attempts = 200): Promise<T> {
  for (let i = 0; i < attempts; i++) { try { const value = await read(); if (value !== undefined) return value; } catch {} await delay(100); }
  throw new Error(`timeout: ${label}`);
}

async function scenario(runtime: Runtime): Promise<void> {
  const home = mkdtempSync(resolve(tmpdir(), `cct-footer-e2e-${runtime}-`));
  const dir = resolve(home, ".cct");
  mkdirSync(resolve(dir, "pidmaps"), { recursive: true, mode: 0o700 });
  mkdirSync(resolve(dir, "flags"), { recursive: true, mode: 0o700 });
  const session = `footer-e2e-${runtime}-${process.pid}`;
  if (runtime === "os") {
    // The MCP child resolves the marker at the `os` host ancestor, using the same walk as server.ts.
    let hostPid = process.pid;
    for (let pid = process.pid, depth = 0; pid > 1 && depth < 8; depth++) {
      const name = spawnSync("ps", ["-o", "comm=", "-p", String(pid)]).stdout.toString().trim();
      if (name === "os" || name.endsWith("/os")) { hostPid = pid; break; }
      const parent = Number(spawnSync("ps", ["-o", "ppid=", "-p", String(pid)]).stdout.toString().trim());
      if (!parent || parent === pid) break;
      pid = parent;
    }
    writeFileSync(resolve(dir, "pidmaps", `os_session_${hostPid}`), session);
  }
  const listener = createServer();
  await new Promise<void>((ok) => listener.listen(0, "127.0.0.1", ok));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((ok) => listener.close(() => ok()));
  const broker = `http://127.0.0.1:${port}`;
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home, CCT_DIR: dir, CCT_PORT: String(port), CCT_BROKER: broker,
    CCT_HOST: "127.0.0.1", CCT_RUNTIME: runtime, PI_OFFLINE: "1", AWS_EC2_METADATA_DISABLED: "true" };
  if (runtime === "os") Object.assign(env, { CCT_OS_INBOX_BODY: "1", CCT_TOOL_SURFACE: "compact" });
  const daemon = spawn(process.execPath, ["--import", "tsx", resolve("broker.ts")], { env, stdio: "ignore" });
  const flagPath = (id: string) => resolve(dir, "flags", `${id}.unread`);
  const readFlag = (id: string) => existsSync(flagPath(id)) ? readFileSync(flagPath(id), "utf8") : undefined;
  const post = async (path: string, body: object): Promise<any> => {
    const response = await fetch(broker + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await response.json() as any;
    assert.equal(json.ok, true, `${path}: ${json.error}`);
    return json.data;
  };
  let client: Client | undefined, transport: StdioClientTransport | undefined;
  try {
    await wait(async () => (await fetch(broker + "/health")).ok ? true : undefined, `${runtime} private broker`);
    const sender = await post("/register", { pid: process.pid, pid_start: String(Date.now()), host_pid: process.pid,
      host_pid_start: String(Date.now()), runtime: "claude", session_key: `sender-${session}`, cwd: process.cwd(),
      name: `sender-${session}`, name_is_explicit: true });
    const auth = { peer_id: sender.id, peer_secret: sender.secret };

    transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", resolve("server.ts")], env, stderr: "pipe" });
    transport.stderr?.on("data", () => undefined);
    client = new Client({ name: "footer-e2e", version: "1" }, { capabilities: {} });
    await client.connect(transport);
    const whoami: any = await client.callTool(runtime === "os"
      ? { name: "cct", arguments: { action: "status" } } : { name: "cct_whoami", arguments: {} });
    const recipient = runtime === "os" ? /^you: ([^/]+)\/(\S+)/.exec(whoami.content[0].text) : /Peer ID: (\S+)/.exec(whoami.content[0].text);
    assert.ok(recipient, whoami.content[0].text);
    const peerId = recipient[1];

    // Pools with delimiter-bearing names and a real pool named DM. Recipient joins via MCP.
    const names = ["DM", "a,b:c|d%e", "quiet"];
    for (const name of names) await post("/pool/create", { ...auth, name });
    for (const name of names) {
      const joined: any = await client.callTool(runtime === "os"
        ? { name: "cct", arguments: { action: "join", pool: name } } : { name: "cct_join_pool", arguments: { pool_name: name } });
      assert.match(joined.content[0].text, /joined|Joined|member/i, `${runtime} join ${name}: ${joined.content[0].text}`);
    }
    await post("/message/send", { ...auth, to_peer_id: peerId, body: "direct-1" });
    await post("/message/send", { ...auth, to_peer_id: peerId, body: "direct-2" });
    await post("/message/send", { ...auth, pool_name: "DM", body: "pool-named-DM" });
    for (let i = 0; i < 3; i++) await post("/message/send", { ...auth, pool_name: "a,b:c|d%e", body: `delimited-${i}` });

    // Oracle: the broker's own per-pool unread rows for this recipient.
    const oracle = async () => (await post("/message/unread-count", { peer_id: peerId })) as
      { total: number; by_pool: { pool_id: string | null; pool_name: string | null; count: number }[] };
    const expectedTotal = (await oracle()).total;
    assert.ok(expectedTotal >= 6, `${runtime} broker reports unread: ${expectedTotal}`);
    const flagRaw = await wait(async () => {
      const raw = readFlag(peerId);
      return raw && raw.startsWith(`${expectedTotal}|`) ? raw : undefined;
    }, `${runtime} server flag reaches broker total`, 300);

    const parsed = parseUnreadFlag(flagRaw);
    const brokerRows = (await oracle()).by_pool.filter((row) => row.count > 0);
    const brokerDirect = brokerRows.find((row) => row.pool_id === null)?.count ?? 0;
    const brokerPools = brokerRows.filter((row) => row.pool_id !== null)
      .map((row) => ({ name: row.pool_name ?? "", count: row.count })).sort((a, b) => a.name.localeCompare(b.name));
    assert.equal(parsed.direct, brokerDirect, `${runtime} direct count equals broker direct row`);
    assert.deepEqual([...parsed.pools].sort((a, b) => a.name.localeCompare(b.name)), brokerPools, `${runtime} pool rows equal broker rows`);
    assert.ok(parsed.pools.some((pool) => pool.name === "DM"), "real pool named DM is a pool");
    assert.ok(parsed.pools.some((pool) => pool.name === "a,b:c|d%e" && pool.count === 3), "delimiter pool name is exact");
    assert.ok(!parsed.pools.some((pool) => pool.name === "quiet"), "zero-count membership does not render");
    console.log(`PASS ${runtime} server flag matches broker rows: ${flagRaw.trim()}`);

    if (runtime === "os") {
      const identityRaw = readFileSync(resolve(dir, "pidmaps", `os_${session}`), "utf8");
      const identity = identityView(identityRaw, false);
      assert.equal(identity.kind, "peer");
      const footer = renderFooter(identity, unreadView(flagRaw, Date.now()));
      assert.ok(footer.startsWith(`CCT: ${identity.name}`), footer);
      // Each unread pool is its own `|` segment; the escaped flag decodes to the exact name,
      // with a pipe shown as ¦ so it cannot be mistaken for a separator.
      const segments = footer.split(" | ");
      assert.equal(segments[0], `CCT: ${identity.name}`, footer);
      assert.ok(segments.includes(`DM(${brokerDirect})`) && segments.includes("@DM(1)") && segments.includes("@a,b:c¦d%e(3)"), footer);
      assert.ok(!segments.some((segment) => segment.startsWith("@quiet")), "zero-count membership is not a segment");
      console.log(`PASS os footer from real flag: ${footer}`);
    }

    // cct_check_messages returns the batch. The next flag must not keep a stale pool summary.
    const checked: any = await client.callTool({ name: "cct_check_messages", arguments: {} });
    assert.match(checked.content[0].text, /you: /);
    const after = await wait(async () => {
      const raw = readFlag(peerId);
      return raw && raw.startsWith("0|") ? raw : undefined;
    }, `${runtime} flag total drops to zero after check`, 100);
    assert.equal(after.trim().split("|")[1], "", `${runtime} summary empty after read batch: ${after.trim()}`);
    if (runtime === "os") {
      const identity = identityView(readFileSync(resolve(dir, "pidmaps", `os_${session}`), "utf8"), false);
      assert.equal(renderFooter(identity, unreadView(after, Date.now())), `CCT: ${identity.kind === "peer" ? identity.name : ""}`, "quiet footer after check");
    }
    console.log(`PASS ${runtime} cct_check_messages leaves no stale pool summary`);
  } finally {
    await client?.close().catch(() => {});
    await transport?.close().catch(() => {});
    daemon.kill();
    rmSync(home, { recursive: true, force: true });
  }
}

for (const runtime of ["os", "claude"] as const) await scenario(runtime);
console.log("PASS real broker/server footer e2e: os footer identity and non-os flag rewrite");
