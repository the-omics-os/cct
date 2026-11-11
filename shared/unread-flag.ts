// Derived unread-flag contract for `~/.cct/flags/<peer>.unread`.
// Writers: server.ts only. Readers: the os footer (read-only) and hook scripts,
// which read only the leading count. Shape:
//
//   <total>|<entries>|<epoch-ms>
//   entries = <token>:<count>[,<token>:<count>...]     (zero counts never written)
//
// Direct (no pool) unread is the token `DM`. A pool token is its name encoded so
// it cannot contain `,` `:` `|` `%`, control characters, or the exact token `DM`:
// those become `%2C` `%3A` `%7C` `%25` `%HH`, and the name `DM` becomes `%44M`.
// A real pool named DM therefore never collides with direct unread.
// `total` is always the sum of entries, so the summary cannot disagree with it.
//
// Legacy flags (raw names) remain readable. A legacy pool named exactly `DM`
// is indistinguishable from direct unread until the server rewrites the flag.
// Names are never trusted as delimiters in legacy input: ambiguous or
// inconsistent flags are rejected, not guessed.

export const UNREAD_FLAG_STALE_MS = 30_000;
/**
 * Largest flag the footer will read. Larger files are rejected whole (`flags
 * unavailable`), never truncated, so a partial summary cannot be mistaken for a
 * complete one. The hook scripts are unaffected and still read only the count.
 */
export const UNREAD_FLAG_MAX_BYTES = 64 * 1024;
export const DIRECT_TOKEN = "DM";
const UNNAMED_POOL = "(unnamed pool)";
const ENCODED_CODES = new Set<number>([0x25, 0x2c, 0x3a, 0x7c, 0x44]);
for (let code = 0; code <= 0x1f; code++) ENCODED_CODES.add(code);
for (let code = 0x7f; code <= 0x9f; code++) ENCODED_CODES.add(code);

export interface UnreadEntry {
  pool_id: string | null;
  pool_name: string | null;
  count: number;
}

export interface UnreadFlag {
  total: number;
  /** Direct (no-pool) unread; zero when absent. */
  direct: number;
  /** Named pools with unread > 0, in writer order. */
  pools: { name: string; count: number }[];
  timestamp: number;
}

function encodeName(name: string): string {
  if (name === DIRECT_TOKEN) return "%44M";
  return name.replace(/[%,:|\u0000-\u001f\u007f-\u009f]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

function decodeToken(token: string): string | null {
  if (token === DIRECT_TOKEN) return null;
  // Single pass, and only codes the encoder can emit; other `%HH` stay literal.
  return token.replace(/%([0-9A-F]{2})/g, (whole, hex: string) => {
    const code = parseInt(hex, 16);
    return ENCODED_CODES.has(code) ? String.fromCharCode(code) : whole;
  });
}

/** Writer: build the flag line. Zero counts are omitted; total is the entry sum. */
export function formatUnreadFlag(entries: readonly UnreadEntry[], timestamp: number = Date.now()): string {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.count) || entry.count <= 0) continue;
    // Pool identity is the ID; a missing name is never mistaken for direct unread.
    const name = entry.pool_name || (entry.pool_id != null ? UNNAMED_POOL : null);
    const token = name === null ? DIRECT_TOKEN : encodeName(name);
    counts.set(token, (counts.get(token) ?? 0) + entry.count);
  }
  let total = 0;
  for (const count of counts.values()) total += count;
  const summary = [...counts].map(([token, count]) => `${token}:${count}`).join(",");
  return `${total}|${summary}|${timestamp}`;
}

/** Reader: strict parse. Throws on any malformed, ambiguous or inconsistent flag. */
export function parseUnreadFlag(raw: string): UnreadFlag {
  const text = raw.replace(/\r?\n$/, "");
  // Split at the outer pipes only, so a legacy pipe inside a name cannot shift fields.
  const first = text.indexOf("|"), last = text.lastIndexOf("|");
  if (first < 0 || last === first) throw new Error("malformed unread flag");
  const totalText = text.slice(0, first), summary = text.slice(first + 1, last), timeText = text.slice(last + 1);
  if (!/^\d+$/.test(totalText) || !/^\d+$/.test(timeText)) throw new Error("malformed unread flag");
  const total = Number(totalText), timestamp = Number(timeText);
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(timestamp)) throw new Error("unread flag out of range");
  const tokens = summary === "" ? [] : summary.split(",");
  const seen = new Set<string>();
  const pools: { name: string; count: number }[] = [];
  let direct = 0, sum = 0;
  for (const item of tokens) {
    const match = /^(.+):(\d+)$/.exec(item);
    if (!match) throw new Error("malformed unread entry");
    const [, token, countText] = match;
    const count = Number(countText);
    if (!Number.isSafeInteger(count) || seen.has(token)) throw new Error("ambiguous unread entry");
    seen.add(token);
    sum += count;
    if (!Number.isSafeInteger(sum)) throw new Error("unread flag out of range");
    const name = decodeToken(token);
    if (name === null) direct = count;
    else if (name === "") throw new Error("empty pool name");
    else if (count > 0) pools.push({ name, count });
  }
  if (sum !== total) throw new Error("inconsistent unread flag");
  return { total, direct, pools, timestamp };
}
