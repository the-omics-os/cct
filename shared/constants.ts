import * as path from "node:path";
import * as os from "node:os";
import { readFileSync } from "node:fs";

export const BROKER_PORT = parseInt(process.env.CCT_PORT ?? "7888", 10);
export const BROKER_BIND_HOST = process.env.CCT_HOST ?? "127.0.0.1";

export const CCT_DIR = process.env.CCT_DIR ?? path.join(os.homedir(), ".cct");
export const CODEX_HOME = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
export const CODEX_SESSIONS_DIR = path.join(CODEX_HOME, "sessions");
// os and the MCP adapter have separate resolvers. This constant describes os;
// the installer separately checks the adapter's PI_CODING_AGENT_DIR selection.
const osAgentOverride = process.env.OS_CODING_AGENT_DIR;
export const OS_AGENT_DIR = osAgentOverride
  ? path.resolve(osAgentOverride === "~" ? os.homedir()
    : osAgentOverride.startsWith("~/") ? path.join(os.homedir(), osAgentOverride.slice(2)) : osAgentOverride)
  : path.join(os.homedir(), ".os", "agent");
export const DB_PATH = path.join(CCT_DIR, "cct.db");
export const PIDMAP_DIR = path.join(CCT_DIR, "pidmaps");
export const FLAGS_DIR = path.join(CCT_DIR, "flags");
export const CONFIG_PATH = path.join(CCT_DIR, "config.json");

function readConfig(): { broker?: string; token?: string } {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

const config = readConfig();

export const BROKER_TOKEN = process.env.CCT_TOKEN ?? config.token ?? "";

function resolveBrokerUrl(): string {
  const raw = process.env.CCT_BROKER ?? config.broker;
  if (!raw) return `http://127.0.0.1:${BROKER_PORT}`;
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  if (raw.includes(":")) return `http://${raw}`;
  return `http://${raw}:${BROKER_PORT}`;
}

export const BROKER_URL = resolveBrokerUrl();

function isRemoteBroker(): boolean {
  const raw = process.env.CCT_BROKER ?? config.broker;
  if (!raw) return false;
  let host = raw;
  if (host.startsWith("http://")) host = host.slice(7);
  if (host.startsWith("https://")) host = host.slice(8);
  host = host.split(":")[0].split("/")[0];
  return host !== "127.0.0.1" && host !== "localhost";
}

export const IS_REMOTE = isRemoteBroker();

export const POLL_INTERVAL_MS = 2000;
export const HEARTBEAT_INTERVAL_MS = 15000;
export const STALE_CHECK_INTERVAL_MS = 30000;

export const PEER_SECRET_LENGTH = 32;
export const PEER_ID_LENGTH = 8;

export type CompactFieldType = "string" | "number" | "boolean" | "vote";
export interface CompactActionDefinition {
  action: string;
  required: readonly string[];
  optional: readonly string[];
  types: Readonly<Record<string, CompactFieldType>>;
  handler: string;
  handlerArgs: Readonly<Record<string, string>>;
  legacyTool: string | readonly string[];
}

// Single source for compact schema generation, validation and dispatch mapping.
export const CCT_COMPACT_ACTIONS = [
  { action: "send", required: ["to", "message"], optional: [], types: { to: "string", message: "string" }, handler: "send", handlerArgs: { to: "to", message: "message" }, legacyTool: "cct_send_message" },
  { action: "status", required: [], optional: [], types: {}, handler: "status", handlerArgs: {}, legacyTool: "cct_whoami" },
  { action: "peers", required: [], optional: [], types: {}, handler: "peers", handlerArgs: {}, legacyTool: "cct_list_peers" },
  { action: "pools", required: [], optional: ["pool"], types: { pool: "string" }, handler: "pools", handlerArgs: { pool: "pool_name" }, legacyTool: ["cct_list_pools", "cct_pool_status"] },
  { action: "create", required: ["pool"], optional: ["purpose"], types: { pool: "string", purpose: "string" }, handler: "create", handlerArgs: { pool: "name", purpose: "purpose" }, legacyTool: "cct_create_pool" },
  { action: "join", required: ["pool"], optional: [], types: { pool: "string" }, handler: "join", handlerArgs: { pool: "pool_name" }, legacyTool: "cct_join_pool" },
  { action: "leave", required: ["pool"], optional: [], types: { pool: "string" }, handler: "leave", handlerArgs: { pool: "pool_name" }, legacyTool: "cct_leave_pool" },
  { action: "invite", required: ["pool", "peer"], optional: [], types: { pool: "string", peer: "string" }, handler: "invite", handlerArgs: { pool: "pool_name", peer: "peer" }, legacyTool: "cct_invite_to_pool" },
  { action: "summary", required: ["text"], optional: [], types: { text: "string" }, handler: "summary", handlerArgs: { text: "summary" }, legacyTool: "cct_set_summary" },
  { action: "idle", required: ["pool", "minutes"], optional: ["reason", "force"], types: { pool: "string", minutes: "number", reason: "string", force: "boolean" }, handler: "idle", handlerArgs: { pool: "pool_name", minutes: "minutes", reason: "reason", force: "force" }, legacyTool: "cct_set_pool_idle" },
  { action: "resume", required: ["pool"], optional: [], types: { pool: "string" }, handler: "resume", handlerArgs: { pool: "pool_name" }, legacyTool: "cct_clear_pool_idle" },
  { action: "release", required: ["pool", "peer"], optional: ["reason"], types: { pool: "string", peer: "string", reason: "string" }, handler: "release", handlerArgs: { pool: "pool_name", peer: "target", reason: "reason" }, legacyTool: "cct_propose_release" },
  { action: "vote", required: ["release_id", "vote"], optional: [], types: { release_id: "string", vote: "vote" }, handler: "vote", handlerArgs: { release_id: "release_id", vote: "vote" }, legacyTool: "cct_vote_release" },
  { action: "services", required: [], optional: ["service_id"], types: { service_id: "string" }, handler: "services", handlerArgs: { service_id: "service_id" }, legacyTool: "cct_list_services" },
  { action: "terminate", required: ["reason"], optional: [], types: { reason: "string" }, handler: "terminate", handlerArgs: { reason: "reason" }, legacyTool: "cct_self_terminate" },
] as const satisfies readonly CompactActionDefinition[];
