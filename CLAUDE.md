# CCT (Claude Code Talk)

Real-time inter-session communication for Claude Code. Multiple Claude Code sessions collaborate via named pools without experimental/gated features.

## How It Works

1. **PreToolUse hook** (busy sessions) — Pure-bash hook checks a flag file before every tool call. If unread messages exist, it blocks until Claude reads its inbox. The "Error:" in the UI is normal pool communication.
2. **CronCreate** (idle sessions, best-effort) — MCP instructions suggest a recurring check. Not required for correctness.

```
Session A ──► MCP Server A ──► Broker (SQLite) ◄── MCP Server B ◄── Session B
                                    ↑
                               CLI / Services
```

## Key Concepts

- **Peer**: A Claude Code session with CCT connected. Has a name, ID, summary, cwd, branch.
- **Pool**: A named group of peers. Has a purpose and optional metadata. Messages broadcast to all members.
- **Service**: An infrastructure component (e.g., CCP browser server) registered with the broker for discovery.
- **Peer Name**: Set via `CCT_PEER_NAME=backend claude` or auto-generated as `{dirname}-{4char}`.
- **Flag File**: `~/.cct/flags/{peer_id}.unread` — format: `count|pool_summary|timestamp`. Atomic writes via rename.

## Commands

```bash
cct install          # Register MCP + hook (one-time setup)
cct uninstall        # Remove MCP + hook
cct status           # Broker health, peers, pools
cct peers            # List all registered peers
cct pools            # List pools with members
cct services         # List registered infrastructure services
cct pool create X    # Create a pool (no ephemeral peer — uses CLI endpoint)
cct pool invite P X  # Add peer to pool
cct send P "msg"     # DM a peer
cct broadcast X "m"  # Send to pool
cct messages         # Show message history
cct start            # Start broker (detached)
cct kill             # Stop broker
```

## MCP Tools (11)

| Tool | Description |
|------|-------------|
| `cct_check_messages` | Atomic read: polls + marks read in one transaction. Updates flag. |
| `cct_send_message` | `@pool` = broadcast, `@pool/peer` = directed pool msg, `peer` = DM |
| `cct_list_peers` | All peers with name, cwd, branch, summary, pool memberships |
| `cct_list_pools` | All active pools with members and purpose |
| `cct_create_pool` | Create pool. Creator auto-joins as creator role. |
| `cct_join_pool` | Join an existing pool (archived pools: only prior members can rejoin) |
| `cct_leave_pool` | Leave a pool |
| `cct_invite_to_pool` | Forced join. Resolves peer name to ID. Detects ambiguous names. |
| `cct_set_summary` | Update this peer's work summary |
| `cct_pool_status` | Detailed pool info: members, roles, metadata, recent activity |
| `cct_list_services` | List registered infrastructure services (CCP, etc.) |

## Project Structure

```
cct/
  broker.ts           HTTP broker + SQLite (26 endpoints, 6 tables, transactions)
  server.ts           MCP stdio server (11 tools, polling, heartbeat, auto-broker-launch)
  cli.ts              CLI (15 commands, no ephemeral peers, uses CLI-specific endpoints)
  hook.sh             PreToolUse hook (pure bash, <10ms, per-pool breakdown, stale detection)
  test-integration.sh Integration tests (39 tests)
  shared/
    types.ts          TypeScript interfaces
    constants.ts      Ports, paths, timeouts
    summarize.ts      Git-based summary generation
  package.json
  tsconfig.json
```

## Broker Endpoints

**Peers:** `/register`, `/heartbeat`, `/unregister`, `/set-summary`, `/list-peers`
**Pools:** `/pool/create`, `/pool/join`, `/pool/leave`, `/pool/invite`, `/pool/list`, `/pool/members`, `/pool/status`, `/pool/update-metadata`
**Messages:** `/message/send`, `/message/poll`, `/message/read`, `/message/check` (atomic), `/message/unread-count`
**CLI (no auth):** `/pool/create-cli`, `/pool/invite-cli`, `/message/send-cli`, `/message/history`
**Services (no auth):** `/service/register`, `/service/heartbeat`, `GET /services`
**System:** `GET /health`

## Design Documents

All design authority lives in `/Users/tyo/Omics-OS/.planning/cct/`:
- `ARCHITECTURE.md` — **Frozen design decisions (D1-D15).** Source of truth.
- `ROADMAP.md` — 4 build phases
- `STATE.md` — Current progress
- `REQUIREMENTS.md` — User flows and constraints
- `codex_output/` — Research + implementation review

## Rules

1. **ARCHITECTURE.md is the source of truth** for design decisions.
2. **SQLite is the only message store.** Flag files are derived caches, not authoritative.
3. **Hook must be pure bash.** No python, no curl, no jq. Target <10ms.
4. **Never block CCT tools or ToolSearch** in the hook — prevents infinite loops.
5. **Peer secrets required** on all mutating peer endpoints. CLI endpoints and service endpoints are unauthenticated (localhost only).
6. **~/.cct/ directory must be 0700.** Permissions are checked and corrected on startup.
7. **All multi-step mutations use transactions.** Pool create/join/invite, message send, peer death — all atomic.
8. **read_at is the only message state.** NULL = unread. No delivered/ack states.
9. **Flag file format is `count|pool_summary|timestamp`.** Atomic writes via temp+rename. Hook ignores stale flags (>30s).
10. **CLI never creates ephemeral peers.** Uses dedicated `-cli` broker endpoints.

## Runtime Directory

```
~/.cct/                    0700
  cct.db                   SQLite database (6 tables)
  pidmaps/                 0700  —  {claude_ppid}_{start_time} → peer_id
  flags/                   0700  —  {peer_id}.unread → "count|pools|timestamp"
```

## CCP Integration

CCT provides service discovery for CCP (Claude Code Playwright) and other infrastructure:
- Services self-register via `POST /service/register`
- Heartbeat via `POST /service/heartbeat` (stale after 60s → status=down)
- Agents discover via `cct_list_services` tool or `GET /services`
- Pool metadata stores service config (e.g., `{"port": 8931, "browser": "chrome"}`)
- `msg_type: "service_event"` for structured service messages

See `.planning/ccp_handoff_requirements.md` for full integration spec.

## Dependencies

- `@modelcontextprotocol/sdk` — MCP server framework
- `bun:sqlite` — Database (Bun built-in)
- `Bun.serve()` — HTTP server (Bun built-in)
- No external API dependencies
