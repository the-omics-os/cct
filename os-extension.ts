import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Local structural types: os's loader aliases do not apply to CCT's standalone tsc.
// Citations refer to the os source reviewed for PHASE_2 (134ceb8c).
type OsSessionManager = { getSessionId(): string }; // src/core/session-manager.ts:190-195,1021
type OsExtensionContext = { sessionManager: OsSessionManager }; // src/core/extensions/types.ts:319
type OsToolCallEvent = { toolName: string }; // src/core/extensions/types.ts:934-936
type OsToolCallResult = { block?: boolean; reason?: string }; // src/core/extensions/types.ts:1125-1128
// Existing AgentMessages are opaque; the extension only appends a message.
type OsContextEvent = { messages: unknown[] }; // src/core/extensions/types.ts:688-691
type OsContextResult = { messages?: unknown[] }; // src/core/extensions/types.ts:1119-1121
type OsHandler<E, R = void> = (event: E, ctx: OsExtensionContext) => R | void; // types.ts:1247 (sync subset)
type OsExtensionAPI = {
  on(event: "session_start" | "session_shutdown", handler: OsHandler<unknown>): void; // types.ts:1259,1272
  on(event: "tool_call", handler: OsHandler<OsToolCallEvent, OsToolCallResult>): void; // types.ts:1298
  on(event: "context", handler: OsHandler<OsContextEvent, OsContextResult>): void; // types.ts:1275
  getActiveTools(): string[]; // src/core/extensions/types.ts:1400
};

// PHASE_0 measured this exact direct-tool name with toolPrefix: "none".
const CHECK_MESSAGES = "cct_check_messages";
const STALE_MS = 30_000;

export default function cctExtension(pi: OsExtensionAPI): void {
  const cctDir = process.env.CCT_DIR ?? join(homedir(), ".cct");
  const pidmapDir = join(cctDir, "pidmaps");
  const sessionMarker = join(pidmapDir, `os_session_${process.pid}`);
  const diagnosedSessions = new Set<string>();

  function unreadReason(ctx: OsExtensionContext): string | undefined {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId || !/^[\w-]+$/.test(sessionId)) return;
    const pidmap = join(pidmapDir, `os_${sessionId}`);
    let peerId: string;
    try {
      peerId = readFileSync(pidmap, "utf8").trim().split("|")[0];
    } catch {
      if (!diagnosedSessions.has(sessionId)) {
        diagnosedSessions.add(sessionId);
        console.error(`CCT: session pidmap unavailable at ${pidmap}; allowing tools until MCP registration completes.`);
      }
      return;
    }
    // Cold discovery and disabled/colliding direct tools must never wedge the host.
    if (!/^[\w-]+$/.test(peerId) || !pi.getActiveTools().includes(CHECK_MESSAGES)) return;

    const raw = readFileSync(join(cctDir, "flags", `${peerId}.unread`), "utf8").trim();
    const fields = raw.split("|");
    const count = Number(fields[0]);
    if (!/^\d+$/.test(fields[0]) || !Number.isSafeInteger(count) || count <= 0) return;
    let pools = "";
    if (fields.length >= 3) {
      pools = fields[1];
      const timestamp = fields[fields.length - 1];
      if (timestamp) {
        if (!/^\d+$/.test(timestamp) || !Number.isSafeInteger(Number(timestamp))) return;
        if (Date.now() - Number(timestamp) > STALE_MS) return;
      }
    }
    return `CCT: ${count} unread message(s)${pools ? ` in ${pools}` : ""}. Call ${CHECK_MESSAGES} to read them. This is normal pool communication, not an error.`;
  }

  pi.on("session_start", (_event, ctx) => {
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      if (!sessionId || !/^[\w-]+$/.test(sessionId)) return;
      mkdirSync(pidmapDir, { recursive: true, mode: 0o700 });
      chmodSync(cctDir, 0o700);
      chmodSync(pidmapDir, 0o700);
      // File A is owned by this host. server.ts owns file B (os_{sessionId}).
      writeFileSync(sessionMarker, sessionId, { mode: 0o600 });
      chmodSync(sessionMarker, 0o600);
    } catch {}
  });

  pi.on("tool_call", (event, ctx) => {
    try {
      // Match hook.sh's *cct_* exclusion, including prefixed MCP tool names.
      if (event.toolName.includes("cct_") || event.toolName === "ToolSearch") return;
      const reason = unreadReason(ctx);
      if (reason) return { block: true, reason };
    } catch {}
  });

  // Next-turn delivery: context runs on provider requests, never as an idle wake-up.
  pi.on("context", (event, ctx) => {
    try {
      const reason = unreadReason(ctx);
      if (!reason) return;
      return {
        messages: [
          ...event.messages,
          // User text message shape: os/src/core/messages.ts:157-162,168-172.
          { role: "user", content: [{ type: "text", text: reason }], timestamp: Date.now() },
        ],
      };
    } catch {}
  });

  pi.on("session_shutdown", () => {
    try {
      // Only remove file A. MCP stdin EOF/host monitoring owns peer cleanup.
      unlinkSync(sessionMarker);
    } catch {}
  });
}
