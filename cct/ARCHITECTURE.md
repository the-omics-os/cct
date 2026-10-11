# CCT Architecture — Design Decisions

Core design date: 2026-04-19. Current release target: 0.2.1.
Status: design authority; user UI approval complete, release publication and
verification in progress. D16–D19 extend the original Claude-only design.
The existing `v0.2.0` tag is preserved, not overwritten.

## Design Decisions (resolved)

### D1: Delivery model
**Decision: Stock Claude Code only. Next-tool-boundary delivery. Idle delivery is best-effort via cron.**

The research proves no MCP-native push exists for API auth. PreToolUse hook is our primary delivery. CronCreate is best-effort for idle sessions — we tell Claude to set it up in MCP instructions, but correctness never depends on it. If Anthropic unblocks `claude/channel` later, we add it as an accelerator — the architecture doesn't change.

### D2: Single source of truth
**Decision: SQLite broker only. No file-based message queues.**

The broker owns all state: peers, pools, memberships, messages. The hook does NOT read inbox bodies or curl the broker. Instead, the **MCP server writes a derived flag** (`~/.cct/flags/{peer_id}.unread`, containing `count|pool_summary|timestamp`) whenever it polls the broker. The hook reads this small file and ignores stale flags. The MCP server keeps the flag in sync; SQLite remains authoritative.

Flow:
```
Broker (SQLite) ←── MCP server polls every 2s ──→ ~/.cct/flags/{peer_id}.unread
                                                        ↑
                                               Hook reads this file
```

This provides one authoritative store and a fast hook (<10ms target). Flags
and D19's bounded body/receipt files are derived coordination data, not durable
message queues or an exactly-once guarantee.

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

The database stores `read_at` (nullable); unread = `read_at IS NULL`. The MCP
recovery tool uses deferred acknowledgement: on a successful check, it marks
messages returned by the prior check as read, then peeks and returns currently
unread messages. If a prior check result was not consumed by the agent, those
messages remain unread until the next check. The hook checks the unread count,
not delivery state. This keeps durable message state simple while avoiding
lost reads when a tool result is swallowed. D19 adds automatic os response
receipts that set the same `read_at`; no delivery state is added.

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
- **`cli.ts` (`cct whoami` from a bare shell) still resolves identity via pidmap process-ancestry, not the session key.** Works for shells descended from the Claude host; a detached shell that only has the env var can't resolve the peer. Low impact — `cct_whoami` and `cct_list_peers` are authoritative for Claude/Codex; os compact sessions use `cct` with `action: status` for their identity.

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
- On registration, the broker mints a `peer_secret` (32-char random). Mutating
  peer endpoints authenticate it; localhost CLI/service endpoints are separate.
- LAN mode requires a Bearer token on all endpoints except `/health`. Loopback
  locality does not authenticate a peer or authorize delegated work.
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
**Decision: Required agent setup for Claude idle delivery; timing is best-effort.**

Claude pool members set up one `*/1 * * * *` CronCreate inbox check and remove it
after leaving their last pool. This is the only idle delivery path for Claude;
while busy, the hook still covers the next tool boundary. Cron is not a durable
scheduler or hard latency guarantee. Codex uses prompt hooks, and os D19 uses
its open-session observer; neither requires Claude cron.

### D16: os runtime through pi-mcp-adapter and a local extension

**Decision (2026-09-13):** os is the third runtime. pi-mcp-adapter runs the
resident CCT MCP server; `os-extension.ts` supplies identity and delivery hooks.
D19's current contract is documented in [DM_BODY_PROTOTYPE.md](DM_BODY_PROTOTYPE.md).
This entry specifies os behavior; earlier prototype descriptions above must not
override the later contracts.

**Transport and ownership.** CCT's HTTP wire protocol does not require MCP:
`cli.ts` is already a non-MCP client. A resident process sending heartbeats is
required, because the broker reaps stale heartbeats even if the host PID exists.
Path A was selected because os needs MCP independently and should expose
`cct_check_messages` as a real tool. A CCT-owned broker client in the extension
would introduce a second registrant whose identity could drift. Reproducing
message reads without MCP would also require a CLI acknowledgement command and
special handling of bash command strings. The original D16 extension therefore made no broker calls or acknowledgments;
D19 adds bounded response receipts through the private file channel.

**Environment variables must be checked individually.** os's branding is
intentionally inconsistent across variables. The measured installed bundle
provides `PI_SESSION_ID` and `PI_SESSION_FILE` only in the local environment
object passed to its bash child (`src/core/tools/bash.ts:174-183`). They are
absent from the os host and adapter-spawned MCP process. Adapter `inheritEnv`
cannot forward a variable absent from `process.env`.

| Variable | Definition | os behavior |
|---|---|---|
| `PI_SESSION_ID`, `PI_SESSION_FILE` | Hardcoded in `bash.ts` | Remain `PI_*`, bash child only |
| `ENV_AGENT_DIR`, `ENV_SESSION_DIR` | Computed from `APP_NAME`, `config.ts:516-517` | Become `OS_*` |
| `PI_PACKAGE_DIR` | Hardcoded in `config.ts:399` | Remains `PI_*` |

**Identity uses two files in the private CCT pidmap directory.**

| File | Contents | Writer and cleanup owner |
|---|---|---|
| A: `os_session_<osHostPid>` | os session ID | Extension `session_start` / `session_shutdown` |
| B: `os_<sessionId>` | CCT peer ID and PID-map metadata | `server.ts` registration / final connection cleanup |

File A is mode 0600 in a 0700 directory. `server.ts` resolves the os ancestor,
reads A with bounded retries, and registers `runtime: "os"` with
`session_key: "os:<sessionId>"`. B follows the existing peer-ID pidmap contract
used by CLI/hook/status consumers; combining A and B would mix an input owned
by the host with an output owned by its MCP child. The extension removes only A.
The CLI follows A → B even when a bash child has `PI_SESSION_ID`, and never
falls through to an inherited Codex mapping when A identifies os but B is absent.

Missing A produces `os-host:<pid>_<start>` and a `source=fallback` diagnostic;
the server remains usable. Identity is available through `cct` action `status`
on the compact os surface (or `cct_whoami` on legacy surfaces), even if adapter
stderr forwarding is disabled (`debug: true` forwards it). Duplicate live MCP
connections share one peer without retiring one another. A weak host key may
adopt/upgrade a resolved key for the same live host; two different resolved
`os:<sessionId>` keys never collapse merely because they share an ancestor.
Stable-key revival reuses the existing membership restoration transaction.

**Adapter settings are a functional requirement.**

| Setting | Required value | Failure prevented |
|---|---|---|
| `lifecycle` | `keep-alive` | Starts automatically even with warm metadata and reconnects a failed local MCP process; `lazy-keep-alive` waits for first use with warm metadata, and `eager` does not reconnect |
| `directTools` | `true` | Tools otherwise remain behind the `mcp` proxy |
| `toolPrefix` | `"none"` | Default `"server"` exposes `cct_cct_check_messages`, making an unprefixed block reason unusable |
| `env.CCT_RUNTIME` | `"os"` | Explicit runtime classification independent of inherited Codex environment |
| `env.CCT_TOOL_SURFACE` | `"compact"` | Selects the two-tool os surface; the unset/default surface remains legacy |
| `env.CCT_OS_INBOX_BODY` | `"1"` | D19: enables bounded body publication and response receipts |

**Lifecycle revision (2026-09-18):** automatic connection replaces the original
`lazy-keep-alive` decision, which left warm sessions unregistered until first use.
The verified `pi-mcp-adapter@2.33.0` factory initializes at load time and again
at session initialization, which supersedes the first connection. Observing two
startup launches alone does not establish a surviving duplicate. Acceptance
covers cold/warm caches, surviving processes/peer rows, session changes and recovery.

Use the adapter's existing `keep-alive` setting; no adapter patch is required.
D19's installer puts canonical CCT first among explicit global entries. Connections must settle to one live MCP process and one
active peer per host, with the resolved session key. The installer persists the
setting without changing other clients' configuration. The footer remains a
reader of A and B. No timeout is claimed to make every marker race impossible;
delayed and absent-marker controls exercise the fallback.

**Historical blocking contract (superseded by D18 for os).** os `tool_call` handlers must return
`{ block: true, reason }` (`runner.ts:982-1003`). Throwing produces an extension
error and does not establish this block contract. The handler exempts exact `cct`, all `cct_*` tools, and ToolSearch, reads B and the existing `count|pool_summary|timestamp` flag,
and ignores stale or malformed flags. Both delivery handlers require the exact
`cct_check_messages` tool to be active. Missing identity emits one diagnostic
per session; missing identity or an unavailable direct tool allows work without
acknowledging messages. This prevents first-install discovery from trapping the
host behind a tool it cannot call.

**Historical next-tool/model-turn delivery (superseded by D18).** Busy os sessions saw a returned
`tool_call` block. `context` appends an unread notification through
`transformContext` (`src/core/sdk.ts:356-360`), which runs only on a model turn.
It never wakes an idle session. This matches Codex's next-prompt timing; Claude
cron can additionally trigger an idle check. The MCP process remains resident
and heartbeats throughout an idle interval.

Live testing exposed a second-message silence bug: the old polling path paused
while a returned batch awaited deferred acknowledgement. Without a cron to
issue another check, os could miss the next DM. os now peeks without acking,
excludes the IDs already returned, and refreshes the flag for new messages.
Read-generation and in-flight-read guards prevent an older poll from restoring
a flag just cleared by `cct_check_messages`. Existing Claude/Codex polling is
unchanged. The installed-runtime test sends a second DM after the first read.

**Q7 binds all adapter state to os.** In measured adapter 2.33.0,
`mcp.json`, `mcp-cache.json`, and `mcp-onboarding.json` share `getAgentPath()`.
Only the config file has a separate override; relocating it alone leaves state
elsewhere. With `PI_PACKAGE_DIR` unset, the adapter defaults to `~/.pi/agent`
and may create it. The approved os launcher sets:

```sh
export PI_CODING_AGENT_DIR="${OS_CODING_AGENT_DIR:-$HOME/.os/agent}"
export PI_MCP_CONFIG_MODE=exclusive
```

The installer must receive that same host environment. It resolves both os and
adapter paths, prints them, and refuses writes under real or synthetic `.pi`,
including symlink targets and backups. `exclusive` prevents automatic imports
of other clients' MCP servers; it alone does not relocate cache/onboarding
state. `cct install` does not acquire/install the adapter. The host and installer
must both receive the same environment; a launcher's exports do not propagate
back into the shell running the installer.

**Local structural types.** `os-extension.ts` imports only Node built-ins and
declares minimal local types with citations to reviewed os source. The os loader
alias is a runtime alias, unavailable to standalone CCT `tsc`; a type-only
package import would disappear before a load test and conceal that mismatch.
The accepted cost is no compiler-detected upstream API drift. Source citations,
handler checks, and actual installed-bundle acceptance cover that risk.

**Accepted limitations.** Sub-agent identity remains deferred. `--no-session`
still assigns a session ID (`session-manager.ts:926-930`); the difficulty is
inherited environment and process ancestry, not an absent ID. A lost marker
race produces only a host-scoped identity, so a new host cannot recover that
fallback peer by session ID. The adapter remains third-party software with a
native dependency; pruning it belongs to its owner. D18 adds spontaneous idle
chat-DM wake through the existing os API. Package upgrades may replace the local launcher and require Q7
to be reapplied. No os source edits are part of this integration.

---

### D17: Compact os tool surface

**Decision (2026-09-25):** `cct install --os` selects a compact two-tool MCP
surface for os with `CCT_TOOL_SURFACE=compact`. `CCT_TOOL_SURFACE` is the
server-side switch: exact value `compact` selects compact; unset or any other
value retains the legacy surface. Claude Code and Codex remain on the legacy
17-tool surface. This reduces tool-selection overhead while preserving all
operations by moving variability from tool names into action inputs (fewer
tools, more variable inputs per tool).

The compact surface consists of:

- `cct_check_messages`: the exact-named, zero-argument, always-eager recovery
tool. It remains the active tool named by unread-block reasons, cannot be
called with malformed arguments, and its description is static on both compact
and legacy surfaces. Its output starts with `you: <id>/<name>`.
- `cct`: a flat-schema dispatcher with required `action` and optional independent
fields. It covers `send`, `status`, `peers`, `pools`, `create`, `join`, `leave`,
`invite`, `summary`, `idle`, `resume`, `release`, `vote`, `services`, and
`terminate`. Server-side validation strictly rejects unknown fields, fields
irrelevant to the selected action, missing required fields, and invalid types
or values. See `shared/constants.ts` and `shared/compact.ts` for the full
field contract and exact errors.

The schema is a flat object with no top-level `oneOf`/`anyOf` combinators,
including for Anthropic/Bedrock compatibility. Tool descriptions and compact
instructions are static because adapter tool metadata/instructions are cached
across sessions; neither may contain session-specific peer identity. The
compact identity path is `cct` with `action: status`, whose output includes the
caller identity first. The recovery description is static on both surfaces.
**Historical D17 unread guard:** the original extension exempted bare `cct`,
`cct_*` and ToolSearch. D19 does not block tools at all.

The 17 legacy tools remain available unchanged to Claude Code and Codex, with
`cct_check_messages`'s now-static description as the intentional shared fix.
The compact surface is a facade over existing handlers and broker APIs: no
broker endpoints, tables, or storage change. The default surface remains
legacy, making rollback a change of the installer-provided environment value.
PHASE_3 measured 1,244 B of compact eager schemas versus 5,441 B for legacy;
the first synthetic-provider request was 15,100 B compact versus 20,730 B
legacy, and a status response for a 25-member pool was 456 B.

---

## D18: Historical os inbox notice and idle chat-DM wake

**Historical contract, superseded by D19.** The following records the former
one-shot notice/controller and its tests, not current automatic body behavior.
Its stop instruction, ten-consecutive cap and refused-DM watermark are not the
canonical policy.

**Decision (2026-09-25):** Replace D16's repeating os tool blocks/ephemeral
context reminders with a session-owned observer and coalesced custom message.
Only os changes; Claude/Codex hooks and idle delivery stay unchanged. No os-core,
adapter, broker endpoint, SQLite schema, or tool-schema change is required.

**Producer contract.** `server.ts` keeps the legacy three-field unread flag and
adds atomic `flags/<peerId>.os-notify` JSON, version 1, containing `peerId`,
`producer`, `readGeneration`, `count`, `maxId`, `maxDmId`, `timestamp`, and
`localBroker`. Numeric message fields describe outstanding unread messages
minus this process's deferred-ack batch; `maxDmId` selects only non-system chat
with `pool_name === null`. No body or secret is stored in the sidecar.
`timestamp` is freshness, not owner identity. `localBroker` is derived from the
resolved broker URL endpoint: exact `localhost`, canonical IPv4 `127/8`, or
IPv6 `::1` is local; remote/invalid/unknown is false. This is **endpoint
locality, not peer authentication or a trust boundary**: LAN-bound brokers via
localhost and SSH tunnels appear local. No DNS lookup. A successful check
prepares the complete response before deferred ack; optional sidecar/flag cache
write failures do not hide bodies or ack a batch that was never returned.

For os only, B is `peerId|name|producer|ownerStart`; first two fields remain
unchanged, fourth may be empty when process start cannot be verified. Only B's
producer publishes/deletes metadata, checking ownership after async polling
and before publishing. After a successful peek, a non-owner can claim an owner
only on verified `ESRCH` or a verified PID-start mismatch (PID reuse), with a
synchronous B re-read before claim. **Never steal on sidecar staleness/absence**,
a stalled live PID, EPERM/unknown process identity or a legacy B lacking a
verified start. Competing survivors settle behind the live B winner, without
cross-process CAS or exactly-once crash delivery. A successful checker can
transfer B and advance its read generation; a failed checker cannot transfer
ownership or rearm. The extension never writes caches, queries the broker,
registers a peer or acknowledges messages. SQLite remains authoritative.

**Consumer contract.** Start one unref'd 1-second observer in `session_start`
for open TUI/RPC only, stop on shutdown, invalidate old-session callbacks.
Require exact active `cct_check_messages`, valid A/B session mapping and fresh
matching metadata (≤30s old, no future timestamp). Missing inputs fail open
for tools and closed for idle scheduling, without acknowledging messages.
Observe at agent/tool/context boundaries but never return a block or append a
competing context reminder. Print/JSON have no observer.

Use os's existing provenance-labelled `cct-inbox-notice` custom message with
`{triggerTurn:true,deliverAs:"steer"}`. During a human-driven run it queues at a
safe boundary without aborting tools; an autonomous run defers further busy
notices until settle (no unbudgeted peer-driven chaining). Only an outstanding
chat DM can start an idle run; pool-only, system/service and directed pool
messages (even a pool named `DM`) await normal work. RPC embedders must expect
unprompted model requests. The notice asks for a check and, on idle starts,
to handle available work and stop rather than wait/poll for replies. It grants
no authority and does not bound the model's own inference or tool loops.

**Coalescing and receipt.** Per `peer:producer:readGeneration`, track eligible,
queued, dequeued-into-history or uncertain separately from an idle start spent,
budget refusal and DM high-water mark. `sendMessage` is fire-and-forget;
matching `message_end` means history entry, **not model acknowledgement**.
An attempted/delivered DM-containing notice remains claimed even when further
DMs arrive; a successful read generation rearms without a zero-count interval.
A first DM may follow an earlier pool-only notice. TUI Esc can discard a queued
notice: do not immediately restart human-cancelled work, but re-offer **once**
(DM or pool-only) on later human work. RPC retains queued steers and is not
auto-re-offered; an RPC `clear_queue` or uncertain delivery needs a manual
`cct_check_messages`. Crash/restart may conservatively replay; exactly-once
model consumption is not promised.

**Scheduling, lifecycle and order.** Known `agent_start`→`agent_settled` running
state is distinct from `ctx.isIdle()`: non-idle tree/summary/compaction and
human preflight are not agent runs and cannot license a new start. The CCT
`input` handler synchronously reserves trusted interactive/RPC prompt preflight
before later async handlers, with no time-based release. `cct install --os`
places CCT first among **explicit global** `settings.extensions`, de-duplicates
it and preserves all other entries' order; installed os processes same-level
handlers serially. Earlier CLI, managed or project async `input` handlers can
still invalidate this scheduling assumption. Verify actual effective load order.
UI waits, failed/handled preflight and pending switch/fork pause notification;
replacement also pauses busy notices. os has no reliable completion event for
failed/handled preflight or cancelled replacement: never infer completion from
elapsed time or activity. `/cct-wake status` exposes a visible pause; human
`/cct-wake resume` only **after the operation has finished** clears lifecycle
latches and refuses known running/non-idle/UI wait. It cannot prove hidden
async preflight finished, does not synchronously restart cancelled work, and
never clears budget, denied DM state or master opt-out. New session/reload
clears old lifecycle state; explicit inbox checks always work.

**Idle policy and budgets.** Fresh matched `localBroker:true` is needed by
default for idle starts; remote/unknown locality needs host
`CCT_OS_AUTO_WAKE_REMOTE=1`. Host `CCT_OS_AUTO_WAKE=0` always wins, suppressing
idle starts only (busy notices/manual reads still work). Use master opt-out on
LAN/tunnel hosts if desired; changing only MCP child env is insufficient.
Checkpoint max **5 starts per rolling 60 seconds plus 10 consecutive** per
logical session to os session history *before attempted dispatch*; restore on
reload/resume, new fork/session gets separate budget. Only trusted interactive/
RPC input resets consecutive, not rolling history. Extension/peer inputs and
resume do not reset either cap. A refused old DM is **not retried on time expiry
or human reset**; only a strictly newer chat DM may be reconsidered when the
current budget permits, and repeated refusals advance the high-water mark.
The per-source refusal watermark is in memory and not restored on reload;
budget checkpoints are restored, so reload does not guarantee suppression of
an old refused source after the rolling window expires. Attempted failed/aborted dispatch costs a start; invalid/unwritable checkpoints
fail closed for idle starts without suppressing later human-work busy notices.
These limits bound CCT-initiated idle starts, **not total inference spending**.

**Historical verification.** Source controller/owner tests and installed
RPC/TUI synthetic-provider acceptance used private HOME/brokers and a staged
source adapter. A 900s quiet plus 2h periodic/reconnect run passed for D18 notices,
including owned cleanup. These results are historical notice-delivery evidence,
not current D19 actual-body acceptance, arbitrary host certification or a
long body-delivery soak.

---

## D19: Canonical os automatic DM body delivery

**Decision:** integrate actual-body delivery in canonical `os-extension.ts`.
D19 supersedes D18's one-shot notice/controller for os only; Claude/Codex hooks,
manual tools and SQLite `read_at` semantics are unchanged. User UI approval is
complete; 0.2.1 publication verification remains in progress.

**Installation:** `cct install --os` selects canonical `os-extension.ts`, removes
duplicate canonical/prototype entries, preserves unrelated order and writes
MCP-child `CCT_OS_INBOX_BODY=1` alongside compact/keep-alive settings. Never load
the former `os-inbox-extension.ts` alongside it. Explicit global ordering puts
the body extension first; earlier CLI/managed/project handlers can precede it.
No os-core or third-party file edits, socket, fsync handoff, broker schema or
tool-schema change is required.

**Release-owned outgoing wrapper:** `os-mcp-extension.ts` delegates to the
unmodified original `pi-mcp-adapter@2.33.0` factory via the normal host loader.
It intercepts tool registration to decorate only direct CCT display callbacks;
execution, schemas, prompts, preparation and non-CCT renderers remain unchanged.
The supported activation is exactly one verified explicit global string entry
for the original `index.ts` or single-factory directory, outside autoextensions.
The installer replaces the adapter at its existing slot and saves the exact
original entry/canonical factory path in per-profile `cct-adapter.json` beside
settings, not in `extensions/`. Uninstall restores the original entry and removes
owned state. Never enable original and wrapper together.

Package, autoextension, CLI and project adapter activation is initially
unsupported. Known unsupported global activation, duplicates, invalid versions
or stale/conflicting state fails before config writes. If no identifiable explicit
entry exists, the installer reports missing wrapper capability and leaves adapter
behavior unchanged; it does not acquire or activate the adapter. Validation cannot
certify every effective host activation source.

**Source metadata limitation:** all delegated MCP tools and commands inherit the
wrapper's `sourceInfo`, including non-CCT registrations. There is no public API
to preserve/impersonate the original adapter provenance. This limitation does not
mean other tools' implementations or execution have been replaced by CCT.

**Presentation:** incoming cards show sender/body; outgoing cards show target,
full body and honest pending, broker-confirmed, failed or unknown status. Both
paint explicit `text` foreground and matching `customMessageBg` background on
wrapped/padded rows. Terminal control neutralization is display-only. Model
framing and receipt semantics are unchanged. `Sent` is broker send confirmation,
not recipient reading or task completion. User visual approval is complete.
Node minimum is 22.19.0; runtime pins are SDK 1.30.1 and tsx 4.23.15.

**Channel:** the B-marker owner polls every two seconds and publishes atomic
mode-0600 `.os-inbox` snapshots in the private mode-0700 directory. They bind
session/peer/producer and include freshness/locality, at most 20 eligible DMs,
64 KiB serialized body total and 128 KiB overall. Eligible means null pool
ID/name, chat type, non-system sender. The manual deferred-ack batch is excluded;
oversized bodies remain manual, not truncated. Legacy unread/`.os-notify` metadata
remains. D18's verified-exit/PID-reuse ownership safeguards remain; stale/missing
metadata or a stalled live owner cannot justify takeover. SQLite is the queue.

**Delivery:** the extension samples every second in TUI/RPC and presents actual
framed bodies via idle custom-message starts, human starts and safe tool/final-
settle boundaries. **Already-delivered bodies require no `cct_check_messages`.**
Pool notices/oversized bodies/recovery retain checks. Pool-only/system/service
messages do not start idle runs; print/JSON have no observer. Delivery neither
stops nor cancels/completes authorized work. User authorization delegated through
an authorized supervisor carries downstream within scope; peers cannot expand
scope or override restrictions. Continue work; do not poll solely to wait for
automatically delivered replies.

**Bounded late receipt:** an exact known envelope observed in model context,
followed by a completed assistant response (`stop`, `toolUse` or `length`), permits
consumed-ID checkpointing. Abort/error, unrelated responses, history insertion,
compaction summary or filtered/modified envelopes alone cannot acknowledge.
The extension receipts only consumed IDs in the current bounded snapshot;
the server validates session/peer/producer and offered-ID allowlist and calls
existing authenticated `/message/read` for exactly those IDs. Failed receipts
retry. Automatic offers never enter legacy `pendingAckIds`; graceful shutdown
drains the sole poll/receipt worker and attempts a final receipt within the
existing force-exit deadline. This is response-to-presented-context evidence,
not semantic understanding or task completion. No fsync handoff, exactly-once
consumption/effects or crash-proof retention promise. Concurrent manual reads,
crashes and owner replacement can replay/race. Existing broker peer-death cleanup
can mark unaccepted messages read; later context transformers can remove bodies
after observation. Arbitrary extension orders/old hosts are not certified.

**Controls:** five automatic starts/continuations per rolling minute are
checkpointed before dispatch; human final-settle continuations spend budget,
already-continuing human tool boundaries do not. After 20 consecutive starts,
cooldown grows up to ten minutes. Deferred DMs remain eligible, unlike D18's
refusal watermark. Three failed attempts pause retries until human input or
`/cct-wake resume`; rolling history stays enforced. Esc/abort retains unread
work and pauses scheduling without immediately restarting on settle. Same-session
reload/graceful restart restores cancellation and budgets. Host
`CCT_OS_AUTO_WAKE=0` disables automatic starts/continuations and overrides remote
opt-in; host `CCT_OS_AUTO_WAKE_REMOTE=1` is needed for remote/unknown locality.
Human/manual access remains. Resolved loopback locality is not authentication
or a trust boundary, including LAN-bound loopback brokers/SSH tunnels. Limits
bound starts, not total inference/spending; failed budget persistence fails
closed for automatic work.

Known running state remains distinct from `isIdle()`. Human preflight, UI waits
and replacement prevent competing idle starts. Failed/handled preflight and
cancelled replacement have no definitive completion event: no guessed timeout.
Use `/cct-wake resume` **only after the operation actually finished**; it refuses
running/non-idle/UI-wait states but cannot prove hidden async completion. Resume
clears pauses/failure backoff, not rolling budget or opt-out. No closed-process
wake or permission bypass.

**Acceptance:** recorded controller, private-server and isolated installer gates
plus installed RPC/TUI cases cover actual bodies, zero model inbox-tool calls,
cancellation retention, late acknowledgment, owned cleanup, native compaction,
restart/reload and readable incoming/outgoing history. Real-model exchanges
verified automatic delivery and scoped delegated continuation. The user personally
confirmed the UI; no further UI approval is pending. D18 wake/hardening/endurance
results are historical, not current acceptance. No long body soak or arbitrary
host/extension-order certification is claimed. Contract and compatibility limits:
[DM_BODY_PROTOTYPE.md](DM_BODY_PROTOTYPE.md).

**OpenCode scope:** existing Phase 1 identity work is preserved, not promoted
to a claim of complete OpenCode delivery, installer or feature support.

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
    {peer_id}.unread                   Contains: count|pool_summary|timestamp
    {peer_id}.os-inbox                 Bounded automatic-body snapshot (os)
    {peer_id}.os-receipt               Bounded late response receipt (os)

<source checkout>/                     Source code
  package.json
  tsconfig.json
  CLAUDE.md
  broker.ts                            HTTP server + SQLite
  server.ts                            MCP stdio server
  cli.ts                               CLI tool
  os-extension.ts                      os identity/body observer
  os-mcp-extension.ts                  Outgoing presentation wrapper
  hook.sh                              PreToolUse hook (pure bash)
  shared/
    types.ts                           TypeScript interfaces
    constants.ts                       Ports, paths, timeouts, compact actions
    compact.ts                         Compact schemas, validation, dispatch, status formatting
    os-adapter-config.ts               Verified adapter/per-profile wrapper state
    os-cct-send-renderer.ts             Display-only outgoing cards
    os-inbox-renderer.ts                Display-only incoming cards
    summarize.ts                       Local git-based summary
```

## MCP Tools — legacy surface (17 tools)

The legacy tool surface is used by Claude Code and Codex. The os installer
selects the compact surface documented in D17 (two tools: `cct_check_messages`
and `cct`). The server selects compact only for `CCT_TOOL_SURFACE=compact`;
unset or other values retain legacy. `cct_check_messages` has a static
description on both surfaces; the compact recovery result begins with
`you: <id>/<name>`.

| Tool | Description |
|------|-------------|
| `cct_check_messages` | Deferred-ack read: acknowledges the previous successful check, then returns currently unread messages. |
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
| `cct_self_terminate` | Terminate own host session; requires a reason |

## Broker Endpoints

Peer mutations require `peer_secret`; registration, CLI and service endpoints
have separate contracts. LAN Bearer authentication covers everything except
`/health`. See `broker.ts` and the endpoint list in AGENTS.md for the full surface.

**Peers:** `/register`, `/heartbeat`, `/unregister`, `/set-summary`, `/list-peers`
**Pools:** `/pool/create`, `/pool/join`, `/pool/leave`, `/pool/invite`, `/pool/list`, `/pool/members`, `/pool/status`
**Messages:** `/message/send`, `/message/poll`, `/message/read`, `/message/unread-count`
**System:** `/health` (GET)

## Hook Logic (pure bash)

`hook.sh` parses the Claude tool call, exempts CCT tools and ToolSearch, resolves
the peer through process pidmaps and reads `count|pool_summary|timestamp` from
the derived flag. Missing/malformed/stale flags allow work. Fresh unread counts
block ordinary calls with the recovery tool named in the reason. `hook-codex.sh`
implements the corresponding Codex JSON contract. The canonical os extension
never blocks tools. These hook files are the implementation authority; no HTTP,
Python or jq call is required on the hot path.
