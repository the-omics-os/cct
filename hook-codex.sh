#!/bin/bash
# CCT PreToolUse hook for OpenAI Codex CLI
# Reads JSON from stdin, checks flag files, outputs JSON block decision.
# Fail-open on any error. Target <10ms.

# JSON escape helper (pure bash)
json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  printf '%s' "$s"
}

# 1. Read JSON input from stdin (fail-open if no input)
IFS= read -r INPUT || exit 0

# 2. Parse tool_name from JSON (first occurrence, not last)
case "$INPUT" in
  *'"tool_name":"'*) TOOL_NAME="${INPUT#*\"tool_name\":\"}"; TOOL_NAME="${TOOL_NAME%%\"*}" ;;
  *) exit 0 ;;
esac

# 3. Skip CCT tools (Codex namespaces as mcp__cct__*) and ToolSearch
case "$TOOL_NAME" in mcp__cct__*|*cct_*|ToolSearch) exit 0 ;; esac

# 4. Parse session_id from JSON (first occurrence)
case "$INPUT" in
  *'"session_id":"'*) SESSION_ID="${INPUT#*\"session_id\":\"}"; SESSION_ID="${SESSION_ID%%\"*}" ;;
  *) SESSION_ID="" ;;
esac

# 5. Find peer ID via pidmap — try Codex session_id key first, then PPID fallback
_CCT="${CCT_DIR:-$HOME/.cct}"
PIDMAP_DIR="$_CCT/pidmaps"

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

link_codex_session_pidmap() {
  [ -n "$SESSION_ID" ] || return 1
  [ -d "$PIDMAP_DIR" ] || return 1
  local marker=""
  local marker_pid=""
  for marker in "$PIDMAP_DIR"/codex_mcp_*; do
    [ -f "$marker" ] || continue
    marker_pid="${marker##*codex_mcp_}"
    case "$marker_pid" in ''|*[!0-9]*) continue ;; esac
    if pid_has_ancestor "$marker_pid" "$PPID"; then
      IFS= read -r PEER_LINE < "$marker" || [ -n "$PEER_LINE" ] || return 1
      [ -n "$PEER_LINE" ] || return 1
      printf '%s' "$PEER_LINE" > "$PIDMAP_DIR/codex_${SESSION_ID}" 2>/dev/null || return 1
      chmod 600 "$PIDMAP_DIR/codex_${SESSION_ID}" 2>/dev/null
      return 0
    fi
  done
  return 1
}

PIDMAP=""
if [ -n "$SESSION_ID" ]; then
  if [ ! -f "$PIDMAP_DIR/codex_${SESSION_ID}" ]; then
    link_codex_session_pidmap
  fi
  if [ -f "$PIDMAP_DIR/codex_${SESSION_ID}" ]; then
    PIDMAP="$PIDMAP_DIR/codex_${SESSION_ID}"
  fi
fi

if [ -z "$PIDMAP" ]; then
  set -- "$PIDMAP_DIR"/"${PPID}_"*
  [ -f "$1" ] || exit 0
  PIDMAP=$1
fi

IFS= read -r PEER_LINE < "$PIDMAP" || [ -n "$PEER_LINE" ] || exit 0
PEER_ID="${PEER_LINE%%|*}"
[ -n "$PEER_ID" ] || exit 0

# 6. Check unread flag
FLAG="$_CCT/flags/${PEER_ID}.unread"
[ -f "$FLAG" ] || exit 0
IFS= read -r RAW < "$FLAG" || [ -n "$RAW" ] || exit 0
[ -z "$RAW" ] && exit 0

# 7. Parse count (must be positive integer)
COUNT="${RAW%%|*}"
case "$COUNT" in
  ''|0|*[!0-9]*) exit 0 ;;
esac

# 8. Parse timestamp and check freshness (ignore if >30s stale)
REST="${RAW#*|}"
POOLS="${REST%%|*}"
TS="${REST##*|}"
if [ -n "$TS" ]; then
  NOW_MS=$(($(date +%s) * 1000))
  AGE=$(( NOW_MS - TS ))
  [ "$AGE" -gt 30000 ] 2>/dev/null && exit 0
fi

# 9. Build reason with pool names
if [ -n "$POOLS" ]; then
  REASON="CCT: ${COUNT} unread message(s) in ${POOLS}. Call mcp__cct__cct_check_messages to read them."
else
  REASON="CCT: ${COUNT} unread message(s). Call mcp__cct__cct_check_messages to read them."
fi

# 10. Output JSON block decision (Codex schema) with proper escaping
ESC_REASON=$(json_escape "$REASON")
printf '{"decision":"block","reason":"%s"}\n' "$ESC_REASON"
