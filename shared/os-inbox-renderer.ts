// Presentation only: never change the message stored in history/model context.
// pi-tui is supplied by the os extension loader; the dev dependency is for tests.
import { Text } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";

type Message = { content?: unknown; details?: any };
type Theme = {
  fg(color: "accent" | "text", text: string): string;
  bg(color: "customMessageBg", text: string): string;
  bold(text: string): string;
};

// Decode the existing nonce-framed format, including messages saved before this
// renderer existed. Do not duplicate bodies in details or alter receipt evidence.
export function inboxDisplayMessages(message: Message): { sender: string; body: string }[] {
  const { content, details } = message;
  if (typeof content !== "string" || content.length > 256 * 1024 || details?.version !== 1 ||
      typeof details.nonce !== "string" || !/^[\w-]{1,127}$/.test(details.nonce) ||
      !Array.isArray(details.ids) || !details.ids.length || details.ids.length > 20 ||
      !details.ids.every((n: unknown) => Number.isSafeInteger(n) && Number(n) > 0)) return [];
  const open = `<peer-body-${details.nonce}>\n`, close = `\n</peer-body-${details.nonce}>`;
  const messages: { sender: string; body: string }[] = [];
  let cursor = 0;
  for (const id of details.ids) {
    const start = content.indexOf(open, cursor);
    if (start < 0) return [];
    const prefix = content.slice(cursor, start);
    const header = prefix.slice(prefix.lastIndexOf("\nSender ") + 1);
    const match = /^Sender ("(?:[^"\\]|\\.)*") \("(?:[^"\\]|\\.)*"\), message ([1-9]\d*), time "(?:[^"\\]|\\.)*"\n$/.exec(header);
    const end = content.indexOf(close, start + open.length);
    if (!match || Number(match[2]) !== id || end < 0) return [];
    try {
      messages.push({ sender: JSON.parse(match[1]), body: content.slice(start + open.length, end) });
    } catch { return []; }
    cursor = end + close.length;
  }
  if (content.indexOf(open, cursor) !== -1) return [];
  return messages;
}

// Peer text is plain text, not trusted terminal escape sequences. This changes
// display only; the original bytes remain in model context and session history.
function terminalText(text: string): string {
  return stripVTControlCharacters(text).replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
}

export function renderInboxMessage(message: Message, { outputPad }: { outputPad: number }, theme: Theme): Text {
  const messages = inboxDisplayMessages(message);
  // Never throw and let the host fall back to displaying the raw protocol.
  const content = messages.length ? messages.map(({ sender, body }) =>
    theme.fg("accent", theme.bold("CCT")) + theme.fg("text", ` · ${terminalText(sender).replace(/[\n\t]/g, " ")}`) +
    "\n" + theme.fg("text", terminalText(body))).join("\n\n") :
    theme.fg("text", "CCT · Message display unavailable; original content retained in session.");
  // Paint the matching background as well: a light os theme can otherwise
  // put dark text directly onto a dark terminal. Every wrapped/padded row is
  // covered by Text's background callback, independent of terminal defaults.
  return new Text(content, outputPad, 1, line => theme.bg("customMessageBg", line));
}
