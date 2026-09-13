#!/bin/bash
set -euo pipefail

# End-to-end test: a codex-hosted MCP server must resolve a stable session_key
# and reclaim the SAME CCT peer id when codex is resumed / the MCP server is
# respawned. Unit tests cover the resolution logic; this covers the wiring in
# server.ts (host process discovery → argv parse → fork-chain root → register).
#
# Runs against an isolated broker on port 17889 with an isolated CCT_DIR and a
# fake CODEX_HOME. It never touches the live broker, live ~/.cct, or real codex.

PORT=17889
BROKER_URL="http://127.0.0.1:$PORT"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/cct-codex-e2e.XXXXXX")
export CCT_DIR="$WORK/cct"
export CCT_PORT="$PORT"
export CCT_BROKER="$BROKER_URL"
export CODEX_HOME="$WORK/codex"
unset CCT_TOKEN CODEX_THREAD_ID CODEX_SESSION_ID CCT_CODEX_SESSION_ID 2>/dev/null || true

ROOT_ID="01a09000-0000-7000-8000-000000000001"
FORK_ID="01a09000-0000-7000-8000-000000000002"
PROJECT="$WORK/project"

PASSED=0
FAILED=0
pass() { echo "  PASS: $1"; PASSED=$((PASSED + 1)); }
fail() { echo "  FAIL: $1"; FAILED=$((FAILED + 1)); }
check() {
  if [ "$3" = "$2" ]; then pass "$1"; else fail "$1 (expected='$2' actual='$3')"; fi
}

# MCP servers register a `codex_mcp_{pid}` marker; that is the reliable way to
# reap them without pattern-matching on server.ts (which would hit the real
# MCP servers of live sessions).
kill_mcp_servers() {
  local marker pid
  for marker in "$CCT_DIR"/pidmaps/codex_mcp_*; do
    [ -e "$marker" ] || continue
    pid="${marker##*codex_mcp_}"
    case "$pid" in ''|*[!0-9]*) continue ;; esac
    kill "$pid" 2>/dev/null || true
  done
}

BROKER_PID=""
cleanup() {
  [ -n "$BROKER_PID" ] && kill "$BROKER_PID" 2>/dev/null || true
  lsof -ti :$PORT 2>/dev/null | xargs kill 2>/dev/null || true
  pkill -f "$WORK/bin/codex" 2>/dev/null || true
  kill_mcp_servers
  rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$CCT_DIR" "$PROJECT" "$CODEX_HOME/sessions/2026/09/13" "$WORK/bin"

# Rollout transcripts: FORK_ID was forked from ROOT_ID (what codex does on
# compaction). Pad session_meta past 16KB, like the real thing.
PAD=$(printf 'e%.0s' $(seq 1 20000))
printf '%s\n{"type":"message","payload":{"text":"x"}}\n' \
  "{\"type\":\"session_meta\",\"payload\":{\"session_id\":\"$ROOT_ID\",\"cwd\":\"$PROJECT\",\"originator\":\"codex-tui\",\"environment_context\":\"$PAD\"}}" \
  > "$CODEX_HOME/sessions/2026/09/13/rollout-2026-09-13T10-00-00-$ROOT_ID.jsonl"
printf '%s\n{"type":"message","payload":{"text":"x"}}\n' \
  "{\"type\":\"session_meta\",\"payload\":{\"session_id\":\"$FORK_ID\",\"forked_from_id\":\"$ROOT_ID\",\"cwd\":\"$PROJECT\",\"originator\":\"codex-tui\",\"environment_context\":\"$PAD\"}}" \
  > "$CODEX_HOME/sessions/2026/09/13/rollout-2026-09-13T11-00-00-$FORK_ID.jsonl"

# Fake codex host: its command line carries `resume <session_id>` (that is how
# the real MCP server learns the session id — codex exports nothing) and it owns
# the MCP server as a child process, so host discovery has something to find.
cat > "$WORK/bin/codex" <<'EOF'
#!/bin/bash
# `sleep` keeps the MCP server's stdin open — server.ts treats stdin EOF as
# "host exited" and cleans up.
echo "[$(date +%s)] fake codex host $$ up: $*" >> "$CCT_E2E_LOG"
trap 'echo "[$(date +%s)] fake codex host $$ down" >> "$CCT_E2E_LOG"' EXIT
sleep 300 | "$CCT_TSX" "$CCT_SERVER_TS" >/dev/null 2>>"$CCT_E2E_LOG"
EOF
chmod +x "$WORK/bin/codex"

export CCT_TSX="$HERE/node_modules/.bin/tsx"
[ -x "$CCT_TSX" ] || CCT_TSX="npx tsx"
export CCT_SERVER_TS="$HERE/server.ts"
export CCT_E2E_LOG="$WORK/server.log"
export CCT_RUNTIME=codex

echo "=== Starting isolated broker on $PORT ==="
CCT_PORT="$PORT" CCT_DIR="$CCT_DIR" npx tsx "$HERE/broker.ts" >"$WORK/broker.log" 2>&1 &
BROKER_PID=$!
for _ in $(seq 1 30); do
  curl -sf "$BROKER_URL/health" >/dev/null 2>&1 && break
  sleep 0.3
done
check "broker healthy" "true" "$(curl -s "$BROKER_URL/health" | grep -q '"ok":true' && echo true)"

peer_field() { # $1 = python expression over the peer list
  curl -s -X POST "$BROKER_URL/list-peers" -H 'Content-Type: application/json' -d '{}' |
    python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print($1)" 2>/dev/null || echo ""
}

# Backgrounded outside any command substitution so the host process outlives the
# call; the pid lands in HOST_PID.
start_codex_session() { # $1 = session id on the command line
  ( cd "$PROJECT" && exec "$WORK/bin/codex" resume "$1" ) &
  HOST_PID=$!
  for _ in $(seq 1 120); do
    [ "$(peer_field "len(d)")" = "1" ] && return 0
    sleep 0.5
  done
  return 0
}

stop_codex_session() {
  # Kill the host's children (the stdin keeper and the MCP server) before the
  # host itself: killing only the host orphans the MCP server, whose stdin stays
  # open, so it lingers for a full parent-death check and pollutes the next run.
  if [ -n "${HOST_PID:-}" ]; then
    pkill -P "$HOST_PID" 2>/dev/null || true
    kill "$HOST_PID" 2>/dev/null || true
  fi
  kill_mcp_servers
  for _ in $(seq 1 40); do
    [ "$(peer_field "len(d)")" = "0" ] && break
    sleep 0.5
  done
}

echo ""
echo "=== First codex session (resume of the forked session) ==="
start_codex_session "$FORK_ID"
ID_1=$(peer_field "d[0]['id']")
NAME_1=$(peer_field "d[0]['name']")
check "one codex peer registered" "1" "$(peer_field "len(d)")"
if [ -n "$ID_1" ]; then pass "peer id assigned ($ID_1 / $NAME_1)"; else fail "peer id assigned"; fi

# The peer must be keyed on the fork-chain ROOT, not the forked session id.
KEY_1=$(python3 - "$CCT_DIR/cct.db" <<'PY'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
row = con.execute("select session_key from peers where runtime='codex' order by registered_at desc limit 1").fetchone()
print(row[0] if row else "")
PY
)
check "session_key is the fork-chain root" "codex-root:$ROOT_ID" "$KEY_1"

echo ""
echo "=== Codex exits, then resumes (new host process, new MCP server) ==="
stop_codex_session
start_codex_session "$FORK_ID"
ID_2=$(peer_field "d[0]['id']")
NAME_2=$(peer_field "d[0]['name']")
check "still exactly one codex peer" "1" "$(peer_field "len(d)")"
check "peer id survives the resume" "$ID_1" "$ID_2"
check "peer name survives the resume" "$NAME_1" "$NAME_2"

echo ""
echo "=== Resuming the ROOT id resolves to the same identity ==="
stop_codex_session
start_codex_session "$ROOT_ID"
check "peer id stable when resuming the root id" "$ID_1" "$(peer_field "d[0]['id']")"

echo ""
echo "=========================================="
echo "  Results: $PASSED passed, $FAILED failed"
echo "=========================================="
if [ "$FAILED" -ne 0 ]; then
  echo "--- peers table ---"
  python3 - "$CCT_DIR/cct.db" <<'PY'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
for row in con.execute("select id,name,runtime,session_key,pid,host_pid,status,registered_at from peers order by registered_at"):
    print(row)
PY
  echo "--- server log ---"
  tail -20 "$WORK/server.log" 2>/dev/null
  exit 1
fi
