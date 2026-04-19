import * as path from "node:path";
import * as os from "node:os";

export const BROKER_PORT = 7888;
export const BROKER_HOST = "127.0.0.1";

export const CCT_DIR = path.join(os.homedir(), ".cct");
export const DB_PATH = path.join(CCT_DIR, "cct.db");
export const PIDMAP_DIR = path.join(CCT_DIR, "pidmaps");
export const FLAGS_DIR = path.join(CCT_DIR, "flags");

export const POLL_INTERVAL_MS = 2000;
export const HEARTBEAT_INTERVAL_MS = 15000;
export const STALE_CHECK_INTERVAL_MS = 30000;

export const PEER_SECRET_LENGTH = 32;
export const PEER_ID_LENGTH = 8;
