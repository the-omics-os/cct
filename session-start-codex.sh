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

pid_has_ancestor() {
  local child=$1
  local ancestor=$2
  local current=$child
  local parent=""
  local i=0
  while [ -n "$current" ] && [ "$i" -lt 12 ]; do
    [ "$current" = "$ancestor" ] && return 0
    parent=$(ps -o ppid= -p "$current" 2>/dev/null)
    parent=${parent//[[:space:]]/}
    [ -z "$parent" ] && return 1
    [ "$parent" = "1" ] && return 1
    current=$parent
    i=$((i + 1))
  done
  return 1
}

find_marker_for_session() {
  local marker=""
  local marker_pid=""
  for marker in "$PIDMAP_DIR"/codex_mcp_*; do
    [ -f "$marker" ] || continue
    marker_pid="${marker##*codex_mcp_}"
    case "$marker_pid" in ''|*[!0-9]*) continue ;; esac
    if pid_has_ancestor "$marker_pid" "$PPID"; then
      printf '%s' "$marker"
      return 0
    fi
  done
  return 1
}

# Find the MCP server marker for this Codex process. SessionStart can fire
# before the MCP server has finished registration, so wait briefly.
MARKER=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  MARKER=$(find_marker_for_session)
  [ -n "$MARKER" ] && break
  sleep 0.05
done

if [ -z "$MARKER" ]; then
  ONLY_MARKER=""
  MARKER_COUNT=0
  for candidate in "$PIDMAP_DIR"/codex_mcp_*; do
    [ -f "$candidate" ] || continue
    ONLY_MARKER="$candidate"
    MARKER_COUNT=$((MARKER_COUNT + 1))
  done
  [ "$MARKER_COUNT" -eq 1 ] && MARKER="$ONLY_MARKER"
fi

[ -f "$MARKER" ] || exit 0
IFS= read -r CONTENT < "$MARKER" || [ -n "$CONTENT" ] || exit 0
[ -n "$CONTENT" ] || exit 0
printf '%s' "$CONTENT" > "$PIDMAP_DIR/codex_${SESSION_ID}"
chmod 600 "$PIDMAP_DIR/codex_${SESSION_ID}" 2>/dev/null

exit 0
