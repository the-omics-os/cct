#!/usr/bin/env tsx
import { DatabaseSync as Database } from "node:sqlite";
import { mkdirSync, existsSync, statSync, chmodSync, unlinkSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import {
  BROKER_PORT,
  BROKER_BIND_HOST,
  BROKER_TOKEN,
  CCT_DIR,
  DB_PATH,
  PIDMAP_DIR,
  FLAGS_DIR,
  HEARTBEAT_INTERVAL_MS,
  STALE_CHECK_INTERVAL_MS,
  PEER_SECRET_LENGTH,
  PEER_ID_LENGTH,
} from "./shared/constants.ts";
import type {
  BrokerResponse,
  RegisterRequest,
  HeartbeatRequest,
  UnregisterRequest,
  SetSummaryRequest,
  PoolCreateRequest,
  PoolJoinRequest,
  PoolLeaveRequest,
  PoolInviteRequest,
  PoolListRequest,
  PoolMembersRequest,
  PoolStatusRequest,
  MessageSendRequest,
  MessagePollRequest,
  MessageReadRequest,
  UnreadCountRequest,
  ProposeReleaseRequest,
  VoteReleaseRequest,
  ReleaseStatusRequest,
  SetBusyRequest,
  SetReadyRequest,
} from "./shared/types.ts";

// --- Directory setup ---

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

// --- SQLite setup ---

const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");
db.exec("PRAGMA foreign_keys = ON");

function transaction<T extends (...args: any[]) => any>(fn: T): T {
  return ((...args: any[]) => {
    db.exec("BEGIN");
    try {
      const result = fn(...args);
      db.exec("COMMIT");
      return result;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }) as T;
}

db.exec(`
CREATE TABLE IF NOT EXISTS peers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  secret        TEXT NOT NULL,
  pid           INTEGER NOT NULL,
  pid_start     TEXT NOT NULL,
  cwd           TEXT NOT NULL,
  git_root      TEXT,
  git_branch    TEXT,
  summary       TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active',
  registered_at TEXT NOT NULL,
  last_seen     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pools (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  purpose       TEXT NOT NULL DEFAULT '',
  metadata      TEXT DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'active',
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pool_members (
  pool_id       TEXT NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  peer_id       TEXT NOT NULL REFERENCES peers(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'member',
  status        TEXT NOT NULL DEFAULT 'active',
  joined_at     TEXT NOT NULL,
  left_at       TEXT,
  PRIMARY KEY (pool_id, peer_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id       TEXT REFERENCES pools(id) ON DELETE CASCADE,
  from_id       TEXT NOT NULL,
  body          TEXT NOT NULL,
  msg_type      TEXT NOT NULL DEFAULT 'chat',
  seq           INTEGER NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS message_recipients (
  message_id    INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  peer_id       TEXT NOT NULL REFERENCES peers(id) ON DELETE CASCADE,
  read_at       TEXT,
  PRIMARY KEY (message_id, peer_id)
);

CREATE INDEX IF NOT EXISTS idx_recipients_unread ON message_recipients(peer_id, read_at)
  WHERE read_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pool_members_active ON pool_members(peer_id, status)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_peers_status ON peers(status)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_pool_members_pool ON pool_members(pool_id, status)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_messages_pool_seq ON messages(pool_id, seq);

CREATE TABLE IF NOT EXISTS services (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL,
  url           TEXT,
  status        TEXT NOT NULL DEFAULT 'unknown',
  metadata      TEXT DEFAULT '{}',
  registered_by TEXT,
  registered_at TEXT NOT NULL,
  last_health   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pool_releases (
  id              TEXT PRIMARY KEY,
  pool_id         TEXT NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  target_peer_id  TEXT NOT NULL REFERENCES peers(id) ON DELETE CASCADE,
  proposed_by     TEXT NOT NULL REFERENCES peers(id) ON DELETE CASCADE,
  reason          TEXT NOT NULL DEFAULT '',
  quorum_rule     TEXT NOT NULL DEFAULT 'unanimous',
  quorum_needed   INTEGER NOT NULL DEFAULT 0,
  eligible_voters TEXT NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'open',
  created_at      TEXT NOT NULL,
  resolved_at     TEXT
);

CREATE TABLE IF NOT EXISTS release_votes (
  release_id      TEXT NOT NULL REFERENCES pool_releases(id) ON DELETE CASCADE,
  voter_peer_id   TEXT NOT NULL REFERENCES peers(id) ON DELETE CASCADE,
  vote            TEXT NOT NULL,
  cast_at         TEXT NOT NULL,
  PRIMARY KEY (release_id, voter_peer_id)
);

CREATE INDEX IF NOT EXISTS idx_releases_pool_status ON pool_releases(pool_id, status)
  WHERE status = 'open';
`);

// Schema migrations for existing DBs
try { db.exec("ALTER TABLE pool_members ADD COLUMN busy_until TEXT"); } catch {}
try { db.exec("ALTER TABLE pool_members ADD COLUMN busy_reason TEXT NOT NULL DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE pool_releases ADD COLUMN quorum_needed INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE pool_releases ADD COLUMN eligible_voters TEXT NOT NULL DEFAULT '[]'"); } catch {}

db.exec(`
CREATE TABLE IF NOT EXISTS pool_throttles (
  pool_id        TEXT PRIMARY KEY REFERENCES pools(id) ON DELETE CASCADE,
  set_by_peer_id TEXT NOT NULL REFERENCES peers(id) ON DELETE CASCADE,
  idle_until     TEXT NOT NULL,
  reason         TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL
)
`);

// --- Helpers ---

function genId(len: number): string {
  return randomBytes(len).toString("hex").slice(0, len);
}

function genSecret(): string {
  return randomBytes(PEER_SECRET_LENGTH).toString("hex").slice(0, PEER_SECRET_LENGTH);
}

function now(): string {
  return new Date().toISOString();
}

function ok<T>(data: T): BrokerResponse<T> {
  return { ok: true, data };
}

function err(msg: string): BrokerResponse {
  return { ok: false, error: msg };
}

function requireSecret(peerId: string, secret: string): string | null {
  const row = db.prepare("SELECT secret FROM peers WHERE id = ?").get(peerId) as { secret: string } | null;
  if (!row) return "peer not found";
  if (row.secret !== secret) return "invalid peer_secret";
  return null;
}

function pidIsAlive(pid: number, pidStart: string): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getNextSeq(poolId: string | null): number {
  const key = poolId ?? "__dm__";
  const row = db.prepare(
    "SELECT MAX(seq) as max_seq FROM messages WHERE pool_id IS ?"
  ).get(poolId) as { max_seq: number | null } | null;
  return (row?.max_seq ?? 0) + 1;
}

function getPoolByName(name: string): { id: string; name: string; purpose: string; status: string; created_by: string; created_at: string } | null {
  return db.prepare("SELECT * FROM pools WHERE name = ?").get(name) as any;
}

function insertSystemMessage(poolId: string, body: string, targetPeerId?: string, excludePeerId?: string): void {
  insertSystemMessageTyped(poolId, "system", body, targetPeerId, excludePeerId);
}

function insertSystemMessageTyped(poolId: string, msgType: string, body: string, targetPeerId?: string, excludePeerId?: string): void {
  const seq = getNextSeq(poolId);
  const ts = now();
  const result = db.prepare(
    "INSERT INTO messages (pool_id, from_id, body, msg_type, seq, created_at) VALUES (?, 'system', ?, ?, ?, ?)"
  ).run(poolId, body, msgType, seq, ts);
  const msgId = Number(result.lastInsertRowid);

  if (targetPeerId) {
    db.prepare(
      "INSERT INTO message_recipients (message_id, peer_id) VALUES (?, ?)"
    ).run(msgId, targetPeerId);
  } else {
    const members = db.prepare(
      "SELECT peer_id FROM pool_members WHERE pool_id = ? AND status = 'active'"
    ).all(poolId) as { peer_id: string }[];

    for (const m of members) {
      if (m.peer_id !== excludePeerId) {
        db.prepare(
          "INSERT INTO message_recipients (message_id, peer_id) VALUES (?, ?)"
        ).run(msgId, m.peer_id);
      }
    }
  }
}

function archivePoolIfEmpty(poolId: string): void {
  const count = db.prepare(
    "SELECT COUNT(*) as cnt FROM pool_members WHERE pool_id = ? AND status = 'active'"
  ).get(poolId) as { cnt: number };
  if (count.cnt === 0) {
    db.prepare("UPDATE pools SET status = 'archived' WHERE id = ?").run(poolId);
  }
}

// --- Pool throttle helpers ---

function clearPoolThrottleWithNotify(poolId: string, reason: string): void {
  const deleted = db.prepare("DELETE FROM pool_throttles WHERE pool_id = ?").run(poolId);
  if (deleted.changes > 0) {
    insertSystemMessageTyped(poolId, "pool_active", `Pool throttle cleared: ${reason}. Resume normal polling.`);
  }
}

// --- Endpoint handlers ---

function handleHealth(): BrokerResponse {
  const peers = db.prepare("SELECT COUNT(*) as cnt FROM peers WHERE status = 'active'").get() as { cnt: number };
  const pools = db.prepare("SELECT COUNT(*) as cnt FROM pools WHERE status = 'active'").get() as { cnt: number };
  return ok({ status: "ok", peers: peers.cnt, pools: pools.cnt });
}

function handleRegister(body: RegisterRequest): BrokerResponse {
  const { pid, pid_start, cwd, name, git_root, git_branch } = body;

  if (!pid || !pid_start || !cwd) {
    return err("pid, pid_start, and cwd are required");
  }

  const id = genId(PEER_ID_LENGTH);
  const secret = genSecret();
  const peerName = name || `peer-${id}`;
  const ts = now();

  db.prepare(
    `INSERT INTO peers (id, name, secret, pid, pid_start, cwd, git_root, git_branch, summary, status, registered_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', 'active', ?, ?)`
  ).run(id, peerName, secret, pid, pid_start, cwd, git_root ?? null, git_branch ?? null, ts, ts);

  return ok({ id, secret, name: peerName });
}

function handleHeartbeat(body: HeartbeatRequest): BrokerResponse {
  const authErr = requireSecret(body.peer_id, body.peer_secret);
  if (authErr) return err(authErr);

  db.prepare("UPDATE peers SET last_seen = ? WHERE id = ?").run(now(), body.peer_id);
  return ok({ acknowledged: true });
}

function handleUnregister(body: UnregisterRequest): BrokerResponse {
  const authErr = requireSecret(body.peer_id, body.peer_secret);
  if (authErr) return err(authErr);

  markPeerDead(body.peer_id);
  return ok({ unregistered: true });
}

function cancelOpenProposalsForPeer(peerId: string): void {
  const openProposals = db.prepare(
    "SELECT id, pool_id FROM pool_releases WHERE target_peer_id = ? AND status = 'open'"
  ).all(peerId) as { id: string; pool_id: string }[];
  for (const r of openProposals) {
    db.prepare("UPDATE pool_releases SET status = 'expired', resolved_at = ? WHERE id = ?").run(now(), r.id);
    const peer = db.prepare("SELECT name FROM peers WHERE id = ?").get(peerId) as { name: string } | null;
    insertSystemMessage(r.pool_id, `Release proposal for ${peer?.name ?? peerId} cancelled (peer left/disconnected).`);
  }
}

const markPeerDeadTx = transaction((peerId: string) => {
  db.prepare("UPDATE peers SET status = 'dead' WHERE id = ?").run(peerId);

  const peer = db.prepare("SELECT name, cwd FROM peers WHERE id = ?").get(peerId) as { name: string; cwd: string } | null;
  const poolMemberships = db.prepare(
    "SELECT pool_id FROM pool_members WHERE peer_id = ? AND status = 'active'"
  ).all(peerId) as { pool_id: string }[];

  cancelOpenProposalsForPeer(peerId);

  for (const { pool_id } of poolMemberships) {
    db.prepare(
      "UPDATE pool_members SET status = 'left', left_at = ? WHERE pool_id = ? AND peer_id = ?"
    ).run(now(), pool_id, peerId);
    insertSystemMessage(pool_id, `Peer ${peer?.name ?? peerId} (${peer?.cwd ?? "unknown"}) disconnected.`);
    db.prepare("DELETE FROM pool_throttles WHERE pool_id = ? AND set_by_peer_id = ?").run(pool_id, peerId);
    archivePoolIfEmpty(pool_id);
  }
});

function markPeerDead(peerId: string): void {
  markPeerDeadTx(peerId);
}

function handleSetSummary(body: SetSummaryRequest): BrokerResponse {
  const authErr = requireSecret(body.peer_id, body.peer_secret);
  if (authErr) return err(authErr);

  db.prepare("UPDATE peers SET summary = ? WHERE id = ?").run(body.summary, body.peer_id);
  return ok({ updated: true });
}

function handleListPeers(_body: any): BrokerResponse {
  const peers = db.prepare(
    "SELECT id, name, pid, cwd, git_root, git_branch, summary, status, registered_at, last_seen FROM peers WHERE status = 'active'"
  ).all() as any[];

  const allMemberships = db.prepare(
    `SELECT pm.peer_id, pm.pool_id, po.name as pool_name, pm.role
     FROM pool_members pm JOIN pools po ON pm.pool_id = po.id
     WHERE pm.status = 'active' AND po.status = 'active'`
  ).all() as { peer_id: string; pool_id: string; pool_name: string; role: string }[];

  const poolsByPeer = new Map<string, typeof allMemberships>();
  for (const m of allMemberships) {
    const arr = poolsByPeer.get(m.peer_id) ?? [];
    arr.push(m);
    poolsByPeer.set(m.peer_id, arr);
  }

  const result = peers.map((p) => ({
    ...p,
    pools: (poolsByPeer.get(p.id) ?? []).map(({ pool_id, pool_name, role }) => ({ pool_id, pool_name, role })),
  }));

  return ok(result);
}

// --- Pool handlers ---

const poolCreateTx = transaction((poolId: string, body: PoolCreateRequest, existing: any) => {
  const ts = now();

  if (existing && existing.status === "archived") {
    db.prepare("UPDATE pools SET status = 'active', purpose = ? WHERE id = ?").run(body.purpose ?? "", existing.id);
    const prior = db.prepare(
      "SELECT peer_id FROM pool_members WHERE pool_id = ? AND peer_id = ?"
    ).get(existing.id, body.peer_id);
    if (prior) {
      db.prepare(
        "UPDATE pool_members SET status = 'active', joined_at = ?, left_at = NULL WHERE pool_id = ? AND peer_id = ?"
      ).run(ts, existing.id, body.peer_id);
    } else {
      db.prepare(
        "INSERT INTO pool_members (pool_id, peer_id, role, status, joined_at) VALUES (?, ?, 'member', 'active', ?)"
      ).run(existing.id, body.peer_id, ts);
    }
    insertSystemMessage(existing.id, `Pool reactivated by ${body.peer_id}.`);
    return existing.id;
  }

  db.prepare(
    "INSERT INTO pools (id, name, purpose, status, created_by, created_at) VALUES (?, ?, ?, 'active', ?, ?)"
  ).run(poolId, body.name, body.purpose ?? "", body.peer_id, ts);

  db.prepare(
    "INSERT INTO pool_members (pool_id, peer_id, role, status, joined_at) VALUES (?, ?, 'creator', 'active', ?)"
  ).run(poolId, body.peer_id, ts);

  return poolId;
});

function handlePoolCreate(body: PoolCreateRequest): BrokerResponse {
  const authErr = requireSecret(body.peer_id, body.peer_secret);
  if (authErr) return err(authErr);

  if (!body.name) return err("pool name is required");

  const existing = getPoolByName(body.name);
  if (existing && existing.status === "active") {
    return err("pool with this name already exists");
  }

  const poolId = genId(PEER_ID_LENGTH);
  const resultId = poolCreateTx(poolId, body, existing);
  return ok({ pool_id: resultId, name: body.name });
}

const poolJoinTx = transaction((pool: any, peerId: string) => {
  if (pool.status === "archived") {
    const prior = db.prepare(
      "SELECT peer_id FROM pool_members WHERE pool_id = ? AND peer_id = ?"
    ).get(pool.id, peerId);
    if (!prior) return "only prior members can rejoin an archived pool";
    db.prepare("UPDATE pools SET status = 'active' WHERE id = ?").run(pool.id);
    insertSystemMessage(pool.id, `Pool reactivated by rejoining peer.`);
  }

  const existing = db.prepare(
    "SELECT status FROM pool_members WHERE pool_id = ? AND peer_id = ?"
  ).get(pool.id, peerId) as { status: string } | null;

  if (existing?.status === "active") return "already a member";

  const ts = now();
  if (existing) {
    db.prepare(
      "UPDATE pool_members SET status = 'active', joined_at = ?, left_at = NULL WHERE pool_id = ? AND peer_id = ?"
    ).run(ts, pool.id, peerId);
  } else {
    db.prepare(
      "INSERT INTO pool_members (pool_id, peer_id, role, status, joined_at) VALUES (?, ?, 'member', 'active', ?)"
    ).run(pool.id, peerId, ts);
  }

  const peer = db.prepare("SELECT name FROM peers WHERE id = ?").get(peerId) as { name: string } | null;
  insertSystemMessage(pool.id, `${peer?.name ?? peerId} joined the pool.`, undefined, peerId);
  return null;
});

function handlePoolJoin(body: PoolJoinRequest): BrokerResponse {
  const authErr = requireSecret(body.peer_id, body.peer_secret);
  if (authErr) return err(authErr);

  const pool = getPoolByName(body.pool_name);
  if (!pool) return err("pool not found");

  const txErr = poolJoinTx(pool, body.peer_id);
  if (txErr) return err(txErr);

  return ok({ joined: true, pool_id: pool.id });
}

const poolLeaveTx = transaction((pool: any, peerId: string) => {
  const membership = db.prepare(
    "SELECT status FROM pool_members WHERE pool_id = ? AND peer_id = ?"
  ).get(pool.id, peerId) as { status: string } | null;

  if (!membership || membership.status !== "active") return "not a member of this pool";

  // Cancel any open release proposals targeting this peer
  const openProposals = db.prepare(
    "SELECT id FROM pool_releases WHERE pool_id = ? AND target_peer_id = ? AND status = 'open'"
  ).all(pool.id, peerId) as { id: string }[];
  for (const r of openProposals) {
    db.prepare("UPDATE pool_releases SET status = 'expired', resolved_at = ? WHERE id = ?").run(now(), r.id);
  }

  db.prepare(
    "UPDATE pool_members SET status = 'left', left_at = ? WHERE pool_id = ? AND peer_id = ?"
  ).run(now(), pool.id, peerId);

  const peer = db.prepare("SELECT name FROM peers WHERE id = ?").get(peerId) as { name: string } | null;
  insertSystemMessage(pool.id, `${peer?.name ?? peerId} left the pool.`);
  db.prepare("DELETE FROM pool_throttles WHERE pool_id = ? AND set_by_peer_id = ?").run(pool.id, peerId);
  archivePoolIfEmpty(pool.id);
  return null;
});

function handlePoolLeave(body: PoolLeaveRequest): BrokerResponse {
  const authErr = requireSecret(body.peer_id, body.peer_secret);
  if (authErr) return err(authErr);

  const pool = getPoolByName(body.pool_name);
  if (!pool) return err("pool not found");

  const txErr = poolLeaveTx(pool, body.peer_id);
  if (txErr) return err(txErr);

  return ok({ left: true });
}

const poolInviteTx = transaction((pool: any, body: PoolInviteRequest, target: { id: string; name: string }) => {
  const existing = db.prepare(
    "SELECT status FROM pool_members WHERE pool_id = ? AND peer_id = ?"
  ).get(pool.id, body.target_peer_id) as { status: string } | null;

  if (existing?.status === "active") return "target is already a member";

  const ts = now();
  if (existing) {
    db.prepare(
      "UPDATE pool_members SET status = 'active', joined_at = ?, left_at = NULL, role = 'member' WHERE pool_id = ? AND peer_id = ?"
    ).run(ts, pool.id, body.target_peer_id);
  } else {
    db.prepare(
      "INSERT INTO pool_members (pool_id, peer_id, role, status, joined_at) VALUES (?, ?, 'member', 'active', ?)"
    ).run(pool.id, body.target_peer_id, ts);
  }

  const inviter = db.prepare("SELECT name FROM peers WHERE id = ?").get(body.peer_id) as { name: string } | null;
  insertSystemMessageTyped(pool.id, "pool_invite", `You were added to pool ${pool.name} by ${inviter?.name ?? body.peer_id}.`, body.target_peer_id);
  insertSystemMessage(pool.id, `${target.name} joined the pool.`, undefined, body.target_peer_id);
  return null;
});

function handlePoolInvite(body: PoolInviteRequest): BrokerResponse {
  const authErr = requireSecret(body.peer_id, body.peer_secret);
  if (authErr) return err(authErr);

  const pool = getPoolByName(body.pool_name);
  if (!pool || pool.status !== "active") return err("pool not found or not active");

  const target = db.prepare("SELECT id, name FROM peers WHERE id = ? AND status = 'active'").get(body.target_peer_id) as { id: string; name: string } | null;
  if (!target) return err("target peer not found or not active");

  const txErr = poolInviteTx(pool, body, target);
  if (txErr) return err(txErr);

  return ok({ invited: true, pool_id: pool.id });
}

function handlePoolList(body: PoolListRequest): BrokerResponse {
  let pools: any[];

  if (body.peer_id) {
    pools = db.prepare(
      `SELECT DISTINCT p.* FROM pools p
       JOIN pool_members pm ON p.id = pm.pool_id
       WHERE pm.peer_id = ? AND pm.status = 'active' AND p.status = 'active'`
    ).all(body.peer_id) as any[];
  } else {
    pools = db.prepare("SELECT * FROM pools WHERE status = 'active'").all() as any[];
  }

  const poolIds = pools.map((p) => p.id);
  if (poolIds.length === 0) return ok([]);

  const placeholders = poolIds.map(() => "?").join(",");
  const allMembers = db.prepare(
    `SELECT pm.pool_id, pm.peer_id, pe.name as peer_name, pm.role, pm.status
     FROM pool_members pm JOIN peers pe ON pm.peer_id = pe.id
     WHERE pm.pool_id IN (${placeholders}) AND pm.status = 'active'`
  ).all(...poolIds) as any[];

  const membersByPool = new Map<string, any[]>();
  for (const m of allMembers) {
    const arr = membersByPool.get(m.pool_id) ?? [];
    arr.push(m);
    membersByPool.set(m.pool_id, arr);
  }

  const result = pools.map((p) => ({ ...p, members: membersByPool.get(p.id) ?? [] }));
  return ok(result);
}

function handlePoolMembers(body: PoolMembersRequest): BrokerResponse {
  const pool = getPoolByName(body.pool_name);
  if (!pool) return err("pool not found");

  const members = db.prepare(
    `SELECT pm.peer_id, pe.name as peer_name, pm.role, pm.status, pm.joined_at, pm.left_at
     FROM pool_members pm JOIN peers pe ON pm.peer_id = pe.id
     WHERE pm.pool_id = ?`
  ).all(pool.id) as any[];

  return ok(members);
}

function handlePoolStatus(body: PoolStatusRequest): BrokerResponse {
  const pool = getPoolByName(body.pool_name);
  if (!pool) return err("pool not found");

  const members = db.prepare(
    `SELECT pm.peer_id, pe.name as peer_name, pm.role, pm.status
     FROM pool_members pm JOIN peers pe ON pm.peer_id = pe.id
     WHERE pm.pool_id = ? AND pm.status = 'active'`
  ).all(pool.id) as any[];

  const msgCount = db.prepare(
    "SELECT COUNT(*) as cnt FROM messages WHERE pool_id = ? AND datetime(created_at) > datetime('now', '-1 hour')"
  ).get(pool.id) as { cnt: number };

  return ok({
    ...pool,
    members,
    recent_message_count: msgCount.cnt,
  });
}

// --- Message handlers ---

const messageSendPoolTx = transaction((poolId: string, fromId: string, body: string, msgType: string, targetPeerId?: string) => {
  const ts = now();
  const seq = getNextSeq(poolId);
  const result = db.prepare(
    "INSERT INTO messages (pool_id, from_id, body, msg_type, seq, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(poolId, fromId, body, msgType, seq, ts);
  const msgId = Number(result.lastInsertRowid);

  let recipientCount: number;
  const staleRecipients: { peer_id: string; peer_name: string; last_seen: string; age_seconds: number }[] = [];
  const staleThresholdMs = HEARTBEAT_INTERVAL_MS * 2;

  if (targetPeerId) {
    const targetPeer = db.prepare("SELECT name, last_seen, status FROM peers WHERE id = ?").get(targetPeerId) as
      { name: string; last_seen: string; status: string } | null;
    if (targetPeer && (targetPeer.status === "dead" || Date.now() - new Date(targetPeer.last_seen).getTime() > staleThresholdMs)) {
      staleRecipients.push({
        peer_id: targetPeerId,
        peer_name: targetPeer.name,
        last_seen: targetPeer.last_seen,
        age_seconds: Math.round((Date.now() - new Date(targetPeer.last_seen).getTime()) / 1000),
      });
    }
    db.prepare("INSERT INTO message_recipients (message_id, peer_id) VALUES (?, ?)").run(msgId, targetPeerId);
    recipientCount = 1;
  } else {
    const members = db.prepare(
      `SELECT pm.peer_id, p.name, p.last_seen, p.status
       FROM pool_members pm JOIN peers p ON pm.peer_id = p.id
       WHERE pm.pool_id = ? AND pm.status = 'active' AND pm.peer_id != ?`
    ).all(poolId, fromId) as { peer_id: string; name: string; last_seen: string; status: string }[];
    let liveCount = 0;
    for (const m of members) {
      const age = Date.now() - new Date(m.last_seen).getTime();
      if (m.status === "dead" || age > staleThresholdMs) {
        staleRecipients.push({
          peer_id: m.peer_id,
          peer_name: m.name,
          last_seen: m.last_seen,
          age_seconds: Math.round(age / 1000),
        });
      } else {
        liveCount++;
      }
      db.prepare("INSERT INTO message_recipients (message_id, peer_id) VALUES (?, ?)").run(msgId, m.peer_id);
    }
    recipientCount = members.length;
  }

  // Auto-clear pool throttle if a non-setter sends a chat message
  if (msgType === "chat") {
    const throttle = db.prepare(
      "SELECT set_by_peer_id FROM pool_throttles WHERE pool_id = ? AND datetime(idle_until) > datetime('now')"
    ).get(poolId) as { set_by_peer_id: string } | null;
    if (throttle && fromId !== throttle.set_by_peer_id && fromId !== "system" && fromId !== "cli") {
      db.prepare("DELETE FROM pool_throttles WHERE pool_id = ?").run(poolId);
      const senderPeer = db.prepare("SELECT name FROM peers WHERE id = ?").get(fromId) as { name: string } | null;
      // Inline system message (we're already inside a transaction)
      const clearSeq = getNextSeq(poolId);
      const clearResult = db.prepare(
        "INSERT INTO messages (pool_id, from_id, body, msg_type, seq, created_at) VALUES (?, 'system', ?, 'pool_active', ?, ?)"
      ).run(poolId, `Pool throttle auto-cleared: ${senderPeer?.name ?? fromId} sent a message. Resume normal polling.`, clearSeq, ts);
      const clearMsgId = Number(clearResult.lastInsertRowid);
      const clearMembers = db.prepare(
        "SELECT peer_id FROM pool_members WHERE pool_id = ? AND status = 'active'"
      ).all(poolId) as { peer_id: string }[];
      for (const cm of clearMembers) {
        db.prepare("INSERT INTO message_recipients (message_id, peer_id) VALUES (?, ?)").run(clearMsgId, cm.peer_id);
      }
    }
  }

  return {
    message_id: msgId,
    seq,
    recipient_count: recipientCount,
    stale_recipients: staleRecipients.length > 0 ? staleRecipients : undefined,
  };
});

const messageSendDmTx = transaction((fromId: string, toPeerId: string, body: string) => {
  const ts = now();
  const seq = getNextSeq(null);
  const result = db.prepare(
    "INSERT INTO messages (pool_id, from_id, body, msg_type, seq, created_at) VALUES (NULL, ?, ?, 'chat', ?, ?)"
  ).run(fromId, body, seq, ts);
  const msgId = Number(result.lastInsertRowid);
  db.prepare("INSERT INTO message_recipients (message_id, peer_id) VALUES (?, ?)").run(msgId, toPeerId);

  const targetPeer = db.prepare("SELECT name, last_seen, status FROM peers WHERE id = ?").get(toPeerId) as
    { name: string; last_seen: string; status: string } | null;
  const staleThresholdMs = HEARTBEAT_INTERVAL_MS * 2;
  let staleRecipients: { peer_id: string; peer_name: string; last_seen: string; age_seconds: number }[] | undefined;
  if (targetPeer && (targetPeer.status === "dead" || Date.now() - new Date(targetPeer.last_seen).getTime() > staleThresholdMs)) {
    staleRecipients = [{
      peer_id: toPeerId,
      peer_name: targetPeer.name,
      last_seen: targetPeer.last_seen,
      age_seconds: Math.round((Date.now() - new Date(targetPeer.last_seen).getTime()) / 1000),
    }];
  }

  return { message_id: msgId, seq, recipient_count: 1, stale_recipients: staleRecipients };
});

function handleMessageSend(body: MessageSendRequest): BrokerResponse {
  const fromId = body.peer_id;
  if (fromId !== "cli") {
    const authErr = requireSecret(fromId, body.peer_secret);
    if (authErr) return err(authErr);
  }

  if (!body.body) return err("message body is required");
  if (!body.pool_name && !body.to_peer_id) return err("pool_name or to_peer_id is required");

  if (body.pool_name) {
    const pool = getPoolByName(body.pool_name);
    if (!pool || pool.status !== "active") return err("pool not found or not active");

    if (fromId !== "cli") {
      const membership = db.prepare(
        "SELECT status FROM pool_members WHERE pool_id = ? AND peer_id = ? AND status = 'active'"
      ).get(pool.id, fromId) as { status: string } | null;
      if (!membership) return err("not a member of this pool");
    }

    const msgType = body.msg_type ?? "chat";
    const result = messageSendPoolTx(pool.id, fromId, body.body, msgType, body.to_peer_id);
    return ok(result);
  }

  const target = db.prepare("SELECT id FROM peers WHERE id = ? AND status = 'active'").get(body.to_peer_id!) as { id: string } | null;
  if (!target) return err("target peer not found or not active");

  const result = messageSendDmTx(fromId, body.to_peer_id!, body.body);
  return ok(result);
}

function handleMessagePoll(body: MessagePollRequest): BrokerResponse {
  if (!body.peer_id) return err("peer_id is required");

  const messages = db.prepare(
    `SELECT m.id as message_id, m.pool_id, po.name as pool_name,
            m.from_id, pe.name as from_name, pe.cwd as from_cwd,
            pe.git_branch as from_branch, pe.summary as from_summary,
            m.body, m.msg_type, m.seq, m.created_at
     FROM message_recipients mr
     JOIN messages m ON mr.message_id = m.id
     LEFT JOIN peers pe ON m.from_id = pe.id
     LEFT JOIN pools po ON m.pool_id = po.id
     WHERE mr.peer_id = ? AND mr.read_at IS NULL
     ORDER BY m.seq ASC`
  ).all(body.peer_id) as any[];

  return ok(messages);
}

const messageReadTx = transaction((peerId: string, messageIds: number[]) => {
  const ts = now();
  const stmt = db.prepare(
    "UPDATE message_recipients SET read_at = ? WHERE message_id = ? AND peer_id = ? AND read_at IS NULL"
  );
  let marked = 0;
  for (const msgId of messageIds) {
    const result = stmt.run(ts, msgId, peerId);
    marked += Number(result.changes);
  }
  return marked;
});

function handleMessageRead(body: MessageReadRequest): BrokerResponse {
  const authErr = requireSecret(body.peer_id, body.peer_secret);
  if (authErr) return err(authErr);

  if (!body.message_ids || !Array.isArray(body.message_ids) || body.message_ids.length === 0) {
    return err("message_ids array is required");
  }

  const marked = messageReadTx(body.peer_id, body.message_ids);
  return ok({ marked_read: marked });
}

const messageCheckTx = transaction((peerId: string) => {
  const messages = db.prepare(
    `SELECT m.id as message_id, m.pool_id, po.name as pool_name,
            m.from_id, pe.name as from_name, pe.cwd as from_cwd,
            pe.git_branch as from_branch, pe.summary as from_summary,
            m.body, m.msg_type, m.seq, m.created_at
     FROM message_recipients mr
     JOIN messages m ON mr.message_id = m.id
     LEFT JOIN peers pe ON m.from_id = pe.id
     LEFT JOIN pools po ON m.pool_id = po.id
     WHERE mr.peer_id = ? AND mr.read_at IS NULL
     ORDER BY m.seq ASC`
  ).all(peerId) as any[];

  if (messages.length > 0) {
    const ts = now();
    const stmt = db.prepare(
      "UPDATE message_recipients SET read_at = ? WHERE message_id = ? AND peer_id = ? AND read_at IS NULL"
    );
    for (const m of messages) {
      stmt.run(ts, m.message_id, peerId);
    }
  }

  const remaining = db.prepare(
    `SELECT m.pool_id, po.name as pool_name, COUNT(*) as count
     FROM message_recipients mr
     JOIN messages m ON mr.message_id = m.id
     LEFT JOIN pools po ON m.pool_id = po.id
     WHERE mr.peer_id = ? AND mr.read_at IS NULL
     GROUP BY m.pool_id`
  ).all(peerId) as { pool_id: string | null; pool_name: string | null; count: number }[];
  const remainingTotal = remaining.reduce((sum, r) => sum + r.count, 0);

  const myPools = db.prepare(
    "SELECT pool_id FROM pool_members WHERE peer_id = ? AND status = 'active'"
  ).all(peerId) as { pool_id: string }[];
  const poolThrottles: any[] = [];
  for (const { pool_id } of myPools) {
    const throttle = db.prepare(
      `SELECT pt.pool_id, po.name as pool_name, pt.set_by_peer_id, pe.name as set_by_peer_name, pt.idle_until, pt.reason
       FROM pool_throttles pt
       JOIN pools po ON pt.pool_id = po.id
       JOIN peers pe ON pt.set_by_peer_id = pe.id
       WHERE pt.pool_id = ? AND datetime(pt.idle_until) > datetime('now')`
    ).get(pool_id) as any;
    if (throttle) poolThrottles.push(throttle);
  }

  return { messages, unread: { total: remainingTotal, by_pool: remaining }, busy_peers: [], pool_throttles: poolThrottles };
});

function handleMessageCheck(body: { peer_id: string; peer_secret: string }): BrokerResponse {
  const authErr = requireSecret(body.peer_id, body.peer_secret);
  if (authErr) return err(authErr);

  const result = messageCheckTx(body.peer_id);
  return ok(result);
}

// Read-only version of /message/check — returns unread messages + metadata
// without marking anything as read. Used by server.ts for deferred ack.
const messagePeekTx = transaction((peerId: string) => {
  const messages = db.prepare(
    `SELECT m.id as message_id, m.pool_id, po.name as pool_name,
            m.from_id, pe.name as from_name, pe.cwd as from_cwd,
            pe.git_branch as from_branch, pe.summary as from_summary,
            m.body, m.msg_type, m.seq, m.created_at
     FROM message_recipients mr
     JOIN messages m ON mr.message_id = m.id
     LEFT JOIN peers pe ON m.from_id = pe.id
     LEFT JOIN pools po ON m.pool_id = po.id
     WHERE mr.peer_id = ? AND mr.read_at IS NULL
     ORDER BY m.seq ASC`
  ).all(peerId) as any[];

  const unreadByPool = db.prepare(
    `SELECT m.pool_id, po.name as pool_name, COUNT(*) as count
     FROM message_recipients mr
     JOIN messages m ON mr.message_id = m.id
     LEFT JOIN pools po ON m.pool_id = po.id
     WHERE mr.peer_id = ? AND mr.read_at IS NULL
     GROUP BY m.pool_id`
  ).all(peerId) as { pool_id: string | null; pool_name: string | null; count: number }[];
  const unreadTotal = unreadByPool.reduce((sum, r) => sum + r.count, 0);

  const myPools = db.prepare(
    "SELECT pool_id FROM pool_members WHERE peer_id = ? AND status = 'active'"
  ).all(peerId) as { pool_id: string }[];
  const poolThrottles: any[] = [];
  for (const { pool_id } of myPools) {
    const throttle = db.prepare(
      `SELECT pt.pool_id, po.name as pool_name, pt.set_by_peer_id, pe.name as set_by_peer_name, pt.idle_until, pt.reason
       FROM pool_throttles pt
       JOIN pools po ON pt.pool_id = po.id
       JOIN peers pe ON pt.set_by_peer_id = pe.id
       WHERE pt.pool_id = ? AND datetime(pt.idle_until) > datetime('now')`
    ).get(pool_id) as any;
    if (throttle) poolThrottles.push(throttle);
  }

  return { messages, unread: { total: unreadTotal, by_pool: unreadByPool }, busy_peers: [], pool_throttles: poolThrottles };
});

function handleMessagePeek(body: { peer_id: string; peer_secret: string }): BrokerResponse {
  const authErr = requireSecret(body.peer_id, body.peer_secret);
  if (authErr) return err(authErr);

  const result = messagePeekTx(body.peer_id);
  return ok(result);
}

function handleUnreadCount(body: UnreadCountRequest): BrokerResponse {
  if (!body.peer_id) return err("peer_id is required");

  const rows = db.prepare(
    `SELECT m.pool_id, po.name as pool_name, COUNT(*) as count
     FROM message_recipients mr
     JOIN messages m ON mr.message_id = m.id
     LEFT JOIN pools po ON m.pool_id = po.id
     WHERE mr.peer_id = ? AND mr.read_at IS NULL
       AND (m.pool_id IS NULL OR EXISTS (
         SELECT 1 FROM pool_members pm
         WHERE pm.pool_id = m.pool_id AND pm.peer_id = mr.peer_id AND pm.status = 'active'
       ))
     GROUP BY m.pool_id`
  ).all(body.peer_id) as { pool_id: string | null; pool_name: string | null; count: number }[];

  const total = rows.reduce((sum, r) => sum + r.count, 0);

  return ok({ total, by_pool: rows });
}

// --- CLI-specific handlers (no peer registration needed) ---

function handlePoolCreateCli(body: { name: string; purpose?: string }): BrokerResponse {
  if (!body.name) return err("pool name is required");

  const existing = getPoolByName(body.name);
  if (existing && existing.status === "active") {
    return err("pool with this name already exists");
  }

  const poolId = genId(PEER_ID_LENGTH);
  const ts = now();

  if (existing && existing.status === "archived") {
    db.prepare("UPDATE pools SET status = 'active', purpose = ? WHERE id = ?").run(body.purpose ?? "", existing.id);
    return ok({ pool_id: existing.id, name: body.name });
  }

  db.prepare(
    "INSERT INTO pools (id, name, purpose, status, created_by, created_at) VALUES (?, ?, ?, 'active', 'cli', ?)"
  ).run(poolId, body.name, body.purpose ?? "", ts);

  return ok({ pool_id: poolId, name: body.name });
}

function handlePoolInviteCli(body: { target_peer_id: string; pool_name: string }): BrokerResponse {
  const pool = getPoolByName(body.pool_name);
  if (!pool || pool.status !== "active") return err("pool not found or not active");

  const target = db.prepare("SELECT id, name FROM peers WHERE id = ? AND status = 'active'").get(body.target_peer_id) as { id: string; name: string } | null;
  if (!target) return err("target peer not found or not active");

  const existing = db.prepare(
    "SELECT status FROM pool_members WHERE pool_id = ? AND peer_id = ?"
  ).get(pool.id, body.target_peer_id) as { status: string } | null;

  if (existing?.status === "active") return err("target is already a member");

  const ts = now();
  if (existing) {
    db.prepare(
      "UPDATE pool_members SET status = 'active', joined_at = ?, left_at = NULL, role = 'member' WHERE pool_id = ? AND peer_id = ?"
    ).run(ts, pool.id, body.target_peer_id);
  } else {
    db.prepare(
      "INSERT INTO pool_members (pool_id, peer_id, role, status, joined_at) VALUES (?, ?, 'member', 'active', ?)"
    ).run(pool.id, body.target_peer_id, ts);
  }

  insertSystemMessageTyped(pool.id, "pool_invite", `You were added to pool ${pool.name} by CLI.`, body.target_peer_id);
  insertSystemMessage(pool.id, `${target.name} joined the pool.`, undefined, body.target_peer_id);

  return ok({ invited: true, pool_id: pool.id });
}

function handleMessageSendCli(body: { pool_name?: string; to_peer_id?: string; body: string }): BrokerResponse {
  if (!body.body) return err("message body is required");
  if (!body.pool_name && !body.to_peer_id) return err("pool_name or to_peer_id is required");

  if (body.pool_name) {
    const pool = getPoolByName(body.pool_name);
    if (!pool || pool.status !== "active") return err("pool not found or not active");

    const members = db.prepare(
      "SELECT peer_id FROM pool_members WHERE pool_id = ? AND status = 'active'"
    ).all(pool.id) as { peer_id: string }[];

    const ts = now();
    const seq = getNextSeq(pool.id);
    const result = db.prepare(
      "INSERT INTO messages (pool_id, from_id, body, msg_type, seq, created_at) VALUES (?, 'cli', ?, 'chat', ?, ?)"
    ).run(pool.id, body.body, seq, ts);
    const msgId = Number(result.lastInsertRowid);

    for (const m of members) {
      db.prepare("INSERT INTO message_recipients (message_id, peer_id) VALUES (?, ?)").run(msgId, m.peer_id);
    }

    return ok({ message_id: msgId, seq, recipient_count: members.length });
  }

  const target = db.prepare("SELECT id FROM peers WHERE id = ? AND status = 'active'").get(body.to_peer_id!) as { id: string } | null;
  if (!target) return err("target peer not found or not active");

  const seq = getNextSeq(null);
  const ts = now();
  const result = db.prepare(
    "INSERT INTO messages (pool_id, from_id, body, msg_type, seq, created_at) VALUES (NULL, 'cli', ?, 'chat', ?, ?)"
  ).run(body.body, seq, ts);
  const msgId = Number(result.lastInsertRowid);
  db.prepare("INSERT INTO message_recipients (message_id, peer_id) VALUES (?, ?)").run(msgId, body.to_peer_id!);

  return ok({ message_id: msgId, seq, recipient_count: 1 });
}

function handleMessageHistory(body: { pool_name?: string; limit?: number }): BrokerResponse {
  const lim = body.limit ?? 50;

  if (body.pool_name) {
    const pool = getPoolByName(body.pool_name);
    if (!pool) return err("pool not found");

    const messages = db.prepare(
      `SELECT m.id as message_id, m.pool_id, ? as pool_name,
              m.from_id, pe.name as from_name,
              m.body, m.msg_type, m.seq, m.created_at
       FROM messages m
       LEFT JOIN peers pe ON m.from_id = pe.id
       WHERE m.pool_id = ?
       ORDER BY m.seq DESC LIMIT ?`
    ).all(pool.name, pool.id, lim) as any[];

    return ok(messages.reverse());
  }

  const messages = db.prepare(
    `SELECT m.id as message_id, m.pool_id, po.name as pool_name,
            m.from_id, pe.name as from_name,
            m.body, m.msg_type, m.seq, m.created_at
     FROM messages m
     LEFT JOIN peers pe ON m.from_id = pe.id
     LEFT JOIN pools po ON m.pool_id = po.id
     ORDER BY m.id DESC LIMIT ?`
  ).all(lim) as any[];

  return ok(messages.reverse());
}

// --- Pool metadata ---

function handlePoolUpdateMetadata(body: { peer_id: string; peer_secret: string; pool_name: string; metadata: string }): BrokerResponse {
  const authErr = requireSecret(body.peer_id, body.peer_secret);
  if (authErr) return err(authErr);

  const pool = getPoolByName(body.pool_name);
  if (!pool || pool.status !== "active") return err("pool not found or not active");

  db.prepare("UPDATE pools SET metadata = ? WHERE id = ?").run(body.metadata ?? "{}", pool.id);
  return ok({ updated: true });
}

// --- Release consensus handlers ---

function getQuorumNeeded(memberCount: number, rule: string): number {
  if (rule === "unanimous") return memberCount;
  return Math.floor(memberCount / 2) + 1;
}

const proposeReleaseTx = transaction((releaseId: string, body: ProposeReleaseRequest, pool: any) => {
  const ts = now();
  const members = db.prepare(
    "SELECT peer_id FROM pool_members WHERE pool_id = ? AND status = 'active'"
  ).all(pool.id) as { peer_id: string }[];

  const isMember = members.some((m) => m.peer_id === body.peer_id);
  if (!isMember) return { error: "not a member of this pool" };

  const targetIsMember = members.some((m) => m.peer_id === body.target_peer_id);
  if (!targetIsMember) return { error: "target peer is not a member of this pool" };

  const existing = db.prepare(
    "SELECT id FROM pool_releases WHERE pool_id = ? AND target_peer_id = ? AND status = 'open'"
  ).get(pool.id, body.target_peer_id) as { id: string } | null;
  if (existing) return { error: "an open release proposal already exists for this peer" };

  const quorumRule = members.length <= 2 ? "unanimous" : "majority";
  const quorumNeeded = getQuorumNeeded(members.length, quorumRule);
  const eligibleVoters = JSON.stringify(members.map((m) => m.peer_id));

  db.prepare(
    `INSERT INTO pool_releases (id, pool_id, target_peer_id, proposed_by, reason, quorum_rule, quorum_needed, eligible_voters, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
  ).run(releaseId, pool.id, body.target_peer_id, body.peer_id, body.reason ?? "", quorumRule, quorumNeeded, eligibleVoters, ts);

  db.prepare(
    "INSERT INTO release_votes (release_id, voter_peer_id, vote, cast_at) VALUES (?, ?, 'yes', ?)"
  ).run(releaseId, body.peer_id, ts);

  const targetPeer = db.prepare("SELECT name FROM peers WHERE id = ?").get(body.target_peer_id) as { name: string } | null;
  const proposer = db.prepare("SELECT name FROM peers WHERE id = ?").get(body.peer_id) as { name: string } | null;
  const reason = body.reason ? ` Reason: ${body.reason}` : "";

  // Auto-resolve if quorum already met (e.g., 1-member pool)
  if (1 >= quorumNeeded) {
    db.prepare("UPDATE pool_releases SET status = 'approved', resolved_at = ? WHERE id = ?").run(ts, releaseId);
    insertSystemMessageTyped(
      pool.id,
      "release_approved",
      `Release approved for ${targetPeer?.name ?? body.target_peer_id}. You are free to leave the pool and stop your cron job.`,
      body.target_peer_id
    );
    return {
      data: {
        release_id: releaseId,
        quorum_rule: quorumRule,
        members_count: members.length,
        status: "approved",
      },
    };
  }

  insertSystemMessage(
    pool.id,
    `📋 Release proposal: ${proposer?.name ?? body.peer_id} proposes releasing ${targetPeer?.name ?? body.target_peer_id}.${reason} Vote with cct_vote_release (release_id: ${releaseId}). Quorum: ${quorumRule} (${quorumNeeded}/${members.length}).`
  );

  return {
    data: {
      release_id: releaseId,
      quorum_rule: quorumRule,
      members_count: members.length,
      status: "open",
    },
  };
});

function handleProposeRelease(body: ProposeReleaseRequest): BrokerResponse {
  const authErr = requireSecret(body.peer_id, body.peer_secret);
  if (authErr) return err(authErr);

  if (!body.pool_name || !body.target_peer_id) {
    return err("pool_name and target_peer_id are required");
  }

  const pool = getPoolByName(body.pool_name);
  if (!pool || pool.status !== "active") return err("pool not found or not active");

  const releaseId = genId(PEER_ID_LENGTH);
  const result = proposeReleaseTx(releaseId, body, pool);
  if ("error" in result) return err(result.error as string);
  return ok(result.data);
}

const voteReleaseTx = transaction((body: VoteReleaseRequest) => {
  const release = db.prepare(
    "SELECT * FROM pool_releases WHERE id = ?"
  ).get(body.release_id) as any;
  if (!release) return { error: "release proposal not found" };
  if (release.status !== "open") return { error: `proposal is already ${release.status}` };

  // Validate voter is in the frozen eligible voter set
  const eligibleVoters: string[] = JSON.parse(release.eligible_voters || "[]");
  if (eligibleVoters.length > 0 && !eligibleVoters.includes(body.peer_id)) {
    return { error: "not eligible to vote on this proposal" };
  }

  const existingVote = db.prepare(
    "SELECT vote FROM release_votes WHERE release_id = ? AND voter_peer_id = ?"
  ).get(body.release_id, body.peer_id) as { vote: string } | null;
  if (existingVote) return { error: "already voted on this proposal" };

  const ts = now();
  db.prepare(
    "INSERT INTO release_votes (release_id, voter_peer_id, vote, cast_at) VALUES (?, ?, ?, ?)"
  ).run(body.release_id, body.peer_id, body.vote, ts);

  const votes = db.prepare(
    "SELECT vote, COUNT(*) as cnt FROM release_votes WHERE release_id = ? GROUP BY vote"
  ).all(body.release_id) as { vote: string; cnt: number }[];

  const yesCount = votes.find((v) => v.vote === "yes")?.cnt ?? 0;
  const noCount = votes.find((v) => v.vote === "no")?.cnt ?? 0;

  // Use frozen quorum from proposal creation
  const quorumNeeded = release.quorum_needed;
  const totalEligible = eligibleVoters.length;

  let finalStatus = "open";

  if (yesCount >= quorumNeeded) {
    finalStatus = "approved";
    db.prepare("UPDATE pool_releases SET status = 'approved', resolved_at = ? WHERE id = ?").run(ts, body.release_id);

    const targetPeer = db.prepare("SELECT name FROM peers WHERE id = ?").get(release.target_peer_id) as { name: string } | null;
    insertSystemMessageTyped(
      release.pool_id,
      "release_approved",
      `Release approved for ${targetPeer?.name ?? release.target_peer_id}. You are free to leave the pool and stop your cron job.`,
      release.target_peer_id
    );
    insertSystemMessageTyped(
      release.pool_id,
      "release_notify",
      `Release approved: ${targetPeer?.name ?? release.target_peer_id} has been released from the pool.`,
      undefined,
      release.target_peer_id
    );
  } else if (noCount > totalEligible - quorumNeeded) {
    finalStatus = "rejected";
    db.prepare("UPDATE pool_releases SET status = 'rejected', resolved_at = ? WHERE id = ?").run(ts, body.release_id);

    const targetPeer = db.prepare("SELECT name FROM peers WHERE id = ?").get(release.target_peer_id) as { name: string } | null;
    insertSystemMessageTyped(
      release.pool_id,
      "release_rejected",
      `Release rejected for ${targetPeer?.name ?? release.target_peer_id}. Not enough votes to reach quorum.`
    );
  }

  return {
    data: {
      voted: true,
      status: finalStatus,
      yes_count: yesCount,
      no_count: noCount,
      quorum_needed: quorumNeeded,
    },
  };
});

function handleVoteRelease(body: VoteReleaseRequest): BrokerResponse {
  const authErr = requireSecret(body.peer_id, body.peer_secret);
  if (authErr) return err(authErr);

  if (!body.release_id || !body.vote) return err("release_id and vote are required");
  if (body.vote !== "yes" && body.vote !== "no") return err("vote must be 'yes' or 'no'");

  const result = voteReleaseTx(body);
  if ("error" in result) return err(result.error as string);
  return ok(result.data);
}

function handleReleaseStatus(body: ReleaseStatusRequest): BrokerResponse {
  const pool = getPoolByName(body.pool_name);
  if (!pool) return err("pool not found");

  const releases = db.prepare(
    `SELECT pr.*, pe_target.name as target_name, pe_proposer.name as proposer_name
     FROM pool_releases pr
     LEFT JOIN peers pe_target ON pr.target_peer_id = pe_target.id
     LEFT JOIN peers pe_proposer ON pr.proposed_by = pe_proposer.id
     WHERE pr.pool_id = ?
     ORDER BY pr.created_at DESC`
  ).all(pool.id) as any[];

  const proposals = releases.map((r: any) => {
    const votes = db.prepare(
      "SELECT vote, COUNT(*) as cnt FROM release_votes WHERE release_id = ? GROUP BY vote"
    ).all(r.id) as { vote: string; cnt: number }[];

    return {
      id: r.id,
      target_peer_name: r.target_name ?? r.target_peer_id,
      target_peer_id: r.target_peer_id,
      proposed_by_name: r.proposer_name ?? r.proposed_by,
      reason: r.reason,
      status: r.status,
      quorum_rule: r.quorum_rule,
      yes_count: votes.find((v) => v.vote === "yes")?.cnt ?? 0,
      no_count: votes.find((v) => v.vote === "no")?.cnt ?? 0,
      quorum_needed: r.quorum_needed,
      created_at: r.created_at,
    };
  });

  return ok({ proposals });
}

// --- Pool throttle handlers ---

const setPoolIdleTx = transaction((poolId: string, peerId: string, minutes: number, reason: string, force: boolean) => {
  const members = db.prepare(
    "SELECT peer_id FROM pool_members WHERE pool_id = ? AND status = 'active'"
  ).all(poolId) as { peer_id: string }[];

  const isMember = members.some((m) => m.peer_id === peerId);
  if (!isMember) return { error: "not a member of this pool" };

  const others = members.filter((m) => m.peer_id !== peerId);

  if (others.length > 1 && !force) {
    const recentSenders = db.prepare(
      `SELECT DISTINCT from_id FROM messages
       WHERE pool_id = ? AND from_id != ? AND from_id != 'system' AND from_id != 'cli'
         AND msg_type = 'chat'
         AND datetime(created_at) > datetime('now', '-5 minutes')`
    ).all(poolId, peerId) as { from_id: string }[];

    const unreadFromOthers = db.prepare(
      `SELECT COUNT(*) as cnt FROM message_recipients mr
       JOIN messages m ON mr.message_id = m.id
       WHERE m.pool_id = ? AND m.from_id != ? AND m.from_id != 'system' AND m.from_id != 'cli'
         AND m.msg_type = 'chat' AND mr.read_at IS NULL`
    ).get(poolId, peerId) as { cnt: number };

    if (recentSenders.length >= 2 || unreadFromOthers.cnt > 0) {
      const senderNames = recentSenders.map((s) => {
        const p = db.prepare("SELECT name FROM peers WHERE id = ?").get(s.from_id) as { name: string } | null;
        return p?.name ?? s.from_id;
      });
      return {
        data: {
          approved: false,
          activity: {
            recent_chat_count: recentSenders.length,
            recent_distinct_senders: senderNames,
            window_minutes: 5,
            unread_from_others: unreadFromOthers.cnt,
          },
        },
      };
    }
  }

  const idleUntil = new Date(Date.now() + Math.min(minutes, 120) * 60_000).toISOString();
  const ts = now();

  db.prepare(
    "INSERT OR REPLACE INTO pool_throttles (pool_id, set_by_peer_id, idle_until, reason, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(poolId, peerId, idleUntil, reason, ts);

  const peer = db.prepare("SELECT name FROM peers WHERE id = ?").get(peerId) as { name: string } | null;
  const reasonText = reason ? `: ${reason}` : "";
  insertSystemMessageTyped(
    poolId,
    "pool_idle",
    `${peer?.name ?? peerId} set pool idle (~${minutes} min)${reasonText}. Reduce polling to save tokens.`,
    undefined,
    peerId
  );

  return { data: { approved: true, idle_until: idleUntil, reason } };
});

function handleSetPoolIdle(body: { peer_id: string; peer_secret: string; pool_name: string; minutes: number; reason?: string; force?: boolean }): BrokerResponse {
  const authErr = requireSecret(body.peer_id, body.peer_secret);
  if (authErr) return err(authErr);

  if (!body.pool_name || !body.minutes) return err("pool_name and minutes are required");

  const pool = getPoolByName(body.pool_name);
  if (!pool || pool.status !== "active") return err("pool not found or not active");

  const result = setPoolIdleTx(pool.id, body.peer_id, body.minutes, body.reason ?? "", body.force ?? false);
  if ("error" in result) return err(result.error as string);
  return ok(result.data);
}

const clearPoolIdleTx = transaction((poolId: string, peerId: string) => {
  const throttle = db.prepare(
    "SELECT set_by_peer_id FROM pool_throttles WHERE pool_id = ?"
  ).get(poolId) as { set_by_peer_id: string } | null;

  if (!throttle) return "no active throttle on this pool";
  if (throttle.set_by_peer_id !== peerId) return "only the setter can clear the throttle";

  db.prepare("DELETE FROM pool_throttles WHERE pool_id = ?").run(poolId);

  const peer = db.prepare("SELECT name FROM peers WHERE id = ?").get(peerId) as { name: string } | null;
  insertSystemMessageTyped(
    poolId,
    "pool_active",
    `${peer?.name ?? peerId} cleared the pool throttle. Resume normal polling.`
  );

  return null;
});

function handleClearPoolIdle(body: { peer_id: string; peer_secret: string; pool_name: string }): BrokerResponse {
  const authErr = requireSecret(body.peer_id, body.peer_secret);
  if (authErr) return err(authErr);

  if (!body.pool_name) return err("pool_name is required");

  const pool = getPoolByName(body.pool_name);
  if (!pool || pool.status !== "active") return err("pool not found or not active");

  const txErr = clearPoolIdleTx(pool.id, body.peer_id);
  if (txErr) return err(txErr);

  return ok({ cleared: true });
}

// --- Deprecated busy signaling (returns errors pointing to new endpoints) ---

function handleSetBusy(_body: SetBusyRequest): BrokerResponse {
  return err("deprecated: use POST /pool/set-idle instead");
}

function handleSetReady(_body: SetReadyRequest): BrokerResponse {
  return err("deprecated: use POST /pool/clear-idle instead");
}

function handleGetBusyPeers(_body: { pool_name: string }): BrokerResponse {
  return err("deprecated: pool throttle info is now included in /message/check and /message/peek responses");
}

// --- Service handlers ---

function handleServiceRegister(body: { id: string; name: string; type: string; url?: string; metadata?: string }): BrokerResponse {
  if (!body.id || !body.name || !body.type) return err("id, name, and type are required");

  const ts = now();
  db.prepare(
    `INSERT INTO services (id, name, type, url, status, metadata, registered_at, last_health)
     VALUES (?, ?, ?, ?, 'healthy', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name=?, type=?, url=?, status='healthy', metadata=?, last_health=?`
  ).run(
    body.id, body.name, body.type, body.url ?? null, body.metadata ?? "{}", ts, ts,
    body.name, body.type, body.url ?? null, body.metadata ?? "{}", ts
  );

  return ok({ registered: true });
}

function handleServiceHeartbeat(body: { id: string; status?: string; metadata?: string }): BrokerResponse {
  if (!body.id) return err("id is required");

  const existing = db.prepare("SELECT id FROM services WHERE id = ?").get(body.id);
  if (!existing) return err("service not registered");

  const ts = now();
  const status = body.status ?? "healthy";
  if (body.metadata) {
    db.prepare("UPDATE services SET status = ?, metadata = ?, last_health = ? WHERE id = ?").run(status, body.metadata, ts, body.id);
  } else {
    db.prepare("UPDATE services SET status = ?, last_health = ? WHERE id = ?").run(status, ts, body.id);
  }

  return ok({ acknowledged: true });
}

function handleListServices(): BrokerResponse {
  const services = db.prepare("SELECT * FROM services").all() as any[];
  return ok(services);
}

// --- Undelivered message bounce-back ---

function bounceUndeliveredMessages(): void {
  // Find unread messages sent to dead/stale peers older than 30s.
  // Notify the sender once, then mark as read (so we don't re-bounce).
  const undelivered = db.prepare(
    `SELECT mr.message_id, mr.peer_id as recipient_id, m.from_id, m.pool_id, m.body, m.created_at,
            pr.name as recipient_name, po.name as pool_name
     FROM message_recipients mr
     JOIN messages m ON mr.message_id = m.id
     JOIN peers pr ON mr.peer_id = pr.id
     LEFT JOIN pools po ON m.pool_id = po.id
     WHERE mr.read_at IS NULL
       AND pr.status = 'dead'
       AND m.from_id != 'system'
       AND m.from_id != 'cli'
       AND datetime(m.created_at) < datetime('now', '-30 seconds')
     ORDER BY m.created_at ASC
     LIMIT 50`
  ).all() as {
    message_id: number;
    recipient_id: string;
    from_id: string;
    pool_id: string | null;
    body: string;
    created_at: string;
    recipient_name: string;
    pool_name: string | null;
  }[];

  if (undelivered.length === 0) return;

  // Group by sender to batch notifications
  const bySender = new Map<string, typeof undelivered>();
  for (const msg of undelivered) {
    const existing = bySender.get(msg.from_id) ?? [];
    existing.push(msg);
    bySender.set(msg.from_id, existing);
  }

  const ts = now();
  for (const [senderId, msgs] of bySender) {
    // Check sender is still active (don't bounce to dead peers)
    const sender = db.prepare("SELECT status FROM peers WHERE id = ?").get(senderId) as { status: string } | null;
    if (!sender || sender.status !== "active") {
      // Just mark as read to clean up
      for (const msg of msgs) {
        db.prepare("UPDATE message_recipients SET read_at = ? WHERE message_id = ? AND peer_id = ?")
          .run(ts, msg.message_id, msg.recipient_id);
      }
      continue;
    }

    // Build bounce notification grouped by recipient
    const byRecipient = new Map<string, { name: string; pool_name: string | null; count: number }>();
    for (const msg of msgs) {
      const key = msg.recipient_id;
      const existing = byRecipient.get(key);
      if (existing) {
        existing.count++;
      } else {
        byRecipient.set(key, { name: msg.recipient_name, pool_name: msg.pool_name, count: 1 });
      }
    }

    const details = Array.from(byRecipient.values())
      .map((r) => `${r.name} (${r.count} msg${r.count > 1 ? "s" : ""}${r.pool_name ? ` in ${r.pool_name}` : ""})`)
      .join(", ");

    const bounceBody = `⚠️ UNDELIVERED: ${msgs.length} message(s) could not be delivered — recipient(s) disconnected: ${details}. These peers are offline and will NOT respond. Do not wait for replies from them.`;

    // Send as DM to the sender
    const seq = getNextSeq(null);
    const result = db.prepare(
      "INSERT INTO messages (pool_id, from_id, body, msg_type, seq, created_at) VALUES (NULL, 'system', ?, 'bounce', ?, ?)"
    ).run(bounceBody, seq, ts);
    const bounceMsgId = Number(result.lastInsertRowid);
    db.prepare("INSERT INTO message_recipients (message_id, peer_id) VALUES (?, ?)").run(bounceMsgId, senderId);

    // Mark original messages as read to prevent re-bouncing
    for (const msg of msgs) {
      db.prepare("UPDATE message_recipients SET read_at = ? WHERE message_id = ? AND peer_id = ?")
        .run(ts, msg.message_id, msg.recipient_id);
    }
  }
}

// --- Stale peer cleanup ---

function cleanupPeerArtifacts(peerId: string, pid: number): void {
  try { unlinkSync(`${FLAGS_DIR}/${peerId}.unread`); } catch {}
  try { unlinkSync(`${FLAGS_DIR}/${peerId}.unread.tmp`); } catch {}
  try {
    const files = readdirSync(PIDMAP_DIR);
    for (const f of files) {
      if (f.startsWith(`${pid}_`)) {
        try { unlinkSync(`${PIDMAP_DIR}/${f}`); } catch {}
      }
    }
  } catch {}
}

function cleanupStalePeers(): void {
  const activePeers = db.prepare("SELECT id, pid, pid_start, last_seen FROM peers WHERE status = 'active'").all() as {
    id: string;
    pid: number;
    pid_start: string;
    last_seen: string;
  }[];

  for (const peer of activePeers) {
    const age = Date.now() - new Date(peer.last_seen).getTime();
    const pidDead = !pidIsAlive(peer.pid, peer.pid_start);
    const heartbeatStale = age > HEARTBEAT_INTERVAL_MS * 3;

    if ((pidDead && age > HEARTBEAT_INTERVAL_MS) || heartbeatStale) {
      markPeerDead(peer.id);
      cleanupPeerArtifacts(peer.id, peer.pid);
    }
  }

  db.prepare(
    "UPDATE services SET status = 'down' WHERE status != 'down' AND datetime(last_health) < datetime('now', '-60 seconds')"
  ).run();

  // Expire stale open release proposals (>1 hour old)
  const staleReleases = db.prepare(
    "SELECT id, pool_id FROM pool_releases WHERE status = 'open' AND datetime(created_at) < datetime('now', '-1 hour')"
  ).all() as { id: string; pool_id: string }[];
  for (const r of staleReleases) {
    db.prepare("UPDATE pool_releases SET status = 'expired', resolved_at = ? WHERE id = ?").run(now(), r.id);
    insertSystemMessage(r.pool_id, "Release proposal expired (no quorum reached within 1 hour).");
  }

  // Clean up expired pool throttles
  db.prepare("DELETE FROM pool_throttles WHERE datetime(idle_until) <= datetime('now')").run();

  // Bounce-back: notify senders of undelivered messages to dead peers
  bounceUndeliveredMessages();
}

const staleInterval = setInterval(cleanupStalePeers, STALE_CHECK_INTERVAL_MS);

// --- HTTP server ---

type RouteHandler = (body: any) => BrokerResponse;

const routes: Record<string, RouteHandler> = {
  "POST /register": handleRegister,
  "POST /heartbeat": handleHeartbeat,
  "POST /unregister": handleUnregister,
  "POST /set-summary": handleSetSummary,
  "POST /list-peers": handleListPeers,
  "POST /pool/create": handlePoolCreate,
  "POST /pool/join": handlePoolJoin,
  "POST /pool/leave": handlePoolLeave,
  "POST /pool/invite": handlePoolInvite,
  "POST /pool/list": handlePoolList,
  "POST /pool/members": handlePoolMembers,
  "POST /pool/status": handlePoolStatus,
  "POST /message/send": handleMessageSend,
  "POST /message/poll": handleMessagePoll,
  "POST /message/read": handleMessageRead,
  "POST /message/check": handleMessageCheck,
  "POST /message/peek": handleMessagePeek,
  "POST /pool/create-cli": handlePoolCreateCli,
  "POST /pool/invite-cli": handlePoolInviteCli,
  "POST /message/send-cli": handleMessageSendCli,
  "POST /message/history": handleMessageHistory,
  "POST /pool/update-metadata": handlePoolUpdateMetadata,
  "POST /pool/propose-release": handleProposeRelease,
  "POST /pool/vote-release": handleVoteRelease,
  "POST /pool/release-status": handleReleaseStatus,
  "POST /pool/set-idle": handleSetPoolIdle,
  "POST /pool/clear-idle": handleClearPoolIdle,
  "POST /pool/set-busy": handleSetBusy,
  "POST /pool/set-ready": handleSetReady,
  "POST /pool/busy-peers": handleGetBusyPeers,
  "POST /service/register": handleServiceRegister,
  "POST /service/heartbeat": handleServiceHeartbeat,
  "POST /message/unread-count": handleUnreadCount,
};

function sendJson(res: ServerResponse, data: any, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const method = req.method ?? "GET";

  if (method === "GET" && url.pathname === "/health") {
    return sendJson(res, handleHealth());
  }

  if (BROKER_TOKEN) {
    const authHeader = req.headers.authorization;
    const provided = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (provided !== BROKER_TOKEN) {
      return sendJson(res, err("unauthorized — set CCT_TOKEN"), 401);
    }
  }

  if (method === "GET" && url.pathname === "/services") {
    return sendJson(res, handleListServices());
  }

  const key = `${method} ${url.pathname}`;
  const handler = routes[key];

  if (!handler) {
    return sendJson(res, err("not found"), 404);
  }

  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw);
    const result = handler(body);
    sendJson(res, result);
  } catch (e: any) {
    sendJson(res, err(e.message ?? "internal error"), 500);
  }
});

server.listen(BROKER_PORT, BROKER_BIND_HOST, () => {
  const mode = BROKER_BIND_HOST === "0.0.0.0" ? " (LAN)" : "";
  console.log(`CCT broker listening on ${BROKER_BIND_HOST}:${BROKER_PORT}${mode}`);
});

process.on("SIGINT", () => {
  clearInterval(staleInterval);
  db.close();
  server.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  clearInterval(staleInterval);
  db.close();
  server.close();
  process.exit(0);
});
