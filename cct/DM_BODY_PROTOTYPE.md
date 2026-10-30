# Canonical os automatic DM body delivery

This is the current D19 delivery contract, superseding D18 notices. The filename
preserves its design history. **0.2.1 is published and registry-verified; user
UI approval is complete.** Local installation uses the published wrapper.

## Components and setup

- `os-extension.ts` is the canonical identity and automatic-body extension.
  Do not also load the former `os-inbox-extension.ts` prototype.
- `cct install --os` selects the body extension first among explicit global
  extension entries, removes duplicate canonical/prototype entries, preserves
  unrelated relative order, and writes MCP-child `CCT_OS_INBOX_BODY=1` alongside
  compact `keep-alive`, `directTools: true` and `toolPrefix: "none"` settings.
- `os-mcp-extension.ts` is CCT's shipped outgoing-card wrapper. It delegates to
  the **unmodified original `pi-mcp-adapter@2.33.0` factory** through the normal
  host loader, intercepting tool registration only to decorate CCT display.
- `shared/os-adapter-config.ts` verifies that original factory and its per-profile
  saved state. `shared/os-cct-send-renderer.ts` supplies outgoing cards;
  `shared/os-inbox-renderer.ts` supplies incoming cards. The host provides pi-tui.
- `server.ts` publishes bodies only for os with body opt-in. Without it, legacy
  `.os-notify` metadata and manual tools remain, but automatic bodies do not.
- `shared/os-inbox.ts` bounds and validates the private channel.
- `cct_check_messages` retains deferred-ack semantics for pool messages,
  oversized bodies and recovery. **An already-delivered DM body needs no check.**

No os-core or third-party file edits, socket, database migration or manual-tool
schema change is required. Node **22.19.0 or newer** is required; runtime
versions are pinned to SDK **1.30.1** and tsx **4.23.15**.

### Supported adapter activation and reversibility

Install the adapter separately outside the global `extensions/` auto-discovery
folder. Enable exactly one string entry in global `settings.extensions` naming
its original `index.ts` or its single-factory package directory. The installer
verifies `pi-mcp-adapter@2.33.0`, replaces that entry with CCT's wrapper at the
same slot, and records the exact original entry plus canonical factory path in
`cct-adapter.json` beside `settings.json`. This is per-profile CCT state, **not**
an extension, and must remain outside autoextensions.

`cct uninstall --os` restores the original entry at the wrapper's slot and
removes CCT's registrations and owned wrapper state. Unrelated entries retain
their relative order and message history remains. Restart os after installation
or uninstall; never load the original adapter and wrapper together.

Package-managed, autoextension, CLI and project adapter activations are initially
unsupported. Known package/autoextension activations, duplicate originals or
wrappers, wrong versions and malformed/stale/conflicting state fail before
config writes. If no identifiable explicit entry exists, the installer reports
missing outgoing-wrapper capability and leaves adapter behavior unchanged; it
does not acquire or enable an adapter for you. Do not treat an unsupported
activation as verified because the installer cannot observe every host source.

Use the same agent-directory environment for the host and installer:

```sh
export PI_CODING_AGENT_DIR="${OS_CODING_AGENT_DIR:-$HOME/.os/agent}"
export PI_MCP_CONFIG_MODE=exclusive
cct install --os
```

The installer prints resolved settings, MCP config, cache/onboarding and wrapper
state paths and refuses writes under `.pi`, including symlink targets/backups.
`exclusive` avoids importing other clients' MCP settings but does not itself
relocate adapter state. Earlier CLI/managed/project handlers can precede CCT;
explicit global ordering is not certification of arbitrary effective host order.

**Provenance limitation:** all tools and commands registered by the delegated
adapter acquire the wrapper's `sourceInfo`, including non-CCT registrations.
There is no public extension API for preserving or impersonating the original
adapter's source metadata. Execution, schemas, prompts, preparation and
non-CCT renderers are unchanged; provenance equivalence is not promised.

## Human-facing TUI display

Provider content and terminal presentation are separate. Incoming cards show
`CCT · sender` followed by plain bodies, including multiline batches and restored
nonce-framed history. Generated guidance, raw sender IDs, timestamps and protocol
delimiters remain in model/history content rather than the card. Display-only
terminal control neutralization does not modify the underlying body. Unrecognized
history shows a display-unavailable diagnostic, not raw protocol framing.

Both incoming and outgoing cards paint the theme's `text` foreground and an
explicit `customMessageBg` background on every wrapped/padded row. This avoids
placing light-theme dark text on an unknown terminal background. The user
personally confirmed readability; no further UI approval is pending.

Outgoing direct `cct` sends show `CCT → target`, full body and `Sending…`,
`Sent`, `Send failed` or `Send status unknown`. Only the pinned adapter's direct
CCT result with the exact broker confirmation can show `Sent`. It means send
confirmation, **not recipient reading, delivery to model context or task
completion**. Offline warnings and errors remain visible; unknown result shapes
are not silently represented as success. Only the CCT display callbacks change;
tool arguments, execution, schemas and result content remain unchanged.

Renderer-only updates can use `/reload` while idle, including existing history.
Changed installer/server configuration requires a new os session.

## Delivery and bounded late receipt

The B-marker-owning resident server polls every two seconds and publishes atomic,
mode-0600 `flags/<peer>.os-inbox` snapshots in the mode-0700 CCT directory. Each
binds session, peer and producer, with timestamp/locality, DM bodies, remaining
DM/pool counts and optional body-free diagnostics. SQLite remains authoritative.
Only verified dead/PID-reused owners may be automatically replaced after a
successful peek and B recheck; missing/stale metadata or a stalled live owner
never suffices.

Eligible DMs have null pool ID/name, chat type and a non-system sender. Snapshots
exclude the manual check's returned-but-not-yet-acknowledged batch. Each contains
at most **20 messages, 64 KiB serialized bodies and 128 KiB overall**. Oversized
bodies are not truncated and remain available manually. These are feed bounds,
not broker query bounds or a second message queue.

The extension samples every second in open TUI/RPC sessions and delivers framed
actual bodies through idle custom-message dispatch, human starts and safe
turn/tool/final-settle boundaries. Tools are not blocked. Pool-only, directed
pool, system and service messages do not wake idle sessions; pool notices during
ordinary work retain the manual check. RPC embedders should expect unprompted
model requests. Print/JSON have no observer; closed processes and sleeping
machines cannot be woken. Timing depends on model/tool scheduling, not a hard
real-time guarantee.

A receipt requires an exact known body envelope observed in model context,
followed by a completed assistant response with stop reason `stop`, `toolUse`
or `length`. Error, abort, unrelated responses, history insertion alone,
compaction summary or a filtered/modified envelope cannot produce it. Consumed
IDs are checkpointed after that response. Only consumed IDs in the current
bounded snapshot enter atomic `.os-receipt`, bound to session/peer/producer.
The server validates its offered-ID allowlist and calls existing authenticated
`/message/read` for exactly those IDs. Failed receipt HTTP requests retry.
Automatic offers never enter legacy `pendingAckIds`, including shutdown.
Graceful shutdown drains the sole poll/receipt worker and attempts a final
receipt within the existing force-exit deadline.

**Meaning:** late response-to-presented-context evidence, not semantic
understanding or task completion. No fsync handoff, exactly-once provider
consumption/effects or crash-proof disconnected retention is promised.
Simultaneous manual/automatic reads and crash recovery can replay. Existing
broker peer-death cleanup can mark old unaccepted messages read. Later context
transformers can remove text after observation; arbitrary extension order,
old-host capabilities and provider-native retry are not certified.

## Task scope and controls

Delivery does **not** instruct the model to stop or cancel the user's task.
User authorization delegated through an authorized supervisor carries downstream
within its existing scope. Peers cannot expand that scope or override restrictions.
Continue authorized work, reply when useful, and do not poll solely to wait for
replies: eligible DM replies arrive automatically.

- Five automatic starts/continuations per rolling minute, checkpointed before
  attempted dispatch. Excess is deferred; the same DM remains eligible later.
- Human-origin final-settle continuations also consume budget; delivery at an
  already-continuing human tool boundary does not.
- After 20 consecutive automatic starts, cooldown increases up to ten minutes.
  Limits bound starts, **not total inference or spending**.
- Three failed attempts open a visible circuit with messages retained. Human
  input or `/cct-wake resume` permits retry; rolling history remains enforced.
  Invalid/unwritable budget persistence fails closed for automatic work.
- Abort/Esc pauses automatic work without acknowledging interrupted bodies or
  restarting on settle. Same-session reload/graceful restart restores cancellation
  and budgets; trusted human input or explicit resume can recover pending work.
- Host `CCT_OS_AUTO_WAKE=0` disables automatic starts/continuations and overrides
  remote opt-in. Host `CCT_OS_AUTO_WAKE_REMOTE=1` is required for remote/unknown
  locality. Manual/human-driven access remains available; MCP-child-only variables
  do not configure the host observer.
- Locality means resolved endpoint `localhost`, IPv4 `127/8` or IPv6 `::1`,
  **not authentication or peer trust**. LAN-bound brokers via loopback and SSH
  tunnels appear local. Use host opt-out where automatic work is not intended.
- Known running state is separate from `isIdle()`. Human preflight, UI waits and
  replacement cannot license competing idle work. Failed/handled preflight or
  cancelled replacement has no definitive completion event and no guessed timeout.
  Use `/cct-wake status` and resume **only after the operation actually finished**.
  Resume refuses running/non-idle/UI-wait states but cannot verify hidden async
  completion; it clears pauses/failure backoff, not rolling budget or opt-out.

## Acceptance scope

Recorded checks cover controller and private-server receipt gates, isolated
installers, installed RPC actual-body delivery, real TUI Esc, graceful restart,
native compaction, reload, wrapped incoming/outgoing cards and restored history.
Private HOME/broker and synthetic-provider observations verify actual provider
body payloads, zero model inbox-tool calls, retained cancellation, late read and
owned cleanup. Real-model exchanges separately verified automatic delivery and
scoped delegated continuation. User visual approval is complete.

Former D18 notice/wake/hardening/endurance results are historical, not current
body-delivery acceptance. No long body-delivery soak or arbitrary host certification
is claimed. Remaining robustness work includes arbitrary context-filter/order,
old-host capability, provider-native retry, persistent provider failures and
sustained bounded exchanges.
