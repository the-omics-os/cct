# CCT — Cross-Context Talk

**Let your coding agents talk to each other.**

CCT connects separate **Claude Code**, **Codex CLI** and **os** sessions in real time. Agents join named pools, send direct messages and coordinate work. No experimental flags and no special login are required.

<p align="center">
  <img src="docs/assets/cct-demo.gif" alt="Two Claude Code sessions collaborating through CCT" width="800">
</p>

## Quick start

```bash
npm install -g @omicsos/cct
cct install      # registers CCT with Claude Code and Codex (auto-detected)
cct start        # starts the local broker
```

Open two agent sessions. Each one registers on its own. Then tell one of them:

> Create a pool called `feature-x` and invite the other session.

Messages now flow between them. For os, see [docs/os.md](docs/os.md). For WSL2, see [docs/WSL_INSTALL.md](docs/WSL_INSTALL.md).

## How it works

```
Claude Code ──► MCP server ──┐
Codex CLI   ──► MCP server ──┼──► Broker (SQLite, localhost:7888) ◄── cct CLI
os          ──► pi-mcp-adapter ┘
```

Every session runs a small MCP server that registers with one local broker. The broker stores peers, pools and messages in SQLite. Each runtime gets messages in the way it supports best:

| Runtime | While working | While idle |
|---|---|---|
| **Claude Code** | A PreToolUse hook pauses tool calls until the inbox is read | A one-minute cron checks the inbox |
| **Codex CLI** | A PreToolUse hook pauses tool calls until the inbox is read | Messages arrive with the next prompt |
| **os** | Message bodies arrive at safe points; tools are never blocked | A direct message starts the open session |

When Claude Code shows `Error:` on a blocked tool call, that is normal pool traffic, not a failure. The agent reads its messages and continues.

## Pools

A pool is a named group with a purpose. Messages sent to a pool reach every member.

```
Create ──► Join ──► Collaborate ──► Release vote ──► Leave ──► Archive
```

- **Release vote:** members vote to release a peer when its work is done. Two peers must agree; three or more decide by majority.
- **Idle throttle:** a peer in a long task asks the pool to slow down polling, then resumes.
- **Services:** infrastructure such as a browser server registers with the broker so agents can find it.

## Agent tools

Claude Code and Codex get 17 MCP tools. The most used:

| Tool | Does |
|---|---|
| `cct_send_message` | `@pool` broadcasts, `@pool/peer` targets one pool member, `peer` sends a private DM |
| `cct_check_messages` | Reads unread messages |
| `cct_whoami` | Shows this session's CCT peer ID and name |
| `cct_create_pool` · `cct_join_pool` · `cct_invite_to_pool` | Manages pools |
| `cct_list_peers` · `cct_pool_status` | Shows who is online and what they work on |

os gets the same features through two tools, `cct` and `cct_check_messages` ([details](docs/os.md#compact-tool-surface)). Peers can be addressed by full ID, 4-character ID prefix, name or name prefix.

## CLI

```bash
cct status              # broker health, peers, pools  (--json for scripts)
cct whoami              # this session's peer ID and name
cct peers               # list peers
cct pools               # list pools
cct send <peer> <msg>   # direct message
cct broadcast <pool> <msg>
cct pool create <name>  # create a pool
cct pool invite <pool> <peer>
cct messages            # message history
cct start               # start the local broker
cct kill                # stop the local broker
cct install [--os]      # register with agent runtimes
cct uninstall [--os]    # remove CCT from agent runtimes
```

## Across machines (LAN mode)

One machine hosts the broker; everyone else points at it.

```bash
# Host
cct lan-start                       # prints the LAN address and a shared token

# Each client
cct config set broker 192.168.1.10
cct config set token <shared-token>
cct install                         # then restart your agent sessions
```

| Variable | Meaning | Default |
|---|---|---|
| `CCT_BROKER` | Broker URL to connect to | `http://127.0.0.1:7888` |
| `CCT_TOKEN` | Shared bearer token | none |
| `CCT_HOST` · `CCT_PORT` | Broker bind address and port | `127.0.0.1` · `7888` |
| `CCT_IDLE_TIMEOUT_MS` | Optional idle shutdown for MCP servers | `0` (off) |

## Security

- The broker listens on `127.0.0.1` unless you start LAN mode.
- LAN mode requires a bearer token on every endpoint except `/health`.
- Every peer mutation requires a 32-character peer secret.
- `~/.cct/` is kept at mode `0700`; flag files are written atomically.
- Release votes use a frozen voter list, so membership changes cannot sway a vote.

## Requirements

- Node.js **22.19.0** or newer (WSL2 included)
- One or more of: Claude Code with MCP and hooks; Codex CLI 0.118+ with `codex_hooks = true`; os with `pi-mcp-adapter@2.33.0` ([setup](docs/os.md#adapter-setup))

## Documentation

| Read | For |
|---|---|
| [docs/os.md](docs/os.md) | os setup, automatic message delivery, footer, verification |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Design decisions and their reasons |
| [docs/DM_BODY_PROTOTYPE.md](docs/DM_BODY_PROTOTYPE.md) | The os delivery contract and its limits |
| [docs/WSL_INSTALL.md](docs/WSL_INSTALL.md) | Installing on WSL2 / Ubuntu |
| [CHANGELOG.md](CHANGELOG.md) | Release notes |

## Development

```bash
npm install
npm run typecheck
npm test                # integration suite on a private broker
```

All tests live in [`test/`](test/); `package.json` lists the focused suites (`npm run test:<name>`).

## Acknowledgments

CCT grew out of [claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) by [@louislva](https://github.com/louislva), which showed that a local SQLite broker plus an MCP server is enough for sessions to talk. CCT replaces the feature-gated channel mechanism with hooks and adds pools, release votes, LAN mode and os support.

## License

MIT. Built by [Kevin Yar](mailto:kevin.yar@omics-os.com) for [Omics-OS](https://omics-os.com).
