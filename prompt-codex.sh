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
PEER_NAME="${PEER_LINE#*|}"
[ "$PEER_NAME" = "$PEER_LINE" ] && PEER_NAME=""
[ -n "$PEER_ID" ] || exit 0

# 4. If the user asks about CCT identity, inject the addressable peer ID.
PROMPT_TEXT=""
case "$INPUT" in
  *'"prompt":"'*) PROMPT_TEXT="${INPUT#*\"prompt\":\"}"; PROMPT_TEXT="${PROMPT_TEXT%%\"*}" ;;
  *'"user_prompt":"'*) PROMPT_TEXT="${INPUT#*\"user_prompt\":\"}"; PROMPT_TEXT="${PROMPT_TEXT%%\"*}" ;;
  *'"input":"'*) PROMPT_TEXT="${INPUT#*\"input\":\"}"; PROMPT_TEXT="${PROMPT_TEXT%%\"*}" ;;
  *'"message":"'*) PROMPT_TEXT="${INPUT#*\"message\":\"}"; PROMPT_TEXT="${PROMPT_TEXT%%\"*}" ;;
esac
if [ -z "$PROMPT_TEXT" ]; then
  case "$INPUT" in
    *CCT*|*"cct id"*|*"cct peer"*|*"cct identity"*|*"cct whoami"*) PROMPT_TEXT="$INPUT" ;;
  esac
fi

IDENTITY_CTX=""
case "$PROMPT_TEXT" in
  *CCT*|*cct*)
    if [ -n "$PEER_NAME" ]; then
      IDENTITY_CTX="CCT identity for this Codex session: peer_id=${PEER_ID}, peer_name=${PEER_NAME}. CODEX_THREAD_ID is a Codex session/thread id, not an addressable CCT peer id. Use cct_whoami for the canonical identity."
    else
      IDENTITY_CTX="CCT identity for this Codex session: peer_id=${PEER_ID}. CODEX_THREAD_ID is a Codex session/thread id, not an addressable CCT peer id. Use cct_whoami for the canonical identity."
    fi
    ;;
esac

# 5. Check unread flag
FLAG="$_CCT/flags/${PEER_ID}.unread"
UNREAD_CTX=""
if [ -f "$FLAG" ]; then
  IFS= read -r RAW < "$FLAG" || [ -n "$RAW" ] || RAW=""
else
  RAW=""
fi

# 6. Parse count (must be positive integer)
COUNT="${RAW%%|*}"
case "$COUNT" in
  ''|0|*[!0-9]*) ;;
  *)
    REST="${RAW#*|}"
    POOLS="${REST%%|*}"
    if [ -n "$POOLS" ]; then
      UNREAD_CTX="CCT: You have ${COUNT} unread message(s) in pools: ${POOLS}. Call mcp__cct__cct_check_messages before proceeding with other work."
    else
      UNREAD_CTX="CCT: You have ${COUNT} unread message(s). Call mcp__cct__cct_check_messages before proceeding with other work."
    fi
    ;;
esac

CTX="$IDENTITY_CTX"
if [ -n "$UNREAD_CTX" ]; then
  if [ -n "$CTX" ]; then
    CTX="${CTX}
${UNREAD_CTX}"
  else
    CTX="$UNREAD_CTX"
  fi
fi

[ -n "$CTX" ] || exit 0

# 7. Output UserPromptSubmit additionalContext (Codex schema) with proper escaping
ESC_CTX=$(json_escape "$CTX")
printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"%s"}}\n' "$ESC_CTX"
