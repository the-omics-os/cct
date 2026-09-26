// Installed os local synthetic provider; primitive file-trigger mode and real CCT acceptance mode.
import fs from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@the-omics-os/os";
const logPath = process.env.INBOX_WAKE_LOG!;
const markerPath = process.env.INBOX_WAKE_MARKER!;
const primitive = !!process.env.INBOX_WAKE_TRIGGER;
const token = "inbox-wake-primitive-v1";
function log(kind: string, extra: Record<string, unknown> = {}) {
  fs.appendFileSync(logPath, JSON.stringify({ kind, at: Date.now(), pid: process.pid, ...extra }) + "\n");
}
function text(message: any): string {
  return typeof message?.content === "string" ? message.content :
    (message?.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
}
export default function (pi: ExtensionAPI) {
  let poller: ReturnType<typeof setInterval> | undefined;
  let failedOnce = false;
  pi.on("session_start", (event, ctx) => {
    const marker = { sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(), pid: process.pid };
    fs.writeFileSync(markerPath, JSON.stringify(marker), { mode: 0o600 });
    log("session_start", { reason: event.reason, mode: ctx.mode, idle: ctx.isIdle(), ...marker, active: pi.getActiveTools() });
    if (!primitive) return;
    poller = setInterval(() => {
      const triggerPath = process.env.INBOX_WAKE_TRIGGER!;
      if (!fs.existsSync(triggerPath)) return;
      const contents = fs.readFileSync(triggerPath, "utf8").trim();
      fs.unlinkSync(triggerPath);
      if (contents !== token) { log("invalid_trigger"); return; }
      const idle = ctx.isIdle();
      log("external_event", { idle });
      if (!idle) { log("not_idle"); return; }
      pi.sendMessage({ customType: "inbox-wake-proof", content: token, display: true },
        { deliverAs: "steer", triggerTurn: true });
      log("custom_message_sent");
    }, 50);
  });
  pi.on("agent_start", (_event, ctx) => log("agent_start", { idle: ctx.isIdle() }));
  pi.on("agent_settled", (_event, ctx) => log("agent_settled", { idle: ctx.isIdle() }));
  pi.on("message_end", (event) => {
    if (event.message.role === "custom" || event.message.role === "toolResult")
      log("message_end", { role: event.message.role, customType: event.message.customType,
        toolName: event.message.toolName, content: text(event.message) });
  });
  pi.on("tool_call", event => log("tool_call", { toolName: event.toolName }));
  pi.on("tool_result", event => log("tool_result", { toolName: event.toolName, isError: event.isError,
    content: event.content.filter(c => c.type === "text").map(c => c.text).join("\n") }));
  pi.on("session_shutdown", event => {
    if (poller) clearInterval(poller);
    log("session_shutdown", { reason: event.reason });
  });
  pi.registerProvider("inbox-wake-local", {
    baseUrl: "http://127.0.0.1:1", apiKey: "synthetic-local", api: "inbox-wake-local-api",
    models: [{ id: "local", name: "Local proof only", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model: any, context: any, options: any) {
      const last = context.messages.at(-1);
      const contents = context.messages.map((m: any) => text(m));
      const abortProbe = process.env.INBOX_WAKE_ABORT === "1";
      const notice = contents.some((s: string) => s.includes("[CCT peer inbox notice]"));
      const checkResult = context.messages.some((m: any) => m.role === "toolResult" && m.toolName === "cct_check_messages");
      const ordinary = contents.some((s: string) => s.startsWith("PROBE_TOOL "));
      const busy = contents.some((s: string) => s.startsWith("PROBE_BUSY"));
      log("provider_request", { model: `${model.provider}/${model.id}`, lastRole: last?.role,
        lastTextContainsToken: text(last).includes(token), contextMessageCount: context.messages.length,
        notice, checkResult, ordinary, busy, lastText: text(last).slice(0, 250) });
      const stream = createAssistantMessageEventStream();
      let requested: any;
      if (!primitive && last?.role !== "toolResult") {
        // A busy notice can be queued after the user's ordinary-tool request.
        // Keep that user request first, then handle the notice at the next safe turn.
        for (let i = context.messages.length - 1; i >= 0; i--) {
          const message = context.messages[i];
          if (message.role === "toolResult") break;
          if (message.role === "user" && text(message).startsWith("PROBE_TOOL ")) {
            requested = JSON.parse(text(message).slice(11)); break;
          }
        }
        if (!requested && !abortProbe && notice && !checkResult) requested = { name: "cct_check_messages", arguments: {} };
        else if (!requested && !abortProbe && text(last).includes("[CCT peer inbox notice]")) requested = { name: "cct_check_messages", arguments: {} };
      }
      const failNow = !primitive && process.env.INBOX_WAKE_FAIL === "1" && !failedOnce;
      if (failNow) failedOnce = true;
      if (failNow) requested = undefined;
      const content: any[] = requested ? [{ type: "toolCall", id: `wake-${Date.now()}-${Math.random()}`, name: requested.name, arguments: requested.arguments }] :
        [{ type: "text", text: primitive ? "Synthetic inbox proof complete." : "Synthetic acceptance complete." }];
      const stopReason = failNow ? "error" : requested ? "toolUse" : "stop";
      const output: any = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, timestamp: Date.now() };
      const finish = (reason = stopReason) => {
        const message = { ...output, stopReason: reason };
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason, message }); stream.end();
      };
      // Keep the first DM-triggered provider request pending until RPC abort. The
      // owned timer is only a fallback if abort fails; it never requests inference.
      if (abortProbe && notice && !requested && !checkResult) {
        // Aborted synthetic request stays pending until the host's real AbortSignal
        // fires. A fallback bounds a broken abort without hiding it as a pass.
        const fallback = setTimeout(() => finish(), 10_000);
        options?.signal?.addEventListener("abort", () => {
          clearTimeout(fallback);
          log("provider_abort_signal");
          finish("aborted");
        }, { once: true });
      } else if (!primitive && text(last).startsWith("PROBE_BUSY")) setTimeout(() => finish(), 3500);
      else queueMicrotask(() => finish());
      return stream;
    },
  });
}
