# CCT Architecture — Final Design Decisions

Date: 2026-04-19
Status: FROZEN — build against this document only.

## Design Decisions (resolved)

### D1: Delivery model
**Decision: Stock Claude Code only. Next-tool-boundary delivery. Idle delivery is best-effort via cron.**

The research proves no MCP-native push exists for API auth. PreToolUse hook is our primary delivery. CronCreate is best-effort for idle sessions — we tell Claude to set it up in MCP instructions, but correctness never depends on it. If Anthropic unblocks `claude/channel` later, we add it as an accelerator — the architecture doesn't change.

### D2: Single source of truth
**Decision: SQLite broker only. No file-based message queues.**

The broker owns all state: peers, pools, memberships, messages. The hook does NOT read inbox files or curl the broker. Instead, the **MCP server writes a tiny flag file** (`/tmp/cct/{peer_id}.unread` containing the count) whenever it polls the broker. The hook reads this one file — a single `stat` + `read` of a few bytes. The MCP server is responsible for keeping this flag in sync via its polling loop.

Flow:
```
Broker (SQLite)  ←── MCP server polls every 2s ──→  writes /tmp/cct/{peer_id}.unread
                                                              ↑
                                                     Hook reads this file (fast)
```

This gives us: one source of truth (SQLite), fast hook (<5ms), no race conditions on message data.

### D3: Hook performance
**Decision: Pure bash, no python, no curl. Read one small file.**

The hook does:
1. Read tool_name from stdin with bash built-ins (not python)
2. Check if tool is CCT or ToolSearch → exit 0
3. Check if pidmap exists for PPID → exit 0 if not (session not in CCT)
4. Read `{peer_id}.unread` → exit 0 if "0" or missing
5. Block with reason if > 0

No python. No curl. No HTTP. Target: <5ms for non-CCT sessions, <10ms for CCT sessions with no messages.

### D4: Peer lifecycle
**Decision: Auto-register on MCP connect. Discoverable immediately. Hook only activates after pool membership.**

Every session with the CCT MCP server gets registered in the broker. `cct_list_peers` shows all registered peers. But the hook only blocks tools if the peer is in at least one pool AND has unread messages. Peers not in any pool = zero interruption.

This resolves the contradiction: peers are discoverable (for invitation) but not interrupted until they join a pool.

### D5: Message state machine
**Decision: Two states only: `unread` and `read_at`. No `delivered`, no `ack`.**

When `cct_check_messages` is called, all unread messages for that peer are returned and marked with `read_at = now()`. The hook checks the unread count, not delivery state. Simple, no ambiguity.

The schema stores `read_at` (nullable). Unread = `read_at IS NULL`. This is forward-compatible: if we add delivery receipts later, we add `delivered_at` without changing the read path.

### D6: Pool broadcasts
**Decision: Fan-out at the broker. One `message_recipients` row per recipient.**

A pool broadcast creates one row in `messages` (the content) and N rows in `message_recipients` (one per pool member, each with their own `read_at`). This correctly handles per-recipient read state.

### D7: Invite model
**Decision: Invite = forced join in v1. Schema supports accept/decline for v2.**

`cct_invite_to_pool` immediately adds the peer as a member. The invited peer gets a system message in their inbox: "You were added to pool X by Y." The `pool_members` table has a `role` column (values: `member`, `admin`, `creator`) and a `status` column (values: `active`, `invited`, `left`) — only `active` and `left` are used in v1, but `invited` is ready for v2 accept/decline flow.

### D8: Hierarchy
**Decision: Schema supports roles. V1 uses them only for display, not enforcement.**

`pool_members.role` stores `creator`, `admin`, or `member`. The pool creator is `creator`. In v1, all roles have equal permissions. In v2, we can add enforcement (only admin/creator can invite, only creator can delete pool). No rework needed.

### D9: Message ordering
**Decision: Broker assigns monotonic sequence number per pool.**

`messages.seq` is an auto-incrementing integer scoped to the pool. No timestamp-based ordering claims. Messages are delivered in `seq` order within a pool. DMs use a global sequence.

### D10: Pool lifecycle
**Decision: Pools survive until explicitly deleted or all members exit. Archived, not destroyed.**

When the last member exits (process dies or leaves), the pool status becomes `archived`. Archived pools are invisible to `cct_list_pools` but remain in the database. A peer can rejoin an archived pool, which reactivates it.

### D11: Peer crash handling
**Decision: Stale peer cleanup notifies pool members.**

Broker checks PIDs every 30s. Dead peers are marked `status = 'dead'`. A system message is inserted into each pool the dead peer was in: "Peer X (cwd) disconnected." Pool members see it on their next check.

### D11b: Stable peer identity across restarts and network changes
**Decision: Anchor registration to a stable session key, for BOTH runtimes. Recover in place on reap, never mint a fresh id mid-session.**

The CCT peer id/name must survive MCP-server restarts, `/mcp` reconnects, and network transitions (e.g. a Wi-Fi change that makes the broker unreachable long enough for stale-cleanup to mark the peer dead). To achieve this, `/register` is keyed on `session_key`:

- **Codex** → `codex-root:<root session id>`, resolved from codex's own rollout transcripts (see **D11c**). The `CODEX_SESSION_ID` / `CODEX_THREAD_ID` env vars are read first but are **never set in an MCP server's environment** — codex only injects them into shell/exec tool environments.
- **Claude** → `CLAUDE_CODE_SESSION_ID` (stable for the whole Claude Code session; inherited by the spawned `npx tsx` MCP server).

When a `session_key` is present, the broker de-dupes on `(runtime, session_key)`: a re-register **revives the existing row** (even if `status='dead'`) and returns the **same id, secret, and name**, superseding any older duplicate. Peers with no session key fall back to the legacy ephemeral behavior (a fresh random id per registration).

**Membership restore (critical).** Marking a peer dead does more than flip `peers.status` — `markPeerDeadTx` also drops every active `pool_members` row to `left` and archives now-empty pools. So reviving only the `peers` row would return the same id but leave the peer **mute**: excluded from pool broadcasts (fan-out selects only active members) and rejected on its own pool sends. To prevent this, `markPeerDeadTx` stamps `peers.died_at` with the same timestamp it writes to the dropped memberships' `left_at`. On a session-keyed revive of a row that `was dead`, `restoreMembershipsAfterRevive` reactivates exactly the memberships whose `left_at == died_at` (the ones *that death* dropped — not pools the peer left on its own earlier) and un-archives those pools, emitting a "reconnected" system message. `died_at` is cleared on revive.

Recovery is proactive: `server.ts:sendHeartbeat` no longer exits when the broker reports `peer not found / not active`. If a `session_key` is set **and the host process is still alive** (`reregister` itself re-checks `isOriginalProcessAlive` — orphan prevention must not depend on the 30s monitor alone), it re-registers in place, reclaims the row, and rewrites the pidmap/flag. It still shuts down on `stale_registration` (a newer instance owns the row — we're the orphan) and on `invalid peer_secret` (a different holder). Deferred-ack ids are bound to the peer id they were peeked under (`pendingAckPeerId`); if recovery ever changes the id, stale acks are dropped rather than misfired. PID-reuse protection (D12) is unchanged: `pid`/`pid_start`/`host_pid` are refreshed on every register/heartbeat.

**Known limitations (accepted, not bugs):**
- **Dead stdio MCP server is not resurrected.** Claude Code does not auto-respawn a dead stdio MCP server. This fix removes the *self-inflicted* exit on `peer not found`, so an alive-but-network-blipped server recovers; but if the MCP process itself dies, recovery needs a `/mcp` reconnect or session restart. The session_key still guarantees the *same* id is reclaimed when it does come back.
- **Two live sessions sharing one `CLAUDE_CODE_SESSION_ID` collapse to one peer row** (e.g. a resumed session in two terminals). This is inherent to session-keying — adding a per-process discriminator would reintroduce the original "new id on every restart" bug. Last registration wins the row; the older instance retires on its next heartbeat via `stale_registration`.
- **`cli.ts` (`cct whoami` from a bare shell) still resolves identity via pidmap process-ancestry, not the session key.** Works for shells descended from the Claude host; a detached shell that only has the env var can't resolve the peer. Low impact — the MCP tools (`cct_whoami`) are authoritative.

### D11c: Codex session key is the fork-chain root, resolved from rollout transcripts
**Decision: Derive the codex session key from codex's own transcripts, keyed on the ROOT of the fork chain. Never trust env propagation, and never key on the current session id.**

D11b assumed codex exports its session id to the MCP server. It does not — a live cct MCP server spawned by codex has only the `CCT_*` vars from `config.toml`, so `env_vars = ["CODEX_THREAD_ID", ...]` forwards nothing and **every codex peer row was written with `session_key = NULL`**. The whole stable-identity mechanism was inert for codex: each MCP respawn inserted a new row (new id, new `codex-XXXX` name), and `reregister()` bailed on the `!sessionKey` guard. Observed: 12 codex rows in one day for one conversation, all `NULL`.

The id is recovered from `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<session_id>.jsonl`, whose first record is `session_meta` carrying `session_id`, `cwd`, and `forked_from_id`. Resolution order (`shared/codex-session.ts`, wired in `server.ts:initCodexIdentity`, retried for 500ms because a freshly started codex may not have flushed the file yet):

1. `CCT_CODEX_SESSION_ID` / `CODEX_SESSION_ID` / `CODEX_THREAD_ID` — future-proofing only; unset in practice.
2. `resume <uuid>` parsed off the host codex command line — exact, and the case that matters most.
3. Newest rollout whose `session_meta.cwd` matches the session cwd (fresh start, bounded scan).
4. Then follow `forked_from_id` to the **root** of the chain → `codex-root:<root_id>`.
5. Fallback `codex-host:<host_pid>_<host_pid_start>` when nothing resolves — still survives MCP respawn and fork within one codex process.

**Why the root and not the current id:** codex mints a NEW session id when it forks a session on compaction (`forked_from_id` + `forked_from_ordinal_exclusive`) and respawns its MCP servers, so keying on the current id would still churn the CCT identity mid-conversation. The root id is constant for the whole lineage, including across `codex resume`.

The pidmap key stays the **current** session id (`codex_{session_id}`) — that is what the hooks receive on stdin — so the broker key and the pidmap key are deliberately different values.

**Codex also gets host-scoped dedupe.** Codex respawns MCP servers without always killing the previous one, which left two live rows per session (both heartbeating; only one addressable). `session_key` dedupe cannot catch that when the two rows carry different keys, so `/register` additionally reaps active codex peers sharing `host_pid`.

**Known limitations (accepted):**
- **Two deliberate parallel forks of one lineage collapse to one row.** Sequential fork/resume is the real usage; simultaneous work in two forks of the same conversation is not supported (same trade-off as two Claude sessions sharing one session id, D11b).
- **Rollout format coupling.** `session_meta` field names (`session_id`, `forked_from_id`, `cwd`) are codex-internal. All readers fail soft: an unparseable record degrades to the host-scoped key, never a crash. `session_meta` is already ~22KB in practice, so the reader must scan for the first newline instead of assuming a fixed head size — a truncated parse silently makes every forked session look like its own root.
- **Unresolvable host process degrades the key.** If the codex ancestor is not discoverable, the key falls back to host scope. In practice codex outlives its MCP child, and if it doesn't the MCP server exits anyway.

### D12: Security model
**Decision: Per-user private runtime directory. Peer secrets for broker auth.**

- Runtime dir: `~/.cct/` with `0700` permissions (not /tmp)
- Broker listens on `127.0.0.1:7888` (localhost only)
- On registration, broker mints a `peer_secret` (32-char random). All mutating endpoints require it.
- Pidmap files in `~/.cct/pidmaps/` with `0700` dir permissions
- Flag files in `~/.cct/flags/` with `0700` dir permissions
- PID mapping includes process start time to prevent PID reuse attacks

### D13: Multiple pools — no head-of-line blocking
**Decision: Hook shows unread count but does NOT block. MCP instructions handle prioritization.**

REVISED from prototype. The hook returns `additionalContext` with the unread summary, NOT `decision: "block"`. Wait — Codex proved additionalContext doesn't reliably land in the model's reasoning.

REVISED AGAIN: Hook blocks but the reason includes ALL pool names with unread counts. Claude reads all at once with `cct_check_messages` (returns messages from all pools). One check, one unblock. No head-of-line blocking because all messages are consumed together.

### D14: The "Error:" prefix
**Decision: Accept it. Mitigate with clear reason text and MCP instructions.**

MCP instructions explicitly say: "When you see a PreToolUse error mentioning CCT messages, this is normal pool communication, not a tool failure. Call cct_check_messages to read your messages, then retry your original action."

The hook reason text: "CCT: {N} unread message(s) in pool(s): {pool_names}. Call cct_check_messages to read them. This is normal pool communication, not an error."

### D15: Cron
**Decision: Best-effort. MCP instructions suggest it. Not required for correctness.**

Instructions say: "Optionally, set up a recurring check every 2 minutes for idle periods." If Claude does it, great. If not, hook covers the busy path and messages wait until the next tool call.

---

## SQLite Schema

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE peers (
  id            TEXT PRIMARY KEY,         -- 8-char random
  name          TEXT NOT NULL,            -- human-readable (from env or auto)
  secret        TEXT NOT NULL,            -- 32-char random, required for mutations
  pid           INTEGER NOT NULL,
  pid_start     TEXT NOT NULL,            -- process start time (prevents PID reuse)
  runtime       TEXT NOT NULL DEFAULT 'claude',
  session_key   TEXT,                     -- stable session id (Codex session id / CLAUDE_CODE_SESSION_ID); NULL for legacy PID-keyed peers
  host_pid      INTEGER,                  -- Claude/Codex host process watched for orphan cleanup
  host_pid_start TEXT,
  cwd           TEXT NOT NULL,
  git_root      TEXT,
  git_branch    TEXT,
  summary       TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active',  -- 'active', 'dead'
  died_at       TEXT,                    -- when marked dead; matches dropped memberships' left_at for revive
  registered_at TEXT NOT NULL,
  last_seen     TEXT NOT NULL
);

CREATE TABLE pools (
  id            TEXT PRIMARY KEY,         -- 8-char random
  name          TEXT NOT NULL UNIQUE,
  purpose       TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active',  -- 'active', 'archived'
  created_by    TEXT NOT NULL,            -- peer_id or 'cli'
  created_at    TEXT NOT NULL
);

CREATE TABLE pool_members (
  pool_id       TEXT NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  peer_id       TEXT NOT NULL REFERENCES peers(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'member',   -- 'creator', 'admin', 'member'
  status        TEXT NOT NULL DEFAULT 'active',   -- 'active', 'invited', 'left'
  joined_at     TEXT NOT NULL,
  left_at       TEXT,
  PRIMARY KEY (pool_id, peer_id)
);

CREATE TABLE messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id       TEXT REFERENCES pools(id) ON DELETE CASCADE,  -- null = DM
  from_id       TEXT NOT NULL,            -- peer_id or 'cli' or 'system'
  body          TEXT NOT NULL,
  msg_type      TEXT NOT NULL DEFAULT 'chat',  -- 'chat', 'system', 'join', 'leave'
  seq           INTEGER NOT NULL,         -- monotonic per pool (or global for DMs)
  created_at    TEXT NOT NULL
);

CREATE TABLE message_recipients (
  message_id    INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  peer_id       TEXT NOT NULL REFERENCES peers(id) ON DELETE CASCADE,
  read_at       TEXT,                     -- null = unread
  PRIMARY KEY (message_id, peer_id)
);

CREATE INDEX idx_recipients_unread ON message_recipients(peer_id, read_at)
  WHERE read_at IS NULL;

CREATE INDEX idx_pool_members_active ON pool_members(peer_id, status)
  WHERE status = 'active';

CREATE INDEX idx_peers_status ON peers(status)
  WHERE status = 'active';
```

## File Layout

```
~/.cct/                          0700  Private runtime directory
  cct.db                               SQLite database (broker)
  pidmaps/                       0700  PID → peer_id mappings
    {claude_pid}_{start_time}          Contains: peer_id
  flags/                         0700  Fast unread count flags
    {peer_id}.unread                   Contains: unread count (integer string)

~/omics-os/cct/                        Source code
  package.json
  tsconfig.json
  CLAUDE.md
  broker.ts                            HTTP server + SQLite
  server.ts                            MCP stdio server
  cli.ts                               CLI tool
  hook.sh                              PreToolUse hook (pure bash)
  shared/
    types.ts                           TypeScript interfaces
    constants.ts                       Ports, paths, timeouts
    summarize.ts                       Local git-based summary
```

## MCP Tools (16)

| Tool | Description |
|------|-------------|
| `cct_check_messages` | Read all unread messages (all pools + DMs). Marks as read. |
| `cct_whoami` | Show this session's CCT peer ID/name. `CODEX_THREAD_ID` is not a CCT peer ID. |
| `cct_send_message` | Send DM (to: "peer-name") or pool broadcast (to: "@pool-name") or directed pool msg (to: "@pool-name/peer-name") |
| `cct_list_peers` | List all registered peers with name, cwd, branch, summary, pool memberships |
| `cct_list_pools` | List all active pools with members and purpose |
| `cct_create_pool` | Create pool with name + purpose. Creator auto-joins as creator role. |
| `cct_join_pool` | Join an existing pool |
| `cct_leave_pool` | Leave a pool |
| `cct_invite_to_pool` | Add a peer to a pool (forced join in v1) |
| `cct_set_summary` | Update this peer's work summary |
| `cct_pool_status` | Show detailed pool info: members, roles, recent activity |
| `cct_list_services` | List registered infrastructure services |
| `cct_propose_release` | Propose releasing a peer from a pool |
| `cct_vote_release` | Vote yes/no on an active release proposal |
| `cct_set_pool_idle` | Ask pool members to reduce polling during deep work |
| `cct_clear_pool_idle` | Clear pool idle throttle early |

## Broker Endpoints

All POST. All mutating endpoints require `peer_secret` in body.

**Peers:** `/register`, `/heartbeat`, `/unregister`, `/set-summary`, `/list-peers`
**Pools:** `/pool/create`, `/pool/join`, `/pool/leave`, `/pool/invite`, `/pool/list`, `/pool/members`, `/pool/status`
**Messages:** `/message/send`, `/message/poll`, `/message/read`, `/message/unread-count`
**System:** `/health` (GET)

## Hook Logic (pure bash)

```bash
#!/bin/bash
# 1. Parse tool_name with bash builtins (jq-free, python-free)
read -r INPUT
TOOL_NAME="${INPUT##*\"tool_name\":\"}"
TOOL_NAME="${TOOL_NAME%%\"*}"

# 2. Skip CCT tools and ToolSearch
case "$TOOL_NAME" in *cct_*|ToolSearch) exit 0 ;; esac

# 3. Find peer ID via pidmap
PIDMAP="$HOME/.cct/pidmaps/${PPID}_"*
[ -f $PIDMAP ] || exit 0
PEER_ID=$(cat $PIDMAP)

# 4. Check unread flag
FLAG="$HOME/.cct/flags/${PEER_ID}.unread"
[ -f "$FLAG" ] || exit 0
COUNT=$(cat "$FLAG")
[ "$COUNT" = "0" ] || [ -z "$COUNT" ] && exit 0

# 5. Block with context
echo "{\"decision\":\"block\",\"reason\":\"CCT: ${COUNT} unread message(s). Call cct_check_messages to read them. This is normal pool communication, not an error.\"}"
```
