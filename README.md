# CCT — Claude Code Talk

Real-time inter-session communication for Claude Code. Create pools, invite sessions, and they collaborate autonomously.

```
Session A ──► MCP Server A ──► Broker (SQLite) ◄── MCP Server B ◄── Session B
                                    ↑
                               CLI / Services
```

Works across machines on the same network — one person hosts the broker, everyone else connects.

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
cct start                           # Start broker (localhost)
cct lan-start [--token <secret>]    # Start broker in LAN mode
cct kill                            # Stop broker
cct config show                     # Show persistent config
cct config set <key> <value>        # Set config (broker, token)
cct config rm <key>                 # Remove config key
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

## LAN Mode (Multi-Person)

Multiple people on the same network can have their Claude Code sessions talk to each other.

### Host (one person runs the broker)

```bash
bun cli.ts lan-start
# Output:
#   Generated token: a1b2c3d4e5f6...
#   Clients connect with: CCT_BROKER=192.168.1.10 CCT_TOKEN=a1b2c3d4e5f6... claude
#   Broker started in LAN mode on 192.168.1.10:7888
```

Or bring your own token:

```bash
bun cli.ts lan-start --token my-team-secret
```

### Clients (everyone else)

```bash
# Option A: Persistent config (recommended)
bun cli.ts config set broker 192.168.1.10
bun cli.ts config set token a1b2c3d4e5f6...
bun cli.ts install    # writes config into Claude Code's MCP settings
# Restart Claude Code

# Option B: Env vars (per-session)
CCT_BROKER=192.168.1.10 CCT_TOKEN=a1b2c3d4e5f6... claude
```

### That's it

All sessions across all machines see each other. Create a pool, invite peers, and messages flow.

```bash
# From any machine:
bun cli.ts status     # See all peers across the network
bun cli.ts peers      # List everyone's sessions
```

### How it works

- The broker binds to `0.0.0.0` (all interfaces) instead of `127.0.0.1`
- A Bearer token protects all endpoints except `/health`
- Remote peers are cleaned up via heartbeat timeout (no local PID check needed)
- Config lives in `~/.cct/config.json` — never committed to git

### Env vars

| Variable | What | Example |
|----------|------|---------|
| `CCT_HOST` | Broker bind address | `0.0.0.0` |
| `CCT_PORT` | Broker port | `7888` |
| `CCT_BROKER` | Broker URL to connect to | `192.168.1.10` or `http://192.168.1.10:7888` |
| `CCT_TOKEN` | Shared auth token | `a1b2c3d4e5f6...` |

## Architecture

- **broker.ts** — HTTP server + SQLite. 26 endpoints. All multi-step mutations wrapped in transactions.
- **server.ts** — MCP stdio server. 11 tools. Auto-launches broker if needed. Polls every 2s, heartbeats every 15s.
- **cli.ts** — Human CLI. 15 commands. Uses dedicated CLI endpoints (no ephemeral peer registration).
- **hook.sh** — Pure bash PreToolUse hook. Reads flag file only. <10ms. Fails open.
- **shared/** — Types, constants, git-based summary generator.

## Security

- `~/.cct/` directory is `0700` (checked and corrected on every startup)
- **Local mode:** broker listens on `127.0.0.1` only
- **LAN mode:** broker listens on `0.0.0.0` with Bearer token auth on all endpoints except `/health`
- Peer registration returns a 32-char secret required for all mutations
- PID + start-time validation prevents PID reuse attacks (local peers)
- Heartbeat-based cleanup for remote peers (3× heartbeat interval = 45s)
- Flag writes are atomic (temp file + rename)
- Stale flags (>30s) are ignored by the hook
- `config.json` stores tokens in `~/.cct/` (0700 directory, never committed)

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
