// Presence-notice regression (FINDINGS F5). Runs the real broker.ts in-process
// against a private HOME/CCT_DIR/port; never touches ~/.cct or a live broker.
// The 30s stale sweep is captured instead of scheduled, so a "missed heartbeat"
// death runs the real cleanupStalePeers -> markPeerDead path on demand.
// Run: node --import tsx test-presence-notices.ts   (or: npm run test:presence)
//
// Contract, for a reader R and a peer P sharing pool X ("presence notice" =
// system "Peer P ... disconnected." / "Peer P reconnected." in X):
//  (a) however often P dies and revives, R has at most ONE unread presence
//      notice about P in X;
//  (b) the unread notice describes the change since R's last read: if R last
//      read while P was alive and P is alive again, there is NONE; if R last
//      read a "disconnected" and P is back, at most one, never "disconnected";
//      if P is now dead, exactly one "disconnected";
//  (c) one check-messages result (/message/peek, what cct_check_messages
//      reads) carries at most one presence notice per peer and pool.
// Finally a sweep firing long after its schedule (system sleep) kills nobody.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const home = mkdtempSync(join(tmpdir(), "cct-presence-"));
const listener = createServer();
await new Promise<void>((ok) => listener.listen(0, "127.0.0.1", ok));
const port = (listener.address() as { port: number }).port;
await new Promise<void>((ok) => listener.close(() => ok()));
const broker = `http://127.0.0.1:${port}`;
Object.assign(process.env, { HOME: home, CCT_DIR: join(home, ".cct"), CCT_PORT: String(port), CCT_HOST: "127.0.0.1", CCT_BROKER: broker, CCT_TOKEN: "" });

// Constants read the environment at import time, so import only after the override.
const { DB_PATH, STALE_CHECK_INTERVAL_MS } = await import("./shared/constants.ts");
if (!DB_PATH.startsWith(home)) throw new Error(`refusing to run against ${DB_PATH}`);
let sweep: (() => void) | undefined;
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
  if (ms === STALE_CHECK_INTERVAL_MS && !sweep) { sweep = fn; return realSetInterval(() => undefined, 2 ** 30).unref(); }
  return realSetInterval(fn, ms, ...rest);
}) as typeof setInterval;
await import("./broker.ts");
globalThis.setInterval = realSetInterval;
if (!sweep) throw new Error("stale sweep not captured");
const runSweep = sweep;

let failures = 0;
function check(label: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${label} (${detail})`);
  if (!ok) failures++;
}
async function call(path: string, body: object): Promise<any> {
  const response = await fetch(broker + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return response.json();
}
async function post(path: string, body: object): Promise<any> {
  const json = await call(path, body);
  if (!json.ok) throw new Error(`${path}: ${json.error}`);
  return json.data;
}

// Epoch-digit pid_start = legacy PID-only liveness: every peer's process (this
// one) stays alive, so the sweep can only kill a peer for its stale heartbeat.
const PID_START = "1";
type Peer = { id: string; secret: string; name: string; key: string };
const auth = (p: Peer) => ({ peer_id: p.id, peer_secret: p.secret });
async function register(key: string, name: string): Promise<Peer> {
  const d = await post("/register", { pid: process.pid, pid_start: PID_START, runtime: "claude", session_key: key, cwd: "/tmp/presence", name, name_is_explicit: true });
  return { id: d.id, secret: d.secret, name: d.name, key };
}
// Revive as server.ts does: same session_key re-register must reclaim the same id.
async function revive(p: Peer) {
  const again = await register(p.key, p.name);
  if (again.id !== p.id) throw new Error(`revive minted ${again.id} for ${p.id}`);
}
const db = new DatabaseSync(DB_PATH);
const status = (p: Peer) => (db.prepare("SELECT status FROM peers WHERE id = ?").get(p.id) as { status: string }).status;
// Missed heartbeats: the victims' last heartbeat is 60s old (> 3 x 15s), the
// survivors just heartbeated; then the real stale sweep runs once.
async function missHeartbeats(victims: Peer[], survivors: Peer[]) {
  for (const s of survivors) await post("/heartbeat", { ...auth(s), pid: process.pid, pid_start: PID_START });
  const old = new Date(Date.now() - 60_000).toISOString();
  for (const v of victims) db.prepare("UPDATE peers SET last_seen = ? WHERE id = ?").run(old, v.id);
  runSweep();
  for (const v of victims) if (status(v) !== "dead") throw new Error(`${v.name} survived the sweep`);
  for (const s of survivors) if (status(s) !== "active") throw new Error(`${s.name} killed by the sweep`);
  // The victim's own server then sees its heartbeat rejected and re-registers.
  for (const v of victims) if ((await call("/heartbeat", { ...auth(v), pid: process.pid, pid_start: PID_START })).ok) throw new Error("dead peer heartbeat accepted");
}
async function unregister(p: Peer) {
  const d = await post("/unregister", { ...auth(p), pid: process.pid, pid_start: PID_START });
  if (!d.unregistered || status(p) !== "dead") throw new Error(`unregister did not retire ${p.name}`);
}

const PRESENCE = /^Peer (\S+) (?:\(.*\) )?(disconnected|reconnected)\.$/;
type Notice = { pool: string; peer: string; kind: string };
async function peek(reader: Peer): Promise<{ ids: number[]; notices: Notice[] }> {
  const { messages } = await post("/message/peek", auth(reader));
  const notices: Notice[] = [];
  for (const m of messages) {
    const hit = m.from_id === "system" ? PRESENCE.exec(m.body) : null;
    if (hit) notices.push({ pool: m.pool_name, peer: hit[1], kind: hit[2] });
  }
  return { ids: messages.map((m: any) => m.message_id), notices };
}
async function about(reader: Peer, peer: Peer, pool: string) {
  return (await peek(reader)).notices.filter((n) => n.peer === peer.name && n.pool === pool).map((n) => n.kind);
}
async function readAll(reader: Peer) {
  const { ids } = await peek(reader);
  if (ids.length) await post("/message/read", { ...auth(reader), message_ids: ids });
}
const summary = (kinds: string[]) => `${kinds.length} unread: ${kinds.filter((k) => k === "disconnected").length} disconnected, ${kinds.filter((k) => k === "reconnected").length} reconnected`;
async function maxPerPeerPool(reader: Peer) {
  const counts = new Map<string, number>();
  for (const n of (await peek(reader)).notices) counts.set(`${n.pool}/${n.peer}`, (counts.get(`${n.pool}/${n.peer}`) ?? 0) + 1);
  return Math.max(0, ...counts.values());
}

const started = Date.now();
try {
  console.log("=== 50 disconnect/reconnect cycles (25 missed-heartbeat sweeps, 25 unregister + re-register) ===");
  const pool = "presence-cycles";
  const a1 = await register("presence-a1", "reader-a1");
  const a2 = await register("presence-a2", "reader-a2");
  const b = await register("presence-b", "cycler-b");
  await post("/pool/create", { ...auth(a1), name: pool, purpose: "presence regression" });
  for (const p of [a2, b]) await post("/pool/invite", { ...auth(a1), target_peer_id: p.id, pool_name: pool });
  await readAll(a1); await readAll(a2); // both readers last read a state with B alive
  for (let i = 0; i < 50; i++) {
    if (i % 2 === 0) await missHeartbeats([b], [a1, a2]); else await unregister(b);
    if (i === 0) {
      const seen = await about(a2, b, pool);
      if (!seen.includes("disconnected")) throw new Error("precondition: A2 sees B's disconnect");
      await readAll(a2); // A2 last read a state with B dead
    }
    await revive(b);
  }
  const members = await post("/pool/status", { pool_name: pool });
  if (!JSON.stringify(members).includes(b.name)) throw new Error("B not restored to the pool after revive");
  const a1Kinds = await about(a1, b, pool);
  check("(a) A1 holds at most one presence notice about B", a1Kinds.length <= 1, summary(a1Kinds));
  check("(b) A1 read with B alive, B alive again: no notice about B", a1Kinds.length === 0, summary(a1Kinds));
  const a2Kinds = await about(a2, b, pool);
  check("(b) A2 read B's disconnect, B alive again: at most one, not 'disconnected'", a2Kinds.length <= 1 && !a2Kinds.includes("disconnected"), summary(a2Kinds));
  check("(c) one check-messages result for A1: <= 1 presence notice per peer and pool", (await maxPerPeerPool(a1)) <= 1, `max ${await maxPerPeerPool(a1)}`);
  check("(c) one check-messages result for A2: <= 1 presence notice per peer and pool", (await maxPerPeerPool(a2)) <= 1, `max ${await maxPerPeerPool(a2)}`);
  await missHeartbeats([b], [a1, a2]); // cycle 51 ends with B dead
  const deadKinds = await about(a1, b, pool);
  check("(b) B dead after the cycles: A1 holds exactly one 'disconnected' about B", deadKinds.length === 1 && deadKinds[0] === "disconnected", summary(deadKinds));

  // orch-align-20261020 path: after system sleep the stale sweep (wall-clock
  // last_seen ages) runs before any queued heartbeat and kills every member in
  // one pass; each server then re-registers. Readers see runs of disconnects for
  // different peers, then runs of reconnects (sometimes without the disconnect).
  console.log("=== 10 sleep/wake sweeps killing every member at once ===");
  const sleepPool = "presence-sleep";
  // The sweep visits peers in registration order: R dies last, so it receives
  // the others' disconnects, as the live readers did.
  const s1 = await register("presence-sleep-s1", "sleeper-s1");
  const s2 = await register("presence-sleep-s2", "sleeper-s2");
  const r = await register("presence-sleep-r", "sleeper-r");
  await post("/pool/create", { ...auth(r), name: sleepPool, purpose: "sleep regression" });
  for (const p of [s1, s2]) await post("/pool/invite", { ...auth(r), target_peer_id: p.id, pool_name: sleepPool });
  await readAll(r);
  for (let i = 0; i < 10; i++) {
    await missHeartbeats([s1, r, s2], [a1, a2]);
    for (const p of i % 2 ? [s2, r, s1] : [r, s1, s2]) await revive(p);
  }
  for (const p of [s1, s2]) {
    const kinds = await about(r, p, sleepPool);
    check(`(a) sleep: R holds at most one presence notice about ${p.name}`, kinds.length <= 1, summary(kinds));
    check(`(b) sleep: everyone alive again: no notice about ${p.name}`, kinds.length === 0, summary(kinds));
  }
  check("(c) one check-messages result for R: <= 1 presence notice per peer and pool", (await maxPerPeerPool(r)) <= 1, `max ${await maxPerPeerPool(r)}`);

  // F10 root cause: the wall clock jumps over the sleep while the 30s sweep
  // timer does not, so the first sweep after a wake fires long after its
  // schedule with every peer's last heartbeat older than 3 x 15s. That sweep
  // must kill nobody, and the next on-time sweep is still inside the heartbeat
  // grace window counted from the wake.
  console.log("=== sweep after a 2-minute system sleep ===");
  const awake = (db.prepare("SELECT id FROM peers WHERE status = 'active'").all() as { id: string }[]).map((p) => p.id);
  const messagesBefore = (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
  const realNow = Date.now;
  Date.now = () => realNow() + 120_000;
  try {
    runSweep(); // late: 120s of wall time since the previous sweep
    runSweep(); // on time, inside the grace window
  } finally {
    Date.now = realNow;
  }
  const killed = awake.filter((id) => (db.prepare("SELECT status FROM peers WHERE id = ?").get(id) as { status: string }).status !== "active");
  check("sleep sweep: no member marked dead", awake.length >= 5 && killed.length === 0, `${killed.length} of ${awake.length} killed`);
  const written = (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n - messagesBefore;
  check("sleep sweep: no notice written", written === 0, `${written} new messages`);
} catch (error) {
  console.log(`  FAIL: harness error: ${(error as Error).message}`);
  failures++;
}
console.log(`${failures ? "FAIL" : "PASS"} presence notices: ${failures} failing assertion(s) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
db.close();
rmSync(home, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
