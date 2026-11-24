// Installed-host observation + synthetic provider. Never renders cards, reads
// CCT sidecars, changes tool arguments/results, injects messages, or acknowledges.
import fs from "node:fs";
import path from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@the-omics-os/os";
import lifecycleProbe from "./inbox-lifecycle-probe.ts";

export default function cardsProbe(pi: ExtensionAPI) {
  lifecycleProbe(pi); // Reuse real lifecycle/event/marker observations.
  const control = process.env.INBOX_BODY_CONTROL!;
  const log = (kind: string, extra: object = {}) => fs.appendFileSync(process.env.INBOX_BODY_LOG!,
    JSON.stringify({ kind, at: Date.now(), pid: process.pid, ...extra }) + "\n");
  pi.on("session_start", (_event, ctx) => log("native_theme", {
    name: ctx.ui.theme.name,
    sample: ctx.ui.theme.bg("customMessageBg", ctx.ui.theme.fg("text", "native-color-sample")),
    expanded: ctx.ui.getToolsExpanded(),
  }));
  pi.on("tool_call", event => log("probe_tool_call", { toolName: event.toolName, input: event.input }));
  pi.on("tool_execution_end", event => log("probe_tool_end", event));
  pi.registerCommand("cards-expanded", { description: "Observe actual native tool expansion",
    handler: (_args, ctx) => log("native_expansion", { expanded: ctx.ui.getToolsExpanded() }) });
  let request = 0;
  const pending = new Set<() => void>();
  pi.on("session_shutdown", () => { for (const cancel of [...pending]) cancel(); });
  // Override only the synthetic provider, not the actual adapter's direct tools.
  pi.registerProvider("inbox-body-local", {
    baseUrl: "http://127.0.0.1:1", apiKey: "synthetic-not-a-credential", api: "inbox-body-local-api",
    models: [{ id: "local", name: "Local CCT card proof", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 2000 }],
    streamSimple(model: any, context: any, options: any) {
      const number = ++request;
      const texts = context.messages.map((m: any) => typeof m.content === "string" ? m.content :
        (m.content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n"));
      log("provider_request", { number, model: `${model.provider}/${model.id}`, context, texts });
      const stream = createAssistantMessageEventStream();
      const output: any = { role: "assistant", content: [], api: model.api, provider: model.provider,
        model: model.id, timestamp: Date.now(), stopReason: "pending",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      let done = false;
      let timer: ReturnType<typeof setInterval>;
      let deadline: ReturnType<typeof setTimeout>;
      const finish = (reason: "stop" | "toolUse" | "aborted" | "error") => {
        if (done) return;
        done = true; clearInterval(timer); clearTimeout(deadline);
        options?.signal?.removeEventListener("abort", abort); pending.delete(abort);
        output.stopReason = reason;
        if (reason === "aborted" || reason === "error") {
          output.errorMessage = "Owned synthetic provider cancelled/timed out";
          stream.push({ type: "error", reason, error: output });
        } else {
          output.content = reason === "toolUse" ? [{ type: "toolCall", id: "owned-cct-card-send",
            name: "cct", arguments: JSON.parse(fs.readFileSync(path.join(control, "send.json"), "utf8")) }]
            : [{ type: "text", text: "Owned card workflow complete." }];
          stream.push({ type: "done", reason, message: output });
        }
        log("provider_finish", { number, reason }); stream.end();
      };
      const abort = () => { log("provider_abort_signal", { number }); finish("aborted"); };
      stream.push({ type: "start", partial: output });
      pending.add(abort); options?.signal?.addEventListener("abort", abort, { once: true });
      timer = setInterval(() => {
        if (fs.existsSync(path.join(control, `release-${number}`))) finish(number === 1 ? "toolUse" : "stop");
      }, 25);
      deadline = setTimeout(() => { log("provider_timeout", { number }); finish("error"); }, 60000);
      if (options?.signal?.aborted) abort();
      return stream;
    },
  });
}
