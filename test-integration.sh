#!/bin/bash
set -euo pipefail

# CCT Integration Test Suite
# Tests broker endpoints, hook performance, and security properties.

BROKER_PORT=17888
BROKER_URL="http://127.0.0.1:${BROKER_PORT}"
CCT_DIR=$(mktemp -d "${TMPDIR:-/tmp}/cct-test.XXXXXX")
HOOK_SH="$(cd "$(dirname "$0")" && pwd)/hook.sh"
BROKER_TS="$(cd "$(dirname "$0")" && pwd)/broker.ts"

export CCT_PORT="$BROKER_PORT"
export CCT_DIR

PASSED=0
FAILED=0
SLEEP_PIDS=()
BROKER_PID=""

# --- Helpers ---

pass() { echo "  PASS: $1"; PASSED=$((PASSED + 1)); }
fail() { echo "  FAIL: $1"; FAILED=$((FAILED + 1)); }

check() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    pass "$desc"
  else
    fail "$desc (expected='$expected' actual='$actual')"
  fi
}

check_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -q "$needle"; then
    pass "$desc"
  else
    fail "$desc (expected to contain '$needle')"
  fi
}

check_not_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -q "$needle"; then
    fail "$desc (should not contain '$needle')"
  else
    pass "$desc"
  fi
}

post() {
  curl -s -X POST "$BROKER_URL$1" -H "Content-Type: application/json" -d "$2"
}

json_field() {
  local json="$1" field="$2"
  echo "$json" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d$field)" 2>/dev/null || echo ""
}

# Field of one peer inside a /list-peers response, by peer id.
peer_field() {
  local json="$1" peer_id="$2" field="$3"
  echo "$json" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for p in d.get('data') or []:
    if p.get('id') == '$peer_id':
        print(p.get('$field'))
        break
" 2>/dev/null || echo ""
}

cleanup() {
  echo ""
  echo "=== Cleanup ==="
  for pid in "${SLEEP_PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  if [ -n "$BROKER_PID" ]; then
    kill "$BROKER_PID" 2>/dev/null || true
    wait "$BROKER_PID" 2>/dev/null || true
  fi
  # Kill test broker on the isolated port (never the live broker)
  lsof -ti :$BROKER_PORT 2>/dev/null | xargs kill 2>/dev/null || true
  rm -rf "$CCT_DIR"
  echo "Cleanup complete."
}

trap cleanup EXIT

# --- Unit tests (no broker needed) ---

echo "=== Codex session resolution unit tests ==="
if npx tsx "$(cd "$(dirname "$0")" && pwd)/test-codex-session.ts"; then
  pass "codex-session unit tests"
else
  fail "codex-session unit tests"
fi

if npx tsx "$(cd "$(dirname "$0")" && pwd)/test-compact-surface.ts"; then
  pass "compact-surface unit tests"
else
  fail "compact-surface unit tests"
fi

# --- Start broker ---

echo ""
echo "=== Starting broker ==="

# Kill any leftover test broker on the isolated port
lsof -ti :$BROKER_PORT 2>/dev/null | xargs kill 2>/dev/null || true
sleep 0.3

mkdir -p "$CCT_DIR"

CCT_TOKEN="" CCT_PORT="$BROKER_PORT" CCT_DIR="$CCT_DIR" npx tsx "$BROKER_TS" &
BROKER_PID=$!
sleep 1

# Verify broker is up
HEALTH=$(curl -s "$BROKER_URL/health")
HEALTH_OK=$(json_field "$HEALTH" "['ok']")
check "Broker health returns ok" "True" "$HEALTH_OK"

echo ""
echo "=== Compact server surface ==="
if CCT_PORT="$BROKER_PORT" CCT_DIR="$CCT_DIR" CCT_TOKEN="" npx tsx "$(cd "$(dirname "$0")" && pwd)/test-compact-surface.ts" --integration; then
  pass "compact surface end-to-end against isolated broker"
else
  fail "compact surface end-to-end against isolated broker"
fi

# os uses the same broker registration protocol. Keep these checks isolated
# from the existing Claude/Codex rows and use this driver's real process ID.
echo ""
echo "=== os session identity and membership recovery ==="
if python3 - "$BROKER_URL" "$CCT_DIR/cct.db" <<'OS_INTEGRATION'
import json, os, sqlite3, subprocess, sys, urllib.request
url, dbpath = sys.argv[1:]
pid = os.getpid()
start = "_".join(subprocess.check_output(["ps", "-o", "lstart=", "-p", str(pid)], text=True).split())
base = dict(pid=pid, pid_start=start, host_pid=pid, host_pid_start=start, cwd="/tmp/cct-os-integration")
def call(path, **body):
    req = urllib.request.Request(url+path, json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as response:
        result = json.load(response)
    assert result["ok"], (path, result.get("error"))
    return result.get("data")
def register(runtime, key):
    return call("/register", **base, runtime=runtime, session_key=key, name="os-control-"+key.replace(":", "-"))
claude = register("claude", "os-claude-control")
weak = register("os", "os-host:integration")
strong = register("os", "os:integration")
assert weak["id"] == strong["id"], "weak-to-marker transition changed identity"
duplicate = register("os", "os:integration")
assert duplicate == strong, "same-session registration changed peer credentials/name"
other = register("os", "os:other-session")
assert other["id"] != strong["id"], "different strong os sessions collapsed"
auth = dict(peer_id=strong["id"], peer_secret=strong["secret"])
call("/pool/create", **auth, name="os-recovery-control")
call("/pool/invite", **auth, pool_name="os-recovery-control", target_peer_id=claude["id"])
call("/unregister", **auth, pid=pid, pid_start=start)
revived = register("os", "os:integration")
assert revived == strong, "resume changed stable os identity"
with sqlite3.connect(dbpath) as db:
    assert db.execute("SELECT runtime,status,session_key FROM peers WHERE id=?", (claude["id"],)).fetchone() == ("claude","active","os-claude-control"), "os registration modified Claude"
    assert db.execute("SELECT COUNT(*) FROM pool_members WHERE peer_id=? AND status='active'", (strong["id"],)).fetchone()[0] == 1, "revive lost os pool membership"
for peer in (strong, other, claude):
    call("/unregister", peer_id=peer["id"], peer_secret=peer["secret"], pid=pid, pid_start=start)
print("  os checks: fallback upgrade, duplicate, separate sessions, resume, Claude isolation, pool restoration")
OS_INTEGRATION
then
  pass "os identity and pool recovery controls"
else
  fail "os identity and pool recovery controls"
fi

# --- Spawn fake PIDs ---

echo ""
echo "=== Registering peers ==="

sleep 300 &
SLEEP_PIDS+=($!)
PID_A=$!

sleep 300 &
SLEEP_PIDS+=($!)
PID_B=$!

PIDSTART_A=$(date +%s)
PIDSTART_B=$(date +%s)

# Register peer A
REG_A=$(post "/register" "{\"pid\":$PID_A,\"pid_start\":\"$PIDSTART_A\",\"cwd\":\"/tmp/test-a\",\"name\":\"peer-alpha\"}")
PEER_A_ID=$(json_field "$REG_A" "['data']['id']")
PEER_A_SECRET=$(json_field "$REG_A" "['data']['secret']")
PEER_A_NAME=$(json_field "$REG_A" "['data']['name']")
check "Peer A registered" "peer-alpha" "$PEER_A_NAME"

# Register peer B
REG_B=$(post "/register" "{\"pid\":$PID_B,\"pid_start\":\"$PIDSTART_B\",\"cwd\":\"/tmp/test-b\",\"name\":\"peer-beta\"}")
PEER_B_ID=$(json_field "$REG_B" "['data']['id']")
PEER_B_SECRET=$(json_field "$REG_B" "['data']['secret']")
PEER_B_NAME=$(json_field "$REG_B" "['data']['name']")
check "Peer B registered" "peer-beta" "$PEER_B_NAME"

# Verify list-peers
PEERS=$(post "/list-peers" "{}")
check_contains "list-peers shows peer A" "peer-alpha" "$PEERS"
check_contains "list-peers shows peer B" "peer-beta" "$PEERS"

echo ""
echo "=== Codex session identity ==="

sleep 300 &
SLEEP_PIDS+=($!)
PID_CODEX_1=$!

sleep 300 &
SLEEP_PIDS+=($!)
PID_CODEX_2=$!
PIDSTART_CODEX_1=$(date +%s)
PIDSTART_CODEX_2=$(date +%s)

CODEX_REG_1=$(post "/register" "{\"pid\":$PID_CODEX_1,\"pid_start\":\"$PIDSTART_CODEX_1\",\"runtime\":\"codex\",\"session_key\":\"codex-session-1\",\"host_pid\":$PID_CODEX_1,\"host_pid_start\":\"$PIDSTART_CODEX_1\",\"cwd\":\"/tmp/codex\",\"name\":\"codex-first\",\"name_is_explicit\":false}")
CODEX_ID_1=$(json_field "$CODEX_REG_1" "['data']['id']")
CODEX_SECRET_1=$(json_field "$CODEX_REG_1" "['data']['secret']")
CODEX_NAME_1=$(json_field "$CODEX_REG_1" "['data']['name']")
check "Codex first registration name" "codex-first" "$CODEX_NAME_1"

CODEX_REG_2=$(post "/register" "{\"pid\":$PID_CODEX_2,\"pid_start\":\"$PIDSTART_CODEX_2\",\"runtime\":\"codex\",\"session_key\":\"codex-session-1\",\"host_pid\":$PID_CODEX_2,\"host_pid_start\":\"$PIDSTART_CODEX_2\",\"cwd\":\"/tmp/codex\",\"name\":\"codex-second\",\"name_is_explicit\":false}")
CODEX_ID_2=$(json_field "$CODEX_REG_2" "['data']['id']")
CODEX_NAME_2=$(json_field "$CODEX_REG_2" "['data']['name']")
check "Codex duplicate keeps same peer id" "$CODEX_ID_1" "$CODEX_ID_2"
check "Codex duplicate keeps stable generated name" "codex-first" "$CODEX_NAME_2"
CODEX_SECRET_2=$(json_field "$CODEX_REG_2" "['data']['secret']")
check "Codex duplicate keeps logical peer secret" "$CODEX_SECRET_1" "$CODEX_SECRET_2"

# Both registrations describe LIVE MCP servers (codex parent thread + a
# fork/subagent thread), so both are connections of one logical peer.
CODEX_CONNS=$(post "/list-peers" "{}")
check "Codex peer tracks both MCP connections" "2" "$(peer_field "$CODEX_CONNS" "$CODEX_ID_1" "connections")"

# THE regression that broke live sessions: an instance that no longer owns
# peers.pid must never be told it is superseded — it used to exit on that and
# close a transport its agent still needed.
CODEX_OLD_HEARTBEAT=$(post "/heartbeat" "{\"peer_id\":\"$CODEX_ID_1\",\"peer_secret\":\"$CODEX_SECRET_1\",\"pid\":$PID_CODEX_1,\"pid_start\":\"$PIDSTART_CODEX_1\"}")
check_not_contains "Superseded Codex MCP instance is never told to shut down" "stale_registration" "$CODEX_OLD_HEARTBEAT"
check_contains "Superseded Codex MCP instance heartbeat is acknowledged" "\"acknowledged\":true" "$CODEX_OLD_HEARTBEAT"

CODEX_CURRENT_HEARTBEAT=$(post "/heartbeat" "{\"peer_id\":\"$CODEX_ID_2\",\"peer_secret\":\"$CODEX_SECRET_2\",\"pid\":$PID_CODEX_2,\"pid_start\":\"$PIDSTART_CODEX_2\"}")
check_contains "Current Codex process heartbeat accepted" "\"acknowledged\":true" "$CODEX_CURRENT_HEARTBEAT"

# A finished subagent's server exiting must not retire the shared identity.
CODEX_CONN_UNREG=$(post "/unregister" "{\"peer_id\":\"$CODEX_ID_1\",\"peer_secret\":\"$CODEX_SECRET_1\",\"pid\":$PID_CODEX_1,\"pid_start\":\"$PIDSTART_CODEX_1\"}")
check "One connection leaving does not retire the Codex peer" "False" "$(json_field "$CODEX_CONN_UNREG" "['data']['unregistered']")"
check "Surviving connection keeps the Codex peer alive" "1" "$(json_field "$CODEX_CONN_UNREG" "['data']['connections_remaining']")"

CODEX_STILL_ACTIVE=$(post "/heartbeat" "{\"peer_id\":\"$CODEX_ID_2\",\"peer_secret\":\"$CODEX_SECRET_2\"}")
check_contains "Codex peer remains active after a sibling connection left" "\"ok\":true" "$CODEX_STILL_ACTIVE"

# A process with no connection row cannot retire a peer others are using.
CODEX_STALE_UNREG=$(post "/unregister" "{\"peer_id\":\"$CODEX_ID_1\",\"peer_secret\":\"$CODEX_SECRET_1\",\"pid\":$PID_CODEX_1,\"pid_start\":\"$PIDSTART_CODEX_1\"}")
check_contains "Untracked process cannot unregister a peer with live connections" "stale_registration" "$CODEX_STALE_UNREG"

# Its own heartbeat re-adds the dropped connection (broker restart / DB loss).
CODEX_READD=$(post "/heartbeat" "{\"peer_id\":\"$CODEX_ID_1\",\"peer_secret\":\"$CODEX_SECRET_1\",\"pid\":$PID_CODEX_1,\"pid_start\":\"$PIDSTART_CODEX_1\"}")
check_contains "Dropped connection is re-added by its own heartbeat" "\"readded\":true" "$CODEX_READD"

# Last connection out retires the peer.
post "/unregister" "{\"peer_id\":\"$CODEX_ID_1\",\"peer_secret\":\"$CODEX_SECRET_1\",\"pid\":$PID_CODEX_1,\"pid_start\":\"$PIDSTART_CODEX_1\"}" > /dev/null
CODEX_CUR_UNREG=$(post "/unregister" "{\"peer_id\":\"$CODEX_ID_2\",\"peer_secret\":\"$CODEX_SECRET_2\",\"pid\":$PID_CODEX_2,\"pid_start\":\"$PIDSTART_CODEX_2\"}")
check "Last Codex connection retires the peer" "True" "$(json_field "$CODEX_CUR_UNREG" "['data']['unregistered']")"

CODEX_REG_3=$(post "/register" "{\"pid\":$PID_CODEX_2,\"pid_start\":\"$PIDSTART_CODEX_2\",\"runtime\":\"codex\",\"session_key\":\"codex-session-1\",\"host_pid\":$PID_CODEX_2,\"host_pid_start\":\"$PIDSTART_CODEX_2\",\"cwd\":\"/tmp/codex\",\"name\":\"codex-third\",\"name_is_explicit\":false}")
CODEX_ID_3=$(json_field "$CODEX_REG_3" "['data']['id']")
check "Codex session reuses peer id after reconnect" "$CODEX_ID_1" "$CODEX_ID_3"

PEERS_AFTER_CODEX=$(post "/list-peers" "{}")
check_contains "list-peers shows canonical Codex peer" "codex-first" "$PEERS_AFTER_CODEX"
check_not_contains "list-peers hides second Codex name" "codex-second" "$PEERS_AFTER_CODEX"
check_not_contains "list-peers hides third Codex name" "codex-third" "$PEERS_AFTER_CODEX"

echo ""
echo "=== Codex duplicate MCP servers under one host process ==="

# Codex spawns an MCP server per thread inside one host process and does not
# always kill the previous one. Two live rows for one codex process means the peer
# other agents can address is not the one the agent believes it is — but the fix
# is adoption, not reaping: reaping a LIVE row made its server re-register, which
# reaped the other, forever (each flip spamming pool disconnect/reconnect).
sleep 300 &
SLEEP_PIDS+=($!)
PID_DUP_HOST=$!
sleep 300 &
SLEEP_PIDS+=($!)
PID_DUP_1=$!
sleep 300 &
SLEEP_PIDS+=($!)
PID_DUP_2=$!
sleep 300 &
SLEEP_PIDS+=($!)
PID_DUP_HOST_2=$!
PIDSTART_DUP=$(date +%s)

DUP_REG_1=$(post "/register" "{\"pid\":$PID_DUP_1,\"pid_start\":\"$PIDSTART_DUP\",\"runtime\":\"codex\",\"session_key\":\"codex-root:root-A\",\"host_pid\":$PID_DUP_HOST,\"host_pid_start\":\"$PIDSTART_DUP\",\"cwd\":\"/tmp/codex-dup\",\"name\":\"codex-dup-first\",\"name_is_explicit\":false}")
DUP_ID_1=$(json_field "$DUP_REG_1" "['data']['id']")
check "Codex host peer registered" "codex-dup-first" "$(json_field "$DUP_REG_1" "['data']['name']")"

# Second MCP server for the SAME codex process, resolving only the weaker
# host-scoped key (session id unresolvable) — a different session_key, so the
# key-based dedupe cannot catch it.
DUP_REG_2=$(post "/register" "{\"pid\":$PID_DUP_2,\"pid_start\":\"$PIDSTART_DUP\",\"runtime\":\"codex\",\"session_key\":\"codex-host:$PID_DUP_HOST\",\"host_pid\":$PID_DUP_HOST,\"host_pid_start\":\"$PIDSTART_DUP\",\"cwd\":\"/tmp/codex-dup\",\"name\":\"codex-dup-second\",\"name_is_explicit\":false}")
DUP_ID_2=$(json_field "$DUP_REG_2" "['data']['id']")
check "Weaker key adopts the live peer of the same codex host" "$DUP_ID_1" "$DUP_ID_2"
check "Adopted registration keeps the canonical name" "codex-dup-first" "$(json_field "$DUP_REG_2" "['data']['name']")"
check "Adopted registration shares the logical peer secret" "$(json_field "$DUP_REG_1" "['data']['secret']")" "$(json_field "$DUP_REG_2" "['data']['secret']")"

PEERS_DUP=$(post "/list-peers" "{}")
check_contains "list-peers shows one canonical Codex peer per host" "codex-dup-first" "$PEERS_DUP"
check_not_contains "adopted registration does not create a second peer" "codex-dup-second" "$PEERS_DUP"
check "Both MCP servers of the host are tracked as connections" "2" "$(peer_field "$PEERS_DUP" "$DUP_ID_1" "connections")"

# No flip-flop: alternating registers/heartbeats from both live instances must
# leave one stable identity, and neither may be told to shut down.
DUP_FLIP_1=$(post "/register" "{\"pid\":$PID_DUP_1,\"pid_start\":\"$PIDSTART_DUP\",\"runtime\":\"codex\",\"session_key\":\"codex-root:root-A\",\"host_pid\":$PID_DUP_HOST,\"host_pid_start\":\"$PIDSTART_DUP\",\"cwd\":\"/tmp/codex-dup\",\"name\":\"codex-dup-first\",\"name_is_explicit\":false}")
DUP_FLIP_2=$(post "/register" "{\"pid\":$PID_DUP_2,\"pid_start\":\"$PIDSTART_DUP\",\"runtime\":\"codex\",\"session_key\":\"codex-host:$PID_DUP_HOST\",\"host_pid\":$PID_DUP_HOST,\"host_pid_start\":\"$PIDSTART_DUP\",\"cwd\":\"/tmp/codex-dup\",\"name\":\"codex-dup-second\",\"name_is_explicit\":false}")
check "Re-register from instance A keeps the identity" "$DUP_ID_1" "$(json_field "$DUP_FLIP_1" "['data']['id']")"
check "Re-register from instance B keeps the identity" "$DUP_ID_1" "$(json_field "$DUP_FLIP_2" "['data']['id']")"
DUP_SECRET_1=$(json_field "$DUP_REG_1" "['data']['secret']")
DUP_HB_A=$(post "/heartbeat" "{\"peer_id\":\"$DUP_ID_1\",\"peer_secret\":\"$DUP_SECRET_1\",\"pid\":$PID_DUP_1,\"pid_start\":\"$PIDSTART_DUP\"}")
DUP_HB_B=$(post "/heartbeat" "{\"peer_id\":\"$DUP_ID_1\",\"peer_secret\":\"$DUP_SECRET_1\",\"pid\":$PID_DUP_2,\"pid_start\":\"$PIDSTART_DUP\"}")
check_not_contains "Instance A is never superseded" "stale_registration" "$DUP_HB_A"
check_not_contains "Instance B is never superseded" "stale_registration" "$DUP_HB_B"
PEERS_NOFLIP=$(post "/list-peers" "{}")
check "Still exactly one peer for the host after the flip rounds" "2" "$(peer_field "$PEERS_NOFLIP" "$DUP_ID_1" "connections")"

# `codex resume` → new codex process, new MCP server, same fork-chain root key.
DUP_REG_3=$(post "/register" "{\"pid\":$PID_DUP_HOST_2,\"pid_start\":\"$PIDSTART_DUP\",\"runtime\":\"codex\",\"session_key\":\"codex-root:root-A\",\"host_pid\":$PID_DUP_HOST_2,\"host_pid_start\":\"$PIDSTART_DUP\",\"cwd\":\"/tmp/codex-dup\",\"name\":\"codex-dup-third\",\"name_is_explicit\":false}")
check "Codex root key reclaims the same peer id after resume" "$DUP_ID_1" "$(json_field "$DUP_REG_3" "['data']['id']")"
check "Codex root key reclaims the original peer name" "codex-dup-first" "$(json_field "$DUP_REG_3" "['data']['name']")"

# A server that cannot resolve the rollout id registers under the weak
# host-scoped key. When the strong root key shows up for the same host, the row
# must upgrade to it — otherwise the identity is unreclaimable after `codex
# resume`, which runs in a new host process.
sleep 300 &
SLEEP_PIDS+=($!)
PID_UP_HOST=$!
sleep 300 &
SLEEP_PIDS+=($!)
PID_UP_2=$!
sleep 300 &
SLEEP_PIDS+=($!)
PID_UP_HOST_2=$!
PIDSTART_UP=$(date +%s)

UP_REG_1=$(post "/register" "{\"pid\":$PID_UP_HOST,\"pid_start\":\"$PIDSTART_UP\",\"runtime\":\"codex\",\"session_key\":\"codex-host:$PID_UP_HOST\",\"host_pid\":$PID_UP_HOST,\"host_pid_start\":\"$PIDSTART_UP\",\"cwd\":\"/tmp/codex-up\",\"name\":\"codex-up-first\",\"name_is_explicit\":false}")
UP_ID_1=$(json_field "$UP_REG_1" "['data']['id']")
UP_REG_2=$(post "/register" "{\"pid\":$PID_UP_2,\"pid_start\":\"$PIDSTART_UP\",\"runtime\":\"codex\",\"session_key\":\"codex-root:root-UP\",\"host_pid\":$PID_UP_HOST,\"host_pid_start\":\"$PIDSTART_UP\",\"cwd\":\"/tmp/codex-up\",\"name\":\"codex-up-second\",\"name_is_explicit\":false}")
check "Strong root key adopts the same host's live peer" "$UP_ID_1" "$(json_field "$UP_REG_2" "['data']['id']")"

UP_REG_3=$(post "/register" "{\"pid\":$PID_UP_HOST_2,\"pid_start\":\"$PIDSTART_UP\",\"runtime\":\"codex\",\"session_key\":\"codex-root:root-UP\",\"host_pid\":$PID_UP_HOST_2,\"host_pid_start\":\"$PIDSTART_UP\",\"cwd\":\"/tmp/codex-up\",\"name\":\"codex-up-third\",\"name_is_explicit\":false}")
check "Upgraded root key reclaims the identity from a new host process" "$UP_ID_1" "$(json_field "$UP_REG_3" "['data']['id']")"

echo ""
echo "=== Claude session identity (stable ID across restarts / Wi-Fi changes) ==="

sleep 300 &
SLEEP_PIDS+=($!)
PID_CL_1=$!
sleep 300 &
SLEEP_PIDS+=($!)
PID_CL_2=$!
PIDSTART_CL_1=$(date +%s)
PIDSTART_CL_2=$(date +%s)

# First register with a Claude session_key (CLAUDE_CODE_SESSION_ID)
CL_REG_1=$(post "/register" "{\"pid\":$PID_CL_1,\"pid_start\":\"$PIDSTART_CL_1\",\"runtime\":\"claude\",\"session_key\":\"claude-session-1\",\"host_pid\":$PID_CL_1,\"host_pid_start\":\"$PIDSTART_CL_1\",\"cwd\":\"/tmp/claude\",\"name\":\"claude-first\",\"name_is_explicit\":false}")
CL_ID_1=$(json_field "$CL_REG_1" "['data']['id']")
CL_SECRET_1=$(json_field "$CL_REG_1" "['data']['secret']")
check "Claude first registration name" "claude-first" "$(json_field "$CL_REG_1" "['data']['name']")"

# MCP server restart (e.g. new host PID after reconnect) — same session_key.
# Must reuse the SAME peer id/secret/name so the CCT identity is stable.
CL_REG_2=$(post "/register" "{\"pid\":$PID_CL_2,\"pid_start\":\"$PIDSTART_CL_2\",\"runtime\":\"claude\",\"session_key\":\"claude-session-1\",\"host_pid\":$PID_CL_2,\"host_pid_start\":\"$PIDSTART_CL_2\",\"cwd\":\"/tmp/claude\",\"name\":\"claude-second\",\"name_is_explicit\":false}")
check "Claude re-register keeps same peer id" "$CL_ID_1" "$(json_field "$CL_REG_2" "['data']['id']")"
check "Claude re-register keeps stable name" "claude-first" "$(json_field "$CL_REG_2" "['data']['name']")"
check "Claude re-register keeps same secret" "$CL_SECRET_1" "$(json_field "$CL_REG_2" "['data']['secret']")"

# --- Wi-Fi outage recovery: identity AND pool membership must survive ---
# The naive check (same id after a bare status='dead') is not enough: real stale
# cleanup (markPeerDeadTx) also drops pool memberships and archives emptied pools.
# The revived peer must reclaim BOTH its id and its pool memberships, or it comes
# back mute (excluded from broadcasts, own sends rejected). Ref: Codex finding #1.

# claude peer is in two pools before the outage:
#   - claude-wifi-pool: shared with peer B (tests bidirectional delivery)
#   - claude-solo-pool: claude only (tests archive → un-archive on revive)
post "/pool/create" "{\"peer_id\":\"$CL_ID_1\",\"peer_secret\":\"$CL_SECRET_1\",\"name\":\"claude-wifi-pool\",\"purpose\":\"wifi test\"}" > /dev/null
post "/pool/invite" "{\"peer_id\":\"$CL_ID_1\",\"peer_secret\":\"$CL_SECRET_1\",\"target_peer_id\":\"$PEER_B_ID\",\"pool_name\":\"claude-wifi-pool\"}" > /dev/null
post "/pool/create" "{\"peer_id\":\"$CL_ID_1\",\"peer_secret\":\"$CL_SECRET_1\",\"name\":\"claude-solo-pool\",\"purpose\":\"solo test\"}" > /dev/null

# Simulate the FULL effect of stale cleanup's markPeerDeadTx during the outage:
# status='dead' + died_at=T, and every active membership marked left with left_at=T
# (same timestamp — that pairing is how revive knows what death dropped). The solo
# pool becomes empty, so it is archived, exactly like archivePoolIfEmpty would.
python3 << PYEOF
import sqlite3, os, datetime
db = sqlite3.connect(os.environ['CCT_DIR'] + '/cct.db')
t = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
db.execute("UPDATE peers SET status='dead', died_at=? WHERE id=?", (t, '$CL_ID_1'))
db.execute("UPDATE pool_members SET status='left', left_at=? WHERE peer_id=? AND status='active'", (t, '$CL_ID_1'))
# solo pool now has no active members → archived (mirrors archivePoolIfEmpty)
db.execute("""UPDATE pools SET status='archived' WHERE name='claude-solo-pool'
              AND NOT EXISTS (SELECT 1 FROM pool_members pm WHERE pm.pool_id=pools.id AND pm.status='active')""")
db.commit()
db.close()
PYEOF

# While dead, the peer is mute: it is not an active member of its shared pool.
STATUS_DEAD=$(post "/pool/status" "{\"pool_name\":\"claude-wifi-pool\"}")
check_not_contains "Dead Claude peer dropped from shared pool" "claude-first" "$STATUS_DEAD"

# Network returns → server re-registers with the same session_key.
CL_REG_3=$(post "/register" "{\"pid\":$PID_CL_2,\"pid_start\":\"$PIDSTART_CL_2\",\"runtime\":\"claude\",\"session_key\":\"claude-session-1\",\"host_pid\":$PID_CL_2,\"host_pid_start\":\"$PIDSTART_CL_2\",\"cwd\":\"/tmp/claude\",\"name\":\"claude-third\",\"name_is_explicit\":false}")
check "Claude reclaims same id after being marked dead" "$CL_ID_1" "$(json_field "$CL_REG_3" "['data']['id']")"
CL_REVIVED=$(post "/heartbeat" "{\"peer_id\":\"$CL_ID_1\",\"peer_secret\":\"$CL_SECRET_1\",\"pid\":$PID_CL_2,\"pid_start\":\"$PIDSTART_CL_2\"}")
check_contains "Revived Claude peer heartbeats OK" "\"acknowledged\":true" "$CL_REVIVED"

# Membership must be restored: shared pool shows the peer again, solo pool un-archived.
STATUS_ALIVE=$(post "/pool/status" "{\"pool_name\":\"claude-wifi-pool\"}")
check_contains "Revived Claude peer restored to shared pool" "claude-first" "$STATUS_ALIVE"
SOLO_LIST=$(post "/pool/list" "{\"peer_id\":\"$CL_ID_1\"}")
check_contains "Revived Claude peer's solo pool un-archived" "claude-solo-pool" "$SOLO_LIST"

# Bidirectional delivery works after recovery:
#   B → pool, claude receives it
post "/message/send" "{\"peer_id\":\"$PEER_B_ID\",\"peer_secret\":\"$PEER_B_SECRET\",\"pool_name\":\"claude-wifi-pool\",\"body\":\"welcome back\"}" > /dev/null
CL_POLL=$(post "/message/poll" "{\"peer_id\":\"$CL_ID_1\"}")
check_contains "Recovered Claude peer receives pool messages" "welcome back" "$CL_POLL"
#   claude → pool, send accepted (not "not a member")
CL_SEND=$(post "/message/send" "{\"peer_id\":\"$CL_ID_1\",\"peer_secret\":\"$CL_SECRET_1\",\"pool_name\":\"claude-wifi-pool\",\"body\":\"im back\"}")
check_contains "Recovered Claude peer can send to its pool" "\"ok\":true" "$CL_SEND"

# A Claude peer WITHOUT a session_key stays ephemeral (legacy behavior): two
# registrations must produce DIFFERENT ids.
CL_NOSESS_1=$(post "/register" "{\"pid\":$PID_CL_1,\"pid_start\":\"$PIDSTART_CL_1\",\"runtime\":\"claude\",\"cwd\":\"/tmp/claude-legacy\",\"name\":\"legacy-claude\"}")
CL_NOSESS_2=$(post "/register" "{\"pid\":$PID_CL_2,\"pid_start\":\"$PIDSTART_CL_2\",\"runtime\":\"claude\",\"cwd\":\"/tmp/claude-legacy\",\"name\":\"legacy-claude\"}")
NOSESS_ID_1=$(json_field "$CL_NOSESS_1" "['data']['id']")
NOSESS_ID_2=$(json_field "$CL_NOSESS_2" "['data']['id']")
if [ "$NOSESS_ID_1" != "$NOSESS_ID_2" ]; then
  pass "Session-less Claude peers stay ephemeral (distinct ids)"
else
  fail "Session-less Claude peers should get distinct ids (got $NOSESS_ID_1 twice)"
fi

# Clean up Claude identity test peers/pools so they don't pollute later tests.
# Peer B leaves the shared pool first (it lingers as an active member otherwise).
post "/pool/leave" "{\"peer_id\":\"$PEER_B_ID\",\"peer_secret\":\"$PEER_B_SECRET\",\"pool_name\":\"claude-wifi-pool\"}" > /dev/null 2>&1 || true
# Drain B's inbox of claude-pool traffic so later unread-count assertions are clean.
post "/message/check" "{\"peer_id\":\"$PEER_B_ID\",\"peer_secret\":\"$PEER_B_SECRET\"}" > /dev/null 2>&1 || true
python3 << PYEOF
import sqlite3, os
db = sqlite3.connect(os.environ['CCT_DIR'] + '/cct.db')
db.execute("UPDATE peers SET status = 'dead' WHERE cwd IN ('/tmp/claude', '/tmp/claude-legacy')")
db.execute("UPDATE pools SET status = 'archived' WHERE name IN ('claude-wifi-pool', 'claude-solo-pool')")
db.commit()
db.close()
PYEOF

# --- Pool tests ---

echo ""
echo "=== Pool operations ==="

# Create pool
POOL_RES=$(post "/pool/create" "{\"peer_id\":\"$PEER_A_ID\",\"peer_secret\":\"$PEER_A_SECRET\",\"name\":\"test-pool\",\"purpose\":\"integration test\"}")
POOL_OK=$(json_field "$POOL_RES" "['ok']")
POOL_ID=$(json_field "$POOL_RES" "['data']['pool_id']")
check "Pool created" "True" "$POOL_OK"

# Invite B to pool
INVITE_RES=$(post "/pool/invite" "{\"peer_id\":\"$PEER_A_ID\",\"peer_secret\":\"$PEER_A_SECRET\",\"target_peer_id\":\"$PEER_B_ID\",\"pool_name\":\"test-pool\"}")
INVITE_OK=$(json_field "$INVITE_RES" "['ok']")
check "Peer B invited to pool" "True" "$INVITE_OK"

# Verify pool members
POOL_STATUS=$(post "/pool/status" "{\"pool_name\":\"test-pool\"}")
check_contains "Pool status shows peer-alpha" "peer-alpha" "$POOL_STATUS"
check_contains "Pool status shows peer-beta" "peer-beta" "$POOL_STATUS"

# --- Pool message flow ---

echo ""
echo "=== Pool messaging ==="

# Send message from A to pool
MSG_RES=$(post "/message/send" "{\"peer_id\":\"$PEER_A_ID\",\"peer_secret\":\"$PEER_A_SECRET\",\"pool_name\":\"test-pool\",\"body\":\"Hello from Alpha!\"}")
MSG_OK=$(json_field "$MSG_RES" "['ok']")
MSG_ID=$(json_field "$MSG_RES" "['data']['message_id']")
RCPT_COUNT=$(json_field "$MSG_RES" "['data']['recipient_count']")
check "Pool message sent" "True" "$MSG_OK"
check "Message has 1 recipient (B, not sender A)" "1" "$RCPT_COUNT"

# Poll messages for B
POLL_B=$(post "/message/poll" "{\"peer_id\":\"$PEER_B_ID\"}")
check_contains "B receives pool message" "Hello from Alpha" "$POLL_B"

# Check unread count for B
UNREAD_B=$(post "/message/unread-count" "{\"peer_id\":\"$PEER_B_ID\"}")
UNREAD_TOTAL=$(json_field "$UNREAD_B" "['data']['total']")
# unread-count includes both the chat message and the invite system message
# So total >= 1 is good
if [ "$UNREAD_TOTAL" -ge 1 ] 2>/dev/null; then
  pass "B has unread messages (total=$UNREAD_TOTAL)"
else
  fail "B should have unread messages (got total=$UNREAD_TOTAL)"
fi

# Mark messages as read — need to get the message IDs from poll
B_MSG_IDS=$(echo "$POLL_B" | python3 -c "
import sys, json
d = json.load(sys.stdin)
ids = [m['message_id'] for m in d.get('data', [])]
print(json.dumps(ids))
")
READ_RES=$(post "/message/read" "{\"peer_id\":\"$PEER_B_ID\",\"peer_secret\":\"$PEER_B_SECRET\",\"message_ids\":$B_MSG_IDS}")
READ_OK=$(json_field "$READ_RES" "['ok']")
check "Messages marked as read" "True" "$READ_OK"

# Verify unread count is now 0
UNREAD_B2=$(post "/message/unread-count" "{\"peer_id\":\"$PEER_B_ID\"}")
UNREAD_TOTAL2=$(json_field "$UNREAD_B2" "['data']['total']")
check "B unread count is 0 after read" "0" "$UNREAD_TOTAL2"

# --- DM flow ---

echo ""
echo "=== DM messaging ==="

DM_RES=$(post "/message/send" "{\"peer_id\":\"$PEER_B_ID\",\"peer_secret\":\"$PEER_B_SECRET\",\"to_peer_id\":\"$PEER_A_ID\",\"body\":\"DM from Beta\"}")
DM_OK=$(json_field "$DM_RES" "['ok']")
check "DM sent from B to A" "True" "$DM_OK"

POLL_A=$(post "/message/poll" "{\"peer_id\":\"$PEER_A_ID\"}")
check_contains "A receives DM" "DM from Beta" "$POLL_A"

# --- Pool archival ---

echo ""
echo "=== Pool archival ==="

# Both peers leave
LEAVE_A=$(post "/pool/leave" "{\"peer_id\":\"$PEER_A_ID\",\"peer_secret\":\"$PEER_A_SECRET\",\"pool_name\":\"test-pool\"}")
check "Peer A left pool" "True" "$(json_field "$LEAVE_A" "['ok']")"

LEAVE_B=$(post "/pool/leave" "{\"peer_id\":\"$PEER_B_ID\",\"peer_secret\":\"$PEER_B_SECRET\",\"pool_name\":\"test-pool\"}")
check "Peer B left pool" "True" "$(json_field "$LEAVE_B" "['ok']")"

# Check pool is archived
POOL_STATUS2=$(post "/pool/status" "{\"pool_name\":\"test-pool\"}")
POOL_STAT=$(json_field "$POOL_STATUS2" "['data']['status']")
check "Pool is archived after all members leave" "archived" "$POOL_STAT"

# Pool should not appear in pool list
POOL_LIST=$(post "/pool/list" "{}")
check_not_contains "Archived pool not in active list" "test-pool" "$POOL_LIST"

# --- Pool rejoin (reactivation) ---

echo ""
echo "=== Pool rejoin ==="

JOIN_RES=$(post "/pool/join" "{\"peer_id\":\"$PEER_A_ID\",\"peer_secret\":\"$PEER_A_SECRET\",\"pool_name\":\"test-pool\"}")
JOIN_OK=$(json_field "$JOIN_RES" "['ok']")
check "Peer A rejoined archived pool" "True" "$JOIN_OK"

POOL_STATUS3=$(post "/pool/status" "{\"pool_name\":\"test-pool\"}")
POOL_STAT3=$(json_field "$POOL_STATUS3" "['data']['status']")
check "Pool reactivated after rejoin" "active" "$POOL_STAT3"

# --- Peer death notification ---

echo ""
echo "=== Peer crash simulation ==="

# Invite B back to pool
INVITE_B2=$(post "/pool/invite" "{\"peer_id\":\"$PEER_A_ID\",\"peer_secret\":\"$PEER_A_SECRET\",\"target_peer_id\":\"$PEER_B_ID\",\"pool_name\":\"test-pool\"}")
check "B re-invited to pool" "True" "$(json_field "$INVITE_B2" "['ok']")"

# First mark B's messages as read so we can cleanly detect new system messages
POLL_B_PRE=$(post "/message/poll" "{\"peer_id\":\"$PEER_B_ID\"}")
B_PRE_IDS=$(echo "$POLL_B_PRE" | python3 -c "
import sys, json
d = json.load(sys.stdin)
ids = [m['message_id'] for m in d.get('data', [])]
print(json.dumps(ids))
" 2>/dev/null || echo "[]")
if [ "$B_PRE_IDS" != "[]" ]; then
  post "/message/read" "{\"peer_id\":\"$PEER_B_ID\",\"peer_secret\":\"$PEER_B_SECRET\",\"message_ids\":$B_PRE_IDS}" > /dev/null
fi

# Connection-set liveness: a peer survives while ANY of its MCP servers lives,
# and dies when the last one is gone. Set up two peers before the (shared) stale
# cleanup wait below so this costs no extra test time.
sleep 300 &
SLEEP_PIDS+=($!)
PID_SURV_LIVE=$!
sleep 300 &
SLEEP_PIDS+=($!)
PID_SURV_DEAD=$!
sleep 300 &
SLEEP_PIDS+=($!)
PID_GONE=$!
PIDSTART_CONN=$(date +%s)

SURV_REG=$(post "/register" "{\"pid\":$PID_SURV_LIVE,\"pid_start\":\"$PIDSTART_CONN\",\"runtime\":\"codex\",\"session_key\":\"codex-root:surv\",\"host_pid\":$PID_SURV_LIVE,\"host_pid_start\":\"$PIDSTART_CONN\",\"cwd\":\"/tmp/codex-surv\",\"name\":\"codex-surv\",\"name_is_explicit\":true}")
SURV_ID=$(json_field "$SURV_REG" "['data']['id']")
SURV_SECRET=$(json_field "$SURV_REG" "['data']['secret']")
post "/register" "{\"pid\":$PID_SURV_DEAD,\"pid_start\":\"$PIDSTART_CONN\",\"runtime\":\"codex\",\"session_key\":\"codex-root:surv\",\"host_pid\":$PID_SURV_LIVE,\"host_pid_start\":\"$PIDSTART_CONN\",\"cwd\":\"/tmp/codex-surv\",\"name\":\"codex-surv\",\"name_is_explicit\":true}" > /dev/null

GONE_REG=$(post "/register" "{\"pid\":$PID_GONE,\"pid_start\":\"$PIDSTART_CONN\",\"runtime\":\"codex\",\"session_key\":\"codex-root:gone\",\"host_pid\":$PID_GONE,\"host_pid_start\":\"$PIDSTART_CONN\",\"cwd\":\"/tmp/codex-gone\",\"name\":\"codex-gone\",\"name_is_explicit\":true}")
GONE_ID=$(json_field "$GONE_REG" "['data']['id']")

# Kill peer A's sleep process to simulate crash
kill "${SLEEP_PIDS[0]}" 2>/dev/null || true
wait "${SLEEP_PIDS[0]}" 2>/dev/null || true

# Kill one of the survivor's two MCP processes, and the lone process of the other.
kill "$PID_SURV_DEAD" 2>/dev/null || true
wait "$PID_SURV_DEAD" 2>/dev/null || true
kill "$PID_GONE" 2>/dev/null || true
wait "$PID_GONE" 2>/dev/null || true

# Trigger stale peer cleanup (broker checks every 30s, we wait a bit or poke it)
sleep 1
# Send a heartbeat from B to keep it alive, then wait for cleanup cycle
post "/heartbeat" "{\"peer_id\":\"$PEER_B_ID\",\"peer_secret\":\"$PEER_B_SECRET\"}" > /dev/null

# The stale check runs every 30s; wait for it
echo "  Waiting for stale peer cleanup (up to 35s)..."
for i in $(seq 1 35); do
  sleep 1
  # Keep the survivor's live connection heartbeating, as a real MCP server would.
  post "/heartbeat" "{\"peer_id\":\"$SURV_ID\",\"peer_secret\":\"$SURV_SECRET\",\"pid\":$PID_SURV_LIVE,\"pid_start\":\"$PIDSTART_CONN\"}" > /dev/null
  PEER_A_STATUS=$(post "/list-peers" "{}" | python3 -c "
import sys, json
d = json.load(sys.stdin)
# Peer A won't be in active list if dead
print('dead')
" 2>/dev/null)
  # Check if A has been cleaned up by looking for system messages to B
  CHECK_MSGS=$(post "/message/poll" "{\"peer_id\":\"$PEER_B_ID\"}")
  if echo "$CHECK_MSGS" | grep -q "disconnected"; then
    break
  fi
done

DEATH_MSGS=$(post "/message/poll" "{\"peer_id\":\"$PEER_B_ID\"}")
check_contains "B received death notification" "disconnected" "$DEATH_MSGS"

PEERS_AFTER_CLEANUP=$(post "/list-peers" "{}")
check_contains "Peer with one live MCP connection survives cleanup" "codex-surv" "$PEERS_AFTER_CLEANUP"
check "Dead connection row is reaped, live one kept" "1" "$(peer_field "$PEERS_AFTER_CLEANUP" "$SURV_ID" "connections")"
check_not_contains "Peer whose last MCP connection died is retired" "codex-gone" "$PEERS_AFTER_CLEANUP"
check "Retired peer is gone from list-peers" "" "$(peer_field "$PEERS_AFTER_CLEANUP" "$GONE_ID" "connections")"

# --- Security tests ---

echo ""
echo "=== Security verification ==="

# Directory permissions
DIR_PERMS=$(stat -f "%OLp" "$CCT_DIR" 2>/dev/null || stat -c "%a" "$CCT_DIR" 2>/dev/null)
check "~/.cct/ permissions are 700" "700" "$DIR_PERMS"

PIDMAP_PERMS=$(stat -f "%OLp" "$CCT_DIR/pidmaps" 2>/dev/null || stat -c "%a" "$CCT_DIR/pidmaps" 2>/dev/null)
check "pidmaps/ permissions are 700" "700" "$PIDMAP_PERMS"

FLAG_PERMS=$(stat -f "%OLp" "$CCT_DIR/flags" 2>/dev/null || stat -c "%a" "$CCT_DIR/flags" 2>/dev/null)
check "flags/ permissions are 700" "700" "$FLAG_PERMS"

# Broker rejects mutations without secret
NO_SEC=$(post "/heartbeat" "{\"peer_id\":\"$PEER_B_ID\"}")
check_contains "Heartbeat without secret rejected" "peer_secret" "$NO_SEC"

# Broker rejects wrong secret
WRONG_SEC=$(post "/heartbeat" "{\"peer_id\":\"$PEER_B_ID\",\"peer_secret\":\"wrong-secret-value\"}")
check_contains "Wrong secret rejected" "invalid" "$WRONG_SEC"

# Broker rejects set-summary without secret
NO_SEC_SUM=$(post "/set-summary" "{\"peer_id\":\"$PEER_B_ID\",\"summary\":\"test\"}")
check_contains "set-summary without secret rejected" "peer_secret" "$NO_SEC_SUM"

# Broker rejects pool create without secret
NO_SEC_POOL=$(post "/pool/create" "{\"peer_id\":\"$PEER_B_ID\",\"name\":\"evil-pool\"}")
check_contains "pool/create without secret rejected" "peer_secret" "$NO_SEC_POOL"

# Broker rejects message send without secret
NO_SEC_MSG=$(post "/message/send" "{\"peer_id\":\"$PEER_B_ID\",\"pool_name\":\"test-pool\",\"body\":\"evil\"}")
check_contains "message/send without secret rejected" "peer_secret" "$NO_SEC_MSG"

# --- Release consensus (2-peer) ---

echo ""
echo "=== Release consensus (2-peer, unanimous) ==="

# Re-register peer A (it was killed earlier)
sleep 300 &
SLEEP_PIDS+=($!)
PID_A2=$!
PIDSTART_A2=$(date +%s)

REG_A2=$(post "/register" "{\"pid\":$PID_A2,\"pid_start\":\"$PIDSTART_A2\",\"cwd\":\"/tmp/test-a2\",\"name\":\"peer-alpha2\"}")
PEER_A2_ID=$(json_field "$REG_A2" "['data']['id']")
PEER_A2_SECRET=$(json_field "$REG_A2" "['data']['secret']")
check "Peer A2 registered" "peer-alpha2" "$(json_field "$REG_A2" "['data']['name']")"

# Create a fresh pool for release tests
RPOOL=$(post "/pool/create" "{\"peer_id\":\"$PEER_A2_ID\",\"peer_secret\":\"$PEER_A2_SECRET\",\"name\":\"release-pool\",\"purpose\":\"release test\"}")
check "Release pool created" "True" "$(json_field "$RPOOL" "['ok']")"

# Invite B
RINV=$(post "/pool/invite" "{\"peer_id\":\"$PEER_A2_ID\",\"peer_secret\":\"$PEER_A2_SECRET\",\"target_peer_id\":\"$PEER_B_ID\",\"pool_name\":\"release-pool\"}")
check "B invited to release pool" "True" "$(json_field "$RINV" "['ok']")"

# Clear B's messages
RPOLL=$(post "/message/check" "{\"peer_id\":\"$PEER_B_ID\",\"peer_secret\":\"$PEER_B_SECRET\"}")

# A proposes releasing B
PROPOSE=$(post "/pool/propose-release" "{\"peer_id\":\"$PEER_A2_ID\",\"peer_secret\":\"$PEER_A2_SECRET\",\"pool_name\":\"release-pool\",\"target_peer_id\":\"$PEER_B_ID\",\"reason\":\"task complete\"}")
PROPOSE_OK=$(json_field "$PROPOSE" "['ok']")
RELEASE_ID=$(json_field "$PROPOSE" "['data']['release_id']")
QUORUM_RULE=$(json_field "$PROPOSE" "['data']['quorum_rule']")
check "Release proposal created" "True" "$PROPOSE_OK"
check "2-peer quorum is unanimous" "unanimous" "$QUORUM_RULE"

# Check release status
RSTATUS=$(post "/pool/release-status" "{\"pool_name\":\"release-pool\"}")
check_contains "Release status shows open proposal" "open" "$RSTATUS"

# A's vote was auto-cast; need B's vote for unanimous
VOTE_B=$(post "/pool/vote-release" "{\"peer_id\":\"$PEER_B_ID\",\"peer_secret\":\"$PEER_B_SECRET\",\"release_id\":\"$RELEASE_ID\",\"vote\":\"yes\"}")
VOTE_OK=$(json_field "$VOTE_B" "['ok']")
VOTE_STATUS=$(json_field "$VOTE_B" "['data']['status']")
check "B voted on release" "True" "$VOTE_OK"
check "Release approved with unanimous votes" "approved" "$VOTE_STATUS"

# B should have release-approved message
BMSG=$(post "/message/check" "{\"peer_id\":\"$PEER_B_ID\",\"peer_secret\":\"$PEER_B_SECRET\"}")
check_contains "B received release approved message" "Release approved" "$(json_field "$BMSG" "['data']")"

# --- Release consensus edge cases ---

echo ""
echo "=== Release consensus edge cases ==="

# Vote on resolved proposal should fail (covers both double-vote and closed proposal)
DOUBLE_VOTE=$(post "/pool/vote-release" "{\"peer_id\":\"$PEER_B_ID\",\"peer_secret\":\"$PEER_B_SECRET\",\"release_id\":\"$RELEASE_ID\",\"vote\":\"yes\"}")
check_contains "Vote on resolved proposal rejected" "already approved" "$DOUBLE_VOTE"

# Duplicate proposal on same peer should fail (need to re-add B and try)
# Re-invite B first (they haven't left yet in the broker, but the release was approved)
PROPOSE_DUP=$(post "/pool/propose-release" "{\"peer_id\":\"$PEER_A2_ID\",\"peer_secret\":\"$PEER_A2_SECRET\",\"pool_name\":\"release-pool\",\"target_peer_id\":\"$PEER_B_ID\",\"reason\":\"again\"}")
# Should succeed since previous proposal was resolved (approved), not open
PROPOSE_DUP_OK=$(json_field "$PROPOSE_DUP" "['ok']")
check "New proposal after resolved one succeeds" "True" "$PROPOSE_DUP_OK"

# --- Release consensus (3-peer, majority) ---

echo ""
echo "=== Release consensus (3-peer, majority) ==="

sleep 300 &
SLEEP_PIDS+=($!)
PID_C=$!
PIDSTART_C=$(date +%s)

REG_C=$(post "/register" "{\"pid\":$PID_C,\"pid_start\":\"$PIDSTART_C\",\"cwd\":\"/tmp/test-c\",\"name\":\"peer-gamma\"}")
PEER_C_ID=$(json_field "$REG_C" "['data']['id']")
PEER_C_SECRET=$(json_field "$REG_C" "['data']['secret']")
check "Peer C registered" "peer-gamma" "$(json_field "$REG_C" "['data']['name']")"

# Create 3-peer pool
MPOOL=$(post "/pool/create" "{\"peer_id\":\"$PEER_A2_ID\",\"peer_secret\":\"$PEER_A2_SECRET\",\"name\":\"majority-pool\",\"purpose\":\"majority test\"}")
check "Majority pool created" "True" "$(json_field "$MPOOL" "['ok']")"

post "/pool/invite" "{\"peer_id\":\"$PEER_A2_ID\",\"peer_secret\":\"$PEER_A2_SECRET\",\"target_peer_id\":\"$PEER_B_ID\",\"pool_name\":\"majority-pool\"}" > /dev/null
post "/pool/invite" "{\"peer_id\":\"$PEER_A2_ID\",\"peer_secret\":\"$PEER_A2_SECRET\",\"target_peer_id\":\"$PEER_C_ID\",\"pool_name\":\"majority-pool\"}" > /dev/null

# Clear messages
post "/message/check" "{\"peer_id\":\"$PEER_B_ID\",\"peer_secret\":\"$PEER_B_SECRET\"}" > /dev/null
post "/message/check" "{\"peer_id\":\"$PEER_C_ID\",\"peer_secret\":\"$PEER_C_SECRET\"}" > /dev/null

# A proposes releasing C
PROPOSE3=$(post "/pool/propose-release" "{\"peer_id\":\"$PEER_A2_ID\",\"peer_secret\":\"$PEER_A2_SECRET\",\"pool_name\":\"majority-pool\",\"target_peer_id\":\"$PEER_C_ID\",\"reason\":\"done\"}")
RELEASE3_ID=$(json_field "$PROPOSE3" "['data']['release_id']")
QUORUM3=$(json_field "$PROPOSE3" "['data']['quorum_rule']")
check "3-peer quorum is majority" "majority" "$QUORUM3"

# B votes yes — should reach quorum (2/3 = majority)
VOTE3=$(post "/pool/vote-release" "{\"peer_id\":\"$PEER_B_ID\",\"peer_secret\":\"$PEER_B_SECRET\",\"release_id\":\"$RELEASE3_ID\",\"vote\":\"yes\"}")
VOTE3_STATUS=$(json_field "$VOTE3" "['data']['status']")
check "3-peer release approved by majority (2/3)" "approved" "$VOTE3_STATUS"

# --- Release rejection ---

echo ""
echo "=== Release rejection ==="

# New proposal: A proposes releasing B
PROPOSE_REJ=$(post "/pool/propose-release" "{\"peer_id\":\"$PEER_A2_ID\",\"peer_secret\":\"$PEER_A2_SECRET\",\"pool_name\":\"majority-pool\",\"target_peer_id\":\"$PEER_B_ID\",\"reason\":\"test rejection\"}")
REJ_ID=$(json_field "$PROPOSE_REJ" "['data']['release_id']")

# B votes no (1 yes, 1 no — still open with 3 members, need 2 for majority)
VOTE_REJ_B=$(post "/pool/vote-release" "{\"peer_id\":\"$PEER_B_ID\",\"peer_secret\":\"$PEER_B_SECRET\",\"release_id\":\"$REJ_ID\",\"vote\":\"no\"}")
VOTE_REJ_B_STATUS=$(json_field "$VOTE_REJ_B" "['data']['status']")
check "1 yes 1 no is still open (3 members)" "open" "$VOTE_REJ_B_STATUS"

# C votes no — now 2 no votes, quorum impossible (need 2 yes but only 1)
VOTE_REJ_C=$(post "/pool/vote-release" "{\"peer_id\":\"$PEER_C_ID\",\"peer_secret\":\"$PEER_C_SECRET\",\"release_id\":\"$REJ_ID\",\"vote\":\"no\"}")
VOTE_REJ_STATUS=$(json_field "$VOTE_REJ_C" "['data']['status']")
check "Rejection after 2 no votes (quorum impossible)" "rejected" "$VOTE_REJ_STATUS"

# --- Busy signaling ---

echo ""
echo "=== Pool throttle ==="

# Clear messages first
post "/message/check" "{\"peer_id\":\"$PEER_A2_ID\",\"peer_secret\":\"$PEER_A2_SECRET\"}" > /dev/null
post "/message/check" "{\"peer_id\":\"$PEER_B_ID\",\"peer_secret\":\"$PEER_B_SECRET\"}" > /dev/null
post "/message/check" "{\"peer_id\":\"$PEER_C_ID\",\"peer_secret\":\"$PEER_C_SECRET\"}" > /dev/null

# A sets pool idle (should auto-approve — no recent cross-talk)
IDLE_RES=$(post "/pool/set-idle" "{\"peer_id\":\"$PEER_A2_ID\",\"peer_secret\":\"$PEER_A2_SECRET\",\"pool_name\":\"majority-pool\",\"minutes\":10,\"reason\":\"running tests\"}")
IDLE_OK=$(json_field "$IDLE_RES" "['ok']")
check "Set pool idle succeeded" "True" "$IDLE_OK"
check_contains "Idle response has idle_until" "idle_until" "$IDLE_RES"
check_contains "Idle response approved" "approved" "$IDLE_RES"

# B should get pool_idle notification
BMSG2=$(post "/message/check" "{\"peer_id\":\"$PEER_B_ID\",\"peer_secret\":\"$PEER_B_SECRET\"}")
check_contains "B received pool_idle notification" "set pool idle" "$(json_field "$BMSG2" "['data']")"

# Message check should include pool_throttles
CMSG=$(post "/message/check" "{\"peer_id\":\"$PEER_C_ID\",\"peer_secret\":\"$PEER_C_SECRET\"}")
check_contains "Message check includes pool_throttles" "pool_throttles" "$CMSG"

# B sends a chat — should auto-clear the throttle
post "/message/send" "{\"peer_id\":\"$PEER_B_ID\",\"peer_secret\":\"$PEER_B_SECRET\",\"pool_name\":\"majority-pool\",\"body\":\"hey everyone\"}" > /dev/null

# After auto-clear, peek should show pool_active
PEEK_AFTER=$(post "/message/peek" "{\"peer_id\":\"$PEER_C_ID\",\"peer_secret\":\"$PEER_C_SECRET\"}")
check_contains "Peek shows pool_active after auto-clear" "pool_active" "$PEEK_AFTER"

# Clear messages for next tests
post "/message/check" "{\"peer_id\":\"$PEER_A2_ID\",\"peer_secret\":\"$PEER_A2_SECRET\"}" > /dev/null
post "/message/check" "{\"peer_id\":\"$PEER_B_ID\",\"peer_secret\":\"$PEER_B_SECRET\"}" > /dev/null
post "/message/check" "{\"peer_id\":\"$PEER_C_ID\",\"peer_secret\":\"$PEER_C_SECRET\"}" > /dev/null

# A sets idle again, then clears explicitly
IDLE_RES2=$(post "/pool/set-idle" "{\"peer_id\":\"$PEER_A2_ID\",\"peer_secret\":\"$PEER_A2_SECRET\",\"pool_name\":\"majority-pool\",\"minutes\":5,\"reason\":\"second round\"}")
check "Second set-idle succeeded" "True" "$(json_field "$IDLE_RES2" "['ok']")"

CLEAR_RES=$(post "/pool/clear-idle" "{\"peer_id\":\"$PEER_A2_ID\",\"peer_secret\":\"$PEER_A2_SECRET\",\"pool_name\":\"majority-pool\"}")
check "Clear idle succeeded" "True" "$(json_field "$CLEAR_RES" "['ok']")"

# B should get pool_active notification
BMSG3=$(post "/message/check" "{\"peer_id\":\"$PEER_B_ID\",\"peer_secret\":\"$PEER_B_SECRET\"}")
check_contains "B received pool_active notification" "Resume normal polling" "$(json_field "$BMSG3" "['data']")"

# Non-setter cannot clear
post "/message/check" "{\"peer_id\":\"$PEER_A2_ID\",\"peer_secret\":\"$PEER_A2_SECRET\"}" > /dev/null
post "/message/check" "{\"peer_id\":\"$PEER_B_ID\",\"peer_secret\":\"$PEER_B_SECRET\"}" > /dev/null
post "/message/check" "{\"peer_id\":\"$PEER_C_ID\",\"peer_secret\":\"$PEER_C_SECRET\"}" > /dev/null
IDLE_RES3=$(post "/pool/set-idle" "{\"peer_id\":\"$PEER_A2_ID\",\"peer_secret\":\"$PEER_A2_SECRET\",\"pool_name\":\"majority-pool\",\"minutes\":5}")
CLEAR_FAIL=$(post "/pool/clear-idle" "{\"peer_id\":\"$PEER_B_ID\",\"peer_secret\":\"$PEER_B_SECRET\",\"pool_name\":\"majority-pool\"}")
check_contains "Non-setter clear-idle rejected" "only the setter" "$CLEAR_FAIL"

# Clean up throttle for next tests
post "/pool/clear-idle" "{\"peer_id\":\"$PEER_A2_ID\",\"peer_secret\":\"$PEER_A2_SECRET\",\"pool_name\":\"majority-pool\"}" > /dev/null
post "/message/check" "{\"peer_id\":\"$PEER_A2_ID\",\"peer_secret\":\"$PEER_A2_SECRET\"}" > /dev/null
post "/message/check" "{\"peer_id\":\"$PEER_B_ID\",\"peer_secret\":\"$PEER_B_SECRET\"}" > /dev/null
post "/message/check" "{\"peer_id\":\"$PEER_C_ID\",\"peer_secret\":\"$PEER_C_SECRET\"}" > /dev/null

echo ""
echo "=== Pool throttle edge cases ==="

sleep 300 &
SLEEP_PIDS+=($!)
PID_D=$!

REG_D=$(post "/register" "{\"pid\":$PID_D,\"pid_start\":\"$(date +%s)\",\"cwd\":\"/tmp/test-d\",\"name\":\"peer-delta\"}")
PEER_D_ID=$(json_field "$REG_D" "['data']['id']")
PEER_D_SECRET=$(json_field "$REG_D" "['data']['secret']")

IDLE_FAIL=$(post "/pool/set-idle" "{\"peer_id\":\"$PEER_D_ID\",\"peer_secret\":\"$PEER_D_SECRET\",\"pool_name\":\"majority-pool\",\"minutes\":5}")
check_contains "Non-member set-idle rejected" "not a member" "$IDLE_FAIL"

# Deprecated endpoints return errors
BUSY_DEP=$(post "/pool/set-busy" "{\"peer_id\":\"$PEER_A2_ID\",\"peer_secret\":\"$PEER_A2_SECRET\",\"pool_name\":\"majority-pool\",\"minutes\":5}")
check_contains "set-busy returns deprecated" "deprecated" "$BUSY_DEP"

READY_DEP=$(post "/pool/set-ready" "{\"peer_id\":\"$PEER_A2_ID\",\"peer_secret\":\"$PEER_A2_SECRET\",\"pool_name\":\"majority-pool\"}")
check_contains "set-ready returns deprecated" "deprecated" "$READY_DEP"

# Propose release by non-member should fail
PROPOSE_FAIL=$(post "/pool/propose-release" "{\"peer_id\":\"$PEER_D_ID\",\"peer_secret\":\"$PEER_D_SECRET\",\"pool_name\":\"majority-pool\",\"target_peer_id\":\"$PEER_B_ID\"}")
check_contains "Non-member propose-release rejected" "not a member" "$PROPOSE_FAIL"

# --- Stale peer detection ---

echo ""
echo "=== Stale peer detection (undelivered message bounce) ==="

# Register a new peer that will go stale
STALE_PEER=$(post "/register" '{"name":"stale-peer","pid":99999,"pid_start":"fake_999","cwd":"/tmp/stale","git_root":"/tmp/stale","git_branch":"main"}')
STALE_PEER_ID=$(json_field "$STALE_PEER" "['data']['id']")
STALE_PEER_SECRET=$(json_field "$STALE_PEER" "['data']['secret']")
check_contains "Stale peer registered" "\"ok\":true" "$STALE_PEER"

# Create pool and add both the stale peer and peer A
STALE_POOL=$(post "/pool/create" "{\"peer_id\":\"$PEER_A_ID\",\"peer_secret\":\"$PEER_A_SECRET\",\"name\":\"stale-test-pool\",\"purpose\":\"test stale detection\"}")
check_contains "Stale test pool created" "\"ok\":true" "$STALE_POOL"

post "/pool/join" "{\"peer_id\":\"$STALE_PEER_ID\",\"peer_secret\":\"$STALE_PEER_SECRET\",\"pool_name\":\"stale-test-pool\"}" > /dev/null

# Make the stale peer's last_seen very old but keep status active initially
# (simulates a peer that stopped heartbeating but hasn't been cleaned up yet)
# Must use ISO format with T and Z to match Node's Date serialization
python3 << PYEOF
import sqlite3, os, datetime
db = sqlite3.connect(os.environ['CCT_DIR'] + '/cct.db')
old_ts = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=120)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
db.execute("UPDATE peers SET last_seen = ? WHERE id = ?", (old_ts, '$STALE_PEER_ID'))
db.commit()
db.close()
PYEOF

# Send message to pool — stale peer should be flagged
STALE_SEND=$(post "/message/send" "{\"peer_id\":\"$PEER_A_ID\",\"peer_secret\":\"$PEER_A_SECRET\",\"pool_name\":\"stale-test-pool\",\"body\":\"hello?\"}")
check_contains "Message sent despite stale recipient" "\"ok\":true" "$STALE_SEND"
check_contains "Stale recipients included in response" "stale_recipients" "$STALE_SEND"
check_contains "Stale peer name in warning" "stale-peer" "$STALE_SEND"

# DM to stale peer — peer still has status=active so DM should go through with warning
DM_STALE=$(post "/message/send" "{\"peer_id\":\"$PEER_A_ID\",\"peer_secret\":\"$PEER_A_SECRET\",\"to_peer_id\":\"$STALE_PEER_ID\",\"body\":\"you there?\"}")
check_contains "DM to stale peer succeeds" "\"ok\":true" "$DM_STALE"
check_contains "DM stale recipient warning" "stale_recipients" "$DM_STALE"

# DM to dead peer should be rejected
python3 << PYEOF
import sqlite3, os
db = sqlite3.connect(os.environ['CCT_DIR'] + '/cct.db')
db.execute("UPDATE peers SET status = 'dead' WHERE id = ?", ('$STALE_PEER_ID',))
db.commit()
db.close()
PYEOF
DM_DEAD=$(post "/message/send" "{\"peer_id\":\"$PEER_A_ID\",\"peer_secret\":\"$PEER_A_SECRET\",\"to_peer_id\":\"$STALE_PEER_ID\",\"body\":\"you there?\"}")
check_contains "DM to dead peer rejected" "not found or not active" "$DM_DEAD"

# --- Hook benchmark ---

echo ""
echo "=== Hook benchmark ==="

# Benchmark 1: No pidmap (non-CCT session)
# The hook uses $PPID to find pidmaps. Ensure none exist for this shell's parent.
# We can't override PPID (readonly), so we just ensure no pidmap exists.
rm -f "$CCT_DIR/pidmaps/${$}_"* 2>/dev/null || true
echo "  Benchmarking hook with no pidmap (100 iterations)..."
START_NS=$(python3 -c "import time; print(int(time.time_ns()))")
for i in $(seq 1 100); do
  echo '{"tool_name":"Read"}' | bash "$HOOK_SH" > /dev/null 2>&1 || true
done
END_NS=$(python3 -c "import time; print(int(time.time_ns()))")
ELAPSED_MS=$(python3 -c "print(($END_NS - $START_NS) / 1_000_000)")
AVG_MS=$(python3 -c "print(f'{($END_NS - $START_NS) / 1_000_000 / 100:.2f}')")
echo "  No pidmap: ${ELAPSED_MS}ms total, ${AVG_MS}ms avg"
AVG_OK=$(python3 -c "print('ok' if ($END_NS - $START_NS) / 1_000_000 / 100 < 10 else 'slow')")
check "Hook <10ms avg with no pidmap" "ok" "$AVG_OK"

# Benchmark 2: Pidmap exists, flag=0
echo "  Benchmarking hook with pidmap, count=0 (100 iterations)..."
mkdir -p "$CCT_DIR/pidmaps" "$CCT_DIR/flags"
MY_PPID=$$
PIDMAP_FILE="$CCT_DIR/pidmaps/${MY_PPID}_test"
echo "fake-peer-id" > "$PIDMAP_FILE"
echo "0" > "$CCT_DIR/flags/fake-peer-id.unread"

START_NS=$(python3 -c "import time; print(int(time.time_ns()))")
for i in $(seq 1 100); do
  echo '{"tool_name":"Read"}' | bash "$HOOK_SH" > /dev/null 2>&1 || true
done
END_NS=$(python3 -c "import time; print(int(time.time_ns()))")
AVG_MS2=$(python3 -c "print(f'{($END_NS - $START_NS) / 1_000_000 / 100:.2f}')")
echo "  Pidmap + count=0: ${AVG_MS2}ms avg"
AVG_OK2=$(python3 -c "print('ok' if ($END_NS - $START_NS) / 1_000_000 / 100 < 10 else 'slow')")
check "Hook <10ms avg with pidmap, count=0" "ok" "$AVG_OK2"

# Benchmark 3: Pidmap exists, count>0 (hook blocks)
echo "  Benchmarking hook with messages pending (100 iterations)..."
echo "3" > "$CCT_DIR/flags/fake-peer-id.unread"

START_NS=$(python3 -c "import time; print(int(time.time_ns()))")
for i in $(seq 1 100); do
  echo '{"tool_name":"Read"}' | bash "$HOOK_SH" > /dev/null 2>&1 || true
done
END_NS=$(python3 -c "import time; print(int(time.time_ns()))")
AVG_MS3=$(python3 -c "print(f'{($END_NS - $START_NS) / 1_000_000 / 100:.2f}')")
echo "  Pidmap + count>0 (blocks): ${AVG_MS3}ms avg"
AVG_OK3=$(python3 -c "print('ok' if ($END_NS - $START_NS) / 1_000_000 / 100 < 10 else 'slow')")
check "Hook <10ms avg with messages pending" "ok" "$AVG_OK3"

# Benchmark 4: CCT tool bypass
echo "  Benchmarking hook CCT tool bypass (100 iterations)..."
START_NS=$(python3 -c "import time; print(int(time.time_ns()))")
for i in $(seq 1 100); do
  echo '{"tool_name":"cct_check_messages"}' | bash "$HOOK_SH" > /dev/null 2>&1 || true
done
END_NS=$(python3 -c "import time; print(int(time.time_ns()))")
AVG_MS4=$(python3 -c "print(f'{($END_NS - $START_NS) / 1_000_000 / 100:.2f}')")
echo "  CCT tool bypass: ${AVG_MS4}ms avg"

# Clean up benchmark artifacts
rm -f "$PIDMAP_FILE" "$CCT_DIR/flags/fake-peer-id.unread"

# --- Hook tool_name parsing ---

echo ""
echo "=== Hook tool_name parsing ==="

# Test that CCT tools are bypassed (hook reads PPID from env, which is our shell's PID)
HOOK_OUT=$(echo '{"tool_name":"cct_send_message"}' | bash "$HOOK_SH" 2>/dev/null || true)
check "Hook bypasses cct_ tools" "" "$HOOK_OUT"

HOOK_OUT=$(echo '{"tool_name":"ToolSearch"}' | bash "$HOOK_SH" 2>/dev/null || true)
check "Hook bypasses ToolSearch" "" "$HOOK_OUT"

# Test that non-CCT tools exit clean when no pidmap exists
rm -f "$CCT_DIR/pidmaps/${$}_"* 2>/dev/null || true
HOOK_OUT=$(echo '{"tool_name":"Bash"}' | bash "$HOOK_SH" 2>/dev/null || true)
check "Hook exits clean for non-pool session" "" "$HOOK_OUT"

# --- Results ---

echo ""
echo "=========================================="
echo "  Results: $PASSED passed, $FAILED failed"
echo "=========================================="

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
