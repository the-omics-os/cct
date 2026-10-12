# Changelog

## 0.2.1 — 2026-10-12

Published as `@omicsos/cct@0.2.1` and GitHub `v0.2.1`. The registry artifact,
clean production-only installation and actual CLI are verified. The existing
GitHub `v0.2.0` tag is preserved; no earlier history was overwritten.

### Added

- Automatic actual-body DM delivery for open os TUI/RPC sessions at safe
  boundaries, without a model-issued inbox check for already-presented bodies.
- Bounded late acknowledgments after a completed response to exact known body
  context. This is response evidence, **not task-completion acknowledgment**.
- Readable incoming sender/body and outgoing target/body/status cards, with
  explicit foreground and matching background across wrapped/padded rows.
  User visual approval is complete.
- Shipped CCT-owned `os-mcp-extension.ts` presentation wrapper delegating to the
  original, unmodified `pi-mcp-adapter@2.33.0` factory. Only CCT display callbacks
  are decorated; no os-core or third-party file edits are required.
- Reversible installer support for exactly one verified explicit global adapter
  file/single-factory directory outside autoextensions. Replacement keeps the
  adapter's slot, places the CCT body extension first, preserves unrelated order,
  and saves per-profile `cct-adapter.json` outside `extensions/`. Uninstall
  restores the exact original entry and removes owned state.

### Installation and compatibility

- Merged the reviewed WSL2/Ubuntu installation guidance and aligned it with the
  supported adapter setup. Minimum Node version is **22.19.0**.
- Runtime dependency pins: `@modelcontextprotocol/sdk@1.30.1` and `tsx@4.23.15`.
- Adapter activation via packages, autoextensions, CLI flags or project settings
  is initially unsupported. Known ambiguous/invalid activation and conflicting
  saved state fail before config writes; missing explicit adapter capability
  is reported rather than silently claimed.
- All delegated MCP tools and commands carry the wrapper's `sourceInfo`, including
  non-CCT registrations. The public extension API cannot preserve original
  adapter provenance; execution and non-CCT renderers remain unchanged.
- Preserved the existing OpenCode Phase 1 identity work without claiming complete
  OpenCode delivery, installer or feature support.
- Public documentation no longer depends on operator-specific receipts, rollback
  scripts, personal footer paths or ignored planning documents.

### Security and delivery boundaries

- SQLite `read_at` remains authoritative; private files are bounded derived feeds,
  not a second queue. Owner takeover requires verified exit/PID reuse.
- Peers cannot expand user authorization. Loopback locality is not authentication;
  remote automatic delivery requires host opt-in and host opt-out takes precedence.
- Cancellation retains unread bodies; budgets bound automatic starts, not total
  inference/spending. Pool, oversized and recovery reads remain manual.
- Send confirmation is not receipt or completion. No fsync handoff, exactly-once
  effects, closed-process wake, crash-proof retention or long body soak is claimed.

See the [delivery contract](cct/DM_BODY_PROTOTYPE.md) and
[release state](cct/STATE.md) for details.
