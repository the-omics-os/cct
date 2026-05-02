#!/bin/bash
# CCT SessionStart hook for OpenAI Codex CLI
# Creates a session_id→peer_id mapping so PreToolUse/UserPromptSubmit hooks
# can find the correct CCT peer for this Codex session.
#
# The MCP server (server.ts) writes a "codex peer marker" file at startup.
# This hook reads that marker and creates the session-keyed pidmap symlink.
# Fail-open on any error.

# 1. Read JSON input from stdin
IFS= read -r INPUT || exit 0

# 2. Parse session_id (first occurrence)
case "$INPUT" in
  *'"session_id":"'*) SESSION_ID="${INPUT#*\"session_id\":\"}"; SESSION_ID="${SESSION_ID%%\"*}" ;;
  *) exit 0 ;;
esac
[ -n "$SESSION_ID" ] || exit 0

# 3. Find the MCP server's peer marker
# server.ts writes: ~/.cct/pidmaps/codex_mcp_{pid} → "peer_id|peer_name"
# We need to find it and create: ~/.cct/pidmaps/codex_{session_id} → same content
_CCT="${CCT_DIR:-$HOME/.cct}"
PIDMAP_DIR="$_CCT/pidmaps"

# Already mapped? Skip.
[ -f "$PIDMAP_DIR/codex_${SESSION_ID}" ] && exit 0

# Find the MCP server's marker (most recent codex_mcp_* file)
set -- "$PIDMAP_DIR"/codex_mcp_*
if [ -f "$1" ]; then
  # Use the most recently modified marker
  MARKER=$(ls -t "$PIDMAP_DIR"/codex_mcp_* 2>/dev/null | head -1)
  [ -f "$MARKER" ] || exit 0
  IFS= read -r CONTENT < "$MARKER" || exit 0
  [ -n "$CONTENT" ] || exit 0
  # Write session-keyed pidmap with same content
  printf '%s' "$CONTENT" > "$PIDMAP_DIR/codex_${SESSION_ID}"
  chmod 600 "$PIDMAP_DIR/codex_${SESSION_ID}" 2>/dev/null
fi

exit 0
