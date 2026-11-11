# Changelog

## 0.2.3 — candidate, unpublished

Source candidate only. Not published, tagged, pushed or installed. The footer has
automated acceptance only: no user visual approval is recorded for it. The 0.2.1
approval covers the incoming and outgoing cards. The earlier 0.2.2 candidate was
never published; its footer and flag changes ship in 0.2.3.

### Added

- `cct version` (also `--version`, `-v`) prints the package version.
- `cct status --json` prints one machine-readable object without requiring a
  running broker: `schema` (1), `version`, `package_dir`, `node`, `broker`
  (`url`, `mode`, `running`, `peers`, `pools`) and `os` (resolved settings, MCP and
  wrapper-state paths; `extension`, `wrapper`, `adapter_state`, `mcp_server`,
  `mcp_command_ok`, `mcp_env_ok`, `stale`, `connected`, `errors`). It is read-only
  and exits 0 whatever the state. `connected` means this package's
  `os-extension.ts` is enabled and `mcpServers.cct` runs this package's
  `server.ts` with an existing command and the os environment. `stale` means
  entries from another CCT install: rerun `cct install --os`.

### Fixed

- The broker is now started with the node running CCT and CCT's own pinned tsx
  (`server.ts` lazy start, `cct start`, `cct lan-start`). These used
  `npx tsx`, which on a global install could download an unpinned tsx or fail
  offline. The opencode plugin and the Claude/Codex MCP launch commands are unchanged.

### Changed

- os footer consolidation: the canonical `os-extension.ts` owns one footer status key,
  `cct`, shown as `CCT: <peer name> | DM(n) | @pool(n) | <short exceptional state>`.
  The personal statusline duplicated identity and flags. It is superseded by this key
  once activation is decided. `cct-wake` no longer owns a status key.
- Each unread pool is its own `|` segment, for example
  `CCT: os-xxxx | DM(2) | @alpha(1) | @beta(3)`. Pools are no longer space-joined
  inside one segment, and the earlier three-pool cap and `+N` overflow are removed. A
  `|` inside a pool name is shown as `¦` so separators stay unambiguous.
- A display name longer than 40 characters is never truncated. The footer shows the
  unique peer ID instead, because an ellipsis could resemble another peer.
- Footer file reads are bounded: file B 4 KiB, session marker 512 bytes and unread flag
  64 KiB. Larger files are rejected whole, never truncated. An oversized flag shows
  `flags unavailable`. The delivery path reads file B with the same 4 KiB bound; valid
  files behave as before.
- A malformed, oversized or unreadable file B keeps the identity already resolved in
  the session. Delivery still cannot resolve the peer from that file, so it reports
  `inbox stale` and makes no delivery attempt.
- Verbose delivery reasons stay in `/cct-wake`. The footer shows only short
  exceptional states. Usual scheduled, appended and pending states are omitted.
- Unread flag contract in `shared/unread-flag.ts`, shared by every writer and reader.
  Pool names escape `%`, `,`, `:`, `|`, control characters and the exact name `DM`
  (as `%44M`). Direct unread stays `DM`. `total` is the sum of the entries. Hook scripts
  read only the count and are unchanged, but they echo the escaped entries into
  reason text. Pool names containing those characters therefore appear escaped there.
  The personal Claude statusline shows the stored escaped form.
- Version 0.2.3 in `package.json`, `package-lock.json` and `npm-shrinkwrap.json`.

### Compatibility

- Unread flag: no wire schema change. A flag is rewritten only by its own peer's MCP
  server. Until that peer runs 0.2.3 and polls, or calls `cct_check_messages`, its footer
  may show: a raw name containing an escape-like sequence (`%2C`, `%44M`, …) decoded
  (`a%2Cb` as `a,b`); a raw pool named exactly `DM` as direct unread (`DM(n)`, not
  `@DM(n)`); or `flags unavailable` for a raw name containing `,`. Totals, counts, hook
  scripts and delivery are unaffected, and the footer never drives delivery or
  acknowledgment. No migration is provided. Protocol expansion was rejected as
  disproportionate for a display-only ambiguity.

### Fixed

- A real pool named `DM` was indistinguishable from direct unread in the flag.
- Pool names containing `,`, `:` or `|` could corrupt the flag summary.
- After `cct_check_messages`, the non-os flag kept a per-pool summary that still
  counted the batch just returned, while the total excluded it. Summary and total
  now agree. Legacy flags the strict reader cannot parse unambiguously (for example
  a comma inside a pool name) show `flags unavailable` until the next poll rewrites them.

### Tests

- `test-os-footer.ts`: flag and identity contract, freshness boundaries, footer
  composition (one segment per pool), and the real os-extension status surface with
  the single `cct` key.
- `test-os-footer-broker.ts`: isolated real broker plus real os and claude MCP
  servers. The flag matches broker rows, including a pool named `DM` and delimiter
  names. Each pool is checked as its own footer segment. Also checks no stale summary
  after `cct_check_messages`.
- `test-os-autostart.py` (installed-runtime acceptance) reads the canonical `cct` key
  from the host RPC `setStatus` stream. It no longer loads or reads a personal
  footer. Its MCP child environment matches `cct install --os`
  (`CCT_TOOL_SURFACE=compact`, `CCT_OS_INBOX_BODY=1`), because the footer's inbox state
  depends on the body feed. It asserts the footer and the absence of any `cct-wake`
  status key. Private HOME, CCT_DIR and broker; no operator state is read or written.
- `test-compact-packed.ts` accepts `CCT_PACK_ARTIFACT` (and optional
  `CCT_PACK_ARTIFACT_SHA256`) to test an exact archive instead of a fresh pack.
- `test-os-footer.ts` also covers the 40/41-character name boundary, identity fallback,
  bounded B, marker and flag reads (exact limit and one byte over), and exactly one
  identity segment.
- `npm run test:os-footer` runs both footer suites. `test-os-inbox-pump.ts` asserts the
  footer and the `/cct-wake` diagnostic separately.

### Known issues (preexisting; not changed in 0.2.3)

- The os unread flag and body feed use `/message/peek`, which does not filter by active
  pool membership. `/message/unread-count` does. Unread messages from a pool the peer
  has left therefore still count in the os footer and body feed, and in
  `cct_check_messages`. Verified on a private broker
  (before leave: unread-count 2, after leave: unread-count 0, peek 2). No regression
  covers it yet. Fixing it changes delivery and needs its own decision.
- At startup the os footer can show `inbox stale` for up to about two seconds, until the
  first poll writes the body feed.

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
  User visual approval of these cards is complete.
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

See the [delivery contract](cct/DM_BODY_PROTOTYPE.md) for details.
