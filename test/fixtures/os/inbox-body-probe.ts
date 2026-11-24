// Synthetic provider only: never reads CCT files, injects messages, or acknowledges DMs.
// Test-owned controls: release-N permits response N; error-once makes next released
// response fail; release-tool permits the optional ordinary busy tool to finish.
import fs from "node:fs";
import path from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@the-omics-os/os";
import { Type } from "typebox";

const root = process.env.INBOX_BODY_CONTROL!;
const logPath = process.env.INBOX_BODY_LOG!;
function log(kind: string, extra: Record<string, unknown> = {}) {
  fs.appendFileSync(logPath, JSON.stringify({ kind, at: Date.now(), pid: process.pid, ...extra }) + "\n");
}
function text(message: any): string {
  return typeof message?.content === "string" ? message.content :
    (message?.content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
}

export default function (pi: ExtensionAPI) {
  let request = 0;
  const pending = new Set<() => void>();
  pi.on("session_start", (event, ctx) => {
    const marker = { sessionId: ctx.sessionManager.getSessionId(), pid: process.pid,
      sessionFile: ctx.sessionManager.getSessionFile(), mode: ctx.mode };
    fs.writeFileSync(process.env.INBOX_BODY_MARKER!, JSON.stringify(marker), { mode: 0o600 });
    log("session_start", { ...marker, reason: event.reason, idle: ctx.isIdle() });
  });
  pi.on("agent_start", () => log("agent_start"));
  pi.on("agent_settled", () => log("agent_settled"));
  pi.on("message_end", event => log("message_end", { message: event.message, text: text(event.message) }));
  pi.on("tool_call", event => { log("tool_call", { toolName: event.toolName }); });
  pi.on("tool_result", event => { log("tool_result", { toolName: event.toolName, isError: event.isError }); });
  pi.on("session_shutdown", () => {
    for (const cancel of [...pending]) cancel();
    log("session_shutdown");
  });
  pi.registerTool({
    name: "inbox_body_wait", label: "Owned wait", description: "Local test-owned synchronization only",
    parameters: Type.Object({}),
    async execute(_id, _args, signal) {
      log("tool_enter");
      const end = Date.now() + 30_000;
      while (!fs.existsSync(path.join(root, "release-tool"))) {
        if (signal?.aborted || Date.now() > end) throw new Error("Owned tool aborted or timed out");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      log("tool_exit");
      return { content: [{ type: "text", text: "Owned ordinary tool completed." }], details: {} };
    },
  });
  pi.registerProvider("inbox-body-local", {
    baseUrl: "http://127.0.0.1:1", apiKey: "synthetic-not-a-credential", api: "inbox-body-local-api",
    models: [{ id: "local", name: "Local inbox body proof", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model: any, context: any, options: any) {
      const number = ++request;
      // Full actual model context, not a fixture-reconstructed inbox or substring-only claim.
      log("provider_request", { number, model: `${model.provider}/${model.id}`, context,
        texts: context.messages.map(text) });
      const stream = createAssistantMessageEventStream();
      const output: any = { role: "assistant", content: [], api: model.api, provider: model.provider,
        model: model.id, timestamp: Date.now(), stopReason: "pending",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      let done = false;
      let timer: ReturnType<typeof setInterval> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const abort = () => { log("provider_abort_signal", { number }); finish("aborted"); };
      const finish = (reason: "stop" | "error" | "aborted" | "toolUse") => {
        if (done) return;
        done = true;
        clearInterval(timer); clearTimeout(deadline);
        options?.signal?.removeEventListener("abort", abort);
        pending.delete(abort);
        output.stopReason = reason;
        if (reason === "error" || reason === "aborted") {
          output.errorMessage = reason === "error" ? "Synthetic deliberate failure" : "Synthetic cancelled";
          stream.push({ type: "error", reason, error: output });
        } else {
          output.content = reason === "toolUse" ? [{ type: "toolCall", id: `owned-${number}`,
            name: "inbox_body_wait", arguments: {} }] : [{ type: "text", text: `Synthetic response ${number} complete.` }];
          stream.push({ type: "done", reason, message: output });
        }
        log("provider_finish", { number, reason });
        stream.end();
      };
      stream.push({ type: "start", partial: output });
      pending.add(abort);
      options?.signal?.addEventListener("abort", abort, { once: true });
      timer = setInterval(() => {
        if (!fs.existsSync(path.join(root, `release-${number}`))) return;
        const fail = path.join(root, "error-once");
        if (fs.existsSync(fail)) { fs.unlinkSync(fail); finish("error"); return; }
        const busy = text(context.messages.at(-1)) === "BODY_BUSY";
        finish(busy ? "toolUse" : "stop");
      }, 25);
      deadline = setTimeout(() => { log("provider_timeout", { number }); finish("error"); }, 40_000);
      if (options?.signal?.aborted) abort();
      return stream;
    },
  });
}
