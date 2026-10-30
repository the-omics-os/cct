// CCT opencode PHASE_1 acceptance — identity + registration + lifecycle.
//
// Unit: sanitizeInstanceKey edge cases.
// Integration (private broker on a probed port, temp CCT_DIR, real child
//   processes running the real plugin module):
//   1. register: peer appears active with runtime "opencode", oc-XXXX name,
//      sanitized session_key, cwd = instance directory.
//   2. dispose -> unregister: peer leaves the active list.
//   3. revive: second server() call in the same directory reuses the SAME
//      peer id and RESTORES dropped pool membership (ARCHITECTURE D11b).
//   4. concurrent same-directory processes converge on one row (D11b),
//      connections count 2 -> 1 -> dead as each disposes.
//   5. heartbeat-404 convergence (R8): marking the row dead makes the next
//      heartbeat re-register the same session_key -> same id (revive, not fork).
//   6. CCT_PEER_NAME explicit name honored.
//
// Usage: tsx test-opencode-identity.ts          (parent; spawns children)

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let PASSED = 0;
let FAILED = 0;
const CHILDREN: ChildProcess[] = [];
let BROKER: ChildProcess | null = null;
let CCT_DIR = "";

function pass(desc: string) { console.log(`  PASS: ${desc}`); PASSED++; }
function fail(desc: string, extra = "") { console.log(`  FAIL: ${desc}${extra ? ` — ${extra}` : ""}`); FAILED++; }
function check(desc: string, cond: boolean, extra = "") {
  if (cond) pass(desc); else fail(desc, extra);
}

async function waitFor(desc: string, fn: () => Promise<boolean | unknown>, timeoutMs = 6000): Promise<unknown | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  fail(`${desc} (timeout after ${timeoutMs}ms)`);
  return null;
}

// ---------- child role ----------

async function runChild(): Promise<void> {
  const directory = process.argv[2] ?? "";
  const plugin = await import("./opencode-plugin.ts");
  const input = {
    client: undefined,
    project: "",
    directory,
    worktree: "",
    experimental_workspace: {},
    serverUrl: new URL("http://127.0.0.1:0"),
    $: undefined,
  } as unknown as import("@opencode-ai/plugin").PluginInput;

  type Hooks = { dispose?: () => Promise<void> };
  let hooks: Hooks | null = null;
  const send = (obj: unknown) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  send({ event: "ready" });

  process.stdin.setEncoding("utf-8");
  for await (const chunk of process.stdin) {
    for (const raw of chunk.split("\n")) {
      const cmd = raw.trim();
      if (cmd === "start") {
        hooks = await (plugin.default as { server: (i: unknown) => Promise<Hooks> }).server(input);
        send({ event: "started" });
      } else if (cmd === "dispose") {
        await hooks?.dispose?.();
        hooks = null;
        send({ event: "disposed" });
      } else if (cmd === "exit") {
        process.exit(0);
      }
    }
  }
  process.exit(0);
}

// ---------- parent role ----------

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

interface ChildHandle {
  proc: ChildProcess;
  events: Record<string, unknown>[];
  send(cmd: string): void;
  waitEvent(name: string, timeoutMs?: number): Promise<unknown | null>;
}

function spawnChild(directory: string, extraEnv: Record<string, string | undefined>): ChildHandle {
  const proc = spawn(process.execPath, [
    "--import", path.resolve(__dirname, "node_modules/tsx/dist/loader.mjs"),
    path.resolve(__dirname, "test-opencode-identity.ts"),
    directory,
  ], {
    env: {
      ...process.env,
      ...extraEnv,
      CCT_OPENCODE_TEST_ROLE: "child",
      CCT_OPENCODE_HEARTBEAT_MS: "300",
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  CHILDREN.push(proc);
  const events: Record<string, unknown>[] = [];
  let buf = "";
  proc.stdout!.setEncoding("utf-8");
  proc.stdout!.on("data", (d: string) => {
    buf += d;
    for (const raw of buf.split("\n")) {
      if (!raw.trim()) continue;
      try { events.push(JSON.parse(raw)); } catch { /* non-JSON noise */ }
      buf = buf.slice(raw.length + 1);
    }
  });
  return {
    proc,
    events,
    send(cmd: string) { proc.stdin!.write(`${cmd}\n`); },
    async waitEvent(name: string, timeoutMs = 6000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const hit = events.find((e) => e.event === name);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 50));
      }
      return null;
    },
  };
}

async function main(): Promise<void> {
  // 1. Unit: sanitizeInstanceKey
  console.log("\n=== Unit: sanitizeInstanceKey ===");
  const { sanitizeInstanceKey } = await import("./opencode-plugin.ts");

  {
    const key = sanitizeInstanceKey("/home/dev/foo");
    check("short path sanitizes separators", key === "opencode:_home_dev_foo", `got ${key}`);
  }
  {
    const key = sanitizeInstanceKey("dir with spaces/and:colons");
    check("invalid chars replaced with underscore", key === "opencode:dir_with_spaces_and_colons", `got ${key}`);
  }
  {
    const long = `/${"a".repeat(300)}`;
    const key = sanitizeInstanceKey(long);
    const suffix = key?.slice("opencode:".length) ?? "";
    check(
      "long path truncated + hashed, suffix <= 150",
      key !== null && suffix.length === 150 && /-[0-9a-f]{8}$/.test(suffix),
      `got ${key}`,
    );
    check("long path hash is deterministic", sanitizeInstanceKey(long) === key);
    {
      const nearMiss = `/${"a".repeat(299)}b`;
      check(
        "long-path keys for different dirs differ",
        sanitizeInstanceKey(nearMiss) !== key,
      );
    }
  }
  {
    check("empty directory -> null", sanitizeInstanceKey("") === null);
    check("non-string -> null", sanitizeInstanceKey(undefined as unknown as string) === null);
  }

  if (FAILED > 0) {
    console.log(`\nunit failures: ${FAILED}; aborting integration section`);
    process.exit(1);
  }

  // 2. Private broker on a probed port, isolated CCT_DIR
  const port = await freePort();
  const brokerUrl = `http://127.0.0.1:${port}`;
  CCT_DIR = mkdtempSync(path.join(tmpdir(), "cct-opencode-test."));
  console.log(`\n=== Broker on :${port} (CCT_DIR=${CCT_DIR}) ===`);

  process.env.CCT_BROKER = brokerUrl;
  process.env.CCT_TOKEN = "";

  BROKER = spawn(process.execPath, [
    "--import", path.resolve(__dirname, "node_modules/tsx/dist/loader.mjs"),
    path.resolve(__dirname, "broker.ts"),
  ], {
    env: {
      ...process.env,
      CCT_PORT: String(port),
      CCT_HOST: "127.0.0.1",
      CCT_DIR,
      CCT_TOKEN: "",
      CCT_BROKER: brokerUrl,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  await waitFor("broker health", async () => {
    const res = await fetch(`${brokerUrl}/health`);
    return res.ok;
  }, 10000);
  if (FAILED > 0) { await teardown(); process.exit(1); }

  const { listPeers, poolStatus } = await import("./shared/broker-client.ts");
  const post = async (p: string, body: Record<string, unknown>) =>
    ((await (await fetch(`${brokerUrl}${p}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    })).json()) as { ok: boolean; data?: unknown; error?: string });

  const dbPath = path.join(CCT_DIR, "cct.db");
  async function sql(query: string, ...params: (string | number | null)[]): Promise<Record<string, unknown>[]> {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      const stmt = db.prepare(query);
      const rows = (stmt.all(...params) ?? []) as Record<string, unknown>[];
      return rows;
    } finally { db.close(); }
  }
  async function sqlRun(query: string, ...params: (string | number | null)[]): Promise<void> {
    const { DatabaseSync } = await import("node:sqlite");
    for (let attempt = 0; attempt < 5; attempt++) {
      let db: import("node:sqlite").DatabaseSync | null = null;
      try {
        db = new DatabaseSync(dbPath);
        db.exec("BEGIN IMMEDIATE");
        db.prepare(query).run(...params);
        db.exec("COMMIT");
        return;
      } catch (e) {
        try { db?.exec("ROLLBACK"); } catch {}
        if (attempt === 4) throw e;
        await new Promise((r) => setTimeout(r, 150));
      } finally { db?.close(); }
    }
  }

  const findPeer = async (cwd: string) => {
    const res = await listPeers(brokerUrl);
    if (!res.ok || !res.data) return null;
    return res.data.find((p) => p.cwd === cwd && p.status === "active") ?? null;
  };

  const mkd = (name: string) => mkdtempSync(path.join(tmpdir(), `cct-oc-${name}.`));

  // 3. Registration (child A, directory D1)
  console.log("\n=== Registration ===");
  const D1 = mkd("d1");
  const A = spawnChild(D1, {});
  check("child A ready", (await A.waitEvent("ready")) !== null);
  A.send("start");
  check("child A started", (await A.waitEvent("started")) !== null);

  const peerA = (await waitFor("peer A visible and active", () => findPeer(D1))) as { id: string; name: string; connections?: number } | null;
  if (peerA) {
    check("peer A id is 8-hex", /^[0-9a-f]{8}$/.test(peerA.id), `id=${peerA.id}`);
    check("peer A name is oc-XXXX", /^oc-[a-z0-9]{4}$/.test(peerA.name), `name=${peerA.name}`);
    const rows = await sql("SELECT runtime, session_key FROM peers WHERE id = ?", peerA.id);
    check("row runtime is opencode", rows[0]?.runtime === "opencode", `runtime=${rows[0]?.runtime}`);
    check(
      "row session_key is sanitized directory key",
      rows[0]?.session_key === sanitizeInstanceKey(D1),
      `session_key=${rows[0]?.session_key}`,
    );
  }

  const sumRow = await waitFor("summary set on peer", async () => {
    const rows = await sql("SELECT summary FROM peers WHERE cwd = ? AND summary != ''", D1);
    return rows[0]?.summary ? rows : null;
  });
  check("summary populated via /set-summary", Array.isArray(sumRow));

  // 4. Pool membership + dispose + revive (same child, same directory)
  console.log("\n=== Pool membership, dispose, revive (D11b parity) ===");
  const poolName = `octest-${Date.now().toString(36)}`;
  const created = await post("/pool/create-cli", { name: poolName, purpose: "opencode identity test" });
  check("pool created via CLI endpoint", created.ok === true, `err=${created.error}`);
  const invited = await post("/pool/invite-cli", { target_peer_id: peerA?.id, pool_name: poolName });
  check("peer invited via CLI endpoint", invited.ok === true, `err=${invited.error}`);

  let status = await poolStatus(poolName, brokerUrl);
  check(
    "pool status shows peer as member",
    status.ok === true && (status.data as { members: { peer_id: string }[] })?.members?.some((m) => m.peer_id === peerA?.id) === true,
  );

  A.send("dispose");
  check("child A disposed", (await A.waitEvent("disposed")) !== null);
  await waitFor("peer A gone from active list after unregister", async () => !(await findPeer(D1)));

  A.send("start");
  check("child A restarted", (await A.waitEvent("started")) !== null);
  const peerA2 = (await waitFor("peer A revived and active", () => findPeer(D1))) as { id: string } | null;
  check("revive reuses the SAME peer id", peerA2?.id === peerA?.id, `${peerA?.id} -> ${peerA2?.id}`);

  status = await poolStatus(poolName, brokerUrl);
  check(
    "revive RESTORES pool membership",
    status.ok === true && (status.data as { members: { peer_id: string; status: string }[] })?.members?.some(
      (m) => m.peer_id === peerA?.id && m.status === "active",
    ) === true,
  );

  // 5. Concurrent same-directory processes converge on one row
  console.log("\n=== Concurrent same-directory instances ===");
  const B = spawnChild(D1, {});
  check("child B ready", (await B.waitEvent("ready")) !== null);
  B.send("start");
  check("child B started", (await B.waitEvent("started")) !== null);

  const both = (await waitFor("connections converge to 2", async () => {
    const p = await findPeer(D1);
    return p && (p.connections ?? 0) === 2 ? p : null;
  })) as { id: string; connections?: number } | null;
  check("still exactly one peer row for the directory", both?.id === peerA?.id);

  B.send("dispose");
  check("child B disposed", (await B.waitEvent("disposed")) !== null);
  const afterB = (await waitFor("connections back to 1 after B unregister", async () => {
    const p = await findPeer(D1);
    return p && (p.connections ?? 0) === 1 ? p : null;
  })) as { id: string } | null;
  check("peer survives partial unregister (last connection holds row)", afterB?.id === peerA?.id);

  A.send("dispose");
  check("child A disposed again", (await A.waitEvent("disposed")) !== null);
  await waitFor("peer dead after final unregister", async () => !(await findPeer(D1)));

  // 6. Heartbeat-404 re-register converges on the same id (R8)
  console.log("\n=== Heartbeat 404 -> re-register (R8) ===");
  const D2 = mkd("d2");
  const C = spawnChild(D2, {});
  check("child C ready", (await C.waitEvent("ready")) !== null);
  C.send("start");
  check("child C started", (await C.waitEvent("started")) !== null);
  const peerC = (await waitFor("peer C visible and active", () => findPeer(D2))) as { id: string } | null;
  check("peer C registered", peerC !== null);

  await sqlRun("UPDATE peers SET status = 'dead' WHERE id = ?", peerC?.id ?? "");
  const peerC2 = peerC
    ? ((await waitFor("peer C re-registered after heartbeat 404", () => findPeer(D2), 4000)) as { id: string } | null)
    : null;
  check("re-register keeps the SAME id (revive, not fork)", peerC2?.id === peerC?.id, `${peerC?.id} -> ${peerC2?.id}`);

  C.send("dispose");
  await C.waitEvent("disposed");
  C.send("exit");

  // 7. Explicit CCT_PEER_NAME
  console.log("\n=== Explicit peer name ===");
  const D3 = mkd("d3");
  const D3handle = spawnChild(D3, { CCT_PEER_NAME: "octest-explicit" });
  check("child D ready", (await D3handle.waitEvent("ready")) !== null);
  D3handle.send("start");
  check("child D started", (await D3handle.waitEvent("started")) !== null);
  const peerD = (await waitFor("peer D visible and active", () => findPeer(D3))) as { id: string; name: string } | null;
  check("explicit name honored", peerD?.name === "octest-explicit", `name=${peerD?.name}`);
  D3handle.send("dispose");
  await D3handle.waitEvent("disposed");
  D3handle.send("exit");

  // cleanup children A/B
  A.send("exit");
  B.send("exit");

  await teardown();
  console.log(`\nopencode identity: ${PASSED} passed, ${FAILED} failed`);
  process.exit(FAILED > 0 ? 1 : 0);
}

async function teardown(): Promise<void> {
  for (const c of CHILDREN) {
    try { c.kill("SIGKILL"); } catch {}
  }
  if (BROKER) {
    try { BROKER.kill("SIGKILL"); } catch {}
  }
  await new Promise((r) => setTimeout(r, 150));
  if (CCT_DIR) {
    try { rmSync(CCT_DIR, { recursive: true, force: true }); } catch {}
  }
}

if (process.env.CCT_OPENCODE_TEST_ROLE === "child") {
  await runChild();
} else {
  await main();
}
