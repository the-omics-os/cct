// Display-only CCT send cards, extracted from the reviewed adapter renderer.
// pi-tui is supplied by the host loader; its dev dependency is only for tests.
import { Text, type Component } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";

type Send = { to: string; message: string };
type Theme = {
  fg(color: "text", text: string): string;
  bg(color: "customMessageBg", text: string): string;
};
type Context = { args?: unknown; state?: Record<string, unknown>; isPartial?: boolean; isError?: boolean };
type Renderer = (...args: any[]) => any;
type RenderableTool = { name?: unknown; renderCall?: Renderer; renderResult?: Renderer };
const empty: Component = { render: () => [], invalidate() {} };

function sendArgs(args: any): Send | undefined {
  if (args?.action !== "send" || typeof args.to !== "string" || !args.to.trim() ||
      typeof args.message !== "string" || !args.message.trim()) return undefined;
  return { to: args.to, message: args.message };
}

function terminalText(text: string): string {
  return stripVTControlCharacters(text).replace(/\r\n?/g, "\n").replace(/\t/g, "   ")
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
}

function card(send: Send, status: string, theme: Theme, extra = ""): Text {
  const text = terminalText(`CCT → ${send.to}\n${send.message}\n${status}${extra ? `\n${extra}` : ""}`);
  // Explicit foreground + matching background on every wrapped/padded line,
  // just like the incoming card. Never truncate the user's outgoing body.
  return new Text(theme.fg("text", text), 0, 0, line => theme.bg("customMessageBg", line));
}

function jsonish(value: unknown): string {
  try { return JSON.stringify(value, null, 2) ?? String(value); }
  catch { return "[unserializable result]"; }
}

function confirmation(send: Send, text: string): string {
  if (!send.to.startsWith("@")) return `DM sent to "${send.to}".`;
  const target = send.to.slice(1), slash = target.indexOf("/");
  if (slash >= 0) return `Sent directed message in pool "${target.slice(0, slash)}" to "${target.slice(slash + 1)}".`;
  const prefix = `Sent to pool "${target}" (`;
  const match = text.startsWith(prefix) ? /^(\d+) recipients, (\d+) live\)\./.exec(text.slice(prefix.length)) : null;
  if (!match || !Number.isSafeInteger(Number(match[1])) || !Number.isSafeInteger(Number(match[2])) ||
      Number(match[2]) > Number(match[1])) return "";
  return prefix + match[0];
}

function resultCard(send: Send, result: any, theme: Theme, context?: Context): Text {
  const content: any[] = Array.isArray(result?.content) ? result.content : [];
  const textBlocks = content.filter(block => block?.type === "text" && typeof block.text === "string");
  const text = textBlocks.map(block => block.text).join("\n");
  const error = result?.details?.error;
  const failed = context?.isError === true || result?.isError === true || Boolean(error) ||
    /^(?:Error:|Failed to send:)/.test(text);
  // Only the pinned adapter's direct CCT result, with the server's exact
  // confirmation (and optional offline warning), proves a send. It never
  // proves receipt/reading, and a proxy/script/unknown mode is not direct.
  const direct = result?.details?.server === "cct" && result?.details?.tool === "cct" && result?.details?.mode === undefined;
  const expected = confirmation(send, text);
  const suffix = expected && text.startsWith(expected) ? text.slice(expected.length) : null;
  if (!failed && direct && content.length === 1 && textBlocks.length === 1 && suffix !== null &&
      (suffix === "" || suffix.startsWith("\n\n⚠️ WARNING:"))) {
    return card(send, "✓ Sent", theme, suffix.trim());
  }
  const output = Array.isArray(result?.content) ? content.map(block => {
    if (block?.type === "text" && typeof block.text === "string") return block.text;
    if (block?.type === "image") return `[image: ${block.mimeType}]`;
    return jsonish(block);
  }).join("\n") : jsonish(result?.content);
  return card(send, failed ? "✗ Send failed" : "Send status unknown", theme,
    [output || "(empty result)", error ? `Error: ${typeof error === "string" ? error : jsonish(error)}` : ""].filter(Boolean).join("\n"));
}

// Non-CCT tools pass through by exact identity. Only these two display fields
// change for CCT; executor/schema/prompt/preparation/renderShell stay intact.
export function decorateCctTool<T extends RenderableTool>(tool: T): T {
  if (tool.name !== "cct") return tool;
  return {
    ...tool,
    renderCall(args: unknown, theme: Theme, context?: Context) {
      const send = sendArgs(args);
      // Namespaced row-local state supports old hosts without context.args;
      // current/history args always take precedence over this display cache.
      if (context?.state) context.state._cctSend = send ? { action: "send", ...send } : undefined;
      if (!send) return tool.renderCall?.call(tool, args, theme, context);
      return context?.isPartial === false ? empty : card(send, "Sending…", theme);
    },
    renderResult(result: unknown, options: { isPartial?: boolean }, theme: Theme, context?: Context) {
      const send = sendArgs(context?.args !== undefined ? context.args : context?.state?._cctSend);
      if (!send) return tool.renderResult?.call(tool, result, options, theme, context);
      // The call slot owns pending display, the result slot owns the single
      // final card even for expanded/error/history rows.
      return options.isPartial ? empty : resultCard(send, result, theme, context);
    },
  };
}
