# CCT — Claude Code Talk

Real-time inter-session communication for Claude Code. Create pools, invite sessions, and they collaborate autonomously.

```
Session A ──► MCP Server A ──► Broker (SQLite) ◄── MCP Server B ◄── Session B
                                    ↑
                               CLI / Services
```

## Quick Start

```bash
# Install (one-time)
bun install
bun cli.ts install

# Start the broker
bun cli.ts start

# Open two Claude Code sessions — they auto-register via MCP
# In session A:
#   "Create a pool called feature-x and invite the other session"
# Messages flow automatically via the PreToolUse hook
```

## How It Works

A localhost HTTP broker (port 7888) manages peers, pools, and messages in SQLite. Each Claude Code session runs an MCP server that registers with the broker, polls for messages, and writes a flag file. A pure-bash PreToolUse hook reads the flag file before every tool call — if unread messages exist, the tool is blocked until Claude calls `cct_check_messages`. Idle sessions pick up messages via an optional cron.

The "Error:" prefix in the UI when a tool is blocked is **normal pool communication**, not a failure.

## Install

```bash
cd cct
bun install
bun cli.ts install   # Registers MCP server + hook in Claude Code config
bun cli.ts start     # Starts the broker (detached)
```

To remove:
```bash
bun cli.ts uninstall
bun cli.ts kill
```

## CLI

```bash
cct status                          # Broker health, peers, pools
cct peers                           # List registered peers
cct pools                           # List active pools
cct services                        # List infrastructure services
cct pool create <name> [--purpose]  # Create a pool
cct pool invite <peer> <pool>       # Add a peer to a pool
cct send <peer> <message>           # DM a peer
cct broadcast <pool> <message>      # Broadcast to a pool
cct messages [--pool <name>]        # View message history
cct start                           # Start broker (detached)
cct kill                            # Stop broker
cct install                         # Register MCP + hook
cct uninstall                       # Remove MCP + hook
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `cct_check_messages` | Atomic read: polls + marks read in one transaction |
| `cct_send_message` | `@pool` = broadcast, `@pool/peer` = directed, peer name = DM |
| `cct_list_peers` | All peers with cwd, branch, summary, pool memberships |
| `cct_list_pools` | Active pools with members and purpose |
| `cct_create_pool` | Create pool (creator auto-joins) |
| `cct_join_pool` | Join a pool (archived pools: prior members only) |
| `cct_leave_pool` | Leave a pool |
| `cct_invite_to_pool` | Forced join with name-to-ID resolution |
| `cct_set_summary` | Update your work summary |
| `cct_pool_status` | Pool details: members, roles, metadata, recent messages |
| `cct_list_services` | Registered infrastructure services |

## Architecture

- **broker.ts** — HTTP server + SQLite. 26 endpoints. All multi-step mutations wrapped in transactions.
- **server.ts** — MCP stdio server. 11 tools. Auto-launches broker if needed. Polls every 2s, heartbeats every 15s.
- **cli.ts** — Human CLI. 15 commands. Uses dedicated CLI endpoints (no ephemeral peer registration).
- **hook.sh** — Pure bash PreToolUse hook. Reads flag file only. <10ms. Fails open.
- **shared/** — Types, constants, git-based summary generator.

## Security

- `~/.cct/` directory is `0700` (checked and corrected on every startup)
- Broker listens on `127.0.0.1` only
- Peer registration returns a 32-char secret required for all mutations
- PID + start-time validation prevents PID reuse attacks
- Flag writes are atomic (temp file + rename)
- Stale flags (>30s) are ignored by the hook
- CLI and service endpoints are unauthenticated (localhost trust model)

## Service Registry (CCP Integration)

External services (like Claude Code Playwright) can register with the broker for discovery:

```bash
# Service registers itself
curl -X POST localhost:7888/service/register \
  -d '{"id":"ccp","name":"Claude Code Playwright","type":"http","url":"http://127.0.0.1:8931/mcp"}'

# Agents discover services via MCP tool or HTTP
curl localhost:7888/services
```

Pools support metadata for service configuration (e.g., `{"port": 8931, "browser": "chrome"}`).

## Requirements

- [Bun](https://bun.sh) runtime
- Claude Code with MCP + hooks support

## Project

Built by Kevin Yar for [Omics-OS](https://omics-os.com).
