// Loaded by the real os 0.2.0 extension loader. Synthetic inference, no HTTP model calls.
import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@the-omics-os/os";
const path = process.env.HARDENING_LOG!;
function log(kind: string, data: Record<string, unknown> = {}) {
  fs.appendFileSync(path, JSON.stringify({ kind, at: Date.now(), ...data }) + "\n");
}
function text(m: any) { return typeof m?.content === "string" ? m.content :
  (m?.content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n"); }
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export default function (pi: ExtensionAPI) {
  let request = 0;
  let ownedSibling: ChildProcess | undefined;
  const closeSibling = () => {
    if (!ownedSibling) return;
    log("owner_sibling_stop", { pid: ownedSibling.pid });
    ownedSibling.kill("SIGTERM");
    ownedSibling = undefined;
  };
  pi.on("session_start", (e, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    fs.writeFileSync(process.env.HARDENING_MARKER!, JSON.stringify({ sessionId, pid: process.pid }));
    log("session_start", { reason: e.reason, sessionId, mode: ctx.mode });
  });
  pi.on("session_shutdown", e => { closeSibling(); log("session_shutdown", { reason: e.reason }); });
  pi.on("agent_start", () => log("agent_start"));
  pi.on("agent_settled", () => log("agent_settled"));
  pi.on("input", e => {
    log("input", { text: e.text, source: e.source });
    if (e.text === "PREFLIGHT_HANDLED") { log("input_handled"); return { action: "handled" }; }
  });
  pi.on("before_agent_start", async e => {
    if (e.prompt === "PREFLIGHT_SLOW" || e.prompt === "PREFLIGHT_FAIL") {
      log("preflight_enter", { prompt: e.prompt });
      await pause(7200);
      log("preflight_exit", { prompt: e.prompt });
      if (e.prompt === "PREFLIGHT_FAIL") throw new Error("synthetic preflight failure");
    }
  });
  pi.on("session_before_compact", async () => {
    log("compact_enter");
    await pause(7200);
    log("compact_exit");
  });
  pi.on("session_before_tree", async (_e, ctx) => {
    log("tree_enter", { idle: ctx.isIdle() });
    await pause(6500);
    log("tree_exit", { idle: ctx.isIdle() });
    return { summary: { summary: "local tree summary", details: {} } };
  });
  pi.on("session_before_switch", () => {
    log("switch_enter");
    if (process.env.HARDENING_CANCEL_SWITCH === "1") { log("switch_cancel"); return { cancel: true }; }
  });
  pi.on("message_end", e => {
    if (e.message.role === "custom" || e.message.role === "toolResult")
      log("message_end", { role: e.message.role, customType: e.message.customType,
        toolName: e.message.toolName, content: text(e.message).slice(0, 600) });
  });
  pi.on("tool_call", e => log("tool_call", { toolName: e.toolName }));
  pi.on("tool_result", e => log("tool_result", { toolName: e.toolName,
    content: e.content.filter(c => c.type === "text").map(c => c.text).join("\n").slice(0, 600) }));
  pi.registerCommand("hardening-enable-auth", { handler: async () => {
    process.env.HARDENING_SYNTHETIC_AUTH = "synthetic-local";
    log("auth_enabled");
  } });
  pi.registerCommand("hardening-owner-spawn", { handler: async () => {
    if (ownedSibling) throw new Error("fixture sibling already exists");
    const loader = process.env.HARDENING_TSX_LOADER!;
    const server = process.env.HARDENING_SERVER!;
    if (!loader || !server) throw new Error("fixture sibling paths missing");
    const output = fs.openSync(process.env.HARDENING_SIBLING_LOG!, "a");
    try {
      ownedSibling = spawn(process.execPath, ["--import", loader, server], {
        env: { ...process.env, CCT_RUNTIME: "os", CCT_TOOL_SURFACE: "compact" },
        stdio: ["pipe", output, output],
      });
      ownedSibling.on("error", error => log("owner_sibling_error", { error: String(error) }));
      log("owner_sibling_spawn", { pid: ownedSibling.pid });
    } finally { fs.closeSync(output); }
  } });
  pi.registerCommand("hardening-owner-stop", { handler: async () => closeSibling() });
  pi.registerCommand("hardening-reload", { handler: async (_args, ctx) => {
    log("reload_enter");
    await ctx.reload();
    log("reload_done");
  } });
  pi.registerCommand("hardening-tree", { handler: async (_args, ctx) => {
    const entries = ctx.sessionManager.getEntries();
    const target = entries.find(e => e.type === "message" && e.message.role === "user");
    if (!target) throw new Error("tree fixture requires one completed human prompt");
    log("tree_command");
    const result = await ctx.navigateTree(target.id, { summarize: true });
    log("tree_done", { cancelled: result.cancelled });
  } });
  pi.registerTool({ name: "hardening_hold", label: "Hold", description: "Local cancellable test hold",
    parameters: { type: "object", properties: {} },
    async execute(_id, _params, signal) {
      log("hold_enter");
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 11000);
        signal?.addEventListener("abort", () => { clearTimeout(timer); log("hold_abort"); resolve(); }, { once: true });
      });
      log("hold_exit");
      return { content: [{ type: "text", text: "hold done" }], details: {} };
    } });
  pi.registerProvider("hardening-local", {
    baseUrl: "http://127.0.0.1:1", apiKey: process.env.HARDENING_AUTH_TEST === "1" ? "$HARDENING_SYNTHETIC_AUTH" : "synthetic-local", api: "hardening-local-api",
    models: [{ id: "local", name: "Synthetic", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model: any, context: any) {
      const last = context.messages.at(-1);
      const messages = context.messages.map((m: any) => text(m));
      const notice = messages.some((s: string) => s.includes("[CCT peer inbox notice]"));
      const latestNoticeIndex = context.messages.findLastIndex((m: any) => m.role === "user" && text(m).includes("[CCT peer inbox notice]"));
      const checked = context.messages.some((m: any, i: number) => i > latestNoticeIndex &&
        m.role === "toolResult" && m.toolName === "cct_check_messages");
      const hold = last?.role === "user" && text(last) === "HOLD";
      const lastCheck = context.messages.findLast((m: any) => m.role === "toolResult" && m.toolName === "cct_check_messages");
      const pong = /\[DM\][^\n]*PINGPONG:(\d+)/.exec(text(lastCheck));
      const alreadySent = context.messages.findLastIndex((m: any) => m.role === "toolResult" && m.toolName === "cct") >
        context.messages.findLastIndex((m: any) => m.role === "toolResult" && m.toolName === "cct_check_messages");
      const pongTarget = process.env.HARDENING_PONG_TARGET_FILE && fs.existsSync(process.env.HARDENING_PONG_TARGET_FILE)
        ? fs.readFileSync(process.env.HARDENING_PONG_TARGET_FILE, "utf8").trim() : "";
      const pongSend = lastCheck && !alreadySent && pong && pongTarget && Number(pong[1]) < 24;
      const name = hold ? "hardening_hold" : pongSend ? "cct" : notice && !checked && last?.role !== "toolResult" ? "cct_check_messages" : undefined;
      const args = pongSend ? { action: "send", to: pongTarget, message: `PINGPONG:${Number(pong[1]) + 1}` } : {};
      if (pongSend) log("pong_send", { target: pongTarget, n: Number(pong[1]) + 1 });
      const seq = ++request;
      log("provider_request", { seq, lastRole: last?.role, lastText: text(last).slice(0, 140), notice, checked, tool: name });
      const stream = createAssistantMessageEventStream();
      const content: any[] = name ? [{ type: "toolCall", id: `hardening-${seq}`, name, arguments: args }] :
        [{ type: "text", text: "Synthetic response" }];
      const output: any = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
        usage: { input: 50000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 50100,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: name ? "toolUse" : "stop", timestamp: Date.now() };
      const emit = () => { stream.push({ type: "start", partial: output });
        stream.push({ type: "done", reason: output.stopReason, message: output }); stream.end(); };
      if (notice && process.env.HARDENING_DELAY_NOTICE === "1" && !checked) {
        log("notice_provider_held", { seq });
        setTimeout(emit, 11000);
      } else queueMicrotask(emit);
      return stream;
    },
  });
}
