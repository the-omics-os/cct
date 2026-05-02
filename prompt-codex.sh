#!/bin/bash
# CCT UserPromptSubmit hook for OpenAI Codex CLI
# Injects unread CCT messages as additionalContext on every user prompt.
# This provides "idle delivery" — messages arrive when user next types.
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

# 2. Parse session_id for peer lookup (first occurrence)
case "$INPUT" in
  *'"session_id":"'*) SESSION_ID="${INPUT#*\"session_id\":\"}"; SESSION_ID="${SESSION_ID%%\"*}" ;;
  *) SESSION_ID="" ;;
esac

# 3. Find peer ID via pidmap
_CCT="${CCT_DIR:-$HOME/.cct}"

PIDMAP=""
if [ -n "$SESSION_ID" ] && [ -f "$_CCT/pidmaps/codex_${SESSION_ID}" ]; then
  PIDMAP="$_CCT/pidmaps/codex_${SESSION_ID}"
else
  set -- "$_CCT"/pidmaps/"${PPID}_"*
  [ -f "$1" ] || exit 0
  PIDMAP=$1
fi

IFS= read -r PEER_LINE < "$PIDMAP" || exit 0
PEER_ID="${PEER_LINE%%|*}"
[ -n "$PEER_ID" ] || exit 0

# 4. Check unread flag
FLAG="$_CCT/flags/${PEER_ID}.unread"
[ -f "$FLAG" ] || exit 0
IFS= read -r RAW < "$FLAG" || exit 0
[ -z "$RAW" ] && exit 0

# 5. Parse count (must be positive integer)
COUNT="${RAW%%|*}"
case "$COUNT" in
  ''|0|*[!0-9]*) exit 0 ;;
esac

# 6. Parse pools
REST="${RAW#*|}"
POOLS="${REST%%|*}"

# 7. Inject context about pending messages
if [ -n "$POOLS" ]; then
  CTX="CCT: You have ${COUNT} unread message(s) in pools: ${POOLS}. Call mcp__cct__cct_check_messages before proceeding with other work."
else
  CTX="CCT: You have ${COUNT} unread message(s). Call mcp__cct__cct_check_messages before proceeding with other work."
fi

# 8. Output UserPromptSubmit additionalContext (Codex schema) with proper escaping
ESC_CTX=$(json_escape "$CTX")
printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"%s"}}\n' "$ESC_CTX"
