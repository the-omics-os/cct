import * as path from "node:path";
import * as os from "node:os";
import { readFileSync } from "node:fs";

export const BROKER_PORT = parseInt(process.env.CCT_PORT ?? "7888", 10);
export const BROKER_BIND_HOST = process.env.CCT_HOST ?? "127.0.0.1";

export const CCT_DIR = process.env.CCT_DIR ?? path.join(os.homedir(), ".cct");
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
