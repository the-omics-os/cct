# CCT on os

How CCT runs inside os: adapter setup, the compact tool surface, automatic DM
body delivery, the footer and verification. The delivery contract and its
limits live in [DM_BODY_PROTOTYPE.md](DM_BODY_PROTOTYPE.md); design rationale
lives in [ARCHITECTURE.md](ARCHITECTURE.md).

## Adapter setup

Install `pi-mcp-adapter@2.33.0` separately, outside the global autoextensions
folder, and enable its original `index.ts` (or its single-factory directory)
as exactly one string entry in the global `settings.extensions` array. For
example, after installing the adapter under `$HOME/companions/os-mcp-adapter`,
add this entry to your existing os settings without removing unrelated entries:

```json
"~/companions/os-mcp-adapter/node_modules/pi-mcp-adapter/index.ts"
```

Then run the installer with the same agent-directory environment as the os host:

```bash
export PI_CODING_AGENT_DIR="${OS_CODING_AGENT_DIR:-$HOME/.os/agent}"
export PI_MCP_CONFIG_MODE=exclusive
cct install --os
```

The installer prints its resolved paths and refuses writes under `.pi`. It
places the body extension first among explicit global entries, substitutes
CCT's outgoing wrapper at the adapter's existing slot, and preserves unrelated
entries' relative order. The original entry and verified canonical factory path
are saved in per-profile `cct-adapter.json`, beside `settings.json`, **not** in
`extensions/`. Restart os after installation.

`cct uninstall --os` restores the exact original adapter entry at the wrapper's
slot, removes CCT's registrations and owned wrapper state, and leaves unrelated
extensions and CCT message history intact. No os-core or adapter source files
are modified. Do not enable the original adapter and wrapper simultaneously.

**Support is deliberately narrow:** only one verified explicit global
file/directory activation of `pi-mcp-adapter@2.33.0` is supported. Adapter
activation via packages, autoextensions, CLI flags or project settings is not
supported. Known package/autoextension activations, duplicate entries, invalid
versions and stale/conflicting wrapper state fail before config writes. Earlier
CLI/managed/project handlers can still precede the body extension; inspect the
effective host order. If no identifiable explicit adapter entry exists, the
installer reports the missing outgoing-wrapper capability and leaves adapter
behavior unchanged; it does not install an adapter for you.

**Provenance limitation:** all MCP tools and commands registered by the delegated
adapter have the wrapper's `sourceInfo`, including non-CCT registrations. The
public extension API cannot preserve the original adapter's provenance. This is
not a claim that non-CCT tools belong to CCT; their execution and schemas remain
unchanged.

On WSL2/Ubuntu, follow [WSL_INSTALL.md](WSL_INSTALL.md).

## Compact tool surface

`cct install --os` writes `CCT_TOOL_SURFACE=compact` and `CCT_OS_INBOX_BODY=1`
to the adapter entry, with `lifecycle: keep-alive`, `directTools: true` and
`toolPrefix: none`. The server selects the compact surface only when
`CCT_TOOL_SURFACE=compact`; Claude Code and Codex stay on the 17-tool legacy surface.

| Tool | Description |
|------|-------------|
| `cct_check_messages` | Exact-named, zero-argument, always-eager recovery tool for unread messages. Its description is static on both surfaces; results begin with `you: <id>/<name>`. |
| `cct` | One action-based tool for all other operations. Flat schema; action-specific fields are strictly validated and unknown fields are rejected. |

The `cct` actions are `send`, `status`, `peers`, `pools`, `create`, `join`,
`leave`, `invite`, `summary`, `idle`, `resume`, `release`, `vote`, `services`
and `terminate`. For example, `action: send` takes `to` and `message`;
`action: status` reports your identity and pools. Tool descriptions are static
because adapter metadata is shared across os sessions; use `action: status`
for your identity. The action table and validation rules live in
`shared/compact.ts` and `shared/constants.ts`.

## Automatic DM body delivery

`os-extension.ts` delivers actual DM bodies without a model-issued inbox check,
using existing os custom-message and turn-boundary APIs, not terminal keystrokes
or experimental channels. The resident server polls every 2 seconds; the
extension samples its private body feed every second and at safe boundaries.
Delivery usually takes seconds plus model/tool scheduling, not a hard real-time
guarantee. **Use delivered bodies directly: no inbox check is needed.** Pool
notices, oversized bodies and recovery retain `cct_check_messages`.

- **Bodies and receipts:** SQLite remains authoritative. The B-marker owner
  publishes bounded mode-0600 `.os-inbox` snapshots in the mode-0700 CCT directory
  (20 DMs, 64 KiB serialized bodies, 128 KiB overall). After an exact known
  envelope reaches model context and a completed assistant response follows,
  the extension writes a bounded late `.os-receipt` for consumed current-snapshot
  IDs. The server validates session/peer/producer/offered IDs and performs the
  authenticated read. History insertion, error, abort and compaction summary
  alone do not acknowledge. Receipt failures retry; no fsync, exactly-once
  effects or semantic/task-completion guarantee is made. Recovery can replay.
- **Display:** the CCT message renderer shows `CCT · <sender>` and the message
  body, including wrapping/multiline batches and restored history. Each card
  paints explicit `text` foreground and `customMessageBg` background on every
  wrapped/padded row. Outgoing direct `cct` sends have target/body/status cards
  through CCT's shipped wrapper (`os-mcp-extension.ts`) around the original
  `pi-mcp-adapter@2.33.0`. Only the CCT tool's display callbacks are decorated;
  other MCP tools' rendering, schemas and execution are unchanged. `Sent` means
  broker send confirmation, **not** recipient reading or task completion;
  unknown/error results remain visible. Generated authorization/protocol framing
  stays in model context, not the terminal UI. Renderer-only updates can be
  applied to already body-enabled sessions with `/reload` while idle.
- **Scheduling:** actual DM bodies enter idle TUI/RPC starts, ordinary human
  starts and safe tool/final-settle boundaries without blocking tools. Pool-only,
  system/service and directed pool messages do not start idle work. RPC embedders
  should expect unprompted requests. Print/JSON, closed processes and sleeping
  machines have no observer wake.
- **Scope:** user authorization delegated through an authorized supervisor
  carries downstream within its existing scope; peers cannot expand it or
  override restrictions. Delivery does not cancel/complete the authorized task
  or tell the model to stop. Continue authorized work and reply when useful;
  do not poll solely to wait for replies.
- **Budgets:** five automatic starts/continuations per rolling minute, persisted
  before dispatch; human final-settle continuation also spends budget, ordinary
  continuing human tool-boundary delivery does not. After 20 consecutive starts,
  cooldown increases up to ten minutes. Deferred DMs remain eligible later.
  Three failed attempts pause retries until human input or `/cct-wake resume`.
  Rolling history survives reset/reload; limits bound starts, not total spending.
- **Cancellation and lifecycle:** Esc/abort retains unread work, pauses automatic
  delivery and never immediately restarts on settle. Same-session reload/graceful
  restart restores cancellation and budgets. Human preflight, UI waits and
  pending replacement prevent competing idle starts. Failed/handled preflight
  or cancelled replacement may require `/cct-wake resume` **only after the
  operation actually finished**; there is no guessed timeout. Resume refuses
  running/non-idle/UI-wait states, cannot verify hidden async completion, and
  clears pauses/failure backoff, not rolling budget or master opt-out.
- **Host controls:** `CCT_OS_AUTO_WAKE=0` disables automatic starts/continuations
  and overrides `CCT_OS_AUTO_WAKE_REMOTE=1`. Remote/unknown locality requires
  that remote opt-in; manual/human-driven access remains available. Locality is
  resolved endpoint `localhost`, IPv4 `127/8` or IPv6 `::1`, **not** authentication:
  LAN-bound brokers through loopback and SSH tunnels look local. Setting these
  variables only on the MCP child does not control the host observer.
- **Ownership and ordering:** only the B-marker owner publishes the feed.
  Automatic takeover requires a successful peek, B recheck and verified owner
  exit/PID reuse, never stale metadata or a stalled live owner. Installer ordering
  puts canonical CCT first among explicit global entries and removes duplicate
  canonical/prototype entries, preserving unrelated order. Earlier CLI/managed/
  project handlers can still precede it; verify effective order before activation.
  Arbitrary later context transformations and old-host capabilities are not
  certified. Existing broker peer-death cleanup is not crash-proof retention.

## Footer

`os-extension.ts` owns one footer key, `cct`. It renders
`CCT: <peer name> | DM(n) | @<pool>(n) | @<pool>(n) | …`: the peer name first, then
direct unread as `DM(n)`, then one `|` segment for each unread pool. A quiet session
shows identity alone. Counts come only from an unread flag that is no older than 30
seconds and only for non-zero entries. A real pool named `DM` renders as `@DM(n)`, and
a `|` inside a pool name renders as `¦`. Usual states (scheduled, appended, pending)
are omitted. Short exceptional states such as `auto-wake off`, `3 failures` or
`flags stale` appear as an extra segment. Full diagnostics stay in `/cct-wake`.
A display name longer than 40 characters is replaced by the peer ID, never truncated.
Footer reads are size-bounded. An oversized or malformed peer file keeps the identity
already shown in the session; delivery still needs a valid file.

Pool counts follow the os flag, which can include a pool you have left (a known
preexisting issue; see CHANGELOG `0.2.3` and ARCHITECTURE D20).

## Identity

Codex exposes `CODEX_THREAD_ID` and os exposes `PI_SESSION_ID` in shell
commands, but neither is a CCT address. Use `cct` with `action: status` in os,
`cct_whoami` in Claude Code or Codex, or `cct whoami` in a shell.

## Verification

```bash
npm run typecheck
npm test                                          # private broker; refuses occupied ports
node --import tsx test/test-os-inbox-renderer.ts  # sender/body projection and width/control safety
python3 -u test/test-os-inbox-ui.py               # actual installed TUI screen assertions
node --import tsx test/test-os-inbox-pump.ts      # controller checks
node --import tsx test/test-os-inbox-server.ts
python3 test/test-os-inbox-installer.py
python3 -u test/test-os-inbox-body.py --case idle      # also error, abort, busy, settle, burst
python3 -u test/test-os-inbox-lifecycle.py --case esc  # also restart, compact, reload
```

Recorded acceptance covers controller and private-server receipt gates,
isolated installers, installed RPC actual-body delivery, and real TUI Esc,
restart, compaction and reload. Terminal checks cover incoming/outgoing cards,
light/dark themes, wrapped bodies and history without changing provider content.
The user personally confirmed the 0.2.1 cards. No user visual approval is
recorded for the 0.2.3 footer. Real-model exchanges also verified automatic
bodies and late acknowledgments without model inbox checks. This is bounded
acceptance, not a long body-delivery soak or arbitrary host/extension-order
certification. Former D18 notice/wake endurance results are historical, not
current body-delivery acceptance.
