# CCT State

## Current phase: 0.2.1 released and verified

**Status:** user UI approval, GitHub release, npm publication and registry
installation verification are complete. Published runtime source is commit
`0af3df7ad6234122a93c4457c1cfc345954e1923`, tagged `v0.2.1`. The existing
GitHub `v0.2.0` tag is preserved. Local setup uses the published package and
its reversible wrapper without a third-party source patch.

The user personally confirmed the readable incoming/outgoing UI and explicitly
waived further UI approval. No additional UI sign-off is a release gate.

## Release scope

- Canonical `os-extension.ts` delivers actual DM bodies at safe TUI/RPC
  boundaries without blocking ordinary tools or requiring a model inbox check
  for an already-delivered body. Pool messages, oversized bodies and recovery
  retain `cct_check_messages`.
- Bounded late acknowledgments require a completed response to exact known
  presented body context. They do not prove understanding or task completion.
  SQLite `read_at` remains the only authoritative message state.
- Incoming cards show sender/body; outgoing cards show target/body and honest
  pending, broker-confirmed, unknown or failed status. Both use explicit readable
  foreground and matching background on wrapped/padded rows. Provider envelopes,
  authorization guidance and transport semantics remain unchanged.
- The outgoing formatter is shipped in CCT's `os-mcp-extension.ts`, delegating to
  the **unmodified `pi-mcp-adapter@2.33.0` factory**. It decorates only the direct
  CCT tool's display callbacks, not execution, schemas or other tools' renderers.
  No os-core or third-party file edits are required.
- Initial wrapper support is exactly one verified explicit global adapter file
  or single-factory directory outside autoextensions. The installer replaces
  the adapter at its existing slot, puts the CCT body extension first, preserves
  unrelated order and saves the original entry in per-profile `cct-adapter.json`
  beside settings, outside `extensions/`. Uninstall restores the original entry
  and removes owned state. Package/autoextension/CLI/project adapter activation
  is unsupported; known ambiguity, invalid versions and conflicting state fail
  before writes. With no identifiable explicit entry, the installer reports the
  missing wrapper capability rather than silently claiming it.
- Public API limitation: **all delegated MCP tools and commands have the wrapper's
  `sourceInfo`**, including non-CCT registrations. Original adapter provenance
  cannot be impersonated through the public extension API.
- Reviewed WSL2 installation guidance is included and aligned with the supported
  adapter activation. Minimum Node version is **22.19.0**. Runtime dependencies
  are pinned to SDK **1.30.1** and tsx **4.23.15**.
- Existing OpenCode Phase 1 identity work is preserved. Complete OpenCode
  delivery, installer and feature support is not advertised.

## Acceptance and boundaries

Recorded acceptance covers controller, private-server receipt and isolated
installer gates; installed RPC actual-body payloads; and real TUI cancellation,
restart, native compaction, reload and incoming/outgoing card rendering. User
visual approval is separate from, and now supplements, automated terminal checks.
Real-model exchanges verified automatic delivery, scoped delegated continuation,
late acknowledgment, no model inbox-tool calls and owned cleanup.

These are bounded checks, not long body-delivery soak evidence or certification
of arbitrary host versions, extension order or provider-native retry behavior.
Former D18 one-shot notice/wake/endurance results are historical, not current
body-delivery acceptance.

Security boundaries remain explicit: peers cannot expand user authorization;
loopback locality is not authentication; remote automatic delivery requires host
opt-in; cancellation retains unread messages; budgets bound automatic starts,
not total spending. No fsync handoff, exactly-once effects, task-completion ACK,
closed-process wake or crash-proof disconnected retention is promised.

## Design authority

[ARCHITECTURE.md](ARCHITECTURE.md) is the design authority. The current D19
contract is [DM_BODY_PROTOTYPE.md](DM_BODY_PROTOTYPE.md); its filename preserves
history, not a claim that the shipped integration is still a local patch.

- D1–D15: core SQLite broker, hook delivery, pool lifecycle, peer identity and
  authenticated mutations.
- D16: os identity and resident adapter integration.
- D17: compact two-tool os surface.
- D18: historical one-shot notice/idle wake, superseded for os.
- D19: canonical automatic DM body delivery, bounded late receipts and readable
  incoming/outgoing presentation through the release-owned adapter wrapper.

Core broker, server, CLI and service-discovery phases are complete. PTY wrapping
for other runtimes remains a proposal, not implemented functionality. Remaining
compatibility work includes arbitrary context-transform/order, old-host APIs,
provider-native retry, persistent provider failures and sustained bounded exchanges.

## Release completion

GitHub tag/release assets, npm version and the exact registry artifact are verified.
A clean production-only registry install runs the CLI; local os setup selects
one canonical body extension and one reversible adapter wrapper. Existing sessions
need reload/restart to load changed setup. No tag was overwritten.
See [CHANGELOG.md](../CHANGELOG.md).
