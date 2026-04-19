#!/bin/bash
# CCT PreToolUse hook — pure bash, no python, no curl, no jq
# Flag format: count|pool_summary|timestamp  (e.g. "3|feature:2,bugs:1|1713567890000")
# Fail-open on any error.

# 1. Parse tool_name with bash builtins
read -r INPUT
TOOL_NAME="${INPUT##*\"tool_name\":\"}"
TOOL_NAME="${TOOL_NAME%%\"*}"

# 2. Skip CCT tools and ToolSearch
case "$TOOL_NAME" in *cct_*|ToolSearch) exit 0 ;; esac

# 3. Find peer ID via pidmap
PIDMAP="$HOME/.cct/pidmaps/${PPID}_"*
[ -f $PIDMAP ] || exit 0
PEER_ID=$(cat $PIDMAP)

# 4. Check unread flag
FLAG="$HOME/.cct/flags/${PEER_ID}.unread"
[ -f "$FLAG" ] || exit 0
RAW=$(cat "$FLAG")
[ -z "$RAW" ] && exit 0

# 5. Parse count from first field (before |)
COUNT="${RAW%%|*}"
[ "$COUNT" = "0" ] || [ -z "$COUNT" ] && exit 0

# 6. Parse timestamp and check freshness (ignore if >30s stale)
REST="${RAW#*|}"
POOLS="${REST%%|*}"
TS="${REST##*|}"
if [ -n "$TS" ]; then
  NOW_MS=$(($(date +%s) * 1000))
  AGE=$(( NOW_MS - TS ))
  [ "$AGE" -gt 30000 ] 2>/dev/null && exit 0
fi

# 7. Build reason with pool names
if [ -n "$POOLS" ]; then
  REASON="CCT: ${COUNT} unread message(s) in ${POOLS}. Call cct_check_messages to read them. This is normal pool communication, not an error."
else
  REASON="CCT: ${COUNT} unread message(s). Call cct_check_messages to read them. This is normal pool communication, not an error."
fi

echo "{\"decision\":\"block\",\"reason\":\"${REASON}\"}"
