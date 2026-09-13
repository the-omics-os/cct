// Codex session identity resolution.
//
// Codex does NOT export its session id into MCP server environments: a live cct
// MCP server spawned by codex has only the CCT_* vars from config.toml, so the
// `env_vars = ["CODEX_THREAD_ID", ...]` passthrough forwards nothing and the
// broker `session_key` was always NULL for codex peers. Every MCP respawn then
// minted a fresh CCT identity (new id + new codex-XXXX name).
//
// We recover the id from codex's own transcripts instead:
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<session_id>.jsonl
// whose first line is a `session_meta` record carrying `session_id`, `cwd`, and
// — when codex forked the session (compaction) — `forked_from_id`.
//
// Keying on the ROOT of the fork chain is what makes the identity stable: codex
// mints a NEW session id both on compaction fork and (implicitly) across the
// lifetime of a conversation, so the current id alone still churns. The root id
// is constant for the whole lineage, including after `codex resume`.

import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface CodexSessionMeta {
  sessionId: string;
  forkedFromId: string | null;
  cwd: string | null;
}

export interface CodexSessionIdentity {
  /** Current codex session id — used for the `codex_{session_id}` pidmap key the hooks look up. */
  sessionId: string | null;
  /** Root of the fork chain — used for the broker `session_key`. */
  rootSessionId: string | null;
  source: string;
}

const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

/** `codex resume <uuid> --flags` → uuid. The exact id, when codex was resumed. */
export function parseResumeSessionId(command: string): string | null {
  if (!command || !/\bresume\b/.test(command)) return null;
  const m = command.match(UUID_RE);
  return m ? m[0] : null;
}

/**
 * Read just the first line of a rollout — the whole file grows to megabytes, but
 * the `session_meta` record alone is already ~22KB in practice (it carries the
 * environment context), so read in chunks until the newline rather than
 * assuming a fixed head size: a truncated first line parses as nothing, which
 * would silently make every forked session look like its own root.
 */
function readFirstLine(file: string, maxBytes = 1_048_576, chunkSize = 65536): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < maxBytes) {
      const buf = Buffer.alloc(chunkSize);
      const n = readSync(fd, buf, 0, chunkSize, total);
      if (n <= 0) break;
      total += n;
      const chunk = buf.subarray(0, n);
      const nl = chunk.indexOf(0x0a);
      if (nl >= 0) {
        chunks.push(chunk.subarray(0, nl));
        return Buffer.concat(chunks).toString("utf8");
      }
      chunks.push(chunk);
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

export function readSessionMeta(file: string): CodexSessionMeta | null {
  const line = readFirstLine(file);
  if (!line) return null;
  try {
    const rec = JSON.parse(line);
    const payload = rec?.payload ?? rec;
    const sessionId = payload?.session_id ?? payload?.id;
    if (typeof sessionId !== "string" || !sessionId) return null;
    return {
      sessionId,
      forkedFromId: typeof payload?.forked_from_id === "string" ? payload.forked_from_id : null,
      cwd: typeof payload?.cwd === "string" ? payload.cwd : null,
    };
  } catch {
    return null;
  }
}

/**
 * Walk rollout files newest-first (YYYY/MM/DD dirs and timestamped filenames
 * both sort lexically, so reverse-sorted traversal is newest-first). `visit`
 * returns true to stop the walk.
 */
function walkRollouts(sessionsDir: string, visit: (file: string) => boolean, maxFiles = 4000): void {
  let seen = 0;
  const walk = (dir: string, depth: number): boolean => {
    if (depth > 4) return false;
    let names: string[];
    try {
      names = readdirSync(dir).sort().reverse();
    } catch {
      return false;
    }
    for (const name of names) {
      const full = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (walk(full, depth + 1)) return true;
        continue;
      }
      if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
      if (++seen > maxFiles) return true;
      if (visit(full)) return true;
    }
    return false;
  };
  walk(sessionsDir, 0);
}

export function findRolloutById(sessionsDir: string, sessionId: string): string | null {
  if (!sessionId) return null;
  const suffix = `-${sessionId}.jsonl`;
  let hit: string | null = null;
  walkRollouts(sessionsDir, (file) => {
    if (file.endsWith(suffix)) {
      hit = file;
      return true;
    }
    return false;
  });
  return hit;
}

/** Follow `forked_from_id` to the root of the fork chain. */
export function resolveRootSessionId(sessionsDir: string, sessionId: string, maxDepth = 32): string {
  let current = sessionId;
  const seen = new Set<string>([current]);
  for (let i = 0; i < maxDepth; i++) {
    const file = findRolloutById(sessionsDir, current);
    if (!file) return current;
    const meta = readSessionMeta(file);
    if (!meta?.forkedFromId || seen.has(meta.forkedFromId)) return current;
    current = meta.forkedFromId;
    seen.add(current);
  }
  return current;
}

/**
 * Newest session whose `session_meta.cwd` matches — used when codex was started
 * fresh (no resume id on the command line). Bounded scan: only the newest
 * `maxScan` rollouts are inspected.
 */
export function findLatestSessionIdForCwd(
  sessionsDir: string,
  cwd: string,
  maxScan = 60,
): { sessionId: string; file: string } | null {
  if (!cwd) return null;
  let hit: { sessionId: string; file: string } | null = null;
  let scanned = 0;
  walkRollouts(sessionsDir, (file) => {
    if (++scanned > maxScan) return true;
    const meta = readSessionMeta(file);
    if (meta && meta.cwd === cwd) {
      hit = { sessionId: meta.sessionId, file };
      return true;
    }
    return false;
  });
  return hit;
}

export function resolveCodexSessionIdentity(opts: {
  sessionsDir: string;
  cwd: string;
  hostCommand?: string;
  envSessionId?: string | null;
}): CodexSessionIdentity {
  const { sessionsDir, cwd, hostCommand = "", envSessionId } = opts;

  let sessionId: string | null = null;
  let source = "unresolved";

  if (envSessionId) {
    sessionId = envSessionId;
    source = "env";
  }
  if (!sessionId) {
    const resumed = parseResumeSessionId(hostCommand);
    if (resumed) {
      sessionId = resumed;
      source = "host-argv-resume";
    }
  }
  if (!sessionId) {
    const latest = findLatestSessionIdForCwd(sessionsDir, cwd);
    if (latest) {
      sessionId = latest.sessionId;
      source = "rollout-cwd";
    }
  }

  if (!sessionId) return { sessionId: null, rootSessionId: null, source };

  const rootSessionId = resolveRootSessionId(sessionsDir, sessionId);
  return {
    sessionId,
    rootSessionId,
    source: rootSessionId === sessionId ? source : `${source}+fork-root`,
  };
}
