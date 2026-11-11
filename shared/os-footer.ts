// Pure, read-only footer model for the canonical os extension. No file writes,
// broker calls or registration: callers pass raw cache contents in.
// Identity: file B `os_<session>` first two fields (`peerId|name`). Trailing
// producer/start metadata is ignored. Flags: `{peer}.unread`, 30s freshness.
import { UNREAD_FLAG_MAX_BYTES, UNREAD_FLAG_STALE_MS, parseUnreadFlag, type UnreadFlag } from "./unread-flag.ts";

/** Largest file B the footer reads. Real B lines are a few hundred bytes. */
export const PIDMAP_MAX_BYTES = 4 * 1024;
/** Largest session marker (file A) the footer reads. A session ID is a short token. */
export const SESSION_MARKER_MAX_BYTES = 512;
/** Re-exported so the host reader and the flag contract share one limit. */
export { UNREAD_FLAG_MAX_BYTES };

const NAME_LIMIT = 40, POOL_NAME_LIMIT = 24;

export type FooterIdentity =
  | { kind: "peer"; peerId: string; name: string }
  | { kind: "pending" }
  | { kind: "none" }
  | { kind: "unavailable" };

export type FooterUnread =
  | { kind: "absent" }
  | { kind: "stale" }
  | { kind: "unavailable" }
  | { kind: "fresh"; direct: number; pools: { name: string; count: number }[] };

/** Strip control characters and collapse whitespace. No truncation. */
export function cleanText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}

/** Clean, then truncate by code point. Used for pool labels, never for identity. */
export function displayText(text: string, limit: number): string {
  const clean = cleanText(text);
  const chars = Array.from(clean);
  return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : clean;
}

/**
 * `pidmap` is the raw B file, or undefined when absent. `announced` is true when
 * the session marker (file A) matches this session: registration is simply not
 * complete yet, which is `pending`, not an error.
 *
 * A name longer than the display limit is never truncated, because an ellipsis
 * could resemble another peer. The unique peer ID is shown instead.
 */
export function identityView(pidmap: string | undefined, announced: boolean): FooterIdentity {
  if (pidmap === undefined) return announced ? { kind: "pending" } : { kind: "none" };
  const fields = pidmap.replace(/\r?\n$/, "").split("|");
  const peerId = fields[0] ?? "";
  const label = cleanText(fields[1] ?? "");
  if (!/^[\w-]{1,127}$/.test(peerId) || !label) return { kind: "unavailable" };
  const name = Array.from(label).length <= NAME_LIMIT ? label : peerId;
  return { kind: "peer", peerId, name };
}

/** `raw` is the flag file contents, or undefined when no flag has been written yet. */
export function unreadView(raw: string | undefined, now: number): FooterUnread {
  if (raw === undefined) return { kind: "absent" };
  let flag: UnreadFlag;
  try { flag = parseUnreadFlag(raw); } catch { return { kind: "unavailable" }; }
  if (flag.timestamp > now) return { kind: "unavailable" };
  if (now - flag.timestamp > UNREAD_FLAG_STALE_MS) return { kind: "stale" };
  return { kind: "fresh", direct: flag.direct, pools: flag.pools };
}

/** One pool segment label: controls stripped, bounded, and `|` shown as `¦`. */
function poolLabel(name: string): string {
  return displayText(name, POOL_NAME_LIMIT).replace(/\|/g, "¦") || "(unnamed pool)";
}

function identityText(identity: FooterIdentity): string {
  switch (identity.kind) {
    case "peer": return `CCT: ${identity.name}`;
    case "pending": return "CCT: pending";
    case "none": return "CCT: —";
    case "unavailable": return "CCT: identity unavailable";
  }
}

/**
 * Exactly one identity segment, first. Each unread pool is its own `|` segment; no
 * pool is hidden or merged. A `|` inside a pool name is shown as `¦`. Counts appear
 * only for fresh flags with non-zero entries. `state` is a short exceptional label,
 * never verbose text.
 */
export function renderFooter(identity: FooterIdentity, unread: FooterUnread, state = ""): string {
  const parts = [identityText(identity)];
  if (identity.kind === "peer") {
    if (unread.kind === "stale") parts.push("flags stale");
    else if (unread.kind === "unavailable") parts.push("flags unavailable");
    else if (unread.kind === "fresh") {
      if (unread.direct > 0) parts.push(`DM(${unread.direct})`);
      for (const pool of unread.pools) {
        if (pool.count > 0) parts.push(`@${poolLabel(pool.name)}(${pool.count})`);
      }
    }
  }
  if (state) parts.push(state);
  return parts.join(" | ");
}
