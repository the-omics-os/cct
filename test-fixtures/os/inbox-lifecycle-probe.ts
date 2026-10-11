// Real installed-host observation + synthetic inference only. No CCT reads/acks.
// Reuse the body fixture's provider and real AbortSignal handling; the harness
// gives each process fresh log/control directories across process restart.
import fs from "node:fs";
import bodyProbe from "./inbox-body-probe.ts";
import type { ExtensionAPI } from "@the-omics-os/os";

export default function lifecycleProbe(pi: ExtensionAPI) {
  const logPath = process.env.INBOX_BODY_LOG!;
  const log = (kind: string, extra: object = {}) => fs.appendFileSync(logPath,
    JSON.stringify({ kind, at: Date.now(), pid: process.pid, ...extra }) + "\n");
  // Keep the original synthetic provider, including its actual AbortSignal handling.
  // Each process gets separate logs/control directories from the harness.
  bodyProbe(pi);
  pi.on("input", (event) => { log("lifecycle_input", { text: event.text, source: event.source }); });
  pi.on("session_before_compact", (event) => {
    log("lifecycle_before_compact", { reason: event.reason, willRetry: event.willRetry,
      preparation: event.preparation });
    // Observe only: let the installed host generate its summary with the provider.
  });
  pi.on("session_compact", (event, ctx) => log("lifecycle_compact", {
    ...event, entries: ctx.sessionManager.getEntries(), contextEntries: ctx.sessionManager.buildContextEntries() }));
  pi.on("session_compact_failed", (event) => log("lifecycle_compact_failed", event));
  pi.on("session_shutdown", (event) => log("lifecycle_shutdown", event));
  pi.registerCommand("lifecycle-quit", {
    description: "Test-owned graceful host shutdown", handler: (_args, ctx) => ctx.shutdown(),
  });
  pi.registerCommand("lifecycle-reload", {
    description: "Test-owned actual host reload", handler: async (_args, ctx) => { await ctx.reload(); },
  });
  // No mocked session state, sendMessage, abort, or compaction implementation.
}
