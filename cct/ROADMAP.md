# CCT Roadmap (v2 — aligned with ARCHITECTURE.md)

Supersedes: ~/.claude/plans/fizzy-hopping-puzzle.md (original plan, outdated delivery model)

## Phase 1: Foundation

**Goal:** Broker running, schema correct, types complete.

| Task | Description |
|------|-------------|
| 1.1 | Scaffold `~/omics-os/cct/`: package.json, tsconfig.json |
| 1.2 | `shared/types.ts` — all interfaces matching ARCHITECTURE.md schema |
| 1.3 | `shared/constants.ts` — port 7888, paths (~/.cct/), timeouts |
| 1.4 | `broker.ts` — SQLite setup with full schema (5 tables, 3 indexes), WAL mode |
| 1.5 | Broker peer endpoints: register (mint secret), heartbeat, unregister, set-summary, list-peers |
| 1.6 | Broker pool endpoints: create, join, leave, invite, list, members, status |
| 1.7 | Broker message endpoints: send (DM + broadcast fan-out), poll, read (mark read_at), unread-count |
| 1.8 | Broker system: /health, stale peer cleanup (PID + start_time check every 30s), pool archival, death notifications |
| 1.9 | Test broker with curl |

**Exit criteria:** `curl localhost:7888/health` returns peer/pool counts. Can register, create pool, send/receive messages via curl.

## Phase 2: MCP Server + Hook

**Goal:** Two Claude sessions can exchange messages via pools.

| Task | Description |
|------|-------------|
| 2.1 | `shared/summarize.ts` — git-based summary (branch + recent files, no external API) |
| 2.2 | `server.ts` — MCP server: auto-register, generate peer name, write pidmap (PID + start_time), ensureBroker() auto-launch |
| 2.3 | 10 MCP tools matching ARCHITECTURE.md tool table |
| 2.4 | Polling loop: every 2s, call /message/unread-count, write ~/.cct/flags/{peer_id}.unread |
| 2.5 | Heartbeat every 15s, cleanup on SIGINT/SIGTERM (unregister, delete pidmap, delete flag) |
| 2.6 | MCP instructions aligned with hook behavior (explain "Error:" prefix, suggest cron) |
| 2.7 | Peer ID shown in cct_check_messages tool description |
| 2.8 | `hook.sh` — pure bash, no python, reads flag file only (target <5ms) |
| 2.9 | End-to-end test: 2 sessions, create pool, exchange messages |

**Exit criteria:** Session A sends pool message, Session B's next tool call is blocked, B reads message, B can reply. No other sessions affected.

## Phase 3: CLI + Install

**Goal:** Kevin can manage pools from terminal and install/uninstall CCT in one command.

| Task | Description |
|------|-------------|
| 3.1 | `cli.ts` — all commands: status, peers, pools, pool create/delete/invite, send, broadcast, messages, start, kill |
| 3.2 | `cct install` — register MCP in ~/.claude.json + add hook to ~/.claude/settings.json |
| 3.3 | `cct uninstall` — reverse of install |
| 3.4 | Test CLI commands |
| 3.5 | Write `CLAUDE.md` for the cct/ project |

**Exit criteria:** `cct install` makes CCT work in any new Claude session. `cct uninstall` removes all traces.

## Phase 4: Polish + Verify

**Goal:** Production-ready for daily use.

| Task | Description |
|------|-------------|
| 4.1 | Full integration: 3 sessions, 2 pools, messages flowing correctly |
| 4.2 | Edge cases: agent crash mid-pool (death notification), rejoin archived pool, n:n membership |
| 4.3 | Isolation: sessions without CCT have zero hook overhead (no pidmap = instant exit) |
| 4.4 | Hook benchmark: measure actual latency per tool call |
| 4.5 | Security: verify ~/.cct/ permissions, peer_secret enforcement, PID+start_time validation |
| 4.6 | Clean up: remove /tmp/cct-test/, codex probe artifacts, cct-test MCP registration |
| 4.7 | Register real CCT MCP, remove cct-test |

**Exit criteria:** Two independent agents collaborate on a feature via a pool without Kevin's intervention after initial pool setup.
