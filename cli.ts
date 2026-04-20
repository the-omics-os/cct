#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { BROKER_HOST, BROKER_PORT } from "./shared/constants.ts";
import type {
  BrokerResponse,
  HealthResponse,
  PeerInfo,
  PoolInfo,
  PoolCreateResponse,
  MessageSendResponse,
} from "./shared/types.ts";

const BROKER_URL = `http://${BROKER_HOST}:${BROKER_PORT}`;
const CCT_DIR = join(import.meta.dir);
const SERVER_PATH = join(CCT_DIR, "server.ts");
const HOOK_PATH = join(CCT_DIR, "hook.sh");
const BROKER_PATH = join(CCT_DIR, "broker.ts");
const CLAUDE_JSON = join(homedir(), ".claude.json");
const CLAUDE_SETTINGS = join(homedir(), ".claude", "settings.json");

// --- Helpers ---

async function brokerFetch<T>(path: string, body?: unknown): Promise<BrokerResponse<T>> {
  const method = body !== undefined ? "POST" : "GET";
  const opts: RequestInit = { method };
  if (body !== undefined) {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }
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
  peers                        List all registered peers
  pools                        List all active pools
  pool create <name> [--purpose "..."]  Create a new pool
  pool delete <name>           (Not in v1) Pool archival info
  pool invite <peer> <pool>    Add a peer to a pool
  send <peer> <message...>     Send a DM to a peer
  broadcast <pool> <message...>  Broadcast to a pool
  messages [--pool <name>]     Show recent messages
  services                     List registered infrastructure services
  start                        Start the broker (detached)
  kill                         Stop the broker
  install                      Register MCP server + hook
  uninstall                    Remove MCP server + hook
  help                         Show this help`);
}

async function cmdStatus() {
  await requireBroker();
  const health = await brokerFetch<HealthResponse>("/health");
  const peers = await brokerFetch<PeerInfo[]>("/list-peers", {});
  const pools = await brokerFetch<PoolInfo[]>("/pool/list", {});

  console.log("=== CCT Broker Status ===");
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
  if (await brokerIsRunning()) {
    console.log("Broker is already running.");
    return;
  }
  const proc = Bun.spawn(["bun", BROKER_PATH], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  proc.unref();
  // Wait briefly for startup
  await Bun.sleep(500);
  if (await brokerIsRunning()) {
    console.log("Broker started.");
  } else {
    console.log("Broker process spawned. Check stderr for errors.");
  }
}

async function cmdKill() {
  try {
    const proc = Bun.spawnSync(["lsof", "-ti", `:${BROKER_PORT}`]);
    const output = proc.stdout.toString().trim();
    if (!output) {
      console.log("No process found on port 7888.");
      return;
    }
    const pids = output.split("\n").map((s) => parseInt(s.trim(), 10)).filter(Boolean);
    let killed = 0;
    for (const pid of pids) {
      const ps = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)]);
      const cmd = ps.stdout.toString().trim();
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

async function cmdInstall() {
  mkdirSync(dirname(CLAUDE_SETTINGS), { recursive: true });

  backupFile(CLAUDE_JSON);
  const claudeJson = readJsonFile(CLAUDE_JSON);
  if (!claudeJson.mcpServers) claudeJson.mcpServers = {};
  claudeJson.mcpServers.cct = {
    type: "stdio",
    command: "bun",
    args: [SERVER_PATH],
    env: {},
  };
  writeJsonFile(CLAUDE_JSON, claudeJson);
  console.log(`Added MCP server to ${CLAUDE_JSON}`);

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
  console.log(`Added PreToolUse hook to ${CLAUDE_SETTINGS}`);

  console.log("\nCCT installed. Restart Claude Code sessions to activate.");
  console.log("Start the broker with: cct start");
}

async function cmdUninstall() {
  // 1. Remove MCP from ~/.claude.json
  const claudeJson = readJsonFile(CLAUDE_JSON);
  if (claudeJson.mcpServers?.cct) {
    delete claudeJson.mcpServers.cct;
    writeJsonFile(CLAUDE_JSON, claudeJson);
    console.log(`Removed MCP server from ${CLAUDE_JSON}`);
  } else {
    console.log(`No CCT MCP entry in ${CLAUDE_JSON}`);
  }

  // 2. Remove hook from ~/.claude/settings.json
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
      console.log(`Removed PreToolUse hook from ${CLAUDE_SETTINGS}`);
    } else {
      console.log(`No CCT hook found in ${CLAUDE_SETTINGS}`);
    }
  } else {
    console.log(`No hooks in ${CLAUDE_SETTINGS}`);
  }

  console.log("\nCCT uninstalled. Restart Claude Code sessions to deactivate.");
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
    case "kill":
      await cmdKill();
      break;
    case "install":
      await cmdInstall();
      break;
    case "uninstall":
      await cmdUninstall();
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
