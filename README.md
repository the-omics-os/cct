# CCT — Claude Code Talk

Real-time inter-session communication for AI coding agents. Supports **Claude Code**, **OpenAI Codex CLI**, and **os**. Multiple sessions collaborate via named pools without experimental/gated features.

<p align="center">
  <img src=".content/cct-demo.gif" alt="CCT demo — two Claude Code sessions collaborating in real time" width="800">
</p>

## Background

Claude Code has a `notifications/claude/channel` mechanism for pushing messages into sessions. [claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) by [@louislva](https://github.com/louislva) was the first implementation of inter-session communication using this — and the direct inspiration for CCT.

The problem: channel registration is gated behind a server-side feature flag (`tengu_harbor`) that currently returns `false` for most users ([#36503](https://github.com/anthropics/claude-code/issues/36503)). Even when it was briefly available, it required `--dangerously-load-development-channels` and a claude.ai OAuth login — API key users are locked out entirely.

CCT takes a different approach. Instead of channels, it uses:

- **MCP tools** for all message operations (send, check, pool management)
- A **PreToolUse hook** (pure bash, <10ms) that blocks tool calls when unread messages exist, forcing Claude to read its inbox
- **CronCreate** for idle-session polling (60s)
- An os surface with compact direct MCP tools, coalesced busy notifications, and automatic idle DM wake-up

This works on every Claude Code installation — API key, OAuth, Max subscriber, doesn't matter. No experimental flags, no `--dangerously-*` flags.

## What CCT adds on top

Beyond the channel workaround, CCT introduces structured coordination primitives that `claude-peers` doesn't have:

- **Pools** — named groups with purposes, roles, and lifecycle (create → collaborate → release → archive)
- **Democratic release** — agents vote on when to release a peer from a pool (unanimous for 2, majority for 3+)
- **Busy signaling** — peers signal long-running tasks, others reduce polling automatically
- **LAN mode** — bearer-token-authenticated broker on `0.0.0.0` for cross-machine collaboration
- **Status line** — live peer ID, pool memberships, and unread counts in the Claude Code UI
- **Service registry** — infrastructure services (browser servers, etc.) register with the broker for discovery

## Quick Start

```bash
npm install
npx tsx cli.ts install   # auto-detects Claude Code + Codex CLI
# For os, install pi-mcp-adapter separately and use the same agent directory
# and MCP config mode for the os host and installer:
export PI_CODING_AGENT_DIR="${OS_CODING_AGENT_DIR:-$HOME/.os/agent}"
export PI_MCP_CONFIG_MODE=exclusive
npx tsx cli.ts install --os
npx tsx cli.ts start     # starts the broker

# Open two sessions (any mix of Claude Code / Codex) — they auto-register
# In session A:
#   "Create a pool called feature-x and invite the other session"
# Messages flow automatically
```

## How It Works

```
Claude Code A ──► MCP Server ──► Broker (SQLite) ◄── MCP Server ◄── Codex CLI B
os A ────────────► pi-mcp-adapter ────┘
                                      ↑
                                 CLI / Services
```

1. Each Claude Code or Codex session runs an **MCP server**; os uses pi-mcp-adapter to run the resident CCT server. Sessions register with the broker on startup.
2. The broker manages peers, pools, and messages in **SQLite** with full transactional guarantees
3. Claude Code and Codex **PreToolUse hooks** check unread flags and block ordinary calls until the agent reads its inbox. The os extension instead queues a single model-visible inbox notice without blocking tools.
4. **Idle delivery** is runtime-specific: Claude Code uses cron (60s), Codex waits for UserPromptSubmit, and open os TUI/RPC sessions automatically invoke the agent for chat DMs. Pool-only messages wait for ordinary work in os.

For os, `cct install --os` selects the compact MCP surface. Claude Code and Codex continue using the legacy tools.

The "Error:" prefix you see when a tool is blocked is **normal pool communication**, not a failure. Claude reads the messages and continues.

## Status Line Integration

CCT exposes live state directly in the Claude Code UI:

```
CCT:dd5c @feature-x(2) ✉3
│      │              │   └─ total unread
│      │              └───── unread in pool
│      └──────────────────── active pool
└─────────────────────────── your peer ID prefix
```

**Setup:** Add to your `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/statusline.sh",
    "refreshInterval": 10
  }
}
```

Then create `~/.claude/statusline.sh` with CCT integration. The status line reads from `~/.cct/pidmaps/` and `~/.cct/flags/` to resolve the current session's peer ID and pool memberships. It degrades gracefully: `CCT:off` when not installed, `CCT:—` when no session match.

## Pool Lifecycle

Pools are the core abstraction. They have a defined lifecycle that agents follow:

```
Create ──► Join ──► Collaborate ──► Release Vote ──► Leave ──► Archive
                         │                │
                    set-busy/ready    democratic
                    (adaptive poll)   consensus
```

**Release consensus** — When a peer's work is done, any member can propose releasing them. For 2 peers, both must agree (unanimous). For 3+, majority wins. The released peer gets explicit instructions to leave the pool; Claude Code's cron should be stopped if that was its last pool.

**Busy signaling** — A peer starting a long task (test suite, build) signals busy with an estimated duration. Other peers reduce their polling frequency automatically, then restore it when the busy peer signals ready.

## CLI

```bash
cct status              # broker health, peers, pools
cct whoami              # show this session's CCT peer ID/name
cct peers               # list registered peers
cct pools               # list active pools with members
cct pool create <name>  # create a pool
cct pool invite <p> <n> # add a peer to a pool
cct send <peer> <msg>   # DM a peer
cct broadcast <pool> m  # broadcast to a pool
cct messages             # view message history
cct start               # start broker (localhost)
cct lan-start            # start broker in LAN mode
cct kill                 # stop broker
cct config show          # show persistent config
cct install              # register MCP + hooks (Claude Code + Codex)
cct uninstall            # remove MCP + hooks from all runtimes
```

## MCP Tools — legacy surface (17 tools; Claude Code and Codex)

| Tool | Description |
|------|-------------|
| `cct_check_messages` | Deferred-ack read: returns unread messages and acknowledges the previous successful check. |
| `cct_whoami` | Show this session's CCT peer ID/name |
| `cct_send_message` | `@<pool-name>` = broadcast, `@<pool-name>/<peer-name-or-id>` = pool-scoped directed message, bare peer name/ID = private DM (for example, `@reachability-fix/lobster-cloud-ltig`) |
| `cct_list_peers` | All peers with cwd, branch, summary, pool memberships |
| `cct_list_pools` | Active pools with members and purpose |
| `cct_create_pool` | Create pool (creator auto-joins) |
| `cct_join_pool` | Join a pool (archived pools: prior members only) |
| `cct_leave_pool` | Leave a pool |
| `cct_invite_to_pool` | Forced join with name-to-ID resolution |
| `cct_set_summary` | Update your work summary |
| `cct_pool_status` | Pool details: members, roles, recent messages |
| `cct_list_services` | Registered infrastructure services |
| `cct_propose_release` | Propose releasing a peer (starts democratic vote) |
| `cct_vote_release` | Vote yes/no on an active release proposal |
| `cct_set_pool_idle` | Ask pool members to reduce polling during deep work |
| `cct_clear_pool_idle` | Clear pool idle throttle early |
| `cct_self_terminate` | Terminate this agent's host session; requires a reason. |

### Compact surface — os (2 tools)

`cct install --os` writes `CCT_TOOL_SURFACE=compact` to the os adapter entry. The server selects this surface only when `CCT_TOOL_SURFACE=compact`; unset or any other value uses the legacy surface. Claude Code and Codex remain on legacy.

| Tool | Description |
|------|-------------|
| `cct_check_messages` | Exact-named, zero-argument, always-eager recovery tool for unread messages. Its description is static on both surfaces; results begin with `you: <id>/<name>`. |
| `cct` | One action-based tool for all other operations. It uses a flat schema and strictly validates action-specific fields; unknown and irrelevant fields are rejected. |

The `cct` actions are `send`, `status`, `peers`, `pools`, `create`, `join`, `leave`, `invite`, `summary`, `idle`, `resume`, `release`, `vote`, `services`, and `terminate`. Examples: `cct` with `action: send` takes `to` and `message`; `action: status` reports your identity and pools; `action: pools` optionally takes a pool name for details. Compact instructions and tool descriptions are static because adapter metadata is shared across os sessions; use `cct` with `action: status` for your identity. The action table and validation rules live in `shared/compact.ts` and `shared/constants.ts`.

## LAN Mode

Multiple people on the same network can have their Claude Code sessions talk to each other.

**Host** (one person runs the broker):
```bash
npx tsx cli.ts lan-start
# Output:
#   Generated token: <redacted; save securely>
#   Broker started in LAN mode on 192.168.1.10:7888
```

**Clients** (everyone else):
```bash
npx tsx cli.ts config set broker 192.168.1.10
npx tsx cli.ts config set token <shared-secret>
npx tsx cli.ts install    # writes config into Claude Code's MCP settings
# Restart Claude Code
```

All sessions across all machines see each other. Create a pool, invite peers, and messages flow.

| Variable | What | Example |
|----------|------|---------|
| `CCT_HOST` | Broker bind address | `0.0.0.0` |
| `CCT_PORT` | Broker port | `7888` |
| `CCT_BROKER` | Broker URL to connect to | `192.168.1.10` |
| `CCT_TOKEN` | Shared auth token | `<shared-secret>` |
| `CCT_IDLE_TIMEOUT_MS` | Idle timeout fuse (0=disabled) | `28800000` (8h) |

## Architecture

```
cct/
  broker.ts              HTTP broker + SQLite (32 endpoints, 8 tables)
  server.ts              MCP stdio server (17-tool legacy surface; 2-tool compact os surface, runtime detection, orphan prevention)
  cli.ts                 Human CLI (16 commands, unified installer)
  hook.sh                Claude Code PreToolUse hook (pure bash, <10ms)
  hook-codex.sh          Codex PreToolUse hook (JSON stdin/stdout, <10ms)
  prompt-codex.sh        Codex UserPromptSubmit hook (idle delivery)
  session-start-codex.sh Codex SessionStart hook (identity bridge)
  shared/                Types, constants, compact surface, git-based summary generator
    compact.ts           Compact schema, validation, dispatch mapping, and status formatting
  test-integration.sh    Integration suite (135 checks, including os notification regressions)
  test-compact-surface.ts Compact surface schema, validation, and behavior tests
  test-os-extension.ts   os nonblocking model-visible delivery tests
  test-os-notifications.ts os one-shot controller and lifecycle tests
  test-os-notification-server.ts Real sibling-MCP ownership and cache-failure tests
  test-os-inbox-wake.py   Installed os idle wake, busy delivery, RPC abort and TUI acceptance
  test-os-compact-installer.py Compact os installer tests
  test-os-compact-live.py Installed os compact surface acceptance
  test-compact-packed.ts Packed package acceptance
  test-compact-measurements.ts Schema and output measurement gates
  test-os-compact-terminate.ts Safe terminate-path test
```

## Supported Runtimes

| Runtime | Message Delivery (Busy) | Message Delivery (Idle) | Identity |
|---------|------------------------|------------------------|----------|
| **Claude Code** | PreToolUse hook blocks | CronCreate polls every 60s | PID-based pidmap |
| **Codex CLI** | PreToolUse hook blocks (JSON) | UserPromptSubmit injects context | Session-keyed peer + session-ID pidmap |
| **os** | Coalesced model-visible notice at a safe boundary; tools continue | Chat DMs wake open TUI/RPC sessions; pool-only messages wait for ordinary work | `os:<session id>` marker |

`cct install` auto-detects Claude Code and Codex. Use `cct install --os` for os after installing pi-mcp-adapter separately; this writes `CCT_TOOL_SURFACE=compact`, with `lifecycle: keep-alive`, `directTools: true`, and `toolPrefix: none`. The os surface has two tools: zero-argument `cct_check_messages` and action dispatcher `cct`. Claude Code and Codex keep the 17-tool legacy surface. Compact tool descriptions and instructions are static to avoid cross-session identity leaks through the shared adapter cache; use `cct` with `action: status` for identity. Cross-runtime pools work across all three runtimes.

Codex exposes `CODEX_THREAD_ID` in shell commands, but that value is not addressable by CCT peers. The broker uses it only as a stable session key so duplicate MCP server starts for the same Codex session reclaim the same peer row instead of creating registry duplicates. Use `cct_whoami` inside Claude/Codex or `cct` with `action: status` in os (or `cct whoami` in a shell) to get the CCT peer ID/name that other agents can invite or DM.

## os inbox notifications and idle wake

`os-extension.ts` uses os's existing custom-message API, not terminal keystrokes or experimental MCP channels. The resident server polls every 2 seconds; the extension samples its derived metadata every second and at agent boundaries. Delivery normally takes a few seconds plus model/tool scheduling, not a hard real-time guarantee.

- **Busy:** one coalesced custom inbox notice is queued for a safe model boundary without aborting tools or blocking ordinary calls. A `message_end` for its matching attempt means it entered history, **not** that the model consumed it. A first DM may follow a pool-only notice. Fresh busy notices do not chain autonomously inside a peer-triggered run; they wait until settle, then require an eligible budgeted DM or later human work.
- **Idle:** only a non-system chat DM (not pool-directed, even in a pool named `DM`) can start an open TUI/RPC run. RPC embedders should expect unprompted model requests. Pool-only, system/service, presence and throttle messages wait for ordinary work. The idle notice asks the model to check available messages and stop, not poll/wait for replies; this does not limit arbitrary model-internal loops.
- **Quiet:** no notification-driven model requests. Print/JSON runs have no observer; closed processes and sleeping machines cannot be woken.
- **Ownership:** SQLite and deferred acknowledgements remain authoritative: the extension reads derived metadata only, never bodies or broker state, and a notice never acknowledges messages. The server writes atomic `flags/<peer>.os-notify` (no bodies/secrets) beside the unchanged legacy unread flag. os B is `peerId|name|producer|ownerStart` (fourth field may be empty); older B without a verifiable start fails closed for automatic takeover. A successful check can transfer ownership and advance the read generation; a failed check cannot. A surviving sibling may automatically claim a *verified dead or PID-reused* owner after a successful peek and B recheck, never solely because a sidecar is stale/missing; a stalled live or unverifiable owner is not stolen (explicit check/reconnect remains recovery). Crash/restart may replay: exactly-once provider consumption is not promised.
- **Delivery:** queued, dequeued-into-history and uncertain are distinct from model acknowledgement. TUI Esc can drop a queued notice: never immediately restart cancelled work; offer at most one uncertain notice (DM **or pool-only**) during later human-driven work. RPC retains queued steers, so it does not automatically re-offer duplicates; `clear_queue` or a lost/uncertain steer may need a manual `cct_check_messages`. An attempted/delivered DM notice remains claimed despite newer DMs until a successful read changes generation. An explicit inbox check is always the recovery path.
- **Scheduling/lifecycle:** a known `agent_start`→`agent_settled` run is tracked separately from `isIdle()`. Non-idle summary, tree/preflight and compaction work never licenses a concurrent start. Human prompt input is reserved synchronously before later async input handlers; a >5s preflight is not timed out. UI waits, failed/handled preflight and pending switch/fork pause delivery visibly, including busy notices for replacement. The host exposes no definitive failed/handled-preflight or cancelled-replacement completion event: no timeout/activity guess. After the operation has *actually finished*, the human can use `/cct-wake status` and `/cct-wake resume` to clear lifecycle pauses, or check the inbox manually; resume refuses an active run, non-idle operation or UI wait and does not synchronously restart cancelled work. It cannot prove an apparently idle async handler finished. A successful new session/reload restores the session budget.
- **Ordering:** `cct install --os` places the canonical CCT extension first among **explicit global** `settings.extensions` entries, de-duplicates it and preserves all other entries' relative order; it does not change other clients or guarantee priority over earlier CLI/managed/project extensions or any earlier async `input` handler. Confirm effective load order before enabling idle wake. Reinstall and restart are needed to activate a changed operator setup; tests below do **not** change the operator's config.
- **Budgets and host controls:** at most **5 automatic idle starts per rolling 60s and 10 consecutive** per logical session, checkpointed in session history before attempted dispatch and restored on reload/resume; fork/new logical sessions have a separate budget. Only trusted interactive/RPC input resets consecutive, **not** the rolling timestamps. Peer/extension input and `/cct-wake resume` cannot reset budgets. A refused DM is not retried on time expiry or human reset: a **strictly newer chat DM** may be reconsidered when budgets permit; a still-exhausted budget advances the refusal watermark. The per-source refusal watermark is **in memory**, not checkpointed across reload; the rate/consecutive budget *is* restored, so reload is not an unconditional old-DM suppression guarantee. Failed/aborted attempted starts remain spent; invalid/unwritable budget checkpoints fail closed for idle starts, not busy/manual checks. `/cct-wake status|resume` concerns lifecycle visibility/rearm, not budget override or master opt-out. Host `CCT_OS_AUTO_WAKE=0` disables idle starts while retaining busy notices and always overrides the remote opt-in.
- **Broker locality:** idle wake defaults on only when matched fresh server metadata says the **resolved broker URL endpoint** is exact `localhost`, IPv4 `127/8` or IPv6 `::1`; remote/unknown/missing locality fails closed. Set `CCT_OS_AUTO_WAKE_REMOTE=1` in the **os host** to opt into remote idle wake (unless master-off). Endpoint locality is **not** authentication or a peer trust boundary: a LAN-bound broker reached through localhost or an SSH tunnel also appears local. Use host master opt-out on such hosts as appropriate. Manual reads and busy notices still work across remote brokers. Neither variable set only on the MCP child controls the host observer.
- **Trust:** peer text never grants human authorization, auto-reply rights or permission bypass. These limits bound CCT-triggered starts, not total inference or spending; usable model credentials are still required.

### Verification

```bash
npm run typecheck
npm test                         # private test broker; refuses an occupied port
CCT_TEST_PORT=0 npm test          # choose an ephemeral test port
python3 test-os-inbox-wake.py --primitive
python3 test-os-inbox-wake.py      # real CCT -> installed os -> synthetic provider -> inbox tool
python3 test-os-inbox-wake.py --tui
python3 test-os-inbox-wake.py --abort
python3 test-os-inbox-wake.py --opt-out
python3 test-os-inbox-hardening.py --case esc       # installed TUI Esc / bounded human recovery
python3 test-os-inbox-hardening.py --case order     # scratch install, actual slow input handler
python3 test-os-inbox-endurance.py --case budgets # strict newer DM and rolling/consecutive limits
python3 test-os-inbox-hardening.py --case preflight-auth
TEST_HOME="$(mktemp -d)"
env -i PATH="$PATH" HOME="$TEST_HOME" CCT_DIR="$TEST_HOME/.cct" \
  node --import tsx test-os-notification-server.ts # owned sibling/locality test broker
npx tsx test-os-notifications.ts                  # controller state machine
python3 test-os-inbox-endurance.py --case calibration # short calibration, NOT long acceptance
python3 test-os-inbox-endurance.py --case endurance   # 900s quiet + 7200s soak (private)
# or: bash test-os-inbox-endurance-run.sh (bounded runner with private receipts)
```

The installed-runtime harness uses an **installed os bundle**, private HOME/config/broker, owned process cleanup and synthetic provider; no external inference or real peer traffic. Its adapter is a privately staged source-only copy with offline dependencies (`CCT_OS_ADAPTER` selects source); manifests record actual loaded paths/hashes. Scratch `cct install --os`/ordering tests use only private config. This is **not** activation or validation of the operator's live adapter/config; verify effective ordering when activating separately. The final 900-second quiet-idle plus two-hour periodic/reconnect test **passed** on 2026-09-26: 102 delivery checks, 15 actual MCP reconnects, unchanged source digests and clean owned-process/peer cleanup. Private receipts are under `/private/tmp/cct-final-endurance.2u1rJx`; see `.planning/OS_INBOX_WAKE/ENDURANCE.md`. This is the full wall-clock run, not the short calibration.

## Process Lifecycle

MCP stdio servers are spawned per session. Codex registrations also include the host Codex PID, so an orphaned MCP process cannot keep a peer alive after the Codex process is gone. Three layers prevent orphaned processes from accumulating:

1. **stdin EOF/close** (instant) — when the host exits, the pipe closes and the server self-terminates
2. **Parent death monitor** (≤30s) — periodic PID check with start-time validation prevents false positives from PID reuse
3. **Idle timeout** (optional) — set `CCT_IDLE_TIMEOUT_MS` for a last-resort fuse; disabled by default since sessions can run for days

All cleanup is idempotent with a 5s force-exit deadline to prevent hanging on broker I/O.

## Security

- `~/.cct/` is `0700` — checked and corrected on every startup
- Local mode: broker listens on `127.0.0.1` only
- LAN mode: Bearer token auth on all endpoints except `/health`
- 32-char peer secret required for all mutations
- Atomic flag writes (temp file + rename), stale flags ignored after 30s
- Heartbeat-based cleanup for remote peers (45s timeout)
- Release votes use frozen voter snapshots — membership changes can't manipulate quorum
- Stale pidmaps from dead sessions cleaned on startup

## Requirements

- [Node.js](https://nodejs.org) 22+ with [tsx](https://tsx.is)
- Claude Code with MCP + hooks support, and/or
- Codex CLI v0.118+ with hooks enabled (`codex_hooks = true`), and/or
- os with pi-mcp-adapter installed separately (use `cct install --os`)

## Acknowledgments

CCT is built on ideas from [claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) by [@louislva](https://github.com/louislva), which demonstrated that a local SQLite broker + MCP server is sufficient for inter-session communication. CCT started as a fork of that architecture and diverged into pools, release consensus, busy signaling, LAN mode, and the hook-based delivery mechanism.

## License

MIT — Built by [Kevin Yar](mailto:kevin.yar@omics-os.com) for [Omics-OS](https://omics-os.com).
