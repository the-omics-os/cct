# CCT (Claude Code Talk)

Real-time inter-session communication for AI coding agents. Supports **Claude Code**, **OpenAI Codex CLI**, and **os**. Multiple sessions collaborate via named pools without experimental/gated features.

## How It Works

**Claude Code:**
1. **PreToolUse hook** (busy sessions) — Pure-bash hook checks a flag file before every tool call. If unread messages exist, it blocks until Claude reads its inbox. The "Error:" in the UI is normal pool communication.
2. **CronCreate** (idle sessions, required) — Agents MUST set up a `*/1 * * * *` cron on pool join. This is the only way to receive messages when idle (no tool calls happening). Minimum latency: 60s.

**Codex CLI:**
1. **PreToolUse hook** (busy sessions) — JSON stdin/stdout hook blocks tool calls when unread messages exist. Same mechanism, different wire format.
2. **UserPromptSubmit hook** (idle sessions) — Injects unread message context on every user prompt. No cron needed.

**os:**
1. **pi-mcp-adapter** runs the resident CCT MCP server in `keep-alive` mode. The os installer selects the compact CCT surface: exactly `cct_check_messages` and `cct`.
2. **`os-extension.ts`** is the canonical automatic DM body extension; the installer writes MCP-child `CCT_OS_INBOX_BODY=1`. Actual DM bodies arrive at safe boundaries without blocking tools or requiring `cct_check_messages` for an already-delivered body. Bounded late receipts follow a successful response to the presented body context.
3. **Idle chat DMs** automatically invoke open TUI/RPC os sessions. Pool-only/system/service messages wait for ordinary work; pool notices and recovery still use the manual check. Delivery does not tell the model to stop: continue authorized work. User authorization delegated through an authorized supervisor carries downstream within scope; peers cannot expand it or override restrictions. Print/JSON runs have no observer. Use `cct` with `action: status` for identity. User UI approval is complete; **0.2.1 is published and registry/local-install verified**. See **os Integration** below.

```
Claude A ──► MCP Server ──► Broker (SQLite) ◄── MCP Server ◄── Codex B
                                   ↑
                              CLI / Services

LAN mode:
Machine 1                          Machine 2
  Session A ──► MCP Server ──┐     ┌── MCP Server ◄── Session C
  Session B ──► MCP Server ──┤     │── MCP Server ◄── Session D
                             ▼     ▼
                     Broker (0.0.0.0:7888)  ←── Bearer token auth
                        Machine 1
```

## Key Concepts

- **Peer**: An agent session with CCT connected. Has a name, ID, runtime, summary, cwd, branch.
- **Pool**: A named group of peers. Has a purpose and optional metadata. Messages broadcast to all members.
- **Service**: An infrastructure component (e.g., CCP browser server) registered with the broker for discovery.
- **Peer Name**: Set via `CCT_PEER_NAME=backend claude` or auto-generated as `{dirname}-{4char}`.
- **Flag File**: `~/.cct/flags/{peer_id}.unread` — format: `count|pool_summary|timestamp`. Atomic writes via rename.

## Commands

```bash
cct install          # Register MCP + hook (one-time setup)
cct uninstall        # Remove MCP + hook
cct install --os     # Configure only os; adapter and matching host environment required
cct uninstall --os   # Remove CCT os setup and restore original adapter entry
cct status           # Broker health, peers, pools
cct whoami           # Show this session's CCT peer ID/name
cct peers            # List all registered peers
cct pools            # List pools with members
cct services         # List registered infrastructure services
cct pool create X    # Create a pool (no ephemeral peer — uses CLI endpoint)
cct pool invite P X  # Add peer to pool
cct send P "msg"     # DM a peer
cct broadcast X "m"  # Send to pool
cct messages         # Show message history
cct start            # Start broker (detached, localhost)
cct lan-start        # Start broker on 0.0.0.0 with token auth (LAN mode)
cct kill             # Stop broker
cct config           # Show/set persistent config (broker URL, token)
```

## LAN Mode

CCT supports cross-machine communication on a local network. One machine hosts the broker, others connect as clients.

**Configuration priority:** env vars > `~/.cct/config.json` > defaults.

| Setting | Env Var | Config Key | Default | Used By |
|---------|---------|------------|---------|---------|
| Broker bind address | `CCT_HOST` | — | `127.0.0.1` | broker.ts only |
| Broker port | `CCT_PORT` | — | `7888` | all |
| Broker connect URL | `CCT_BROKER` | `broker` | `http://127.0.0.1:7888` | server.ts, cli.ts |
| Bearer token | `CCT_TOKEN` | `token` | (none) | all |
| Idle timeout (ms) | `CCT_IDLE_TIMEOUT_MS` | — | `0` (disabled) | server.ts |

**Host setup:**
```bash
cct lan-start --token <shared-secret>
# Auto-detects LAN IP, prints client instructions
# Token is auto-generated if --token omitted
```

**Client setup:**
```bash
cct config set broker 192.168.x.x    # host's LAN IP
cct config set token <shared-secret>  # same token as host
cct install                           # propagates config to MCP env vars
# Restart Claude Code sessions
```

**Guard rails:**
- `cct start` / `cct kill` / `cct lan-start` are blocked when `CCT_BROKER` points to a remote host
- `server.ts` will not attempt to auto-launch a local broker when configured for remote
- `/health` endpoint is always unauthenticated (for probes and status checks)
- All other endpoints require Bearer token when `CCT_TOKEN` is set

**Stale peer cleanup on LAN:** The broker can't check remote PIDs, so it uses heartbeat age. Peers not seen for 3× the heartbeat interval (45s) are marked dead. Local peers are also cleaned up via PID check after 1× heartbeat interval.

## MCP Tools — legacy surface (Claude Code and Codex, 17 tools)

| Tool | Description |
|------|-------------|
| `cct_check_messages` | Deferred-ack read: peeks unread messages, acks previous batch. Updates flag. |
| `cct_whoami` | Show this session's CCT peer ID/name. Use this when asked for CCT identity; `CODEX_THREAD_ID` is not a CCT peer ID. |
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
| `cct_propose_release` | Propose releasing a peer. Starts democratic vote. |
| `cct_vote_release` | Vote yes/no on release proposal. |
| `cct_set_pool_idle` | Request pool throttle for deep work. Broker validates pool activity. |
| `cct_clear_pool_idle` | Clear pool throttle (setter only). Auto-clears on expiry/leave/new-chat. |
| `cct_self_terminate` | Kill own session (claude/codex). Shell survives. Requires reason. |

### Compact surface — os (2 tools)

`cct install --os` writes `CCT_TOOL_SURFACE=compact`. Claude Code and Codex remain on the legacy surface. The server selects compact only when `CCT_TOOL_SURFACE=compact`; unset or other values select legacy.

| Tool | Purpose |
|------|---------|
| `cct_check_messages` | Exact-named, zero-argument, always-eager recovery tool. Its description is static on both surfaces; output begins `you: <id>/<name>`. |
| `cct` | Flat-schema action dispatcher. `action` is required; per-action inputs are strictly validated. Unknown or irrelevant fields are rejected; there are no top-level schema combinators. |

Compact actions → legacy tools:

| Action | Inputs | Legacy equivalent |
|--------|--------|-------------------|
| `send` | `to`, `message` | `cct_send_message` |
| `status` | none | `cct_whoami` + own memberships from `cct_list_pools` |
| `peers` | none | `cct_list_peers` |
| `pools` | optional `pool` | `cct_list_pools`; with `pool`, `cct_pool_status` |
| `create` | `pool`, optional `purpose` | `cct_create_pool` |
| `join` / `leave` | `pool` | `cct_join_pool` / `cct_leave_pool` |
| `invite` | `pool`, `peer` | `cct_invite_to_pool` |
| `summary` | `text` | `cct_set_summary` |
| `idle` | `pool`, `minutes`; optional `reason`, `force` | `cct_set_pool_idle` |
| `resume` | `pool` | `cct_clear_pool_idle` |
| `release` | `pool`, `peer`; optional `reason` | `cct_propose_release` |
| `vote` | `release_id`, `vote` | `cct_vote_release` |
| `services` | optional `service_id` | `cct_list_services` |
| `terminate` | `reason` | `cct_self_terminate` |

See `shared/constants.ts` and `shared/compact.ts` for exact fields and validator error strings. Compact tool descriptions and instructions are static because adapter metadata is cached across sessions; get identity from `cct` with `action: status`. The status output starts with your identity and displays up to 20 members per pool.


## Project Structure

```
cct/
  broker.ts              HTTP broker + SQLite (29 endpoints, 7 tables, transactions)
  server.ts              MCP stdio server (17-tool legacy surface; 2-tool compact os surface; runtime detection, deferred ack, orphan prevention)
  cli.ts                 CLI (runtime-scoped installer for Claude, Codex, and os)
  os-extension.ts        Canonical os identity and automatic DM body delivery
  os-mcp-extension.ts    Release-owned outgoing wrapper delegating original adapter
  hook.sh                Claude Code PreToolUse hook (pure bash, <10ms, stale detection)
  hook-codex.sh          Codex PreToolUse hook (JSON stdin/stdout, <10ms, session_id lookup)
  prompt-codex.sh        Codex UserPromptSubmit hook (idle delivery via additionalContext)
  session-start-codex.sh Codex SessionStart hook (identity bridge: session_id → peer_id)
  test-integration.sh    Integration tests (135 checks; private broker, refuses occupied ports)
  test-compact-surface.ts Compact schemas, validation, mapping, status, and MCP surface tests
  test-os-extension.ts   Canonical os extension wiring checks
  test-os-inbox-pump.ts  Automatic body controller (62 checks)
  test-os-inbox-server.ts Private broker/MCP body and receipt gates
  test-os-inbox-installer.py Isolated canonical installer gates
  test-os-inbox-body.py  Installed RPC actual-body delivery acceptance
  test-os-inbox-lifecycle.py Installed TUI Esc, restart, compaction and reload
  test-os-notifications.ts Historical D18 one-shot controller
  test-os-notification-server.ts Sibling-MCP ownership/check/cache-failure regressions
  test-os-inbox-wake.py   Historical D18 notice/wake acceptance
  test-os-inbox-hardening.py Historical D18 hardening acceptance
  test-os-inbox-endurance.py Historical D18 quiet/soak harness
  test-os-inbox-endurance-run.sh Bounded long-run runner with private receipts
  test-os-compact-installer.py Isolated compact os installer settings and idempotence
  test-os-compact-live.py Installed os compact-surface acceptance with a synthetic provider
  test-compact-packed.ts Packed-artifact acceptance for compact tools
  test-compact-measurements.ts Schema and compact output measurement gates
  test-os-compact-terminate.ts Safe terminate-path test with a fake host
  test-codex-session.ts  Unit tests for codex session/fork-chain resolution
  test-codex-identity-e2e.sh  E2E: fake codex host + real server.ts, stable id across resume (port 17889)
  test-os-identity-e2e.sh E2E: os marker, fallback, MCP siblings, compact surface, and resume (default port 17890)
  test-os-runtime-live.py Installed os acceptance with a local synthetic provider (15-minute idle check)
  test-os-autostart.py    Installed os automatic registration, session changes and recovery
  test-os-install-autostart.py Scoped installer upgrade and idempotent reinstall checks
  test-fixtures/os/      Local provider and safe runtime observations for installed-os acceptance
  shared/
    types.ts             TypeScript interfaces
    constants.ts         Ports, paths, timeouts, and compact action definitions
    compact.ts           Compact schema, validation, dispatch mapping, and status formatter
    os-adapter-config.ts Original factory verification and per-profile wrapper state
    os-cct-send-renderer.ts Display-only outgoing CCT cards
    os-inbox-renderer.ts  Display-only incoming sender/body cards
    summarize.ts         Git-based summary generation
    codex-session.ts     Codex session id + fork-chain root resolution from rollout transcripts
  package.json
  tsconfig.json
```

## Broker Endpoints

**Peers:** `/register`, `/heartbeat`, `/unregister`, `/set-summary`, `/list-peers`
**Pools:** `/pool/create`, `/pool/join`, `/pool/leave`, `/pool/invite`, `/pool/list`, `/pool/members`, `/pool/status`, `/pool/update-metadata`, `/pool/set-idle`, `/pool/clear-idle`
**Messages:** `/message/send`, `/message/poll`, `/message/read`, `/message/check` (atomic), `/message/peek` (read-only, deferred ack), `/message/unread-count`
**CLI (no auth):** `/pool/create-cli`, `/pool/invite-cli`, `/message/send-cli`, `/message/history`
**Services (no auth):** `/service/register`, `/service/heartbeat`, `GET /services`
**System:** `GET /health`

## Design Documents

Core design documents live in `cct/`:
- `ARCHITECTURE.md` — **Design decisions D1-D19.** D16 records os integration; historical D18 notice/wake is superseded by canonical D19 body delivery and the release-owned outgoing wrapper.
- `DM_BODY_PROTOTYPE.md` — Current automatic-body contract and compatibility limits.

Release notes live in `CHANGELOG.md`. The existing `v0.2.0` tag must not be
moved or overwritten; the new release targets `v0.2.1`. Preserve the existing
OpenCode Phase 1 identity work without advertising complete OpenCode delivery,
installer or feature support.

## Pool Lifecycle

Delivery is runtime-specific; do not set up a cron for every CCT runtime:

| Runtime | While busy | Idle / pool polling |
|---------|------------|---------------------|
| **Claude Code** | PreToolUse hook blocks ordinary calls with unread messages. | Set up one CronCreate job at `*/1 * * * *` while in any pool; its prompt calls `cct_check_messages`. Cancel it via CronList + CronDelete after leaving the last pool. |
| **Codex CLI** | PreToolUse hook blocks ordinary calls. | UserPromptSubmit hook delivers on the next prompt; no cron setup. |
| **os** | Actual DM bodies at safe boundaries; ordinary tools continue. | Eligible chat DMs start open TUI/RPC sessions with bodies; pool-only waits for ordinary work. No cron. |

Claude Code join/create responses include the cron reminder; leave responses check remaining pools and prompt for cleanup when the last pool is left. Codex and os receive their corresponding hook/extension delivery instructions.

**Idle delivery:** MCP alone does not schedule a model turn. Claude Code's CronCreate bottoms out at 60s; Codex waits for the next prompt. os's local extension observes the private body feed and invokes existing os custom-message/boundary APIs for eligible chat DMs. No PTY launcher or os-core patch is required. PTY wrapping for other runtimes remains a proposal, not implemented functionality.

**Stable identity (all three runtimes):** The CCT peer ID/name is anchored to a stable session key so it survives MCP restarts, `/mcp` reconnects, and network transitions (e.g. a Wi-Fi change that lets the broker mark the peer dead). Claude uses `CLAUDE_CODE_SESSION_ID`; Codex uses `codex-root:<root session id>`, resolved from codex's rollout transcripts because **codex never exports its session id into MCP server env** (see below and ARCHITECTURE **D11c**). os uses `os:<session id>` from its extension-owned marker (D16). The broker de-dupes registrations on `(runtime, session_key)` and revives the same row (same id/secret/name) even if it was marked dead — **and restores the pool memberships that death dropped** (via `died_at`/`left_at` pairing), so the reclaimed peer isn't silently mute in its pools. `server.ts` recovers in place on a `peer not found` heartbeat instead of exiting, but only while the host process is alive (checked in `reregister`, so a genuine orphan is not resurrected). Peers with no session key fall back to legacy ephemeral (new id per registration). Limitations: a *dead* stdio MCP process still needs its runtime to reconnect; two live sessions sharing one `CLAUDE_CODE_SESSION_ID` collapse to one row. See ARCHITECTURE **D11b**.

## Codex CLI Integration

CCT supports OpenAI Codex CLI as a first-class runtime. `cct install` auto-detects Codex and configures it.

**Runtime detection:** `CCT_RUNTIME=codex` env var (set by installer in `~/.codex/config.toml`).

**Peer naming:** Codex peers auto-name as `codex-XXXX` (vs `dirname-XXXX` for Claude).

**Identity model:** Codex uses session-keyed broker registration plus session_id-based pidmaps (`~/.cct/pidmaps/codex_{session_id}`) instead of PID-based identity. ⚠️ **Codex does not put `CODEX_THREAD_ID`/`CODEX_SESSION_ID` in an MCP server's environment** — it only injects them into shell/exec tool environments, so the `env_vars` list in `config.toml` forwards nothing and every codex peer used to register with `session_key = NULL` (fresh CCT id on every MCP respawn). The session id is therefore resolved from codex's own transcripts in `~/.codex/sessions/**/rollout-*.jsonl` (`shared/codex-session.ts`): env → `resume <uuid>` on the host command line → newest rollout matching the session cwd, then `forked_from_id` is followed to the **root** of the fork chain, giving `session_key = codex-root:<root_id>`. Root, not current id, because codex mints a new session id whenever it forks on compaction. Unresolvable → `codex-host:<host_pid>_<host_pid_start>`, which still survives MCP respawns within one codex process. `/register` also reaps active codex peers sharing a `host_pid`, since codex respawns MCP servers without always killing the old one. The pidmap key stays the **current** session id (what hooks see on stdin), while SessionStart/Prompt/PreToolUse hooks keep `session_id → peer_id` fresh from the MCP marker (`codex_mcp_{pid}`). `CODEX_THREAD_ID` is never the CCT address; use `cct_whoami`, `cct whoami`, `cct_list_peers`, or the peer name/ID shown by those commands.

**Critical identity rule:** If a Codex agent is asked "what is your CCT ID?", it must call `cct_whoami` or `cct_list_peers` and report the CCT peer ID/name, for example `9a2b01d7` / `codex-vnni`. It must not inspect env vars and return `CODEX_THREAD_ID`; other peers cannot invite or DM that value. After upgrading an installed Codex integration, run `cct install` and restart Codex sessions so `env_vars` and the new hooks are active. Keep Codex pidmap/flag reads tolerant of files without trailing newlines, because CCT writes these marker files with `printf`/`writeFileSync` and no newline. Duplicate MCP servers for one Codex session must converge on one peer row; stale duplicate processes must not unregister the current peer.

**Message delivery:**

| State | Claude Code | Codex CLI | os |
|-------|-------------|-----------|----|
| Busy (tool calls) | `hook.sh` blocks, text output | `hook-codex.sh` blocks, JSON output | Actual DM bodies at safe boundaries; no tool block |
| No current turn | CronCreate 60s polling | `prompt-codex.sh` injects on next prompt | Chat DM invokes open TUI/RPC; pool-only waits for ordinary work |

**Config location:** `~/.codex/config.toml` — `[mcp_servers.cct]` + `[[hooks.*]]` sections.

**No cron in Codex:** Codex has no CronCreate equivalent. The server instructions are conditionalized — Codex agents are told messages arrive via hooks automatically.

## os Integration

Install the unmodified `pi-mcp-adapter@2.33.0` separately, outside global
`extensions/`, and enable its original `index.ts` or single-factory directory
as exactly one string entry in global `settings.extensions`. Use the same
environment for the os host and the CCT installer:

```bash
export PI_CODING_AGENT_DIR="${OS_CODING_AGENT_DIR:-$HOME/.os/agent}"
export PI_MCP_CONFIG_MODE=exclusive
cct install --os
os
```

The host must retain these values; launcher settings do not export them back to
the installer shell. The installer prints resolved settings, MCP config,
cache/onboarding and wrapper-state paths and refuses writes under `.pi`.
Runtime flags can be combined; without flags, installation selects Claude plus
detected Codex/os. `--project` applies only to Claude.

The outgoing formatter is shipped as CCT's `os-mcp-extension.ts`, which delegates
to the verified original `pi-mcp-adapter@2.33.0` factory. No os-core or third-party
file edits are required. The installer replaces the original entry at its slot,
puts the body extension first and preserves unrelated relative order. Per-profile
`cct-adapter.json` beside settings records the exact original entry and canonical
factory path, outside autoextensions. Uninstall restores that original entry and
removes owned state. Never enable original adapter and wrapper simultaneously.

Initial support is limited to a sole verified explicit global file/directory
entry. Package, autoextension, CLI and project adapter activation is unsupported.
Known package/autoextension activation, ambiguity, invalid versions or conflicting
state fails before config writes. If no identifiable explicit entry exists, the
installer reports missing outgoing-wrapper capability and leaves adapter behavior
unchanged; it does not acquire or activate an adapter for you.

**Source metadata limitation:** all delegated MCP tools and commands carry the
wrapper's `sourceInfo`, including non-CCT registrations. Public extension APIs
cannot preserve original adapter provenance. Execution, schemas and non-CCT
renderers remain unchanged; the wrapper is presentation-only.

Required CCT adapter settings are `lifecycle: "keep-alive"`,
`directTools: true`, `toolPrefix: "none"`, `env.CCT_RUNTIME: "os"`, and
`env.CCT_TOOL_SURFACE: "compact"` and `env.CCT_OS_INBOX_BODY: "1"`.
The installer selects canonical `os-extension.ts`, replacing duplicate canonical/
prototype entries; never load it alongside `os-inbox-extension.ts`.
`PI_MCP_CONFIG_MODE=exclusive` avoids importing other clients' MCP configurations.
After installation, start a new os session. Registration starts automatically
with either a cold or warm cache; no model call or `/mcp reconnect cct` is
normally required. Direct tools become available after discovery: the active
CCT tools are `cct_check_messages` and `cct`. Body delivery requires fresh
session/peer/producer-matched `.os-inbox` data; missing/stale data retains manual
recovery without acknowledging messages. Already-delivered bodies need no check.
Ordinary tools are never blocked by the os extension. Use
`cct` with `action: status` to get the CCT peer ID/name, runtime, identity key,
and pool status. `cct_check_messages` remains the exact-named, zero-argument
recovery tool and prefixes its results with `you: <id>/<name>`.

The compact tool descriptions and instructions are static across sessions
because the adapter metadata cache is shared. Do not put per-session peer
identity in tool descriptions or instructions; retrieve it from
`cct` with `action: status`. The recovery tool description is static on both
compact and legacy surfaces. The adapter's load-time connection is superseded
by its session connection. Multiple startup launches are expected; they must
settle to one live MCP process and one active peer for the host. Explicit global
extension load order matters: `cct install --os` places the canonical CCT
extension first in `settings.extensions`, de-duplicates it and preserves all
other entries' relative order. This lets its synchronous human-input reservation
precede later global async handlers (including the adapter). Earlier CLI,
managed or project handlers can still run first; check the effective host order.
`eager` also starts automatically but does not reconnect after a server exit.

**Identity model:** `PI_SESSION_ID` exists in os's bash child environment, but is
absent from the host and MCP child environments. The extension writes
`~/.cct/pidmaps/os_session_<hostPid>` → session ID (file A); the MCP server writes
`os_<sessionId>` → `peerId|name|producer|ownerStart` (file B; fourth field may be empty; first two fields unchanged and producer os-only). Extension shutdown removes only A; MCP
cleanup owns B. The CLI walks this ancestry even when a bash child has
`PI_SESSION_ID`. Neither `PI_SESSION_ID` nor `CODEX_THREAD_ID` is a CCT address:
in os use `cct` with `action: status`; legacy Claude/Codex use `cct_whoami` or
`cct whoami`.

Missing markers degrade to `os-host:<pid>_<start>` with a diagnostic. The
compact `cct` action `status` reports the source and key; legacy `cct_whoami`
reports it on Claude/Codex. Adapter `debug: true` also forwards the child's
stderr diagnostic. Without B, the extension reports direct-inbox unavailability and allows tools. Distinct resolved os session IDs remain distinct; a weak host
key may be upgraded when the marker becomes available.

The resident server polls every two seconds; only the producer named in B
publishes the mode-0600 `.os-inbox` body feed in the private mode-0700 directory.
Automatic owner takeover requires a successful peek, B recheck and verified
exit/PID reuse; stale/missing metadata, a stalled live PID or unknown process
identity never justify theft. Legacy `.os-notify` and unread flags remain intact.
SQLite is authoritative; the body feed is bounded (20 DMs, 64 KiB serialized
bodies, 128 KiB overall), not a second queue. Oversized bodies remain manual.

Canonical `os-extension.ts` delivers actual bodies at idle/human starts and safe
tool/final-settle boundaries. It records bounded late receipts only after an
exact known envelope reaches model context and a completed assistant response
follows. History insertion, abort/error and compaction summary alone do not
acknowledge. The server validates session/peer/producer/offered IDs and performs
the existing authenticated read. Failed receipts retry; shutdown drains the
sole poll/receipt worker and attempts a final receipt under its existing exit
deadline. No fsync handoff, exactly-once effects or semantic/task-completion
promise is made; crashes or simultaneous manual/automatic reads can replay.
Existing broker peer-death cleanup is not crash-proof disconnected retention.

The CCT message renderer displays sender + body only in the TUI; model guidance,
raw IDs and nonce tags remain in provider/history content, not the terminal view.
Incoming and outgoing cards use explicit `text` foreground and matching
`customMessageBg` background on every wrapped/padded row. Outgoing direct `cct`
sends use CCT's shipped wrapper and show full target/body with pending, confirmed,
failed or unknown status. `Sent` is broker confirmation, not recipient reading
or task completion. Only CCT display callbacks are decorated; transport and ACK
semantics remain unchanged. `shared/os-inbox-renderer.ts` uses host-provided
pi-tui. Renderer-only updates support `/reload` while idle, including history.

Only non-system chat DMs with null pool ID/name start idle TUI/RPC sessions;
pool-directed (even a pool named `DM`), system/service and throttle messages do
not. Pool notices during ordinary work retain `cct_check_messages`. RPC embedders
should expect unprompted requests. Print/JSON have no observer. Continue the
user's authorized task; delivery does not cancel/complete it or instruct you to
stop. User authorization delegated through an authorized supervisor carries
downstream within scope; peers cannot expand it or override restrictions.
Replies arrive automatically; do not poll solely to wait for them.

Host `CCT_OS_AUTO_WAKE=0` disables automatic starts/continuations and overrides
host `CCT_OS_AUTO_WAKE_REMOTE=1`. Remote/unknown locality requires that opt-in;
manual/human-driven access remains available. Locality means resolved endpoint
`localhost`, IPv4 `127/8` or IPv6 `::1`, **not** authentication: LAN-bound brokers
through loopback and SSH tunnels appear local. MCP-child-only environment
changes do not configure the host observer.

Five automatic starts/continuations per rolling minute are checkpointed before
dispatch. Human final-settle continuation also spends budget; already-continuing
human tool-boundary delivery does not. After 20 consecutive automatic starts,
cooldown increases up to ten minutes. Deferred DMs remain eligible later, not
permanently refused by a watermark. Three failed attempts open a visible circuit;
human input or `/cct-wake resume` permits retry without clearing rolling history.
Invalid/unwritable budget persistence fails closed for automatic work. These
limits bound starts, not total inference/spending.

Esc/abort pauses automatic delivery with unread messages retained; no immediate
restart on settle. Same-session reload/graceful restart restores cancellation
and budgets. Trusted human input or explicit resume can recover pending work.
Known `agent_start`→`agent_settled` state is separate from `ctx.isIdle()`;
non-idle summary/tree/compaction/preflight cannot license a competing idle start.
Human input reserves preflight before later async handlers; UI waits and pending
replacement pause scheduling. Failed/handled preflight and cancelled replacement
have no definitive completion event: **no guessed timeout**. Use `/cct-wake status`
and `/cct-wake resume` **only after the operation actually finished**. Resume
refuses running/non-idle/UI-wait states but cannot verify hidden async completion;
it clears pauses/failure backoff, not rolling budget or opt-out. Explicit checks
remain available. No closed-process wake or permission bypass.

Recorded acceptance covers controller, private-server receipt and isolated
installer gates; installed RPC body payloads; and real TUI Esc, restart,
compaction, reload, light/dark cards and restored history. Real-model exchanges
verified automatic bodies, scoped delegated continuation, late acknowledgment
and no model inbox-tool calls. **The user personally confirmed UI readability;
no further UI approval is pending.** Version 0.2.1 is published and verified
from the npm registry; local installation uses the shipped wrapper without
third-party source edits. D18 tests are historical, not
current body-delivery acceptance. No long body soak is claimed. Contract and
remaining context-order/old-host/provider-retry limits:
`cct/DM_BODY_PROTOTYPE.md` and README.

Run `npm run test:os-identity` for source identity checks. Installed-runtime
acceptance requires an installed os launcher and adapter:

```bash
export CCT_OS_ADAPTER=/absolute/path/to/pi-mcp-adapter/index.ts
python3 test-os-autostart.py
python3 test-os-install-autostart.py
python3 test-os-runtime-live.py
```

The default idle interval is 900 seconds; setting `OS_IDLE_SECONDS` lower is only
a calibration run. The harness uses an isolated broker and synthetic HOME,
records the actual flags and peer rows, and sends only local fixture messages.
Use distinct `CCT_OS_TEST_PORT` values when running alongside other E2E tests.
An npm upgrade can replace the local os launcher symlink; reapply the launcher
and verify its Q7 environment after upgrading.

## Compact Surface Measurements

PHASE_3 acceptance measured **1,244 B** for the two eager compact schemas
(`cct`: 1,046 B; `cct_check_messages`: 198 B), versus **5,441 B** for the 17
legacy eager schemas. The first synthetic-provider request was **15,100 B** on
compact versus **20,730 B** on legacy. A compact status response for a
25-member pool was **456 B** (displaying up to 20 members plus an overflow
count). These are local synthetic-provider measurements, not external model
or HTTP wire measurements. `test-integration.sh` now reports 135 checks, including notification regressions. PHASE_3
acceptance recorded 14/14 passing rows, including Codex session 15/15, Codex
identity 8/8, Codex concurrent MCP 9/9, and the isolated os compact-surface,
installer, extension, packed-package, measurements, and termination checks.

## Peer Resolution

Both server.ts and cli.ts support flexible peer addressing:
1. **Exact match** on full peer ID or peer name (priority)
2. **Exact pair** `id/name` or `name/id`, as printed by `cct` `status` and member lists (server.ts only; both halves must name the same peer)
3. **Prefix match** on peer ID (minimum 4 characters)
4. **Prefix match** on peer name

Examples: `aaccacce` (full ID), `aaccacce/ccp-ftts` or `ccp-ftts/aaccacce` (pair), `aacc` (4-char prefix), `ccp-ftts` (full name), `ccp-` (name prefix). In pool-directed sends, `@pool/<peer>` accepts the same forms, e.g. `@pool/ccp-ftts/aaccacce`.
Ambiguous matches return all candidates with IDs for disambiguation.

## Status Line Integration

CCT state is exposed in the Claude Code status line (`~/.claude/statusline.sh`):
- Reads `~/.cct/pidmaps/` to resolve current session's peer ID
- Reads `~/.cct/flags/{peer_id}.unread` for pool memberships and unread counts
- Format: `CCT:dd5c @pool(N) ✉` — peer ID prefix, pools with unread counts, total unread
- Refreshes every 10s via `refreshInterval` setting
- Graceful degradation: shows `CCT:off` if CCT not installed, `CCT:—` if no pidmap match

Optional os identity displays can read file B's first two fields (`peerId|name`)
and must tolerate trailing producer/start metadata. They are read-only consumers,
not peer registrants. Use `cct` action `status` for authoritative identity;
`/mcp reconnect cct` inside os remains manual recovery.

## Process Lifecycle (Orphan Prevention)

MCP stdio servers are spawned per Claude Code/Codex/os session. When sessions end, the server must self-terminate. Codex and os registrations include both the MCP server PID and the host PID so an orphaned MCP server cannot stay visible after its host exits. Three layers ensure no orphaned processes accumulate:

| Layer | Mechanism | Latency | Signal |
|-------|-----------|---------|--------|
| 1 | **stdin EOF/close** | Instant | Claude Code exits → pipe closes → `process.stdin.once('end'/'close')` |
| 2 | **Host death monitor** | ≤30s | `kill(hostPid, 0)` + PID start-time validation every 30s (`claude` for Claude Code, `codex` for Codex CLI) |
| 3 | **Idle timeout** | Configurable | `CCT_IDLE_TIMEOUT_MS` env var, disabled by default (sessions can run for days) |

All triggers route through `requestCleanup(reason)` — idempotent guard prevents double cleanup. A 5s force-exit deadline prevents hanging on broker I/O during cleanup. Cleanup unregisters from broker, clears pidmap/flag files, and exits.

## Rules

1. **ARCHITECTURE.md is the source of truth** for design decisions.
2. **SQLite is the only message store.** Flag files are derived caches, not authoritative.
3. **Hook must be pure bash.** No python, no curl, no jq. Target <10ms.
4. **Never block CCT tools or ToolSearch** in the hook — prevents infinite loops.
5. **Peer secrets required** on all mutating peer endpoints. CLI endpoints and service endpoints are unauthenticated (localhost only). **In LAN mode, Bearer token protects all endpoints except `/health`.**
6. **~/.cct/ directory must be 0700.** Permissions are checked and corrected on startup.
7. **All multi-step mutations use transactions.** Pool create/join/invite, message send, peer death — all atomic.
8. **read_at is the only message state.** NULL = unread. No delivered/ack states.
9. **Flag file format is `count|pool_summary|timestamp`.** Atomic writes via temp+rename. Hook ignores stale flags (>30s).
10. **CLI never creates ephemeral peers.** Uses dedicated `-cli` broker endpoints.

## Runtime Directory

```
~/.cct/                    0700
  cct.db                   SQLite database (6 tables)
  config.json              Persistent config (broker URL, token) — not committed
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

Service discovery does not require CCP to be installed; CCT remains independent.

## Sister Projects

CCT is part of a five-tool ecosystem for Claude Code agent infrastructure. Each works independently but they collaborate when co-present.

| Project | What | Port | Runtime Dir | Repo |
|---------|------|------|-------------|------|
| **CCT** (this) | Agent-to-agent messaging + service discovery | `:7888` | `~/.cct/` | `~/omics-os/cct/` |
| **CCP** | Session-aware Playwright browser multiplexer | `:8931` | `~/.ccp/` | `~/omics-os/ccp/` |
| **CCC** | Secure peer-to-peer protocol library (identity, signing, encryption) | — | `~/.ccc/` | `~/omics-os/ccc/` |
| **CCI** | Browser → source code bridge (React component inspection, CCP plugin) | — (CCP plugin) | `~/.cci/` | `~/omics-os/cci/` |
| **CCS** | Session + plan search CLI | — (no network) | `~/.cache/ccs/` | `~/omics-os/ccs/` |

**CCT → CCP:** CCT provides the service registry that CCP registers with on startup. Agents discover CCP's health via `cct_list_services`. The `@browser` pool (created by agents, not CCP) enables browser testing coordination. CCP is a service, not a peer — it uses unauthenticated `/service/*` endpoints only.

**CCT → CCC:** CCT uses CCC as its protocol library for cross-machine secure communication. CCC provides identity (ed25519 keypairs), signed envelopes, encrypted messages, pairing, and transport. Dependency direction: CCT → CCC (never reverse). CCC never imports CCT.

**CCT → CCI (none):** CCI is a CCP plugin. CCT has no direct interaction with CCI. Agents could optionally broadcast CCI selections to a CCT pool, but this is not implemented.

**CCT → CCS:** CCS can index CCT pool activity and message history for searchability. CCT's SQLite DB (`~/.cct/cct.db`) is a potential CCS data source. No integration exists yet — CCS currently indexes only `~/.claude/` sessions and plans.

**Design rule:** CCT never depends on CCP, CCI, or CCS. It provides infrastructure (messaging, service discovery) that others consume optionally. CCT depends on CCC only for the cross-machine protocol layer.

## Dependencies

- `@modelcontextprotocol/sdk@1.30.1` — MCP server framework (exact runtime pin)
- `node:sqlite` — Database (Node.js built-in, zero deps)
- Runtime: Node.js **22.19.0 or newer** with `tsx@4.23.15` (exact runtime pin)
- os presentation wrapper: separately installed original `pi-mcp-adapter@2.33.0`
- No external API dependencies
