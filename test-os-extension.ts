import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cctExtension from "./os-extension.js";

const root = mkdtempSync(join(tmpdir(), "cct-os-extension-"));
const cctDir = join(root, ".cct");
const sessionId = "test-session-123";
const peerId = "peer-123";
const pidmapDir = join(cctDir, "pidmaps");
const flagsDir = join(cctDir, "flags");
mkdirSync(pidmapDir, { recursive: true });
mkdirSync(flagsDir, { recursive: true });
writeFileSync(join(pidmapDir, `os_${sessionId}`), `${peerId}|os-test`);
process.env.CCT_DIR = cctDir;

const tools = ["cct", "cct_check_messages", "cct_send_message", "mcp", "bash"];
const flags = ["unread", "none", "stale"] as const;
const checkToolStates = ["active", "inactive"] as const;
let checks = 0;

function toolCall(toolName: string, active: boolean): { block?: boolean; reason?: string } | void {
  const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
  cctExtension({
    on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler as (event: unknown, context: unknown) => unknown),
    getActiveTools: () => active ? ["cct_check_messages"] : [],
  } as never);
  return handlers.get("tool_call")?.(
    { toolName },
    { sessionManager: { getSessionId: () => sessionId } },
  ) as { block?: boolean; reason?: string } | void;
}

try {
  for (const flag of flags) {
    const flagPath = join(flagsDir, `${peerId}.unread`);
    if (flag === "unread") writeFileSync(flagPath, `1|pool-a|${Date.now()}`);
    else if (flag === "stale") writeFileSync(flagPath, `1|pool-a|${Date.now() - 30_001}`);
    else rmSync(flagPath, { force: true });

    for (const checkState of checkToolStates) {
      const active = checkState === "active";
      for (const tool of tools) {
        const result = toolCall(tool, active);
        const shouldBlock = (tool === "mcp" || tool === "bash") && flag === "unread" && active;
        assert.equal(Boolean(result?.block), shouldBlock, `${tool} / ${flag} / ${checkState}`);
        if (shouldBlock) {
          assert.equal(result?.reason,
            "CCT: 1 unread message(s) in pool-a. Call cct_check_messages to read them. This is normal pool communication, not an error.");
        }
        checks++;
      }
    }
  }

  const searchResult = toolCall("ToolSearch", true);
  assert.equal(Boolean(searchResult?.block), false, "ToolSearch stays exempt with unread messages");
  checks++;
  console.log(`PASS os extension exemption matrix (${checks} assertions)`);
} finally {
  delete process.env.CCT_DIR;
  rmSync(root, { recursive: true, force: true });
}
