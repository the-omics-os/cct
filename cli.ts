#!/usr/bin/env tsx
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import {
  BROKER_PORT,
  BROKER_BIND_HOST,
  BROKER_URL,
  BROKER_TOKEN,
  IS_REMOTE,
  CONFIG_PATH,
  PIDMAP_DIR,
} from "./shared/constants.ts";
import type {
  BrokerResponse,
  HealthResponse,
  PeerInfo,
  PoolInfo,
  PoolCreateResponse,
  MessageSendResponse,
} from "./shared/types.ts";

const CCT_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(CCT_DIR, "server.ts");
const HOOK_PATH = join(CCT_DIR, "hook.sh");
const HOOK_CODEX_PATH = join(CCT_DIR, "hook-codex.sh");
const PROMPT_CODEX_PATH = join(CCT_DIR, "prompt-codex.sh");
const SESSION_START_CODEX_PATH = join(CCT_DIR, "session-start-codex.sh");
const BROKER_PATH = join(CCT_DIR, "broker.ts");
const GLOBAL_CLAUDE_JSON = join(homedir(), ".claude.json");
const GLOBAL_CLAUDE_SETTINGS = join(homedir(), ".claude", "settings.json");
const CODEX_CONFIG_PATH = join(homedir(), ".codex", "config.toml");

function resolveTargetPaths(projectMode: boolean): { claudeJson: string; claudeSettings: string } {
  if (!projectMode) return { claudeJson: GLOBAL_CLAUDE_JSON, claudeSettings: GLOBAL_CLAUDE_SETTINGS };
  const cwd = process.cwd();
  return { claudeJson: join(cwd, ".claude.json"), claudeSettings: join(cwd, ".claude", "settings.json") };
}

// --- Helpers ---

async function brokerFetch<T>(path: string, body?: unknown): Promise<BrokerResponse<T>> {
  const method = body !== undefined ? "POST" : "GET";
  const headers: Record<string, string> = {};
  if (BROKER_TOKEN) headers["Authorization"] = `Bearer ${BROKER_TOKEN}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const opts: RequestInit = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${BROKER_URL}${path}`, opts);
  return res.json() as Promise<BrokerResponse<T>>;
}

async function brokerIsRunning(): Promise<boolean> {
  try {
    const res = await brokerFetch<HealthResponse>("/health");
    return res.ok === true;
  } catch {
    return false;
  }
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function requireBroker(): Promise<void> {
  if (!(await brokerIsRunning())) {
    if (IS_REMOTE) {
      die(`Cannot reach remote broker at ${BROKER_URL}. Is it running?`);
    }
    die("Broker not running. Start with: cct start");
  }
}

async function resolvePeerNameToId(nameOrId: string): Promise<string> {
  const res = await brokerFetch<PeerInfo[]>("/list-peers", {});
  if (!res.ok || !res.data) die(`Failed to list peers: ${res.error}`);

  // Exact match on ID or name first
  const exact = res.data.find((p) => p.id === nameOrId || p.name === nameOrId);
  if (exact) return exact.id;

  // Prefix match on ID (min 4 chars)
  let matches: PeerInfo[] = [];
  if (nameOrId.length >= 4) {
    matches = res.data.filter((p) => p.id.startsWith(nameOrId));
  }
  // Prefix match on name
  if (matches.length === 0) {
    matches = res.data.filter((p) => p.name.startsWith(nameOrId));
  }
  if (matches.length === 0) die(`Peer not found: ${nameOrId}`);
  if (matches.length > 1) {
    const list = matches.map((p) => `  ${p.name} [${p.id}]`).join("\n");
    die(`Ambiguous match for "${nameOrId}":\n${list}\nUse a longer prefix or the full peer ID.`);
  }
  return matches[0].id;
}

function padRight(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length);
}

type LocalIdentity = {
  peerId: string;
  peerName?: string;
  source: string;
};

function parsePidmapContent(content: string, source: string): LocalIdentity | null {
  const [peerId, peerName] = content.trim().split("|");
  if (!peerId) return null;
  return { peerId, peerName: peerName || undefined, source };
}

function readPidmap(path: string): LocalIdentity | null {
  try {
    return parsePidmapContent(readFileSync(path, "utf-8"), path);
  } catch {
    return null;
  }
}

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
  return "";
}

function getParentPid(pid: number): number | null {
  try {
    const proc = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)]);
    const parent = parseInt(proc.stdout?.toString().trim() ?? "", 10);
    return parent && parent !== 1 ? parent : null;
  } catch {
    return null;
  }
}

function getCommandForPid(pid: number): string {
  try {
    const proc = spawnSync("ps", ["-o", "command=", "-p", String(pid)]);
    return proc.stdout?.toString().trim() ?? "";
  } catch {
    return "";
  }
}

function pidHasAncestor(pid: number, ancestorPid: number): boolean {
  let current: number | null = pid;
  for (let i = 0; current && i < 12; i++) {
    if (current === ancestorPid) return true;
    current = getParentPid(current);
  }
  return false;
}

function findCodexAncestorPid(): number | null {
  let pid: number | null = process.ppid;
  for (let i = 0; pid && i < 12; i++) {
    const cmd = getCommandForPid(pid);
    if (cmd.includes("/codex") || cmd.endsWith(" codex") || cmd.includes("@openai/codex")) return pid;
    pid = getParentPid(pid);
  }
  return null;
}

function findPidmapByProcessAncestry(): LocalIdentity | null {
  let pid: number | null = process.ppid;
  for (let i = 0; pid && i < 12; i++) {
    const start = getPidStartForPid(pid);
    if (start) {
      const exact = join(PIDMAP_DIR, `${pid}_${start}`);
      const identity = readPidmap(exact);
      if (identity) return identity;
    }
    pid = getParentPid(pid);
  }
  return null;
}

function findCodexMarkerByAncestry(codexPid: number): LocalIdentity | null {
  try {
    const markers = readdirSync(PIDMAP_DIR)
      .filter((f) => f.startsWith("codex_mcp_"))
      .map((f) => ({ file: f, pid: parseInt(f.slice("codex_mcp_".length), 10) }))
      .filter((m) => m.pid && pidHasAncestor(m.pid, codexPid));
    for (const marker of markers) {
      const identity = readPidmap(join(PIDMAP_DIR, marker.file));
      if (identity) return identity;
    }
  } catch {}
  return null;
}

function resolveLocalIdentity(): LocalIdentity | null {
  if (process.env.CCT_PEER_ID) {
    return {
      peerId: process.env.CCT_PEER_ID,
      peerName: process.env.CCT_PEER_NAME,
      source: "CCT_PEER_ID",
    };
  }

  const codexSessionId = process.env.CCT_CODEX_SESSION_ID ?? process.env.CODEX_SESSION_ID ?? process.env.CODEX_THREAD_ID;
  if (codexSessionId) {
    const sessionPidmap = join(PIDMAP_DIR, `codex_${codexSessionId}`);
    const identity = readPidmap(sessionPidmap);
    if (identity) return identity;

    const codexPid = findCodexAncestorPid();
    const markerIdentity = codexPid ? findCodexMarkerByAncestry(codexPid) : null;
    if (markerIdentity) {
      try {
        writeFileSync(sessionPidmap, `${markerIdentity.peerId}|${markerIdentity.peerName ?? ""}`, { mode: 0o600 });
        chmodSync(sessionPidmap, 0o600);
      } catch {}
      return { ...markerIdentity, source: markerIdentity.source + ` -> ${sessionPidmap}` };
    }
  }

  return findPidmapByProcessAncestry();
}

function readJsonFile(path: string): any {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf-8");
  try {
    return JSON.parse(raw);
  } catch (e: any) {
    die(`Failed to parse ${path}: ${e.message}. Fix the file manually before running install/uninstall.`);
  }
}

function writeJsonFile(path: string, data: any): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

// --- Commands ---

async function cmdHelp() {
  console.log(`CCT — Claude Code Talk

Usage: cct <command> [args]

Commands:
  status                       Show broker health, peers, and pools
  whoami                       Show this session's CCT peer ID and name
  peers                        List all registered peers
  pools                        List all active pools
  pool create <name> [--purpose "..."]  Create a new pool
  pool delete <name>           (Not in v1) Pool archival info
  pool invite <peer> <pool>    Add a peer to a pool
  send <peer> <message...>     Send a DM to a peer
  broadcast <pool> <message...>  Broadcast to a pool
  messages [--pool <name>]     Show recent messages
  services                     List registered infrastructure services
  start                        Start the broker (detached, localhost)
  lan-start                    Start the broker on 0.0.0.0 (LAN mode)
  kill                         Stop the broker
  config                       Show or set persistent config
  install [--project]          Register MCP + hooks (auto-detects Claude Code & Codex)
  uninstall [--project]        Remove MCP + hooks (auto-detects Claude Code & Codex)
  help                         Show this help

LAN mode:
  Host the broker:   cct lan-start --token <shared-secret>
  Join from client:  CCT_BROKER=192.168.x.x CCT_TOKEN=<secret> claude

  Or persist with:   cct config set broker 192.168.x.x
                     cct config set token <shared-secret>

Env vars: CCT_HOST (bind addr), CCT_PORT, CCT_BROKER (connect addr), CCT_TOKEN`);
}

async function cmdStatus() {
  await requireBroker();
  const health = await brokerFetch<HealthResponse>("/health");
  const peers = await brokerFetch<PeerInfo[]>("/list-peers", {});
  const pools = await brokerFetch<PoolInfo[]>("/pool/list", {});

  console.log("=== CCT Broker Status ===");
  console.log(`Broker:  ${BROKER_URL}`);
  console.log(`Mode:    ${IS_REMOTE ? "remote" : "local"}`);
  console.log(`Status:  ${health.data?.status ?? "unknown"}`);
  console.log(`Peers:   ${health.data?.peers ?? 0}`);
  console.log(`Pools:   ${health.data?.pools ?? 0}`);

  if (peers.data && peers.data.length > 0) {
    console.log("\nPeers:");
    for (const p of peers.data) {
      const poolNames = p.pools.map((pl) => pl.pool_name).join(", ") || "none";
      console.log(`  ${p.name} (${p.id}) — ${p.cwd} [${p.git_branch ?? "no branch"}] pools: ${poolNames}`);
    }
  }

  if (pools.data && pools.data.length > 0) {
    console.log("\nPools:");
    for (const p of pools.data) {
      const memberNames = p.members.map((m) => m.peer_name).join(", ") || "empty";
      console.log(`  ${p.name} — ${p.purpose || "(no purpose)"} — members: ${memberNames}`);
    }
  }
}

async function cmdWhoami() {
  const identity = resolveLocalIdentity();
  if (!identity) {
    die(`No CCT identity found for this process.

If you are in Codex, restart the session after running "cct install", or ask the agent to call the cct_whoami MCP tool.
Do not use CODEX_THREAD_ID as a CCT address; it is only the Codex session/thread ID.`);
  }

  let peer: PeerInfo | undefined;
  try {
    const res = await brokerFetch<PeerInfo[]>("/list-peers", {});
    peer = res.data?.find((p) => p.id === identity.peerId);
  } catch {}

  console.log("CCT identity for this session:");
  console.log(`  peer_id:   ${identity.peerId}`);
  console.log(`  peer_name: ${peer?.name ?? identity.peerName ?? "(unknown)"}`);
  if (peer) {
    console.log(`  cwd:       ${peer.cwd}`);
    console.log(`  branch:    ${peer.git_branch ?? "(none)"}`);
    const pools = peer.pools.map((p) => `${p.pool_name}(${p.role})`).join(", ") || "(none)";
    console.log(`  pools:     ${pools}`);
  }
  console.log(`  source:    ${identity.source}`);
  const codexThreadId = process.env.CODEX_THREAD_ID ?? process.env.CODEX_SESSION_ID ?? process.env.CCT_CODEX_SESSION_ID;
  if (codexThreadId) {
    console.log(`  codex_id:  ${codexThreadId} (not a CCT peer ID)`);
  }
}

async function cmdPeers() {
  await requireBroker();
  const res = await brokerFetch<PeerInfo[]>("/list-peers", {});
  if (!res.ok || !res.data) die(`Error: ${res.error}`);

  if (res.data.length === 0) {
    console.log("No active peers.");
    return;
  }

  const header = `${padRight("Name", 20)} ${padRight("ID", 10)} ${padRight("CWD", 30)} ${padRight("Branch", 15)} ${padRight("Summary", 25)} Pools`;
  console.log(header);
  console.log("-".repeat(header.length));
  for (const p of res.data) {
    const pools = p.pools.map((pl) => pl.pool_name).join(", ") || "-";
    console.log(
      `${padRight(p.name, 20)} ${padRight(p.id, 10)} ${padRight(p.cwd, 30)} ${padRight(p.git_branch ?? "-", 15)} ${padRight(p.summary || "-", 25)} ${pools}`
    );
  }
}

async function cmdPools() {
  await requireBroker();
  const res = await brokerFetch<PoolInfo[]>("/pool/list", {});
  if (!res.ok || !res.data) die(`Error: ${res.error}`);

  if (res.data.length === 0) {
    console.log("No active pools.");
    return;
  }

  const header = `${padRight("Name", 20)} ${padRight("Purpose", 30)} ${padRight("Members", 30)} Status`;
  console.log(header);
  console.log("-".repeat(header.length));
  for (const p of res.data) {
    const members = p.members.map((m) => `${m.peer_name}(${m.role})`).join(", ") || "-";
    console.log(`${padRight(p.name, 20)} ${padRight(p.purpose || "-", 30)} ${padRight(members, 30)} ${p.status}`);
  }
}

async function cmdPoolCreate(args: string[]) {
  await requireBroker();
  let name = "";
  let purpose = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--purpose" && i + 1 < args.length) {
      purpose = args[++i];
    } else if (!name) {
      name = args[i];
    }
  }
  if (!name) die("Usage: cct pool create <name> [--purpose \"...\"]");

  const res = await brokerFetch<PoolCreateResponse>("/pool/create-cli", { name, purpose });
  if (!res.ok) die(`Error: ${res.error}`);
  console.log(`Pool "${name}" created (${res.data!.pool_id}).`);
}

async function cmdPoolDelete(_args: string[]) {
  console.log("Pool archival happens automatically when all members leave.");
}

async function cmdPoolInvite(args: string[]) {
  await requireBroker();
  if (args.length < 2) die("Usage: cct pool invite <peer-name-or-id> <pool-name>");
  const peerNameOrId = args[0];
  const poolName = args[1];

  const targetId = await resolvePeerNameToId(peerNameOrId);
  const res = await brokerFetch("/pool/invite-cli", {
    target_peer_id: targetId,
    pool_name: poolName,
  });
  if (!res.ok) die(`Error: ${res.error}`);
  console.log(`Invited ${peerNameOrId} to pool "${poolName}".`);
}

async function cmdSend(args: string[]) {
  await requireBroker();
  if (args.length < 2) die("Usage: cct send <peer-name-or-id> <message...>");
  const peerNameOrId = args[0];
  const message = args.slice(1).join(" ");
  const targetId = await resolvePeerNameToId(peerNameOrId);

  const res = await brokerFetch<MessageSendResponse>("/message/send-cli", {
    to_peer_id: targetId,
    body: message,
  });
  if (!res.ok) die(`Error: ${res.error}`);
  console.log(`Message sent (id: ${res.data!.message_id}).`);
}

async function cmdBroadcast(args: string[]) {
  await requireBroker();
  if (args.length < 2) die("Usage: cct broadcast <pool-name> <message...>");
  const poolName = args[0];
  const message = args.slice(1).join(" ");

  const res = await brokerFetch<MessageSendResponse>("/message/send-cli", {
    pool_name: poolName,
    body: message,
  });
  if (!res.ok) die(`Error: ${res.error}`);
  console.log(`Broadcast to "${poolName}" (${res.data!.recipient_count} recipients).`);
}

async function cmdMessages(args: string[]) {
  await requireBroker();
  let poolFilter: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--pool" && i + 1 < args.length) {
      poolFilter = args[++i];
    }
  }

  const res = await brokerFetch<any[]>("/message/history", {
    pool_name: poolFilter ?? undefined,
    limit: 50,
  });
  if (!res.ok || !res.data) die(`Error: ${res.error}`);

  if (res.data.length === 0) {
    console.log("No messages.");
    return;
  }

  for (const m of res.data) {
    const source = m.pool_name ? `[${m.pool_name}]` : "[DM]";
    const from = m.from_name || m.from_id;
    console.log(`${source} ${from}: ${m.body}  (${m.created_at})`);
  }
}

async function cmdServices() {
  await requireBroker();
  const res = await brokerFetch<any[]>("/services");
  if (!res.ok || !res.data) die(`Error: ${res.error}`);

  if (res.data.length === 0) {
    console.log("No registered services.");
    return;
  }

  const header = `${padRight("ID", 12)} ${padRight("Name", 28)} ${padRight("Type", 8)} ${padRight("URL", 35)} ${padRight("Status", 10)}`;
  console.log(header);
  console.log("-".repeat(header.length));
  for (const s of res.data) {
    console.log(`${padRight(s.id, 12)} ${padRight(s.name, 28)} ${padRight(s.type, 8)} ${padRight(s.url ?? "-", 35)} ${padRight(s.status, 10)}`);
  }
}

async function cmdStart() {
  if (IS_REMOTE) {
    die("CCT_BROKER points to a remote host. Use 'cct status' to check it, or unset with 'cct config rm broker'.");
  }
  if (await brokerIsRunning()) {
    console.log("Broker is already running.");
    return;
  }
  const proc = nodeSpawn("npx", ["tsx", BROKER_PATH], {
    stdio: ["ignore", "ignore", "inherit"],
    detached: true,
  });
  proc.unref();
  await new Promise(r => setTimeout(r, 500));
  if (await brokerIsRunning()) {
    console.log("Broker started on localhost.");
  } else {
    console.log("Broker process spawned. Check stderr for errors.");
  }
}

async function cmdLanStart(args: string[]) {
  if (IS_REMOTE) {
    die("CCT_BROKER points to a remote host. lan-start is for hosting the broker locally.");
  }
  if (await brokerIsRunning()) {
    console.log("Broker is already running. Kill it first with: cct kill");
    return;
  }

  let token = "";
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--token" || args[i] === "-t") && i + 1 < args.length) {
      token = args[++i];
    }
  }

  if (!token) {
    const { randomBytes } = await import("node:crypto");
    token = randomBytes(24).toString("hex");
    console.log(`Generated token: ${token}`);
    console.log(`Clients connect with: CCT_BROKER=<this-ip> CCT_TOKEN=${token} claude`);
    console.log(`Or persist: cct config set token ${token}\n`);
  }

  const env = { ...process.env, CCT_HOST: "0.0.0.0", CCT_TOKEN: token };
  const proc = nodeSpawn("npx", ["tsx", BROKER_PATH], {
    stdio: ["ignore", "ignore", "inherit"],
    env,
    detached: true,
  });
  proc.unref();
  await new Promise(r => setTimeout(r, 500));
  if (await brokerIsRunning()) {
    let ip = "0.0.0.0";
    try {
      const { networkInterfaces } = await import("node:os");
      const nets = networkInterfaces();
      for (const name of Object.keys(nets)) {
        for (const net of nets[name] ?? []) {
          if (net.family === "IPv4" && !net.internal) {
            ip = net.address;
            break;
          }
        }
        if (ip !== "0.0.0.0") break;
      }
    } catch {}
    console.log(`Broker started in LAN mode on ${ip}:${BROKER_PORT}`);
  } else {
    console.log("Broker process spawned. Check stderr for errors.");
  }
}

async function cmdConfig(args: string[]) {
  const sub = args[0];
  const configDir = dirname(CONFIG_PATH);
  mkdirSync(configDir, { recursive: true });

  if (!sub || sub === "show") {
    const cfg = readJsonFile(CONFIG_PATH);
    if (Object.keys(cfg).length === 0) {
      console.log("No config set. Use: cct config set <key> <value>");
      console.log("Keys: broker, token");
      return;
    }
    for (const [k, v] of Object.entries(cfg)) {
      const display = k === "token" ? `${String(v).slice(0, 8)}...` : v;
      console.log(`  ${k} = ${display}`);
    }
    return;
  }

  if (sub === "set") {
    const key = args[1];
    const val = args[2];
    if (!key || !val) die("Usage: cct config set <key> <value>\nKeys: broker, token");
    if (!["broker", "token"].includes(key)) die(`Unknown config key: ${key}. Valid: broker, token`);
    const cfg = readJsonFile(CONFIG_PATH);
    cfg[key] = val;
    writeJsonFile(CONFIG_PATH, cfg);
    const display = key === "token" ? `${val.slice(0, 8)}...` : val;
    console.log(`Set ${key} = ${display}`);
    return;
  }

  if (sub === "rm" || sub === "unset") {
    const key = args[1];
    if (!key) die("Usage: cct config rm <key>");
    const cfg = readJsonFile(CONFIG_PATH);
    delete cfg[key];
    writeJsonFile(CONFIG_PATH, cfg);
    console.log(`Removed ${key}`);
    return;
  }

  die(`Unknown config command: ${sub}. Use: show, set, rm`);
}

async function cmdKill() {
  if (IS_REMOTE) {
    die("Can't kill a remote broker. Stop it on the host machine.");
  }
  try {
    const proc = spawnSync("lsof", ["-ti", `:${BROKER_PORT}`]);
    const output = proc.stdout?.toString().trim() ?? "";
    if (!output) {
      console.log(`No process found on port ${BROKER_PORT}.`);
      return;
    }
    const pids = output.split("\n").map((s) => parseInt(s.trim(), 10)).filter(Boolean);
    let killed = 0;
    for (const pid of pids) {
      const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)]);
      const cmd = ps.stdout?.toString().trim() ?? "";
      if (cmd.includes("broker.ts") || cmd.includes("cct")) {
        process.kill(pid, "SIGTERM");
        killed++;
      }
    }
    if (killed > 0) {
      console.log(`Killed broker (${killed} process${killed > 1 ? "es" : ""}).`);
    } else {
      console.log("Port 7888 is in use but not by CCT broker. Not killing.");
    }
  } catch {
    console.log("No broker process found.");
  }
}

function backupFile(path: string): void {
  if (existsSync(path)) {
    const backup = path + ".bak";
    copyFileSync(path, backup);
  }
}

async function cmdInstall(projectMode: boolean) {
  const { claudeJson: CLAUDE_JSON, claudeSettings: CLAUDE_SETTINGS } = resolveTargetPaths(projectMode);
  const scope = projectMode ? "project" : "global";

  mkdirSync(dirname(CLAUDE_SETTINGS), { recursive: true });

  const cfg = readJsonFile(CONFIG_PATH);
  const mcpEnv: Record<string, string> = {};
  if (cfg.broker) mcpEnv["CCT_BROKER"] = cfg.broker;
  if (cfg.token) mcpEnv["CCT_TOKEN"] = cfg.token;

  backupFile(CLAUDE_JSON);
  const claudeJson = readJsonFile(CLAUDE_JSON);
  if (!claudeJson.mcpServers) claudeJson.mcpServers = {};
  claudeJson.mcpServers.cct = {
    type: "stdio",
    command: "npx",
    args: ["tsx", SERVER_PATH],
    env: mcpEnv,
  };
  writeJsonFile(CLAUDE_JSON, claudeJson);
  console.log(`Added MCP server to ${CLAUDE_JSON} (${scope})`);
  if (cfg.broker) console.log(`  → broker: ${cfg.broker}`);
  if (cfg.token) console.log(`  → token: ${cfg.token.slice(0, 8)}...`);

  backupFile(CLAUDE_SETTINGS);
  const settings = readJsonFile(CLAUDE_SETTINGS);
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];

  settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(
    (entry: any) => {
      if (!entry.hooks) return true;
      return !entry.hooks.some((h: any) => h.command && h.command.includes("hook.sh"));
    }
  );

  settings.hooks.PreToolUse.push({
    matcher: "",
    hooks: [
      {
        type: "command",
        command: `bash "${HOOK_PATH}"`,
      },
    ],
  });
  writeJsonFile(CLAUDE_SETTINGS, settings);
  console.log(`Added PreToolUse hook to ${CLAUDE_SETTINGS} (${scope})`);

  console.log(`\nCCT installed for Claude Code (${scope}). Restart sessions to activate.`);
  console.log("Start the broker with: cct start");

  // --- Auto-detect Codex and install there too ---
  if (detectCodex()) {
    installCodex();
  }
}

function detectCodex(): boolean {
  const codexBin = spawnSync("which", ["codex"]);
  return codexBin.status === 0 && existsSync(join(homedir(), ".codex"));
}

function readTomlFile(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf-8");
}

function ensureTomlEnvVars(toml: string, vars: string[]): { toml: string; changed: boolean } {
  const lines = toml.split("\n");
  const start = lines.findIndex((line) => line.trim() === "[mcp_servers.cct]");
  if (start === -1) return { toml, changed: false };

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].match(/^\s*\[/)) {
      end = i;
      break;
    }
  }

  const envLineIndex = lines.slice(start + 1, end).findIndex((line) => line.trim().startsWith("env_vars"));
  const quoted = vars.map((v) => `"${v}"`);

  if (envLineIndex !== -1) {
    const absoluteIndex = start + 1 + envLineIndex;
    const missing = quoted.filter((v) => !lines[absoluteIndex].includes(v));
    if (missing.length === 0) return { toml, changed: false };
    lines[absoluteIndex] = lines[absoluteIndex].replace(/\]\s*$/, (suffix) => {
      const needsComma = !lines[absoluteIndex].match(/\[\s*\]\s*$/) && !lines[absoluteIndex].trim().endsWith("[");
      return `${needsComma ? ", " : ""}${missing.join(", ")}${suffix}`;
    });
    return { toml: lines.join("\n"), changed: true };
  }

  lines.splice(end, 0, `env_vars = [${quoted.join(", ")}]`);
  return { toml: lines.join("\n"), changed: true };
}

function installCodex(): void {
  const cfg = readJsonFile(CONFIG_PATH);
  const configDir = join(homedir(), ".codex");
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });

  let toml = readTomlFile(CODEX_CONFIG_PATH);
  const requiredEnvVars = ["CODEX_THREAD_ID", "CODEX_SESSION_ID", "CCT_CODEX_SESSION_ID"];

  // Add codex_hooks feature flag if not present
  if (!toml.includes("codex_hooks")) {
    if (toml.includes("[features]")) {
      toml = toml.replace("[features]", "[features]\ncodex_hooks = true");
    } else {
      toml += "\n[features]\ncodex_hooks = true\n";
    }
  }

  // Add MCP server if not present
  if (!toml.includes("[mcp_servers.cct]")) {
    const envParts: string[] = [`CCT_RUNTIME = "codex"`, `CCT_BROKER = "${cfg.broker || "http://127.0.0.1:7888"}"`];
    const envVarsList: string[] = requiredEnvVars.map((v) => `"${v}"`);
    if (cfg.token) envVarsList.push(`"CCT_TOKEN"`);

    let mcpSection = `\n[mcp_servers.cct]\ncommand = "npx"\nargs = ["tsx", "${SERVER_PATH}"]\ncwd = "${CCT_DIR}"\nstartup_timeout_sec = 10\ntool_timeout_sec = 30\nenv = { ${envParts.join(", ")} }\n`;
    if (envVarsList.length > 0) {
      mcpSection += `env_vars = [${envVarsList.join(", ")}]\n`;
    }
    toml += mcpSection;
    console.log(`Added [mcp_servers.cct] to ${CODEX_CONFIG_PATH}`);
  } else {
    const vars = cfg.token ? [...requiredEnvVars, "CCT_TOKEN"] : requiredEnvVars;
    const ensured = ensureTomlEnvVars(toml, vars);
    toml = ensured.toml;
    if (ensured.changed) console.log(`Updated CCT env_vars in ${CODEX_CONFIG_PATH}`);
    console.log(`MCP server 'cct' already in ${CODEX_CONFIG_PATH}`);
  }

  // Add hooks if not present
  if (!toml.includes("hook-codex.sh")) {
    toml += `\n[[hooks.PreToolUse]]\nmatcher = ".*"\n\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "${HOOK_CODEX_PATH}"\ntimeout = 1\n`;
    console.log(`Added PreToolUse hook to ${CODEX_CONFIG_PATH}`);
  }

  if (!toml.includes("prompt-codex.sh")) {
    toml += `\n[[hooks.UserPromptSubmit]]\n\n[[hooks.UserPromptSubmit.hooks]]\ntype = "command"\ncommand = "${PROMPT_CODEX_PATH}"\ntimeout = 1\n`;
    console.log(`Added UserPromptSubmit hook to ${CODEX_CONFIG_PATH}`);
  }

  if (!toml.includes("session-start-codex.sh")) {
    toml += `\n[[hooks.SessionStart]]\nmatcher = "startup|resume"\n\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "${SESSION_START_CODEX_PATH}"\ntimeout = 1\n`;
    console.log(`Added SessionStart hook to ${CODEX_CONFIG_PATH}`);
  }

  backupFile(CODEX_CONFIG_PATH);
  writeFileSync(CODEX_CONFIG_PATH, toml);
  console.log(`\nCCT installed for Codex CLI. Restart Codex sessions to activate.`);
  console.log(`  Busy delivery: PreToolUse hook blocks until messages read`);
  console.log(`  Idle delivery: UserPromptSubmit injects context on next prompt`);
}

function removeCctFromToml(toml: string): string {
  const lines = toml.split("\n");
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip [mcp_servers.cct] section (single table, ends at next [header])
    if (line.trim() === "[mcp_servers.cct]") {
      i++;
      while (i < lines.length && !lines[i].match(/^\s*\[/)) i++;
      continue;
    }

    // Skip [[hooks.*]] blocks that reference our scripts
    if (line.match(/^\[\[hooks\.(PreToolUse|UserPromptSubmit|SessionStart)\]\]/)) {
      // Look ahead to see if this block references a CCT script
      let end = i + 1;
      while (end < lines.length && !lines[end].match(/^\s*\[\[/) && !lines[end].match(/^\s*\[(?!\[)/)) end++;
      const block = lines.slice(i, end).join("\n");
      if (block.includes("hook-codex.sh") || block.includes("prompt-codex.sh") || block.includes("session-start-codex.sh")) {
        i = end;
        // Skip trailing blank lines
        while (i < lines.length && lines[i].trim() === "") i++;
        continue;
      }
    }

    result.push(line);
    i++;
  }

  return result.join("\n").replace(/\n{3,}/g, "\n\n");
}

function uninstallCodex(): void {
  if (!existsSync(CODEX_CONFIG_PATH)) {
    console.log("No Codex config found.");
    return;
  }

  const toml = readTomlFile(CODEX_CONFIG_PATH);
  const cleaned = removeCctFromToml(toml);

  if (cleaned !== toml) {
    backupFile(CODEX_CONFIG_PATH);
    writeFileSync(CODEX_CONFIG_PATH, cleaned);
    console.log(`Removed CCT from ${CODEX_CONFIG_PATH}`);
  } else {
    console.log(`No CCT entries found in ${CODEX_CONFIG_PATH}`);
  }
}

async function cmdUninstall(projectMode: boolean) {
  const { claudeJson: CLAUDE_JSON, claudeSettings: CLAUDE_SETTINGS } = resolveTargetPaths(projectMode);
  const scope = projectMode ? "project" : "global";

  // 1. Remove MCP
  const claudeJson = readJsonFile(CLAUDE_JSON);
  if (claudeJson.mcpServers?.cct) {
    delete claudeJson.mcpServers.cct;
    writeJsonFile(CLAUDE_JSON, claudeJson);
    console.log(`Removed MCP server from ${CLAUDE_JSON} (${scope})`);
  } else {
    console.log(`No CCT MCP entry in ${CLAUDE_JSON}`);
  }

  // 2. Remove hook
  const settings = readJsonFile(CLAUDE_SETTINGS);
  if (settings.hooks?.PreToolUse) {
    const before = settings.hooks.PreToolUse.length;
    settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(
      (entry: any) => {
        if (!entry.hooks) return true;
        return !entry.hooks.some((h: any) => h.command && h.command.includes("hook.sh"));
      }
    );
    if (settings.hooks.PreToolUse.length === 0) {
      delete settings.hooks.PreToolUse;
    }
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }
    writeJsonFile(CLAUDE_SETTINGS, settings);
    if (settings.hooks?.PreToolUse?.length !== before) {
      console.log(`Removed PreToolUse hook from ${CLAUDE_SETTINGS} (${scope})`);
    } else {
      console.log(`No CCT hook found in ${CLAUDE_SETTINGS}`);
    }
  } else {
    console.log(`No hooks in ${CLAUDE_SETTINGS}`);
  }

  console.log(`\nCCT uninstalled from Claude Code (${scope}). Restart sessions to deactivate.`);

  // --- Auto-detect Codex and uninstall there too ---
  if (detectCodex()) {
    uninstallCodex();
  }
}

// --- Main ---

const args = process.argv.slice(2);
const cmd = args[0];
const subArgs = args.slice(1);

try {
  switch (cmd) {
    case "help":
    case "--help":
    case "-h":
    case undefined:
      await cmdHelp();
      break;
    case "status":
      await cmdStatus();
      break;
    case "whoami":
      await cmdWhoami();
      break;
    case "peers":
      await cmdPeers();
      break;
    case "pools":
      await cmdPools();
      break;
    case "pool": {
      const subCmd = subArgs[0];
      const poolArgs = subArgs.slice(1);
      switch (subCmd) {
        case "create":
          await cmdPoolCreate(poolArgs);
          break;
        case "delete":
          await cmdPoolDelete(poolArgs);
          break;
        case "invite":
          await cmdPoolInvite(poolArgs);
          break;
        default:
          die(`Unknown pool command: ${subCmd}. Use: create, delete, invite`);
      }
      break;
    }
    case "send":
      await cmdSend(subArgs);
      break;
    case "broadcast":
      await cmdBroadcast(subArgs);
      break;
    case "messages":
      await cmdMessages(subArgs);
      break;
    case "services":
      await cmdServices();
      break;
    case "start":
      await cmdStart();
      break;
    case "lan-start":
      await cmdLanStart(subArgs);
      break;
    case "kill":
      await cmdKill();
      break;
    case "config":
      await cmdConfig(subArgs);
      break;
    case "install":
      await cmdInstall(subArgs.includes("--project"));
      break;
    case "uninstall":
      await cmdUninstall(subArgs.includes("--project"));
      break;
    default:
      die(`Unknown command: ${cmd}. Run "cct help" for usage.`);
  }
} catch (e: any) {
  if (e.code === "ConnectionRefused" || e.message?.includes("connect")) {
    die("Broker not running. Start with: cct start");
  }
  throw e;
}
