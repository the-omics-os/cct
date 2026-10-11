import type { PollMessage } from "./types.ts";

// Private, derived file channel. SQLite remains authoritative; publication is
// NOT acknowledgement. No durable store, broker fence or exactly-once promise.
export const OS_INBOX_MAX_BYTES = 128 * 1024;
export const OS_INBOX_BODY_BYTES = 64 * 1024;
export const OS_INBOX_MAX_ROWS = 20;
export const OS_INBOX_MAX_OFFERED = 2048;
export const OS_RECEIPT_MAX_IDS = 256;
export const OS_RECEIPT_MAX_BYTES = 16 * 1024;

export interface OsInboxBinding {
  peerId: string;
  sessionId: string;
  producer: string;
}
export interface OsInboxSnapshot extends OsInboxBinding {
  version: 1;
  timestamp: number;
  localBroker: boolean;
  messages: PollMessage[];
  remainingDm: number;
  poolCount: number;
  blocked?: string;
}
export interface OsInboxReceipt extends OsInboxBinding {
  version: 1;
  consumed: number[];
}
export const isAutomaticDm = (m: PollMessage): boolean =>
  m.pool_id === null && m.pool_name === null && m.msg_type === "chat" && m.from_id !== "system";

export function parseOsInboxReceipt(raw: string, binding: OsInboxBinding): OsInboxReceipt | null {
  if (Buffer.byteLength(raw) > OS_RECEIPT_MAX_BYTES) return null;
  try {
    const r = JSON.parse(raw);
    if (!r || typeof r !== "object" || Array.isArray(r) || r.version !== 1 ||
        Object.keys(r).sort().join(",") !== "consumed,peerId,producer,sessionId,version" ||
        r.peerId !== binding.peerId || r.sessionId !== binding.sessionId || r.producer !== binding.producer ||
        !Array.isArray(r.consumed) || r.consumed.length === 0 || r.consumed.length > OS_RECEIPT_MAX_IDS ||
        !r.consumed.every((id: unknown) => Number.isSafeInteger(id) && Number(id) > 0) ||
        new Set(r.consumed).size !== r.consumed.length) return null;
    return r as OsInboxReceipt;
  } catch { return null; }
}

export function buildOsInboxSnapshot(
  binding: OsInboxBinding, localBroker: boolean, unread: PollMessage[], offered: ReadonlySet<number>,
): OsInboxSnapshot {
  const eligible = unread.filter(isAutomaticDm).sort((a, b) => a.message_id - b.message_id);
  const snapshot: OsInboxSnapshot = {
    version: 1, ...binding, timestamp: Date.now(), localBroker, messages: [],
    remainingDm: eligible.length,
    poolCount: unread.filter((m) => m.pool_id !== null || m.pool_name !== null).length,
  };
  const oversized: number[] = [];
  let oversizedCount = 0;
  let bytes = 0;
  let newOffers = 0;
  let backpressure = false;
  // Leave room for bounded diagnostics. Oversized rows do not hide later DMs.
  const baseBytes = Buffer.byteLength(JSON.stringify(snapshot)) + 4096;
  let rowBytes = 0;
  for (const m of eligible) {
    if (!Number.isSafeInteger(m.message_id) || m.message_id <= 0 || typeof m.body !== "string") continue;
    const bodyBytes = Buffer.byteLength(JSON.stringify(m.body));
    const serializedBytes = Buffer.byteLength(JSON.stringify(m)) + 1;
    if (bodyBytes > OS_INBOX_BODY_BYTES || baseBytes + serializedBytes > OS_INBOX_MAX_BYTES) {
      oversizedCount++;
      if (oversized.length < 100) oversized.push(m.message_id);
      continue;
    }
    if (snapshot.messages.length >= OS_INBOX_MAX_ROWS || bytes + bodyBytes > OS_INBOX_BODY_BYTES ||
        baseBytes + rowBytes + serializedBytes > OS_INBOX_MAX_BYTES) continue;
    if (!offered.has(m.message_id) && offered.size + newOffers >= OS_INBOX_MAX_OFFERED) {
      backpressure = true;
      continue;
    }
    snapshot.messages.push(m);
    if (!offered.has(m.message_id)) newOffers++;
    bytes += bodyBytes;
    rowBytes += serializedBytes;
  }
  snapshot.remainingDm -= snapshot.messages.length;
  const reasons: string[] = [];
  if (oversizedCount) reasons.push(`oversized DM IDs: ${oversized.join(",")}${oversizedCount > oversized.length ? ` (+${oversizedCount - oversized.length} more)` : ""}; use manual check`);
  if (backpressure) reasons.push(`offered-ID backpressure (${OS_INBOX_MAX_OFFERED}); receipt or manual check required`);
  if (reasons.length) snapshot.blocked = reasons.join("; ");
  if (Buffer.byteLength(JSON.stringify(snapshot)) > OS_INBOX_MAX_BYTES) throw new Error("Inbox snapshot exceeds private channel bound");
  return snapshot;
}
