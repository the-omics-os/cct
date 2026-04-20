# CCT (Claude Code Talk) — Requirements

## Mission

Enable real-time communication between Claude Code sessions via named pools, without experimental/gated features. Two sessions working independently should be able to collaborate autonomously once grouped into a pool.

## Proven Mechanisms (from prototyping)

1. **PreToolUse hook** — Blocks non-CCT tools when unread messages exist. Fires on every tool call. Confirmed working.
2. **CronCreate** — MCP instructions tell Claude to set up a recurring cron for idle-state polling. Fires when REPL is idle.
3. **File-based inbox** — Simple, fast, no broker HTTP overhead for the hook. SQLite for the broker, file for the hot path.
4. **MCP stdio server** — Standard MCP over stdio, no experimental capabilities needed.

## Core Concepts

### Peers
- A **peer** is a Claude Code session with the CCT MCP server connected.
- Each peer has: `id` (8-char random), `name` (human-readable, from env or auto-generated), `cwd`, `git_root`, `git_branch`, `summary`.
- Peer name: `CCT_PEER_NAME=backend claude` or auto-generated as `{basename(cwd)}-{4char}` (e.g., `landing-k2f3`).
- Peer ID shown in `/mcp` tool description for easy discovery.
- Peers that don't join any pool are invisible — zero overhead, hook exits immediately.

### Pools
- A **pool** is a named group of 2+ peers that can exchange messages.
- Created with: name, purpose (description), optional hierarchy (who leads).
- Pools are n:n — a peer can be in multiple pools, a pool has multiple peers.
- Pool lifecycle: lives while any member is active. Archived when all members leave or exit.
- When a peer crashes/exits, other pool members are notified.

### Messages
- Messages carry: `from_id`, `from_name`, `pool_id` (or null for DM), `body`, `sent_at`, `status`.
- Three states: `pending` → `delivered` → `read`.
- Pool messages: broadcast to all members (except sender), or directed `@name` within pool.
- DMs: peer-to-peer, outside any pool.
- Messages include sender context: name, cwd, branch, summary.
- Ordering: timestamp-based within a pool. Sequential delivery guaranteed.

## User Flows

### Flow 1: Manual Pool Setup
1. Kevin opens 2 terminals with Claude Code (both have CCT MCP auto-registered).
2. In terminal A: "List all CCT peers" → sees both peers with names/IDs.
3. In terminal A: "Create a pool called billing-sync with purpose 'coordinate billing API and frontend checkout'. Invite peer landing-k2f3."
4. Both agents now see the pool. Each sets their summary.
5. Kevin tells backend agent: "When you finish the billing API, notify the pool."
6. Backend finishes → sends pool message → frontend agent's next tool call is blocked → reads message → can ask follow-up questions autonomously.

### Flow 2: Orchestrated Pool Setup
1. Kevin has 3 terminals. Asks one agent: "Create a pool called refactor-auth, list all peers, and invite the ones working in lobster-cloud/ directories."
2. Agent calls `cct_list_peers`, `cct_create_pool`, `cct_invite_to_pool`.
3. Invited peers get notified on their next tool call.
4. Kevin gives the orchestrator agent a task that requires coordination.

### Flow 3: Agent-to-Agent Autonomous Communication
1. Pool is established. Backend agent finishes work.
2. Backend agent: `cct_send_pool_message("billing-sync", "API routes done. Added POST /billing/portal. Frontend can now integrate.")`.
3. Frontend agent's hook fires → reads message → asks: `cct_send_pool_message("billing-sync", "Got it. What's the response schema for POST /billing/portal?")`.
4. Backend agent's hook fires → reads → responds with schema details.
5. This continues without Kevin involvement.

## Constraints

### Must
- Sessions NOT in a pool have ZERO overhead (hook exits immediately, no file reads, no python).
- Hook must NOT block CCT tools or ToolSearch (prevents infinite loops).
- Hook must only affect the session that owns the inbox (PPID-based mapping).
- No experimental MCP features (no `claude/channel`).
- No external API dependencies (no OpenAI for summaries).
- Works with API key auth (no claude.ai login required).
- Multiple pools can coexist. A peer can be in N pools simultaneously.
- Human-readable peer names by default.

### Should
- Hook execution < 10ms for sessions not in any pool.
- Hook caches inbox check for ~2s to reduce file I/O on rapid tool calls.
- Pool creation stores purpose/description visible to all members.
- Agents notified when a peer joins or leaves a pool.
- Messages display sender context (name, cwd, branch) for clarity.
- MCP instructions align with hook behavior so Claude is not surprised by "Error:" prefix.

### Won't (v1)
- No encryption of messages at rest.
- No cross-machine communication (localhost only).
- No message history beyond current session (messages are consumed on read).
- No web UI.
- No automatic pool creation based on git root (explicit pool creation only).
