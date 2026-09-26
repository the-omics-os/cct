import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cctExtension from "./os-extension.js";

const root = mkdtempSync(join(tmpdir(), "cct-os-extension-"));
const cctDir = join(root, ".cct");
const pidmaps = join(cctDir, "pidmaps");
const flags = join(cctDir, "flags");
mkdirSync(pidmaps, { recursive: true });
mkdirSync(flags);
process.env.CCT_DIR = cctDir;
const session = "test-session-123";
const peer = "peer-123";
writeFileSync(join(pidmaps, `os_${session}`), `${peer}|os-test|test-producer`);
const hooks = new Map<string, (event: any, ctx: any) => unknown>();
const notices: unknown[] = [];
let active = true;
const context = { sessionManager: { getSessionId: () => session, getEntries: () => [] }, mode: "rpc", isIdle: () => false,
  ui: { setStatus: () => {}, notify: () => {} } };
cctExtension({
  on: (event: string, handler: (event: any, ctx: any) => unknown) => hooks.set(event, handler),
  getActiveTools: () => active ? ["cct_check_messages"] : [],
  sendMessage: (msg: unknown, opts: unknown) => notices.push([msg, opts]),
  appendEntry: () => {},
  registerCommand: () => {},
} as never);
const emit = (event: string, value: object = {}) => hooks.get(event)?.(value, context);
try {
  emit("session_start");
  emit("input", { source: "rpc" });
  emit("agent_start");
  writeFileSync(join(flags, `${peer}.os-notify`), JSON.stringify({ version: 1, peerId: peer, producer: "test-producer", readGeneration: 1, count: 1, maxId: 1, maxDmId: 0, timestamp: Date.now() }));
  // The pre-existing os guard used to block ordinary tools repeatedly. On this
  // path every tool proceeds; a single custom steer is delivered to the model.
  for (const name of ["bash", "mcp", "cct", "cct_check_messages", "cct_send_message", "ToolSearch", "read"]) {
    assert.equal(emit("tool_call", { toolName: name }), undefined, `${name} must proceed`);
  }
  assert.equal(notices.length, 1);
  for (let i = 0; i < 3; i++) emit("context", { messages: [] });
  assert.equal(notices.length, 1, "context must not inject competing notices");
  active = false;
  writeFileSync(join(flags, `${peer}.os-notify`), JSON.stringify({ version: 1, peerId: peer, producer: "test-producer", readGeneration: 2, count: 1, maxId: 2, maxDmId: 2, timestamp: Date.now() }));
  emit("tool_call", { toolName: "bash" });
  assert.equal(notices.length, 1, "unavailable recovery tool fails open");
  emit("session_shutdown");
  console.log("PASS os extension: no tool blocks, one model-visible notice, recovery readiness");
} finally {
  delete process.env.CCT_DIR;
  rmSync(root, { recursive: true, force: true });
}
