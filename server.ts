#!/usr/bin/env tsx
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { mkdirSync, existsSync, writeFileSync, unlinkSync, readFileSync, readdirSync, renameSync, chmodSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import {
  BROKER_URL,
  IS_REMOTE,
  BROKER_TOKEN,
  CCT_DIR,
  CODEX_SESSIONS_DIR,
  PIDMAP_DIR,
  FLAGS_DIR,
  POLL_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
} from "./shared/constants.ts";
import { resolveCodexSessionIdentity, type CodexSessionIdentity } from "./shared/codex-session.ts";
import type {
  BrokerResponse,
  RegisterResponse,
  PeerInfo,
  PoolInfo,
  PoolStatusResponse,
  PoolCreateResponse,
  PollMessage,
  MessageSendResponse,
  UnreadCountResponse,
  ProposeReleaseResponse,
  VoteReleaseResponse,
  ReleaseStatusResponse,
  BusyPeerInfo,
} from "./shared/types.ts";
import { generateSummary } from "./shared/summarize.ts";

// --- Runtime detection ---
// Codex sets CODEX_HOME; explicit CCT_RUNTIME overrides auto-detection.
type AgentRuntime = "claude" | "codex" | "os";
const detectedRuntime: AgentRuntime =
  (process.env.CCT_RUNTIME as AgentRuntime) ??
  (process.env.CODEX_HOME ? "codex" : process.env.AI_AGENT === "os" ? "os" : "claude");

// For Codex: process.cwd() returns CCT's dir (forced via config.toml cwd field).
// Resolve actual session CWD by reading parent Codex process's working directory.
function resolveSessionCwd(): string {
  if (detectedRuntime !== "codex") return process.cwd();
  try {
    // Walk up process tree to find codex binary, then read its cwd via lsof
    let pid = process.ppid;
    for (let i = 0; i < 8; i++) {
      const comm = spawnSync("ps", ["-o", "comm=", "-p", String(pid)]);
      const name = comm.stdout?.toString().trim() ?? "";
      if (name.includes("codex")) {
        // lsof -Fn output: "fcwd\n" followed by "n/path\n"
        const cwdProc = spawnSync("lsof", ["-p", String(pid), "-Fn"]);
        const output = cwdProc.stdout?.toString() ?? "";
        const lines = output.split("\n");
        for (let j = 0; j < lines.length; j++) {
          if (lines[j] === "fcwd" && lines[j + 1]?.startsWith("n")) {
            return lines[j + 1].slice(1);
          }
        }
      }
      const ppid = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)]);
      const parent = parseInt(ppid.stdout?.toString().trim() ?? "", 10);
      if (!parent || parent === 1) break;
      pid = parent;
    }
  } catch {}
  return process.cwd();
}

const myCwd = resolveSessionCwd();

let myId = "";
let mySecret = "";
let myName = "";
let pollInterval: ReturnType<typeof setInterval> | null = null;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let parentMonitorInterval: ReturnType<typeof setInterval> | null = null;
let idleCheckInterval: ReturnType<typeof setInterval> | null = null;
let lastActivity = Date.now();
let requestCleanupFn: ((reason: string) => void) | null = null;

// Registration payload, stashed by main() so a heartbeat-rejection recovery can
// re-register with identical parameters. Only used when `sessionKey` is set —
// the broker de-dupes on (runtime, session_key) and returns the same peer row.
let lastRegisterBody: Record<string, unknown> | null = null;
let recovering = false;
// Log the "superseded" notice from a legacy broker once, not every 15s.
let warnedSuperseded = false;

// Deferred ack: message IDs returned by the last handleCheckMessages call.
// These get acked at the START of the next call, so if the cron result is
// swallowed (never reaches the agent's conversation), messages stay unread.
// Bound to the peer id/secret they were peeked under: if an in-flight recovery
// changes our identity, acking them under a different peer id would silently
// mark nothing read. On identity change we drop them rather than misfire.
let pendingAckIds: number[] = [];
let pendingAckPeerId = "";
let osReadGeneration = 0;
let osReadsInFlight = 0;

// --- Broker HTTP helpers ---

async function brokerPost<T = unknown>(path: string, body: Record<string, unknown>): Promise<BrokerResponse<T>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (BROKER_TOKEN) headers["Authorization"] = `Bearer ${BROKER_TOKEN}`;
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return await res.json() as BrokerResponse<T>;
}

async function brokerGet<T = unknown>(path: string): Promise<BrokerResponse<T>> {
  const headers: Record<string, string> = {};
  if (BROKER_TOKEN) headers["Authorization"] = `Bearer ${BROKER_TOKEN}`;
  const res = await fetch(`${BROKER_URL}${path}`, { headers });
  return await res.json() as BrokerResponse<T>;
}

// --- Ensure broker is running ---

async function ensureBroker(): Promise<void> {
  try {
    const res = await fetch(`${BROKER_URL}/health`);
    if (res.ok) return;
  } catch {}

  if (IS_REMOTE) {
    throw new Error(`Cannot reach remote broker at ${BROKER_URL}. Is it running?`);
  }

  const brokerPath = new URL("./broker.ts", import.meta.url).pathname;
  const child = spawn("npx", ["tsx", brokerPath], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();

  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const res = await fetch(`${BROKER_URL}/health`);
      if (res.ok) return;
    } catch {}
  }
  throw new Error("Failed to start broker");
}

// --- Ensure directories ---

function ensureDirs(): void {
  for (const dir of [CCT_DIR, PIDMAP_DIR, FLAGS_DIR]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { mode: 0o700, recursive: true });
    } else {
      try {
        const st = statSync(dir);
        if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
      } catch {}
    }
  }
}

// --- Clean stale pidmaps and flags from dead sessions ---

function cleanStalePidmaps(): void {
  try {
    const files = readdirSync(PIDMAP_DIR);
    for (const f of files) {
      if (f.startsWith("codex_") && !f.startsWith("codex_mcp_")) {
        continue;
      }
      const pid = f.startsWith("codex_mcp_")
        ? parseInt(f.slice("codex_mcp_".length), 10)
        : parseInt(f.split("_")[0], 10);
      if (!pid) continue;
      const alive = spawnSync("kill", ["-0", String(pid)]);
      if (alive.status !== 0) {
        const content = readFileSync(join(PIDMAP_DIR, f), "utf-8");
        const peerId = content.split("|")[0];
        try { unlinkSync(join(PIDMAP_DIR, f)); } catch {}
        if (peerId) try { unlinkSync(join(FLAGS_DIR, `${peerId}.unread`)); } catch {}
      }
    }
  } catch {}
}

// --- Get process start time (cached, platform-correct) ---

function getPidStartForPid(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const fields = stat.split(" ");
    if (fields[21]) return fields[21];
  } catch {}
  try {
    const proc = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)]);
    const out = proc.stdout?.toString().trim() ?? "";
    if (out) return out.replace(/\s+/g, "_");
  } catch {}
  return String(Date.now());
}

const cachedPidStart = getPidStartForPid(process.pid);

// Walk up to find the Claude Code process (handles npx/tsx wrapper layers)
function findClaudePid(): number {
  let pid = process.ppid;
  for (let i = 0; i < 5; i++) {
    try {
      const comm = spawnSync("ps", ["-o", "comm=", "-p", String(pid)]);
      const name = comm.stdout?.toString().trim() ?? "";
      if (name.endsWith("/claude") || name === "claude") return pid;
      const ppid = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)]);
      const parent = parseInt(ppid.stdout?.toString().trim() ?? "", 10);
      if (!parent || parent === 1) break;
      pid = parent;
    } catch { break; }
  }
  return process.ppid;
}

function getCommandForPid(pid: number): string {
  try {
    const proc = spawnSync("ps", ["-o", "command=", "-p", String(pid)]);
    return proc.stdout?.toString().trim() ?? "";
  } catch {
    return "";
  }
}

function findCodexPid(): number | null {
  let pid = process.ppid;
  for (let i = 0; i < 12; i++) {
    const cmd = getCommandForPid(pid);
    if (cmd.includes("/codex") || cmd.endsWith(" codex") || cmd.includes("@openai/codex")) {
      return pid;
    }
    const ppid = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)]);
    const parent = parseInt(ppid.stdout?.toString().trim() ?? "", 10);
    if (!parent || parent === 1) break;
    pid = parent;
  }
  return null;
}

// os sets process.title to "os", including when launched through its wrapper.
// The adapter may have node/tsx wrappers between the MCP child and that host.
function findOsPid(): number | null {
  let pid = process.ppid;
  for (let i = 0; i < 8 && pid > 1; i++) {
    const comm = spawnSync("ps", ["-o", "comm=", "-p", String(pid)]);
    const name = comm.stdout?.toString().trim() ?? "";
    if (name === "os" || name.endsWith("/os")) return pid;
    const ppid = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)]);
    const parent = parseInt(ppid.stdout?.toString().trim() ?? "", 10);
    if (!parent || parent === pid) break;
    pid = parent;
  }
  return null;
}

// Stable session identity key, used as the broker `session_key`:
//   Codex  → root of the codex fork chain, resolved from codex's own rollout
//            transcripts (see shared/codex-session.ts). Codex never exports its
//            session id into MCP server env, so the CODEX_* vars below are only
//            a future-proof first choice — in practice they are all unset.
//   Claude → CLAUDE_CODE_SESSION_ID (stable for the entire Claude Code session).
// Anchoring registration to this key makes the broker REUSE the same peer row
// on every re-register, so the CCT peer ID/name survive MCP restarts, /mcp
// reconnects, codex compaction forks, `codex resume`, and network transitions
// (e.g. Wi-Fi changes) instead of a fresh random ID being minted each time.
const codexSessionIdEnv = process.env.CCT_CODEX_SESSION_ID ?? process.env.CODEX_SESSION_ID ?? process.env.CODEX_THREAD_ID;
const claudeSessionId = process.env.CLAUDE_CODE_SESSION_ID ?? process.env.CLAUDE_SESSION_ID;
const hostPid = detectedRuntime === "codex" ? (findCodexPid() ?? process.ppid)
  : detectedRuntime === "os" ? (findOsPid() ?? process.ppid) : findClaudePid();
const cachedPpidStart = getPidStartForPid(hostPid);

// Codex identity is resolved asynchronously in initCodexIdentity() before the
// first registration: a freshly started codex may not have flushed its rollout
// file yet, so resolution needs a short retry window.
let codexIdentity: CodexSessionIdentity = { sessionId: null, rootSessionId: null, source: "unresolved" };
let sessionKey: string | undefined = detectedRuntime === "claude" ? claudeSessionId : undefined;
let osSessionId: string | null = null;

function isOriginalProcessAlive(pid: number, expectedStart: string): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return getPidStartForPid(pid) === expectedStart;
}

// --- Get git info ---

async function getGitInfo(cwd: string): Promise<{ gitRoot: string | null; gitBranch: string | null }> {
  let gitRoot: string | null = null;
  let gitBranch: string | null = null;

  try {
    const rootProc = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd });
    const out = rootProc.stdout?.toString().trim() ?? "";
    if (out) gitRoot = out;
  } catch {}

  try {
    const branchProc = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
    const out2 = branchProc.stdout?.toString().trim() ?? "";
    if (out2) gitBranch = out2;
  } catch {}

  return { gitRoot, gitBranch };
}

// --- Pidmap helpers ---
// Codex uses session_id-based pidmap key; Claude uses PID-based key.
// The codex key is the CURRENT session id (what the hooks receive on stdin),
// not the fork-chain root used for the broker session_key. A "codex_mcp_{pid}"
// marker is written too, so the hooks can still bridge by process ancestry when
// the session id could not be resolved.

let myPidmapKey = `${hostPid}_${cachedPpidStart}`;
let myPidmapPath = `${PIDMAP_DIR}/${myPidmapKey}`;

// Resolve the codex session identity and derive the broker session_key from it.
// Falls back to a host-process key, which still survives MCP respawns and
// compaction forks within one codex process (both keep the same host PID).
async function initCodexIdentity(): Promise<void> {
  if (detectedRuntime !== "codex") return;

  const hostCommand = getCommandForPid(hostPid);
  for (let attempt = 0; attempt < 5; attempt++) {
    codexIdentity = resolveCodexSessionIdentity({
      sessionsDir: CODEX_SESSIONS_DIR,
      cwd: myCwd,
      hostCommand,
      envSessionId: codexSessionIdEnv,
    });
    if (codexIdentity.sessionId) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  sessionKey = codexIdentity.rootSessionId
    ? `codex-root:${codexIdentity.rootSessionId}`
    : `codex-host:${hostPid}_${cachedPpidStart}`;

  if (codexIdentity.sessionId) {
    myPidmapKey = `codex_${codexIdentity.sessionId}`;
    myPidmapPath = `${PIDMAP_DIR}/${myPidmapKey}`;
  }

  process.stderr.write(
    `CCT codex identity: session=${codexIdentity.sessionId ?? "-"} root=${codexIdentity.rootSessionId ?? "-"} ` +
    `source=${codexIdentity.source} host_pid=${hostPid} host_cmd=${JSON.stringify(hostCommand)} cwd=${myCwd} key=${sessionKey}\n`,
  );
}

async function initOsIdentity(): Promise<void> {
  if (detectedRuntime !== "os") return;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const marker = readFileSync(join(PIDMAP_DIR, `os_session_${hostPid}`), "utf8").trim();
      // The marker becomes a filename and diagnostic: reject path separators
      // and control characters instead of following a malformed marker.
      if (/^[a-zA-Z0-9_-]{1,200}$/.test(marker)) {
        osSessionId = marker;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  sessionKey = osSessionId ? `os:${osSessionId}` : `os-host:${hostPid}_${cachedPpidStart}`;
  myPidmapKey = osSessionId ? `os_${osSessionId}` : `os-host_${hostPid}_${cachedPpidStart}`;
  myPidmapPath = join(PIDMAP_DIR, myPidmapKey);
  process.stderr.write(
    `CCT os identity: session=${osSessionId ?? "-"} host_pid=${hostPid} ` +
    `source=${osSessionId ? "marker" : "fallback"} key=${sessionKey} cwd=${myCwd}\n`,
  );
}

// Codex MCP marker — written alongside the main pidmap so SessionStart can find us
const codexMcpMarkerPath = detectedRuntime === "codex"
  ? `${PIDMAP_DIR}/codex_mcp_${process.pid}`
  : null;

function writePidmap(): void {
  writeFileSync(myPidmapPath, `${myId}|${myName}`, { mode: 0o600 });
  if (codexMcpMarkerPath) {
    writeFileSync(codexMcpMarkerPath, `${myId}|${myName}`, { mode: 0o600 });
  }
}

function deletePidmap(removeSessionMappings: boolean): void {
  if (removeSessionMappings) {
    try { unlinkSync(myPidmapPath); } catch {}
  }
  if (codexMcpMarkerPath) {
    try { unlinkSync(codexMcpMarkerPath); } catch {}
  }
  // Clean up session-keyed pidmaps that point to our peer ID
  if (detectedRuntime === "codex" && removeSessionMappings) {
    try {
      const files = readdirSync(PIDMAP_DIR);
      for (const f of files) {
        if (f.startsWith("codex_") && !f.startsWith("codex_mcp_")) {
          const content = readFileSync(join(PIDMAP_DIR, f), "utf-8");
          if (content.startsWith(myId)) {
            try { unlinkSync(join(PIDMAP_DIR, f)); } catch {}
          }
        }
      }
    } catch {}
  }
}

// --- Flag file helpers ---

function flagPath(): string {
  return `${FLAGS_DIR}/${myId}.unread`;
}

function writeFlag(content: string): void {
  const tmp = flagPath() + ".tmp";
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, flagPath());
}

function deleteFlag(): void {
  try { unlinkSync(flagPath()); } catch {}
}

// --- Polling loop ---

let pollFailures = 0;

async function pollOsUnread(): Promise<void> {
  if (osReadsInFlight > 0) return;
  const generation = osReadGeneration;
  const peerId = myId;
  try {
    // Deferred acknowledgement must suppress the delivered batch, not future
    // messages. os has no idle cron to force the next read/ack round trip.
    const res = await brokerPost<{ messages: PollMessage[] }>("/message/peek", {
      peer_id: peerId, peer_secret: mySecret,
    });
    // A read or identity recovery may finish while this request is in flight.
    // Its updated flag is newer than this snapshot.
    if (generation !== osReadGeneration || osReadsInFlight > 0 || peerId !== myId) return;
    if (!res.ok || !res.data) throw new Error("Unread peek failed");
    const pending = new Set(pendingAckPeerId === peerId ? pendingAckIds : []);
    const unread = res.data.messages.filter((message) => !pending.has(message.message_id));
    const pools = new Map<string, number>();
    for (const message of unread) {
      const pool = message.pool_name ?? "DM";
      pools.set(pool, (pools.get(pool) ?? 0) + 1);
    }
    pollFailures = 0;
    writeFlag(`${unread.length}|${[...pools].map(([name, count]) => `${name}:${count}`).join(",")}|${Date.now()}`);
  } catch {
    if (generation !== osReadGeneration || peerId !== myId) return;
    if (++pollFailures >= 3) writeFlag(`0||${Date.now()}`);
  }
}

async function pollUnread(): Promise<void> {
  if (detectedRuntime === "os") return pollOsUnread();
  // Skip flag writes while deferred ack is pending — handleCheckMessages owns
  // the flag during that window. Without this guard, pollUnread overwrites the
  // adjusted count with the raw DB count, causing the hook to block incorrectly.
  if (pendingAckIds.length > 0) return;

  try {
    const res = await brokerPost<UnreadCountResponse>("/message/unread-count", { peer_id: myId });
    if (res.ok && res.data) {
      pollFailures = 0;
      const poolSummary = res.data.by_pool
        .map((p) => `${p.pool_name ?? "DM"}:${p.count}`)
        .join(",");
      writeFlag(`${res.data.total}|${poolSummary}|${Date.now()}`);
    }
  } catch {
    pollFailures++;
    if (pollFailures >= 3) {
      writeFlag(`0||${Date.now()}`);
    }
  }
}

// --- Heartbeat loop ---

// Re-register with the broker after our peer row was reaped (e.g. the broker
// marked us dead during a network outage). With a stable `session_key` the
// broker revives the same row and returns the SAME id/secret/name, so the CCT
// identity survives. Returns true if identity was recovered.
async function reregister(reason: string): Promise<boolean> {
  if (!sessionKey || !lastRegisterBody || recovering) return false;
  // Never resurrect a genuine orphan: if our host process is gone, the broker
  // correctly reaped us — don't undo that. Let the caller run cleanup instead.
  // (Backs up the 30s host-death monitor; recovery must not depend on it.)
  if (!isOriginalProcessAlive(hostPid, cachedPpidStart)) return false;
  recovering = true;
  try {
    const regRes = await brokerPost<RegisterResponse>("/register", lastRegisterBody);
    if (regRes.ok && regRes.data) {
      const prevId = myId;
      myId = regRes.data.id;
      mySecret = regRes.data.secret;
      myName = regRes.data.name;
      // Pidmap/flag are keyed by peer id; rewrite so the hook & status line
      // resolve the recovered identity. If the id changed (row was purged
      // rather than revived), drop the stale flag and any pending acks that
      // belonged to the old identity — they can't be acked under the new id.
      if (prevId && prevId !== myId) {
        try { unlinkSync(`${FLAGS_DIR}/${prevId}.unread`); } catch {}
        if (pendingAckPeerId === prevId) {
          pendingAckIds = [];
          pendingAckPeerId = "";
        }
      }
      writePidmap();
      writeFlag(`0||${Date.now()}`);
      process.stderr.write(`CCT recovered identity after ${reason}: ${myName} [${myId}]\n`);
      return true;
    }
  } catch {}
  finally {
    recovering = false;
  }
  return false;
}

async function sendHeartbeat(): Promise<void> {
  try {
    const res = await brokerPost<{ acknowledged?: boolean; stale_registration?: boolean }>("/heartbeat", {
      peer_id: myId,
      peer_secret: mySecret,
      pid: process.pid,
      pid_start: cachedPidStart,
    });
    if (res.ok && res.data?.stale_registration) {
      // Only a pre-connection-tracking broker still answers this. Exiting here is
      // what killed live agents: codex keeps one MCP client per thread inside one
      // host process, every one of them resolves the SAME session_key, so the
      // first duplicate registration used to evict the parent's server — and
      // codex never respawns a server that exits mid-session, so that session's
      // CCT tools were dead for good ("Transport closed"). A duplicate
      // registration is not evidence that WE are an orphan. Real orphans are
      // still caught by stdin EOF/close, the host SIGTERM, the host-death
      // monitor, and the broker's stale reaper. Keep serving.
      if (!warnedSuperseded) {
        warnedSuperseded = true;
        process.stderr.write(
          "CCT: broker reports another MCP instance registered for this session; continuing to serve the shared peer row\n",
        );
      }
    } else if (!res.ok && (res.error === "peer not found" || res.error === "peer not found or not active")) {
      // Our row was reaped (broker marked us dead during an outage) but our
      // host process is still alive. Reclaim the same identity in place rather
      // than exiting, so the CCT id is stable across network transitions.
      const recovered = await reregister(res.error);
      if (!recovered) requestCleanupFn?.(`heartbeat rejected: ${res.error}`);
    } else if (!res.ok && res.error === "invalid peer_secret") {
      // Different holder owns this id — never reclaim across a secret mismatch.
      requestCleanupFn?.(`heartbeat rejected: ${res.error}`);
    }
  } catch {}
}

// --- Resolve peer name to ID ---

async function resolvePeerId(nameOrId: string): Promise<{ id: string } | { error: string }> {
  const res = await brokerPost<PeerInfo[]>("/list-peers", {});
  if (!res.ok || !res.data) return { error: "Failed to list peers" };
  // Exact match on ID or name first
  const exact = res.data.filter((p) => p.id === nameOrId || p.name === nameOrId);
  if (exact.length === 1) return { id: exact[0].id };

  // Prefix match on ID (min 4 chars to avoid noise)
  let matches = exact;
  if (matches.length === 0 && nameOrId.length >= 4) {
    matches = res.data.filter((p) => p.id.startsWith(nameOrId));
  }
  // Prefix match on name
  if (matches.length === 0) {
    matches = res.data.filter((p) => p.name.startsWith(nameOrId));
  }
  if (matches.length === 0) return { error: `Peer "${nameOrId}" not found.` };
  if (matches.length > 1) {
    const list = matches.map((p) => `  ${p.name} [${p.id}]`).join("\n");
    return { error: `Ambiguous match for "${nameOrId}". Matches:\n${list}\nUse a longer prefix or the full peer ID.` };
  }
  return { id: matches[0].id };
}

// --- Tool handlers ---

async function handleCheckMessages(): Promise<string> {
  // Step 1: Ack messages from the PREVIOUS call (deferred acknowledgment).
  // If the previous cron result was swallowed, pendingAckIds is still set,
  // but the agent is calling us again — meaning it DID process the output.
  if (pendingAckIds.length > 0) {
    // Only ack under the identity they were peeked with. If recovery changed
    // our peer id since then, these ids belong to the old row — acking them
    // under the new id marks nothing read, so drop them instead.
    if (!pendingAckPeerId || pendingAckPeerId === myId) {
      await brokerPost("/message/read", {
        peer_id: myId,
        peer_secret: mySecret,
        message_ids: pendingAckIds,
      });
    }
    pendingAckIds = [];
    pendingAckPeerId = "";
  }

  // Step 2: Peek at unread messages without marking them read.
  const res = await brokerPost<{ messages: PollMessage[]; unread: UnreadCountResponse }>("/message/peek", {
    peer_id: myId,
    peer_secret: mySecret,
  });

  if (!res.ok || !res.data) {
    writeFlag(`0||${Date.now()}`);
    return "No unread messages.";
  }

  const { messages, unread, pool_throttles } = res.data as any;

  // Step 3: Stash IDs for deferred ack on the next call, bound to this identity.
  pendingAckIds = messages.map((m: any) => m.message_id);
  pendingAckPeerId = myId;

  // Update flag — count excludes messages we just peeked (they'll be acked next call)
  const poolSummary = unread.by_pool.map((p: any) => `${p.pool_name ?? "DM"}:${p.count}`).join(",");
  const flagTotal = Math.max(0, unread.total - messages.length);
  writeFlag(`${flagTotal}|${poolSummary}|${Date.now()}`);

  let output: string;

  if (messages.length === 0) {
    output = "No unread messages.";
  } else {
    const lines = messages.map((m: any) => {
      const source = m.pool_name ? `[pool:${m.pool_name}]` : "[DM]";
      const sender = m.from_id === "system" ? "SYSTEM" : `${m.from_name ?? m.from_id}`;
      const context = m.from_cwd ? ` (${m.from_cwd}, branch:${m.from_branch ?? "?"})` : "";
      return `${source} ${sender}${context}: ${m.body}`;
    });

    output = `${messages.length} message(s):\n\n${lines.join("\n")}`;

    if (messages.some((m: any) => m.msg_type === "pool_invite")) {
      output += detectedRuntime === "claude"
        ? `\n\n🚨 ACTION REQUIRED: You were added to a pool. You MUST set up message polling NOW or you will miss all future messages.\nRun CronCreate with cron "*/1 * * * *" and prompt "Call the cct_check_messages tool to check for incoming peer messages. If there are any, read and respond to them."\nThis is not optional — without it you are deaf to messages when idle.`
        : detectedRuntime === "os"
          ? `\n\nYou were added to a pool. Unread messages appear at the next tool call or model turn; they do not wake an idle os session.`
        : `\n\n🚨 You were added to a pool. Messages will arrive automatically via hooks — no action needed.`;
    }

    if (messages.some((m: any) => m.msg_type === "release_approved")) {
      output += detectedRuntime === "claude"
        ? `\n\n🎯 ACTION REQUIRED: You have been released from the pool. Please:\n1. Call cct_leave_pool for the pool\n2. If you have no other pools, cancel your CCT cron via CronList + CronDelete`
        : `\n\n🎯 ACTION REQUIRED: You have been released from the pool. Call cct_leave_pool for the pool.`;
    }

    if (messages.some((m: any) => m.msg_type === "pool_idle") && detectedRuntime === "claude") {
      output += `\n\n⏳ ACTION REQUIRED: Pool throttle activated — a peer is deep-working. Swap your polling cron to save tokens:\n1. CronDelete your current */1 cron\n2. CronCreate with */5 * * * * and the same prompt\nThe throttle will auto-clear when someone sends a message, the setter finishes, or the timer expires.`;
    }

    if (messages.some((m: any) => m.msg_type === "pool_active") && detectedRuntime === "claude") {
      output += `\n\n✅ ACTION REQUIRED: Pool throttle cleared — resume normal polling:\n1. CronDelete your current */5 cron\n2. CronCreate with */1 * * * * and the same prompt`;
    }
  }

  if (pool_throttles && pool_throttles.length > 0) {
    const tLines = pool_throttles.map((t: any) =>
      `  - Pool "${t.pool_name}": throttled by ${t.set_by_peer_name} until ${t.idle_until}${t.reason ? ` (${t.reason})` : ""}`
    );
    output += `\n\nActive pool throttles:\n${tLines.join("\n")}`;
  }

  return output;
}

function formatStaleWarning(data: MessageSendResponse): string {
  if (!data.stale_recipients || data.stale_recipients.length === 0) return "";
  const names = data.stale_recipients.map((s) => `${s.peer_name} (last seen ${s.age_seconds}s ago)`);
  return `\n\n⚠️ WARNING: ${data.stale_recipients.length} recipient(s) may be OFFLINE and unlikely to respond:\n${names.map((n) => `  - ${n}`).join("\n")}\nDo NOT wait for a reply from these peers. They may have disconnected (e.g., worktree agent finished). Consider proceeding without their input or checking cct_list_peers to confirm peer status.`;
}

async function handleSendMessage(args: { to: string; message: string }): Promise<string> {
  const { to, message } = args;

  if (to.startsWith("@")) {
    const target = to.slice(1);
    const slashIdx = target.indexOf("/");

    if (slashIdx !== -1) {
      const poolName = target.slice(0, slashIdx);
      const peerNameOrId = target.slice(slashIdx + 1);
      const resolved = await resolvePeerId(peerNameOrId);
      if ("error" in resolved) return resolved.error;

      const res = await brokerPost<MessageSendResponse>("/message/send", {
        peer_id: myId,
        peer_secret: mySecret,
        pool_name: poolName,
        to_peer_id: resolved.id,
        body: message,
      });
      if (!res.ok) return `Failed to send: ${res.error}`;
      return `Sent directed message in pool "${poolName}" to "${peerNameOrId}".${formatStaleWarning(res.data!)}`;
    }

    const res = await brokerPost<MessageSendResponse>("/message/send", {
      peer_id: myId,
      peer_secret: mySecret,
      pool_name: target,
      body: message,
    });
    if (!res.ok) return `Failed to send: ${res.error}`;
    const liveCount = res.data!.recipient_count - (res.data!.stale_recipients?.length ?? 0);
    return `Sent to pool "${target}" (${res.data!.recipient_count} recipients, ${liveCount} live).${formatStaleWarning(res.data!)}`;
  }

  const resolved = await resolvePeerId(to);
  if ("error" in resolved) return resolved.error;

  const res = await brokerPost<MessageSendResponse>("/message/send", {
    peer_id: myId,
    peer_secret: mySecret,
    to_peer_id: resolved.id,
    body: message,
  });
  if (!res.ok) return `Failed to send: ${res.error}`;
  return `DM sent to "${to}".${formatStaleWarning(res.data!)}`;
}

async function handleListPeers(): Promise<string> {
  const res = await brokerPost<PeerInfo[]>("/list-peers", {});
  if (!res.ok || !res.data) return `Failed: ${res.error}`;
  if (res.data.length === 0) return "No active peers.";

  const lines = res.data.map((p) => {
    const pools = p.pools.length > 0
      ? ` pools:[${p.pools.map((po) => `${po.pool_name}(${po.role})`).join(", ")}]`
      : "";
    const me = p.id === myId ? " (you)" : "";
    return `- ${p.name}${me} [${p.id}] cwd:${p.cwd} branch:${p.git_branch ?? "?"}${pools}\n  summary: ${p.summary || "(none)"}`;
  });

  return `${res.data.length} peer(s):\n\n${lines.join("\n")}`;
}

async function handleWhoAmI(): Promise<string> {
  const codexLine = detectedRuntime === "codex"
    ? `\nCodex session ID: ${codexIdentity.sessionId ?? "(unresolved)"}` +
      `\nCodex root session ID: ${codexIdentity.rootSessionId ?? "(unresolved)"} (source: ${codexIdentity.source})` +
      `\nBroker session key: ${sessionKey ?? "(none)"}`
    : detectedRuntime === "os"
      ? `\nos session ID: ${osSessionId ?? "(unresolved)"} (source: ${osSessionId ? "marker" : "fallback"})` +
        `\nBroker session key: ${sessionKey ?? "(none)"}`
      : "";
  return `CCT identity for this session:
Peer ID: ${myId}
Peer name: ${myName}
Runtime: ${detectedRuntime}
CWD: ${myCwd}
Pidmap key: ${myPidmapKey}${codexLine}

Use the peer ID or peer name above for CCT addressing. CODEX_THREAD_ID is a Codex session/thread identifier, not an addressable CCT peer ID.${detectedRuntime === "os" ? " PI_SESSION_ID is also a session identifier, not a CCT address." : ""}`;
}

async function handleListPools(): Promise<string> {
  const res = await brokerPost<PoolInfo[]>("/pool/list", {});
  if (!res.ok || !res.data) return `Failed: ${res.error}`;
  if (res.data.length === 0) return "No active pools.";

  const lines = res.data.map((p) => {
    const members = p.members.map((m) => `${m.peer_name}(${m.role})`).join(", ");
    return `- ${p.name}: ${p.purpose || "(no purpose)"} | ${p.members.length} member(s): ${members}`;
  });

  return `${res.data.length} pool(s):\n\n${lines.join("\n")}`;
}

async function handleCreatePool(args: { name: string; purpose?: string }): Promise<string> {
  const res = await brokerPost<PoolCreateResponse>("/pool/create", {
    peer_id: myId,
    peer_secret: mySecret,
    name: args.name,
    purpose: args.purpose ?? "",
  });
  if (!res.ok) return `Failed: ${res.error}`;
  const cronReminder = detectedRuntime === "claude"
    ? `\n\n⚠️ IMPORTANT: Set up message polling NOW if you haven't already. Use CronCreate with cron "*/1 * * * *" and prompt "Call the cct_check_messages tool to check for incoming peer messages. If there are any, read and respond to them." This is required to receive messages when idle.`
    : detectedRuntime === "os"
      ? `\n\nUnread messages appear at the next tool call or model turn. os does not wake spontaneously while idle.`
    : `\n\nMessages will be delivered automatically via PreToolUse hook (busy) or UserPromptSubmit hook (idle).`;
  return `Pool "${args.name}" created (id: ${res.data!.pool_id}). You are the creator.${cronReminder}`;
}

async function handleJoinPool(args: { pool_name: string }): Promise<string> {
  const res = await brokerPost("/pool/join", {
    peer_id: myId,
    peer_secret: mySecret,
    pool_name: args.pool_name,
  });
  if (!res.ok) return `Failed: ${res.error}`;
  const joinCronReminder = detectedRuntime === "claude"
    ? `\n\n⚠️ IMPORTANT: Set up message polling NOW if you haven't already. Use CronCreate with cron "*/1 * * * *" and prompt "Call the cct_check_messages tool to check for incoming peer messages. If there are any, read and respond to them." This is required to receive messages when idle.`
    : detectedRuntime === "os"
      ? `\n\nUnread messages appear at the next tool call or model turn. os does not wake spontaneously while idle.`
    : `\n\nMessages will be delivered automatically via PreToolUse hook (busy) or UserPromptSubmit hook (idle).`;
  return `Joined pool "${args.pool_name}".${joinCronReminder}`;
}

async function handleLeavePool(args: { pool_name: string }): Promise<string> {
  const res = await brokerPost("/pool/leave", {
    peer_id: myId,
    peer_secret: mySecret,
    pool_name: args.pool_name,
  });
  if (!res.ok) return `Failed: ${res.error}`;

  // Check if peer is still in any pools
  const peersRes = await brokerPost<PeerInfo[]>("/list-peers", {});
  const me = peersRes.data?.find((p) => p.id === myId);
  const remainingPools = me?.pools?.length ?? 0;

  if (detectedRuntime === "os") {
    return `Left pool "${args.pool_name}". ${remainingPools === 0 ? "You are no longer in any pools." : `Still in ${remainingPools} other pool(s).`}`;
  }
  if (remainingPools === 0) {
    return `Left pool "${args.pool_name}". You are no longer in any pools.\n\n⚠️ CLEANUP: You should now cancel your CCT message polling cron using CronDelete (use CronList to find the job ID). The cron is only needed while you are in a pool. If you join another pool later, set it up again.`;
  }
  return `Left pool "${args.pool_name}". Still in ${remainingPools} other pool(s) — keep your message polling cron running.`;
}

async function handleInviteToPool(args: { pool_name: string; peer: string }): Promise<string> {
  const resolved = await resolvePeerId(args.peer);
  if ("error" in resolved) return resolved.error;
  const targetId = resolved.id;

  const res = await brokerPost("/pool/invite", {
    peer_id: myId,
    peer_secret: mySecret,
    target_peer_id: targetId,
    pool_name: args.pool_name,
  });
  if (!res.ok) return `Failed: ${res.error}`;
  return `Invited "${args.peer}" to pool "${args.pool_name}".\n\nNote: The invited peer will be prompted to set up message polling when they next interact with CCT.`;
}

async function handleSetSummary(args: { summary: string }): Promise<string> {
  const res = await brokerPost("/set-summary", {
    peer_id: myId,
    peer_secret: mySecret,
    summary: args.summary,
  });
  if (!res.ok) return `Failed: ${res.error}`;
  return "Summary updated.";
}

async function handleListServices(args: { service_id?: string }): Promise<string> {
  const res = await brokerGet<any[]>("/services");
  if (!res.ok || !res.data) return `Failed: ${res.error}`;

  let services = res.data;
  if (args.service_id) {
    services = services.filter((s) => s.id === args.service_id);
  }

  if (services.length === 0) return "No registered services.";

  const lines = services.map((s) => {
    const meta = s.metadata !== "{}" ? ` metadata:${s.metadata}` : "";
    return `- ${s.name} [${s.id}] type:${s.type} url:${s.url ?? "n/a"} status:${s.status}${meta}`;
  });

  return `${services.length} service(s):\n\n${lines.join("\n")}`;
}

async function handlePoolStatus(args: { pool_name: string }): Promise<string> {
  const res = await brokerPost<PoolStatusResponse>("/pool/status", {
    pool_name: args.pool_name,
  });
  if (!res.ok || !res.data) return `Failed: ${res.error}`;

  const d = res.data;
  const members = d.members.map((m) => `  - ${m.peer_name} [${m.peer_id}] role:${m.role}`).join("\n");
  return `Pool: ${d.name}\nPurpose: ${d.purpose || "(none)"}\nStatus: ${d.status}\nMembers (${d.members.length}):\n${members}\nRecent messages (1h): ${d.recent_message_count}`;
}

// --- Release consensus handlers ---

async function handleProposeRelease(args: { pool_name: string; target: string; reason?: string }): Promise<string> {
  const resolved = await resolvePeerId(args.target);
  if ("error" in resolved) return resolved.error;

  const res = await brokerPost<ProposeReleaseResponse>("/pool/propose-release", {
    peer_id: myId,
    peer_secret: mySecret,
    pool_name: args.pool_name,
    target_peer_id: resolved.id,
    reason: args.reason ?? "",
  });
  if (!res.ok) return `Failed: ${res.error}`;
  const d = res.data!;
  return `Release proposal created (id: ${d.release_id}). Quorum rule: ${d.quorum_rule} (need votes from ${d.members_count} member(s)). Your "yes" vote has been auto-cast. Other pool members need to vote using cct_vote_release.`;
}

async function handleVoteRelease(args: { release_id: string; vote: "yes" | "no" }): Promise<string> {
  const res = await brokerPost<VoteReleaseResponse>("/pool/vote-release", {
    peer_id: myId,
    peer_secret: mySecret,
    release_id: args.release_id,
    vote: args.vote,
  });
  if (!res.ok) return `Failed: ${res.error}`;
  const d = res.data!;
  if (d.status === "approved") {
    return `Vote cast: ${args.vote}. Proposal APPROVED (${d.yes_count}/${d.quorum_needed} yes votes). The released peer will be notified to leave the pool and stop their cron.`;
  }
  if (d.status === "rejected") {
    return `Vote cast: ${args.vote}. Proposal REJECTED (${d.no_count} no votes made quorum impossible).`;
  }
  return `Vote cast: ${args.vote}. Current tally: ${d.yes_count} yes, ${d.no_count} no (need ${d.quorum_needed} for quorum).`;
}

async function handleSetPoolIdle(args: { pool_name: string; minutes: number; reason?: string; force?: boolean }): Promise<string> {
  const res = await brokerPost<{ approved: boolean; idle_until?: string; activity?: any }>("/pool/set-idle", {
    peer_id: myId,
    peer_secret: mySecret,
    pool_name: args.pool_name,
    minutes: args.minutes,
    reason: args.reason ?? "",
    force: args.force ?? false,
  });
  if (!res.ok) return `Failed: ${res.error}`;
  const d = res.data!;
  if (!d.approved) {
    const act = d.activity;
    let detail = `Pool throttle rejected: other members are actively discussing.`;
    if (act) {
      detail += `\n  Recent chat messages: ${act.recent_chat_count}`;
      detail += `\n  Active senders: ${act.recent_distinct_senders.join(", ")}`;
      detail += `\n  Window: last ${act.window_minutes} min`;
      if (act.unread_from_others > 0) detail += `\n  Unread from others: ${act.unread_from_others}`;
    }
    detail += `\nUse force=true to override this check.`;
    return detail;
  }
  return `Pool "${args.pool_name}" throttled for ~${args.minutes} min${args.reason ? `: ${args.reason}` : ""}. Idle until ${d.idle_until}. Other peers notified to reduce polling. Call cct_clear_pool_idle when done.`;
}

async function handleClearPoolIdle(args: { pool_name: string }): Promise<string> {
  const res = await brokerPost("/pool/clear-idle", {
    peer_id: myId,
    peer_secret: mySecret,
    pool_name: args.pool_name,
  });
  if (!res.ok) return `Failed: ${res.error}`;
  return `Pool throttle cleared for "${args.pool_name}". Other peers notified to resume normal polling.`;
}

// --- MCP server setup ---

async function main() {
  ensureDirs();
  cleanStalePidmaps();
  await initCodexIdentity();
  await initOsIdentity();
  await ensureBroker();

  const peerNameEnv = process.env.CCT_PEER_NAME;
  const prefix = detectedRuntime === "codex" ? "codex" : detectedRuntime === "os" ? "os" : basename(myCwd);
  const defaultName = `${prefix}-${Math.random().toString(36).slice(2, 6)}`;
  const requestedName = peerNameEnv || defaultName;

  const { gitRoot, gitBranch } = await getGitInfo(myCwd);

  lastRegisterBody = {
    pid: process.pid,
    pid_start: cachedPidStart,
    runtime: detectedRuntime,
    session_key: sessionKey,
    host_pid: hostPid,
    host_pid_start: cachedPpidStart,
    cwd: myCwd,
    name: requestedName,
    name_is_explicit: Boolean(peerNameEnv),
    git_root: gitRoot,
    git_branch: gitBranch,
  };

  const regRes = await brokerPost<RegisterResponse>("/register", lastRegisterBody);

  if (!regRes.ok || !regRes.data) {
    process.stderr.write(`CCT registration failed: ${regRes.error}\n`);
    process.exit(1);
  }

  myId = regRes.data.id;
  mySecret = regRes.data.secret;
  myName = regRes.data.name;

  writePidmap();

  const summary = await generateSummary(myCwd);
  await brokerPost("/set-summary", {
    peer_id: myId,
    peer_secret: mySecret,
    summary,
  });

  writeFlag(`0||${Date.now()}`);

  const cronInstructions = detectedRuntime === "claude"
    ? `
POOL LIFECYCLE — follow this exactly:
1. JOIN/CREATE: Immediately set up a recurring cron using CronCreate with cron "*/1 * * * *"
   and prompt "Call the cct_check_messages tool to check for incoming peer messages. If there are any, read and respond to them."
   This is REQUIRED. Without it, you are deaf to messages when idle. Only set up once per session.
2. ACTIVE: The cron polls every 60s when idle. The PreToolUse hook catches messages instantly when busy.
3. LEAVE: When you leave your LAST pool (no pools remaining), cancel the cron via CronList + CronDelete.
   If you still have other pools, keep the cron running.`
    : detectedRuntime === "os" ? `
MESSAGE DELIVERY (os):
- Unread messages block the next ordinary tool call after CCT tools are available.
- Unread context is delivered on the next model turn; it does not wake an idle session.
- Call cct_check_messages to read messages, then retry the blocked action.
- No cron setup is required. The os extension handles delivery.`
    : `
MESSAGE DELIVERY (Codex):
- BUSY: The PreToolUse hook blocks your next tool call when unread messages exist.
- IDLE: Messages are injected as context on your next user prompt via UserPromptSubmit hook.
- No cron setup needed. Delivery is automatic via hooks.`;

  const instructions = `You are connected to CCT (Claude Code Talk) — a peer communication system.
Your peer ID: ${myId} | Your name: ${myName} | CWD: ${myCwd} | Runtime: ${detectedRuntime}

If the user asks for your CCT ID, CCT peer ID, or CCT identity, call cct_whoami.
Do not answer with CODEX_THREAD_ID; that is a Codex session/thread identifier, not a CCT peer ID.

IMPORTANT: When you see a PreToolUse error mentioning "CCT: N unread message(s)",
this is NORMAL pool communication, not a tool failure. Call cct_check_messages
to read your messages, then retry your original action.

After reading messages, respond to them naturally. Use cct_send_message to reply.
To send to a pool: set "to" to "@pool-name". To DM: set "to" to the peer name.
${cronInstructions}`;

  const server = new Server(
    { name: "cct", version: "0.1.0" },
    { capabilities: { tools: {} }, instructions }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    lastActivity = Date.now();
    return { tools: [
      {
        name: "cct_check_messages",
        description: `Check and read all unread messages (pools + DMs). Your peer ID: ${myId}, peer name: ${myName}`,
        inputSchema: { type: "object" as const, properties: {} },
      },
      {
        name: "cct_whoami",
        description: "Show this session's CCT identity. Use this when asked for your CCT ID or peer ID; CODEX_THREAD_ID is not the CCT peer ID.",
        inputSchema: { type: "object" as const, properties: {} },
      },
      {
        name: "cct_send_message",
        description: 'Send a message. "@pool" = broadcast, "@pool/peer" = directed pool msg, "peer" = DM.',
        inputSchema: {
          type: "object" as const,
          properties: {
            to: { type: "string", description: '"@pool" = broadcast, "@pool/peer" = directed, or peer name/ID for DM' },
            message: { type: "string", description: "Message content" },
          },
          required: ["to", "message"],
        },
      },
      {
        name: "cct_list_peers",
        description: "List all registered CCT peers with name, cwd, branch, summary, and pool memberships.",
        inputSchema: { type: "object" as const, properties: {} },
      },
      {
        name: "cct_list_pools",
        description: "List all active pools with members and purpose.",
        inputSchema: { type: "object" as const, properties: {} },
      },
      {
        name: "cct_create_pool",
        description: "Create a new pool. You auto-join as creator.",
        inputSchema: {
          type: "object" as const,
          properties: {
            name: { type: "string", description: "Pool name" },
            purpose: { type: "string", description: "Pool purpose/description" },
          },
          required: ["name"],
        },
      },
      {
        name: "cct_join_pool",
        description: "Join an existing pool.",
        inputSchema: {
          type: "object" as const,
          properties: {
            pool_name: { type: "string", description: "Name of the pool to join" },
          },
          required: ["pool_name"],
        },
      },
      {
        name: "cct_leave_pool",
        description: "Leave a pool.",
        inputSchema: {
          type: "object" as const,
          properties: {
            pool_name: { type: "string", description: "Name of the pool to leave" },
          },
          required: ["pool_name"],
        },
      },
      {
        name: "cct_invite_to_pool",
        description: "Invite a peer to a pool (forced join in v1).",
        inputSchema: {
          type: "object" as const,
          properties: {
            pool_name: { type: "string", description: "Name of the pool" },
            peer: { type: "string", description: "Peer name or ID to invite" },
          },
          required: ["pool_name", "peer"],
        },
      },
      {
        name: "cct_set_summary",
        description: "Update your work summary (shown to other peers).",
        inputSchema: {
          type: "object" as const,
          properties: {
            summary: { type: "string", description: "New summary text" },
          },
          required: ["summary"],
        },
      },
      {
        name: "cct_pool_status",
        description: "Show detailed pool info: members, roles, recent activity.",
        inputSchema: {
          type: "object" as const,
          properties: {
            pool_name: { type: "string", description: "Name of the pool" },
          },
          required: ["pool_name"],
        },
      },
      {
        name: "cct_list_services",
        description: "List registered infrastructure services (browser server, search, etc.).",
        inputSchema: {
          type: "object" as const,
          properties: {
            service_id: { type: "string", description: "Filter by service ID (optional)" },
          },
        },
      },
      {
        name: "cct_propose_release",
        description: "Propose releasing a peer from a pool. Starts a democratic vote. Your 'yes' vote is auto-cast. For 2 peers: both must agree (unanimous). For 3+: majority wins.",
        inputSchema: {
          type: "object" as const,
          properties: {
            pool_name: { type: "string", description: "Name of the pool" },
            target: { type: "string", description: "Peer name or ID to release (can be yourself)" },
            reason: { type: "string", description: "Why this peer should be released" },
          },
          required: ["pool_name", "target"],
        },
      },
      {
        name: "cct_vote_release",
        description: "Vote yes/no on an active release proposal. When quorum is reached, the target peer is notified to leave the pool and stop their cron.",
        inputSchema: {
          type: "object" as const,
          properties: {
            release_id: { type: "string", description: "Release proposal ID (from the proposal notification)" },
            vote: { type: "string", enum: ["yes", "no"], description: "'yes' to approve release, 'no' to reject" },
          },
          required: ["release_id", "vote"],
        },
      },
      {
        name: "cct_set_pool_idle",
        description: "Request pool throttle for deep work. Broker checks if other members are actively discussing — if so, the request is rejected (use force to override). Other peers are told to swap to */5 polling. Auto-clears on: TTL expiry, you leave/disconnect, or another peer sends a message.",
        inputSchema: {
          type: "object" as const,
          properties: {
            pool_name: { type: "string", description: "Name of the pool to throttle" },
            minutes: { type: "number", description: "Estimated minutes of deep work (max 120)" },
            reason: { type: "string", description: "What you are doing (e.g., 'running full test suite')" },
            force: { type: "boolean", description: "Override the activity check (use sparingly)" },
          },
          required: ["pool_name", "minutes"],
        },
      },
      {
        name: "cct_clear_pool_idle",
        description: "Clear pool throttle early and notify peers to resume */1 polling. Only the setter can clear.",
        inputSchema: {
          type: "object" as const,
          properties: {
            pool_name: { type: "string", description: "Name of the pool" },
          },
          required: ["pool_name"],
        },
      },
      {
        name: "cct_self_terminate",
        description: "Terminate this session (claude/codex process). Use after completing work to free the terminal. The shell survives.",
        inputSchema: {
          type: "object" as const,
          properties: {
            reason: { type: "string", description: "Why this session is terminating (logged)" },
          },
          required: ["reason"],
        },
      },
    ],
  }; });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    lastActivity = Date.now();
    const { name, arguments: args } = req.params;
    let text: string;

    try {
      switch (name) {
        case "cct_check_messages":
          osReadGeneration++;
          osReadsInFlight++;
          try {
            text = await handleCheckMessages();
          } finally {
            osReadsInFlight--;
            osReadGeneration++;
          }
          break;
        case "cct_whoami":
          text = await handleWhoAmI();
          break;
        case "cct_send_message":
          text = await handleSendMessage(args as { to: string; message: string });
          break;
        case "cct_list_peers":
          text = await handleListPeers();
          break;
        case "cct_list_pools":
          text = await handleListPools();
          break;
        case "cct_create_pool":
          text = await handleCreatePool(args as { name: string; purpose?: string });
          break;
        case "cct_join_pool":
          text = await handleJoinPool(args as { pool_name: string });
          break;
        case "cct_leave_pool":
          text = await handleLeavePool(args as { pool_name: string });
          break;
        case "cct_invite_to_pool":
          text = await handleInviteToPool(args as { pool_name: string; peer: string });
          break;
        case "cct_set_summary":
          text = await handleSetSummary(args as { summary: string });
          break;
        case "cct_pool_status":
          text = await handlePoolStatus(args as { pool_name: string });
          break;
        case "cct_list_services":
          text = await handleListServices(args as { service_id?: string });
          break;
        case "cct_propose_release":
          text = await handleProposeRelease(args as { pool_name: string; target: string; reason?: string });
          break;
        case "cct_vote_release":
          text = await handleVoteRelease(args as { release_id: string; vote: "yes" | "no" });
          break;
        case "cct_set_pool_idle":
          text = await handleSetPoolIdle(args as { pool_name: string; minutes: number; reason?: string; force?: boolean });
          break;
        case "cct_clear_pool_idle":
          text = await handleClearPoolIdle(args as { pool_name: string });
          break;
        case "cct_self_terminate": {
          const reason = (args as { reason: string }).reason;
          process.stderr.write(`CCT self-terminate requested: ${reason}\n`);
          setTimeout(() => {
            try {
              process.kill(hostPid, "SIGTERM");
            } catch {
              requestCleanup("self-terminate (host kill failed)");
            }
          }, 150);
          text = `Terminating session: ${reason}`;
          break;
        }
        default:
          text = `Unknown tool: ${name}`;
          return { content: [{ type: "text" as const, text }], isError: true };
      }
    } catch (e: any) {
      text = `Error: ${e.message ?? String(e)}`;
      return { content: [{ type: "text" as const, text }], isError: true };
    }

    return { content: [{ type: "text" as const, text }] };
  });

  // Start polling and heartbeat
  pollInterval = setInterval(pollUnread, POLL_INTERVAL_MS);
  heartbeatInterval = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);

  // --- Idempotent cleanup with force-exit deadline ---

  let cleanupStarted = false;

  function requestCleanup(reason: string): void {
    if (cleanupStarted) return;
    cleanupStarted = true;
    process.stderr.write(`CCT cleanup: ${reason}\n`);
    void cleanup();
  }
  requestCleanupFn = requestCleanup;

  const cleanup = async () => {
    const forceExit = setTimeout(() => process.exit(0), 5_000);
    forceExit.unref();

    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    if (parentMonitorInterval) { clearInterval(parentMonitorInterval); parentMonitorInterval = null; }
    if (idleCheckInterval) { clearInterval(idleCheckInterval); idleCheckInterval = null; }

    if (pendingAckIds.length > 0 && (!pendingAckPeerId || pendingAckPeerId === myId)) {
      try {
        await brokerPost("/message/read", {
          peer_id: myId,
          peer_secret: mySecret,
          message_ids: pendingAckIds,
        });
      } catch {}
    }
    pendingAckIds = [];
    let unregistered = false;
    try {
      const res = await brokerPost<{ unregistered?: boolean; connections_remaining?: number }>("/unregister", {
        peer_id: myId,
        peer_secret: mySecret,
        pid: process.pid,
        pid_start: cachedPidStart,
      });
      unregistered = res.ok === true && res.data?.unregistered === true;
      // Sibling MCP connections (codex parent/fork/subagent threads) still hold
      // this peer. Drop only our own process marker — the session pidmap and the
      // unread flag belong to the identity, which is still alive and addressable.
      const remaining = res.data?.connections_remaining ?? 0;
      if (!unregistered && remaining > 0) {
        process.stderr.write(`CCT: peer ${myId} kept alive by ${remaining} other MCP connection(s)\n`);
      }
    } catch {}
    deletePidmap(unregistered);
    if (unregistered) deleteFlag();
    process.exit(0);
  };

  process.once("SIGINT", () => requestCleanup("SIGINT"));
  process.once("SIGTERM", () => requestCleanup("SIGTERM"));

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Layer 1: stdin EOF/close — primary lifecycle signal
  process.stdin.once("end", () => requestCleanup("stdin end"));
  process.stdin.once("close", () => requestCleanup("stdin close"));

  // Layer 2: parent death detection — backup (30s interval, PID start-time validated)
  // For Codex: MCP child processes get stdin EOF on session end, so this is a backup.
  parentMonitorInterval = setInterval(() => {
    if (!isOriginalProcessAlive(hostPid, cachedPpidStart)) {
      requestCleanup("parent process exited");
    }
  }, 30_000);

  // Layer 3: idle timeout — last-resort fuse, disabled by default
  const idleTimeoutMs = Number(process.env.CCT_IDLE_TIMEOUT_MS ?? 0);
  if (idleTimeoutMs > 0) {
    idleCheckInterval = setInterval(() => {
      if (Date.now() - lastActivity > idleTimeoutMs) {
        requestCleanup(`idle timeout (${idleTimeoutMs}ms)`);
      }
    }, 60_000);
  }
}

main().catch((e) => {
  process.stderr.write(`CCT server fatal: ${e.message}\n`);
  process.exit(1);
});
