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
  PIDMAP_DIR,
  FLAGS_DIR,
  POLL_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
} from "./shared/constants.ts";
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

const myCwd = process.cwd();

// --- Runtime detection ---
// Codex sets CODEX_HOME; explicit CCT_RUNTIME overrides auto-detection.
type AgentRuntime = "claude" | "codex";
const detectedRuntime: AgentRuntime =
  (process.env.CCT_RUNTIME as AgentRuntime) ??
  (process.env.CODEX_HOME ? "codex" : "claude");

let myId = "";
let mySecret = "";
let myName = "";
let pollInterval: ReturnType<typeof setInterval> | null = null;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let parentMonitorInterval: ReturnType<typeof setInterval> | null = null;
let idleCheckInterval: ReturnType<typeof setInterval> | null = null;
let lastActivity = Date.now();

// Deferred ack: message IDs returned by the last handleCheckMessages call.
// These get acked at the START of the next call, so if the cron result is
// swallowed (never reaches the agent's conversation), messages stay unread.
let pendingAckIds: number[] = [];

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
      const pid = parseInt(f.split("_")[0], 10);
      if (!pid) { try { unlinkSync(join(PIDMAP_DIR, f)); } catch {} continue; }
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

// For Codex: use session_id env var as stable identity key.
// For Claude: use PID-based identity (existing behavior).
const codexSessionId = process.env.CCT_CODEX_SESSION_ID ?? process.env.CODEX_SESSION_ID;
const hostPid = detectedRuntime === "codex" ? process.ppid : findClaudePid();
const cachedPpidStart = getPidStartForPid(hostPid);

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
// For Codex without explicit session_id: write a "codex_mcp_{pid}" marker
// that the SessionStart hook will find and link to the session_id.

const myPidmapKey = detectedRuntime === "codex" && codexSessionId
  ? `codex_${codexSessionId}`
  : `${hostPid}_${cachedPpidStart}`;
const myPidmapPath = `${PIDMAP_DIR}/${myPidmapKey}`;

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

function deletePidmap(): void {
  try { unlinkSync(myPidmapPath); } catch {}
  if (codexMcpMarkerPath) {
    try { unlinkSync(codexMcpMarkerPath); } catch {}
  }
  // Clean up session-keyed pidmaps that point to our peer ID
  if (detectedRuntime === "codex") {
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

async function pollUnread(): Promise<void> {
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

async function sendHeartbeat(): Promise<void> {
  try {
    await brokerPost("/heartbeat", { peer_id: myId, peer_secret: mySecret });
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
    await brokerPost("/message/read", {
      peer_id: myId,
      peer_secret: mySecret,
      message_ids: pendingAckIds,
    });
    pendingAckIds = [];
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

  // Step 3: Stash IDs for deferred ack on the next call.
  pendingAckIds = messages.map((m: any) => m.message_id);

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
  await ensureBroker();

  const peerNameEnv = process.env.CCT_PEER_NAME;
  const defaultName = `${basename(myCwd)}-${Math.random().toString(36).slice(2, 6)}`;
  const requestedName = peerNameEnv || defaultName;

  const { gitRoot, gitBranch } = await getGitInfo(myCwd);

  const regRes = await brokerPost<RegisterResponse>("/register", {
    pid: process.pid,
    pid_start: cachedPidStart,
    cwd: myCwd,
    name: requestedName,
    git_root: gitRoot,
    git_branch: gitBranch,
  });

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
    : `
MESSAGE DELIVERY (Codex):
- BUSY: The PreToolUse hook blocks your next tool call when unread messages exist.
- IDLE: Messages are injected as context on your next user prompt via UserPromptSubmit hook.
- No cron setup needed. Delivery is automatic via hooks.`;

  const instructions = `You are connected to CCT (Claude Code Talk) — a peer communication system.
Your peer ID: ${myId} | Your name: ${myName} | CWD: ${myCwd} | Runtime: ${detectedRuntime}

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
    ],
  }; });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    lastActivity = Date.now();
    const { name, arguments: args } = req.params;
    let text: string;

    try {
      switch (name) {
        case "cct_check_messages":
          text = await handleCheckMessages();
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

  const cleanup = async () => {
    const forceExit = setTimeout(() => process.exit(0), 5_000);
    forceExit.unref();

    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    if (parentMonitorInterval) { clearInterval(parentMonitorInterval); parentMonitorInterval = null; }
    if (idleCheckInterval) { clearInterval(idleCheckInterval); idleCheckInterval = null; }

    if (pendingAckIds.length > 0) {
      try {
        await brokerPost("/message/read", {
          peer_id: myId,
          peer_secret: mySecret,
          message_ids: pendingAckIds,
        });
      } catch {}
      pendingAckIds = [];
    }
    try {
      await brokerPost("/unregister", { peer_id: myId, peer_secret: mySecret });
    } catch {}
    deletePidmap();
    deleteFlag();
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
