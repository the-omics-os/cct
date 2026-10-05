// Shared broker HTTP client for the opencode plugin (opencode-plugin.ts) and its
// tests. The plugin is the one registrant on the opencode runtime (PLAN OC-2):
// register / heartbeat / unregister / peek / ack / send all flow through here.
//
// server.ts keeps its own inline client — this module must never change any
// existing runtime's behavior. It only reuses the same wire contract.
//
// Runtime note: this module runs under BOTH Bun (inside the opencode server
// process, via the installed plugin stub) and Node/tsx (tests). Keep imports to
// node: builtins and shared/ modules only.

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { BROKER_TOKEN, BROKER_URL, IS_REMOTE } from "./constants.ts";
import type {
  BrokerResponse,
  HeartbeatRequest,
  MessageSendResponse,
  PeerInfo,
  PoolCreateResponse,
  PoolInfo,
  PoolStatusResponse,
  PollMessage,
  ProposeReleaseResponse,
  RegisterRequest,
  RegisterResponse,
  UnreadCountResponse,
  VoteReleaseResponse,
} from "./types.ts";

// --- URL / locality resolution ---

/** True when the resolved broker endpoint is loopback (exact localhost, IPv4
 *  127/8, or IPv6 ::1). Never resolves hostnames — same computation as the
 *  os localBroker guard in server.ts. Locality is NOT authentication. */
export function isLocalBrokerUrl(brokerUrl: string): boolean {
  try {
    const hostname = new URL(brokerUrl).hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "[::1]") return true;
    const parts = hostname.split(".");
    return parts.length === 4
      && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255 && String(Number(p)) === p)
      && Number(parts[0]) === 127;
  } catch {
    return false;
  }
}

/** Auto-launch a local broker if none is reachable (mirrors server.ts
 *  ensureBroker). Remote brokers are never auto-launched or probed-started. */
export async function ensureBroker(brokerUrl = BROKER_URL): Promise<boolean> {
  try {
    const res = await fetch(`${brokerUrl}/health`);
    if (res.ok) return true;
  } catch {}

  if (IS_REMOTE || !isLocalBrokerUrl(brokerUrl)) return false;

  const brokerPath = new URL("../broker.ts", import.meta.url).pathname;
  try {
    const child = spawn("npx", ["tsx", brokerPath], { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    return false;
  }

  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const res = await fetch(`${brokerUrl}/health`);
      if (res.ok) return true;
    } catch {}
  }
  return false;
}

// --- HTTP helpers ---

async function brokerPost<T = unknown>(path: string, body: Record<string, unknown>, brokerUrl = BROKER_URL): Promise<BrokerResponse<T>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (BROKER_TOKEN) headers["Authorization"] = `Bearer ${BROKER_TOKEN}`;
  const res = await fetch(`${brokerUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return await res.json() as BrokerResponse<T>;
}

async function brokerGet<T = unknown>(path: string, brokerUrl = BROKER_URL): Promise<BrokerResponse<T>> {
  const headers: Record<string, string> = {};
  if (BROKER_TOKEN) headers["Authorization"] = `Bearer ${BROKER_TOKEN}`;
  const res = await fetch(`${brokerUrl}${path}`, { headers });
  return await res.json() as BrokerResponse<T>;
}

// --- Identity plumbing (mirrors server.ts helpers) ---

/** Platform-correct process start time for PID-fence validation:
 *  Linux /proc/<pid>/stat field 22, else `ps -o lstart=`, else Date.now(). */
export function getPidStartForPid(pid: number): string {
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

export async function getGitInfo(cwd: string): Promise<{ gitRoot: string | null; gitBranch: string | null }> {
  let gitRoot: string | null = null;
  let gitBranch: string | null = null;
  try {
    const rootProc = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5000 });
    const out = rootProc.stdout?.toString().trim() ?? "";
    if (out) gitRoot = out;
    const branchProc = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 5000 });
    const out2 = branchProc.stdout?.toString().trim() ?? "";
    if (out2) gitBranch = out2;
  } catch {}
  return { gitRoot, gitBranch };
}

// --- Peer lifecycle (registration / heartbeat / unregister) ---

export function registerPeer(body: RegisterRequest, brokerUrl = BROKER_URL): Promise<BrokerResponse<RegisterResponse>> {
  return brokerPost<RegisterResponse>("/register", body as unknown as Record<string, unknown>, brokerUrl);
}

export function sendHeartbeat(body: HeartbeatRequest, brokerUrl = BROKER_URL): Promise<BrokerResponse<{ acknowledged?: boolean; readded?: boolean }>> {
  return brokerPost("/heartbeat", { ...body }, brokerUrl);
}

export function unregisterPeer(
  body: { peer_id: string; peer_secret: string; pid: number; pid_start: string },
  brokerUrl = BROKER_URL,
): Promise<BrokerResponse<{ unregistered?: boolean; connections_remaining?: number }>> {
  return brokerPost("/unregister", { ...body }, brokerUrl);
}

export function setSummary(
  body: { peer_id: string; peer_secret: string; summary: string },
  brokerUrl = BROKER_URL,
): Promise<BrokerResponse<unknown>> {
  return brokerPost("/set-summary", { ...body }, brokerUrl);
}

// --- Messages (deferred-ack read protocol; used from PHASE_2 on) ---

export function peekMessages(
  body: { peer_id: string; peer_secret: string },
  brokerUrl = BROKER_URL,
): Promise<BrokerResponse<{ messages: PollMessage[]; unread: UnreadCountResponse; pool_throttles?: unknown[] }>> {
  return brokerPost("/message/peek", { ...body }, brokerUrl);
}

export function ackMessages(
  body: { peer_id: string; peer_secret: string; message_ids: number[] },
  brokerUrl = BROKER_URL,
): Promise<BrokerResponse<unknown>> {
  return brokerPost("/message/read", { ...body }, brokerUrl);
}

export function unreadCount(
  body: { peer_id: string },
  brokerUrl = BROKER_URL,
): Promise<BrokerResponse<UnreadCountResponse>> {
  return brokerPost("/message/unread-count", { ...body }, brokerUrl);
}

export function sendMessage(
  body: { peer_id: string; peer_secret: string; to_peer_id?: string; pool_name?: string; body: string },
  brokerUrl = BROKER_URL,
): Promise<BrokerResponse<MessageSendResponse>> {
  return brokerPost("/message/send", { ...body }, brokerUrl);
}

// --- Peers / pools / services (compact `cct` action dispatch; PHASE_2) ---

export function listPeers(brokerUrl = BROKER_URL): Promise<BrokerResponse<PeerInfo[]>> {
  return brokerPost("/list-peers", {}, brokerUrl);
}

export function listPools(peerId?: string, brokerUrl = BROKER_URL): Promise<BrokerResponse<PoolInfo[]>> {
  return brokerPost("/pool/list", peerId ? { peer_id: peerId } : {}, brokerUrl);
}

export function poolStatus(poolName: string, brokerUrl = BROKER_URL): Promise<BrokerResponse<PoolStatusResponse>> {
  return brokerPost("/pool/status", { pool_name: poolName }, brokerUrl);
}

export function createPool(
  body: { peer_id: string; peer_secret: string; name: string; purpose?: string },
  brokerUrl = BROKER_URL,
): Promise<BrokerResponse<PoolCreateResponse>> {
  return brokerPost("/pool/create", { ...body }, brokerUrl);
}

export function joinPool(
  body: { peer_id: string; peer_secret: string; pool_name: string },
  brokerUrl = BROKER_URL,
): Promise<BrokerResponse<unknown>> {
  return brokerPost("/pool/join", { ...body }, brokerUrl);
}

export function leavePool(
  body: { peer_id: string; peer_secret: string; pool_name: string },
  brokerUrl = BROKER_URL,
): Promise<BrokerResponse<unknown>> {
  return brokerPost("/pool/leave", { ...body }, brokerUrl);
}

export function inviteToPool(
  body: { peer_id: string; peer_secret: string; target_peer_id: string; pool_name: string },
  brokerUrl = BROKER_URL,
): Promise<BrokerResponse<unknown>> {
  return brokerPost("/pool/invite", { ...body }, brokerUrl);
}

export function setPoolIdle(
  body: { peer_id: string; peer_secret: string; pool_name: string; minutes: number; reason?: string; force?: boolean },
  brokerUrl = BROKER_URL,
): Promise<BrokerResponse<{ approved: boolean; idle_until?: string; activity?: unknown }>> {
  return brokerPost("/pool/set-idle", { ...body }, brokerUrl);
}

export function clearPoolIdle(
  body: { peer_id: string; peer_secret: string; pool_name: string },
  brokerUrl = BROKER_URL,
): Promise<BrokerResponse<unknown>> {
  return brokerPost("/pool/clear-idle", { ...body }, brokerUrl);
}

export function proposeRelease(
  body: { peer_id: string; peer_secret: string; pool_name: string; target_peer_id: string; reason?: string },
  brokerUrl = BROKER_URL,
): Promise<BrokerResponse<ProposeReleaseResponse>> {
  return brokerPost("/pool/propose-release", { ...body }, brokerUrl);
}

export function voteRelease(
  body: { peer_id: string; peer_secret: string; release_id: string; vote: "yes" | "no" },
  brokerUrl = BROKER_URL,
): Promise<BrokerResponse<VoteReleaseResponse>> {
  return brokerPost("/pool/vote-release", { ...body }, brokerUrl);
}

export function listServices(brokerUrl = BROKER_URL): Promise<BrokerResponse<unknown[]>> {
  return brokerGet("/services", brokerUrl);
}
