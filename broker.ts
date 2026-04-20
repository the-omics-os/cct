#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { mkdirSync, existsSync, statSync, chmodSync, unlinkSync, readdirSync } from "node:fs";
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
  const row = db.query("SELECT secret FROM peers WHERE id = ?").get(peerId) as { secret: string } | null;
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
  const row = db.query(
    "SELECT MAX(seq) as max_seq FROM messages WHERE pool_id IS ?"
  ).get(poolId) as { max_seq: number | null } | null;
  return (row?.max_seq ?? 0) + 1;
}

function getPoolByName(name: string): { id: string; name: string; purpose: string; status: string; created_by: string; created_at: string } | null {
  return db.query("SELECT * FROM pools WHERE name = ?").get(name) as any;
}

function insertSystemMessage(poolId: string, body: string, targetPeerId?: string): void {
  const seq = getNextSeq(poolId);
  const ts = now();
  const result = db.query(
    "INSERT INTO messages (pool_id, from_id, body, msg_type, seq, created_at) VALUES (?, 'system', ?, 'system', ?, ?)"
  ).run(poolId, body, seq, ts);
  const msgId = Number(result.lastInsertRowid);

  if (targetPeerId) {
    db.query(
      "INSERT INTO message_recipients (message_id, peer_id) VALUES (?, ?)"
    ).run(msgId, targetPeerId);
  } else {
    const members = db.query(
      "SELECT peer_id FROM pool_members WHERE pool_id = ? AND status = 'active'"
    ).all(poolId) as { peer_id: string }[];

    for (const m of members) {
      db.query(
        "INSERT INTO message_recipients (message_id, peer_id) VALUES (?, ?)"
      ).run(msgId, m.peer_id);
    }
  }
}

function archivePoolIfEmpty(poolId: string): void {
  const count = db.query(
    "SELECT COUNT(*) as cnt FROM pool_members WHERE pool_id = ? AND status = 'active'"
  ).get(poolId) as { cnt: number };
  if (count.cnt === 0) {
    db.query("UPDATE pools SET status = 'archived' WHERE id = ?").run(poolId);
  }
}

// --- Endpoint handlers ---

function handleHealth(): BrokerResponse {
  const peers = db.query("SELECT COUNT(*) as cnt FROM peers WHERE status = 'active'").get() as { cnt: number };
  const pools = db.query("SELECT COUNT(*) as cnt FROM pools WHERE status = 'active'").get() as { cnt: number };
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

  db.query(
    `INSERT INTO peers (id, name, secret, pid, pid_start, cwd, git_root, git_branch, summary, status, registered_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', 'active', ?, ?)`
  ).run(id, peerName, secret, pid, pid_start, cwd, git_root ?? null, git_branch ?? null, ts, ts);

  return ok({ id, secret, name: peerName });
}

function handleHeartbeat(body: HeartbeatRequest): BrokerResponse {
  const authErr = requireSecret(body.peer_id, body.peer_secret);
  if (authErr) return err(authErr);

  db.query("UPDATE peers SET last_seen = ? WHERE id = ?").run(now(), body.peer_id);
  return ok({ acknowledged: true });
}

function handleUnregister(body: UnregisterRequest): BrokerResponse {
  const authErr = requireSecret(body.peer_id, body.peer_secret);
  if (authErr) return err(authErr);

  markPeerDead(body.peer_id);
  return ok({ unregistered: true });
}

const markPeerDeadTx = db.transaction((peerId: string) => {
  db.query("UPDATE peers SET status = 'dead' WHERE id = ?").run(peerId);

  const peer = db.query("SELECT name, cwd FROM peers WHERE id = ?").get(peerId) as { name: string; cwd: string } | null;
  const poolMemberships = db.query(
    "SELECT pool_id FROM pool_members WHERE peer_id = ? AND status = 'active'"
  ).all(peerId) as { pool_id: string }[];

  for (const { pool_id } of poolMemberships) {
    db.query(
      "UPDATE pool_members SET status = 'left', left_at = ? WHERE pool_id = ? AND peer_id = ?"
    ).run(now(), pool_id, peerId);
    insertSystemMessage(pool_id, `Peer ${peer?.name ?? peerId} (${peer?.cwd ?? "unknown"}) disconnected.`);
    archivePoolIfEmpty(pool_id);
  }
});

function markPeerDead(peerId: string): void {
  markPeerDeadTx(peerId);
}

function handleSetSummary(body: SetSummaryRequest): BrokerResponse {
  const authErr = requireSecret(body.peer_id, body.peer_secret);
  if (authErr) return err(authErr);

  db.query("UPDATE peers SET summary = ? WHERE id = ?").run(body.summary, body.peer_id);
  return ok({ updated: true });
}

function handleListPeers(_body: any): BrokerResponse {
  const peers = db.query(
    "SELECT id, name, pid, cwd, git_root, git_branch, summary, status, registered_at, last_seen FROM peers WHERE status = 'active'"
  ).all() as any[];

  const allMemberships = db.query(
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

const poolCreateTx = db.transaction((poolId: string, body: PoolCreateRequest, existing: any) => {
  const ts = now();

  if (existing && existing.status === "archived") {
    db.query("UPDATE pools SET status = 'active', purpose = ? WHERE id = ?").run(body.purpose ?? "", existing.id);
    const prior = db.query(
      "SELECT peer_id FROM pool_members WHERE pool_id = ? AND peer_id = ?"
    ).get(existing.id, body.peer_id);
    if (prior) {
      db.query(
        "UPDATE pool_members SET status = 'active', joined_at = ?, left_at = NULL WHERE pool_id = ? AND peer_id = ?"
      ).run(ts, existing.id, body.peer_id);
    } else {
      db.query(
        "INSERT INTO pool_members (pool_id, peer_id, role, status, joined_at) VALUES (?, ?, 'member', 'active', ?)"
      ).run(existing.id, body.peer_id, ts);
    }
    insertSystemMessage(existing.id, `Pool reactivated by ${body.peer_id}.`);
    return existing.id;
  }

  db.query(
    "INSERT INTO pools (id, name, purpose, status, created_by, created_at) VALUES (?, ?, ?, 'active', ?, ?)"
  ).run(poolId, body.name, body.purpose ?? "", body.peer_id, ts);

  db.query(
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

const poolJoinTx = db.transaction((pool: any, peerId: string) => {
  if (pool.status === "archived") {
    const prior = db.query(
      "SELECT peer_id FROM pool_members WHERE pool_id = ? AND peer_id = ?"
    ).get(pool.id, peerId);
    if (!prior) return "only prior members can rejoin an archived pool";
    db.query("UPDATE pools SET status = 'active' WHERE id = ?").run(pool.id);
    insertSystemMessage(pool.id, `Pool reactivated by rejoining peer.`);
  }

  const existing = db.query(
    "SELECT status FROM pool_members WHERE pool_id = ? AND peer_id = ?"
  ).get(pool.id, peerId) as { status: string } | null;

  if (existing?.status === "active") return "already a member";

  const ts = now();
  if (existing) {
    db.query(
      "UPDATE pool_members SET status = 'active', joined_at = ?, left_at = NULL WHERE pool_id = ? AND peer_id = ?"
    ).run(ts, pool.id, peerId);
  } else {
    db.query(
      "INSERT INTO pool_members (pool_id, peer_id, role, status, joined_at) VALUES (?, ?, 'member', 'active', ?)"
    ).run(pool.id, peerId, ts);
  }

  const peer = db.query("SELECT name FROM peers WHERE id = ?").get(peerId) as { name: string } | null;
  insertSystemMessage(pool.id, `${peer?.name ?? peerId} joined the pool.`);
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

const poolLeaveTx = db.transaction((pool: any, peerId: string) => {
  const membership = db.query(
    "SELECT status FROM pool_members WHERE pool_id = ? AND peer_id = ?"
  ).get(pool.id, peerId) as { status: string } | null;

  if (!membership || membership.status !== "active") return "not a member of this pool";

  db.query(
    "UPDATE pool_members SET status = 'left', left_at = ? WHERE pool_id = ? AND peer_id = ?"
  ).run(now(), pool.id, peerId);

  const peer = db.query("SELECT name FROM peers WHERE id = ?").get(peerId) as { name: string } | null;
  insertSystemMessage(pool.id, `${peer?.name ?? peerId} left the pool.`);
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

const poolInviteTx = db.transaction((pool: any, body: PoolInviteRequest, target: { id: string; name: string }) => {
  const existing = db.query(
    "SELECT status FROM pool_members WHERE pool_id = ? AND peer_id = ?"
  ).get(pool.id, body.target_peer_id) as { status: string } | null;

  if (existing?.status === "active") return "target is already a member";

  const ts = now();
  if (existing) {
    db.query(
      "UPDATE pool_members SET status = 'active', joined_at = ?, left_at = NULL, role = 'member' WHERE pool_id = ? AND peer_id = ?"
    ).run(ts, pool.id, body.target_peer_id);
  } else {
    db.query(
      "INSERT INTO pool_members (pool_id, peer_id, role, status, joined_at) VALUES (?, ?, 'member', 'active', ?)"
    ).run(pool.id, body.target_peer_id, ts);
  }

  const inviter = db.query("SELECT name FROM peers WHERE id = ?").get(body.peer_id) as { name: string } | null;
  insertSystemMessage(pool.id, `You were added to pool ${pool.name} by ${inviter?.name ?? body.peer_id}.`, body.target_peer_id);
  insertSystemMessage(pool.id, `${target.name} joined the pool.`);
  return null;
});

function handlePoolInvite(body: PoolInviteRequest): BrokerResponse {
  const authErr = requireSecret(body.peer_id, body.peer_secret);
  if (authErr) return err(authErr);

  const pool = getPoolByName(body.pool_name);
  if (!pool || pool.status !== "active") return err("pool not found or not active");

  const target = db.query("SELECT id, name FROM peers WHERE id = ? AND status = 'active'").get(body.target_peer_id) as { id: string; name: string } | null;
  if (!target) return err("target peer not found or not active");

  const txErr = poolInviteTx(pool, body, target);
  if (txErr) return err(txErr);

  return ok({ invited: true, pool_id: pool.id });
}

function handlePoolList(body: PoolListRequest): BrokerResponse {
  let pools: any[];

  if (body.peer_id) {
    pools = db.query(
      `SELECT DISTINCT p.* FROM pools p
       JOIN pool_members pm ON p.id = pm.pool_id
       WHERE pm.peer_id = ? AND pm.status = 'active' AND p.status = 'active'`
    ).all(body.peer_id) as any[];
  } else {
    pools = db.query("SELECT * FROM pools WHERE status = 'active'").all() as any[];
  }

  const poolIds = pools.map((p) => p.id);
  if (poolIds.length === 0) return ok([]);

  const placeholders = poolIds.map(() => "?").join(",");
  const allMembers = db.query(
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

  const members = db.query(
    `SELECT pm.peer_id, pe.name as peer_name, pm.role, pm.status, pm.joined_at, pm.left_at
     FROM pool_members pm JOIN peers pe ON pm.peer_id = pe.id
     WHERE pm.pool_id = ?`
  ).all(pool.id) as any[];

  return ok(members);
}

function handlePoolStatus(body: PoolStatusRequest): BrokerResponse {
  const pool = getPoolByName(body.pool_name);
  if (!pool) return err("pool not found");

  const members = db.query(
    `SELECT pm.peer_id, pe.name as peer_name, pm.role, pm.status
     FROM pool_members pm JOIN peers pe ON pm.peer_id = pe.id
     WHERE pm.pool_id = ? AND pm.status = 'active'`
  ).all(pool.id) as any[];

  const msgCount = db.query(
    "SELECT COUNT(*) as cnt FROM messages WHERE pool_id = ? AND datetime(created_at) > datetime('now', '-1 hour')"
  ).get(pool.id) as { cnt: number };

  return ok({
    ...pool,
    members,
    recent_message_count: msgCount.cnt,
  });
}

// --- Message handlers ---

const messageSendPoolTx = db.transaction((poolId: string, fromId: string, body: string, msgType: string, targetPeerId?: string) => {
  const ts = now();
  const seq = getNextSeq(poolId);
  const result = db.query(
    "INSERT INTO messages (pool_id, from_id, body, msg_type, seq, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(poolId, fromId, body, msgType, seq, ts);
  const msgId = Number(result.lastInsertRowid);

  let recipientCount: number;
  if (targetPeerId) {
    db.query("INSERT INTO message_recipients (message_id, peer_id) VALUES (?, ?)").run(msgId, targetPeerId);
    recipientCount = 1;
  } else {
    const members = db.query(
      "SELECT peer_id FROM pool_members WHERE pool_id = ? AND status = 'active' AND peer_id != ?"
    ).all(poolId, fromId) as { peer_id: string }[];
    for (const m of members) {
      db.query("INSERT INTO message_recipients (message_id, peer_id) VALUES (?, ?)").run(msgId, m.peer_id);
    }
    recipientCount = members.length;
  }

  return { message_id: msgId, seq, recipient_count: recipientCount };
});

const messageSendDmTx = db.transaction((fromId: string, toPeerId: string, body: string) => {
  const ts = now();
  const seq = getNextSeq(null);
  const result = db.query(
    "INSERT INTO messages (pool_id, from_id, body, msg_type, seq, created_at) VALUES (NULL, ?, ?, 'chat', ?, ?)"
  ).run(fromId, body, seq, ts);
  const msgId = Number(result.lastInsertRowid);
  db.query("INSERT INTO message_recipients (message_id, peer_id) VALUES (?, ?)").run(msgId, toPeerId);
  return { message_id: msgId, seq, recipient_count: 1 };
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
      const membership = db.query(
        "SELECT status FROM pool_members WHERE pool_id = ? AND peer_id = ? AND status = 'active'"
      ).get(pool.id, fromId) as { status: string } | null;
      if (!membership) return err("not a member of this pool");
    }

    const msgType = body.msg_type ?? "chat";
    const result = messageSendPoolTx(pool.id, fromId, body.body, msgType, body.to_peer_id);
    return ok(result);
  }

  const target = db.query("SELECT id FROM peers WHERE id = ? AND status = 'active'").get(body.to_peer_id!) as { id: string } | null;
  if (!target) return err("target peer not found or not active");

  const result = messageSendDmTx(fromId, body.to_peer_id!, body.body);
  return ok(result);
}

function handleMessagePoll(body: MessagePollRequest): BrokerResponse {
  if (!body.peer_id) return err("peer_id is required");

  const messages = db.query(
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

const messageReadTx = db.transaction((peerId: string, messageIds: number[]) => {
  const ts = now();
  const stmt = db.query(
    "UPDATE message_recipients SET read_at = ? WHERE message_id = ? AND peer_id = ? AND read_at IS NULL"
  );
  let marked = 0;
  for (const msgId of messageIds) {
    const result = stmt.run(ts, msgId, peerId);
    marked += result.changes;
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

const messageCheckTx = db.transaction((peerId: string) => {
  const messages = db.query(
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
    const stmt = db.query(
      "UPDATE message_recipients SET read_at = ? WHERE message_id = ? AND peer_id = ? AND read_at IS NULL"
    );
    for (const m of messages) {
      stmt.run(ts, m.message_id, peerId);
    }
  }

  const remaining = db.query(
    `SELECT m.pool_id, po.name as pool_name, COUNT(*) as count
     FROM message_recipients mr
     JOIN messages m ON mr.message_id = m.id
     LEFT JOIN pools po ON m.pool_id = po.id
     WHERE mr.peer_id = ? AND mr.read_at IS NULL
     GROUP BY m.pool_id`
  ).all(peerId) as { pool_id: string | null; pool_name: string | null; count: number }[];
  const remainingTotal = remaining.reduce((sum, r) => sum + r.count, 0);

  return { messages, unread: { total: remainingTotal, by_pool: remaining } };
});

function handleMessageCheck(body: { peer_id: string; peer_secret: string }): BrokerResponse {
  const authErr = requireSecret(body.peer_id, body.peer_secret);
  if (authErr) return err(authErr);

  const result = messageCheckTx(body.peer_id);
  return ok(result);
}

function handleUnreadCount(body: UnreadCountRequest): BrokerResponse {
  if (!body.peer_id) return err("peer_id is required");

  const rows = db.query(
    `SELECT m.pool_id, po.name as pool_name, COUNT(*) as count
     FROM message_recipients mr
     JOIN messages m ON mr.message_id = m.id
     LEFT JOIN pools po ON m.pool_id = po.id
     WHERE mr.peer_id = ? AND mr.read_at IS NULL
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
    db.query("UPDATE pools SET status = 'active', purpose = ? WHERE id = ?").run(body.purpose ?? "", existing.id);
    return ok({ pool_id: existing.id, name: body.name });
  }

  db.query(
    "INSERT INTO pools (id, name, purpose, status, created_by, created_at) VALUES (?, ?, ?, 'active', 'cli', ?)"
  ).run(poolId, body.name, body.purpose ?? "", ts);

  return ok({ pool_id: poolId, name: body.name });
}

function handlePoolInviteCli(body: { target_peer_id: string; pool_name: string }): BrokerResponse {
  const pool = getPoolByName(body.pool_name);
  if (!pool || pool.status !== "active") return err("pool not found or not active");

  const target = db.query("SELECT id, name FROM peers WHERE id = ? AND status = 'active'").get(body.target_peer_id) as { id: string; name: string } | null;
  if (!target) return err("target peer not found or not active");

  const existing = db.query(
    "SELECT status FROM pool_members WHERE pool_id = ? AND peer_id = ?"
  ).get(pool.id, body.target_peer_id) as { status: string } | null;

  if (existing?.status === "active") return err("target is already a member");

  const ts = now();
  if (existing) {
    db.query(
      "UPDATE pool_members SET status = 'active', joined_at = ?, left_at = NULL, role = 'member' WHERE pool_id = ? AND peer_id = ?"
    ).run(ts, pool.id, body.target_peer_id);
  } else {
    db.query(
      "INSERT INTO pool_members (pool_id, peer_id, role, status, joined_at) VALUES (?, ?, 'member', 'active', ?)"
    ).run(pool.id, body.target_peer_id, ts);
  }

  insertSystemMessage(pool.id, `You were added to pool ${pool.name} by CLI.`, body.target_peer_id);
  insertSystemMessage(pool.id, `${target.name} joined the pool.`);

  return ok({ invited: true, pool_id: pool.id });
}

function handleMessageSendCli(body: { pool_name?: string; to_peer_id?: string; body: string }): BrokerResponse {
  if (!body.body) return err("message body is required");
  if (!body.pool_name && !body.to_peer_id) return err("pool_name or to_peer_id is required");

  if (body.pool_name) {
    const pool = getPoolByName(body.pool_name);
    if (!pool || pool.status !== "active") return err("pool not found or not active");

    const members = db.query(
      "SELECT peer_id FROM pool_members WHERE pool_id = ? AND status = 'active'"
    ).all(pool.id) as { peer_id: string }[];

    const ts = now();
    const seq = getNextSeq(pool.id);
    const result = db.query(
      "INSERT INTO messages (pool_id, from_id, body, msg_type, seq, created_at) VALUES (?, 'cli', ?, 'chat', ?, ?)"
    ).run(pool.id, body.body, seq, ts);
    const msgId = Number(result.lastInsertRowid);

    for (const m of members) {
      db.query("INSERT INTO message_recipients (message_id, peer_id) VALUES (?, ?)").run(msgId, m.peer_id);
    }

    return ok({ message_id: msgId, seq, recipient_count: members.length });
  }

  const target = db.query("SELECT id FROM peers WHERE id = ? AND status = 'active'").get(body.to_peer_id!) as { id: string } | null;
  if (!target) return err("target peer not found or not active");

  const seq = getNextSeq(null);
  const ts = now();
  const result = db.query(
    "INSERT INTO messages (pool_id, from_id, body, msg_type, seq, created_at) VALUES (NULL, 'cli', ?, 'chat', ?, ?)"
  ).run(body.body, seq, ts);
  const msgId = Number(result.lastInsertRowid);
  db.query("INSERT INTO message_recipients (message_id, peer_id) VALUES (?, ?)").run(msgId, body.to_peer_id!);

  return ok({ message_id: msgId, seq, recipient_count: 1 });
}

function handleMessageHistory(body: { pool_name?: string; limit?: number }): BrokerResponse {
  const lim = body.limit ?? 50;

  if (body.pool_name) {
    const pool = getPoolByName(body.pool_name);
    if (!pool) return err("pool not found");

    const messages = db.query(
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

  const messages = db.query(
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

  db.query("UPDATE pools SET metadata = ? WHERE id = ?").run(body.metadata ?? "{}", pool.id);
  return ok({ updated: true });
}

// --- Service handlers ---

function handleServiceRegister(body: { id: string; name: string; type: string; url?: string; metadata?: string }): BrokerResponse {
  if (!body.id || !body.name || !body.type) return err("id, name, and type are required");

  const ts = now();
  db.query(
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

  const existing = db.query("SELECT id FROM services WHERE id = ?").get(body.id);
  if (!existing) return err("service not registered");

  const ts = now();
  const status = body.status ?? "healthy";
  if (body.metadata) {
    db.query("UPDATE services SET status = ?, metadata = ?, last_health = ? WHERE id = ?").run(status, body.metadata, ts, body.id);
  } else {
    db.query("UPDATE services SET status = ?, last_health = ? WHERE id = ?").run(status, ts, body.id);
  }

  return ok({ acknowledged: true });
}

function handleListServices(): BrokerResponse {
  const services = db.query("SELECT * FROM services").all() as any[];
  return ok(services);
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
  const activePeers = db.query("SELECT id, pid, pid_start, last_seen FROM peers WHERE status = 'active'").all() as {
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

  db.query(
    "UPDATE services SET status = 'down' WHERE status != 'down' AND datetime(last_health) < datetime('now', '-60 seconds')"
  ).run();
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
  "POST /pool/create-cli": handlePoolCreateCli,
  "POST /pool/invite-cli": handlePoolInviteCli,
  "POST /message/send-cli": handleMessageSendCli,
  "POST /message/history": handleMessageHistory,
  "POST /pool/update-metadata": handlePoolUpdateMetadata,
  "POST /service/register": handleServiceRegister,
  "POST /service/heartbeat": handleServiceHeartbeat,
  "POST /message/unread-count": handleUnreadCount,
};

const server = Bun.serve({
  hostname: BROKER_BIND_HOST,
  port: BROKER_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const method = req.method;

    if (method === "GET" && url.pathname === "/health") {
      return Response.json(handleHealth());
    }

    if (BROKER_TOKEN) {
      const authHeader = req.headers.get("authorization");
      const provided = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (provided !== BROKER_TOKEN) {
        return Response.json(err("unauthorized — set CCT_TOKEN"), { status: 401 });
      }
    }

    if (method === "GET" && url.pathname === "/services") {
      return Response.json(handleListServices());
    }

    const key = `${method} ${url.pathname}`;
    const handler = routes[key];

    if (!handler) {
      return Response.json(err("not found"), { status: 404 });
    }

    try {
      const body = await req.json();
      const result = handler(body);
      return Response.json(result);
    } catch (e: any) {
      return Response.json(err(e.message ?? "internal error"), { status: 500 });
    }
  },
});

const mode = BROKER_BIND_HOST === "0.0.0.0" ? " (LAN)" : "";
console.log(`CCT broker listening on ${BROKER_BIND_HOST}:${BROKER_PORT}${mode}`);

process.on("SIGINT", () => {
  clearInterval(staleInterval);
  db.close();
  server.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  clearInterval(staleInterval);
  db.close();
  server.stop();
  process.exit(0);
});
