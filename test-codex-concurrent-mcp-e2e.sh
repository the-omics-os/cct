#!/bin/bash
set -euo pipefail

# End-to-end test for the failure that killed live Codex sessions:
#
#   Codex keeps one MCP client per thread inside a single host process (parent
#   thread + every fork/subagent thread). Every one of those MCP servers resolves
#   the SAME session_key, because the host's argv is the only identity signal an
#   MCP server can see. Registration used to overwrite peers.pid, the pid fence on
#   /heartbeat then answered `stale_registration` to the older instance, and that
#   instance exited — closing a stdio transport whose agent was still using it.
#   Codex never respawns a server that exits mid-session, so the parent session's
#   CCT tools were dead for good ("Transport closed").
#
# This drives two REAL server.ts instances under one fake codex host and asserts
# the first one still answers tool calls after the second initializes, past the
# heartbeat interval that used to retire it.
#
# Isolated broker on port 17890, isolated CCT_DIR and fake CODEX_HOME. Never
# touches the live broker, live ~/.cct, or real codex.

PORT=17890
BROKER_URL="http://127.0.0.1:$PORT"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/cct-codex-concurrent.XXXXXX")
export CCT_DIR="$WORK/cct"
export CCT_PORT="$PORT"
export CCT_BROKER="$BROKER_URL"
export CODEX_HOME="$WORK/codex"
export CCT_RUNTIME=codex
unset CCT_TOKEN CODEX_THREAD_ID CODEX_SESSION_ID CCT_CODEX_SESSION_ID 2>/dev/null || true

ROOT_ID="01a09100-0000-7000-8000-000000000001"
PROJECT="$WORK/project"

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

# Rollout transcript for the resumed session, padded past 16KB like the real one.
PAD=$(printf 'e%.0s' $(seq 1 20000))
printf '%s\n{"type":"message","payload":{"text":"x"}}\n' \
  "{\"type\":\"session_meta\",\"payload\":{\"session_id\":\"$ROOT_ID\",\"cwd\":\"$PROJECT\",\"originator\":\"codex-tui\",\"environment_context\":\"$PAD\"}}" \
  > "$CODEX_HOME/sessions/2026/09/13/rollout-2026-09-13T10-00-00-$ROOT_ID.jsonl"

# Fake codex host AND test driver in one: it must be the MCP servers' parent and
# carry `resume <session_id>` in its argv, because that is how server.ts finds the
# host (findCodexPid) and learns the session id (codex exports neither).
# Extensionless file in a tmp dir with no package.json → CommonJS.
cat > "$WORK/bin/codex" <<'DRIVER'
#!/usr/bin/env node
'use strict';
const { spawn } = require('child_process');

const SERVER = process.env.CCT_SERVER_TS;
const TSX_CMD = process.env.CCT_TSX_CMD;
const TSX_ARG0 = process.env.CCT_TSX_ARG0 || '';
const BROKER = process.env.CCT_BROKER;
// Must exceed HEARTBEAT_INTERVAL_MS (15s): the old code retired the parent on its
// next heartbeat after the sibling registered.
const HEARTBEAT_WAIT_MS = Number(process.env.CCT_E2E_WAIT_MS || 18000);

let passed = 0;
let failed = 0;
function check(desc, expected, actual) {
  if (String(actual) === String(expected)) {
    console.log(`  PASS: ${desc}`);
    passed++;
  } else {
    console.log(`  FAIL: ${desc} (expected='${expected}' actual='${actual}')`);
    failed++;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(tag) {
  const args = TSX_ARG0 ? [TSX_ARG0, SERVER] : [SERVER];
  const child = spawn(TSX_CMD, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', (d) => process.stderr.write(`[${tag}] ${d}`));

  const pending = new Map();
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });

  let nextId = 1;
  const request = (method, params, timeoutMs = 20000) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${tag}: ${method} timed out`));
    }, timeoutMs);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const notify = (method, params) =>
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');

  return { tag, child, request, notify };
}

async function handshake(s) {
  await s.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'fake-codex', version: '0' },
  });
  s.notify('notifications/initialized', {});
}

async function whoami(s) {
  const res = await s.request('tools/call', { name: 'cct_whoami', arguments: {} });
  const text = res?.result?.content?.[0]?.text ?? '';
  const m = text.match(/Peer ID: (\S+)/);
  return m ? m[1] : '';
}

async function listPeers() {
  const res = await fetch(`${BROKER}/list-peers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const json = await res.json();
  return json?.data ?? [];
}

async function waitForExit(child, ms = 15000) {
  const deadline = Date.now() + ms;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await sleep(200);
  }
}

async function main() {
  console.log('=== Parent thread MCP server ===');
  const a = startServer('A');
  await handshake(a);
  const idA = await whoami(a);
  check('parent MCP server registered a peer', true, /^[0-9a-f]{8}$/.test(idA));

  console.log('');
  console.log('=== Fork/subagent thread MCP server, same host process ===');
  const b = startServer('B');
  await handshake(b);
  const idB = await whoami(b);
  check('sibling MCP server shares the logical identity', idA, idB);

  let peers = await listPeers();
  check('one peer row for the codex host', 1, peers.length);
  check('both MCP servers tracked as connections', 2, peers[0]?.connections);

  console.log('');
  console.log(`=== Parent must survive the sibling (waiting ${HEARTBEAT_WAIT_MS}ms past a heartbeat) ===`);
  await sleep(HEARTBEAT_WAIT_MS);
  check('parent MCP server process still alive', null, a.child.exitCode);
  check('parent tool call still answers after sibling registered', idA, await whoami(a));

  console.log('');
  console.log('=== Sibling exits (subagent finished) ===');
  b.child.kill('SIGTERM');
  await waitForExit(b.child);
  await sleep(2000);
  peers = await listPeers();
  check('peer survives the sibling exit', 1, peers.length);
  check('one connection remains', 1, peers[0]?.connections);
  check('parent identity unchanged after sibling exit', idA, await whoami(a));

  a.child.kill('SIGTERM');
  await waitForExit(a.child);

  console.log('');
  console.log('==========================================');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('==========================================');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log(`  FAIL: driver error: ${e.message}`);
  process.exit(1);
});
DRIVER
chmod +x "$WORK/bin/codex"

if [ -x "$HERE/node_modules/.bin/tsx" ]; then
  export CCT_TSX_CMD="$HERE/node_modules/.bin/tsx"
  export CCT_TSX_ARG0=""
else
  export CCT_TSX_CMD="npx"
  export CCT_TSX_ARG0="tsx"
fi
export CCT_SERVER_TS="$HERE/server.ts"

echo "=== Starting isolated broker on $PORT ==="
CCT_PORT="$PORT" CCT_DIR="$CCT_DIR" npx tsx "$HERE/broker.ts" >"$WORK/broker.log" 2>&1 &
BROKER_PID=$!
for _ in $(seq 1 30); do
  curl -sf "$BROKER_URL/health" >/dev/null 2>&1 && break
  sleep 0.3
done
if ! curl -s "$BROKER_URL/health" | grep -q '"ok":true'; then
  echo "  FAIL: broker did not come up"
  tail -20 "$WORK/broker.log" 2>/dev/null
  exit 1
fi
echo "  PASS: broker healthy"

echo ""
STATUS=0
( cd "$PROJECT" && exec "$WORK/bin/codex" resume "$ROOT_ID" ) || STATUS=$?

if [ "$STATUS" -ne 0 ]; then
  echo "--- peers table ---"
  python3 - "$CCT_DIR/cct.db" <<'PY' 2>/dev/null || true
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
for row in con.execute("select id,name,session_key,pid,host_pid,status from peers order by registered_at"):
    print(row)
print("--- connections ---")
for row in con.execute("select peer_id,pid,host_pid,last_seen from peer_connections"):
    print(row)
PY
fi
exit "$STATUS"
