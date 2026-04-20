# CCT State

## Current Phase: ALL COMPLETE
## Status: PRODUCTION-READY

## Design Authority
**ARCHITECTURE.md is the single source of truth.** ROADMAP.md aligns with it. The old plan (fizzy-hopping-puzzle.md) is superseded.

## Resolved Design Decisions (see ARCHITECTURE.md for full detail)
- D1: Stock Claude only. Next-tool-boundary delivery. Cron = best-effort.
- D2: SQLite broker = single source of truth. Flag file = derived cache for hook.
- D3: Hook is pure bash, no python, no curl. Reads one flag file. Target <5ms.
- D4: Auto-register peers (discoverable). Hook only activates after pool join + unread messages.
- D5: Two states: unread (read_at IS NULL) and read (read_at set). No delivered/ack.
- D6: Broadcast = fan-out. One message row + N recipient rows.
- D7: Invite = forced join in v1. Schema supports accept/decline for v2.
- D8: Roles in schema (creator/admin/member). Display only in v1. Enforcement in v2.
- D9: Monotonic seq per pool. No timestamp ordering.
- D10: Pools archived when empty. Rejoinable.
- D11: Dead peer → system message to pools. PID + start_time check.
- D12: ~/.cct/ with 0700. Peer secrets. Localhost only.
- D13: Hook blocks once, check_messages reads ALL pools at once. No head-of-line blocking.
- D14: Accept "Error:" prefix. Mitigate with instructions + clear reason text.
- D15: Cron = best-effort suggestion in MCP instructions.

## Research Completed
- [x] Reference implementation analysis (claude-peers-mcp)
- [x] Codex research: 17 empirical probes of MCP notifications
- [x] Binary reverse engineering: tengu_harbor flag + e8() auth gate
- [x] Prototype: PreToolUse hook + file inbox + PPID mapping — all proven
- [x] Codex design review: 16 findings addressed in ARCHITECTURE.md

## Prototype Artifacts (clean up in Phase 4)
- /tmp/cct-test/ — working prototype
- .planning/cct/codex_output/ — research + probes
- cct-test MCP in ~/.claude.json

## Progress
- Phase 1: COMPLETE ✓ (broker verified — all endpoints working)
- Phase 2: COMPLETE ✓ (server.ts, hook.sh, summarize.ts — all verified)
- Phase 3: COMPLETE ✓ (cli.ts — all commands, install/uninstall verified)
- Phase 4: COMPLETE ✓ (39/39 tests pass, hook <10ms, CCT installed, prototype cleaned up)
- Codex Review: 19 findings addressed across 8 batches
- CCP Handoff: Service registry, pool metadata, typed messages, cct_list_services — all implemented
