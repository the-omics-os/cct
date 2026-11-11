// Canonical os footer regression: flag/identity contract, footer rendering and the
// real os-extension status surface. Deterministic: mocked clock and timers,
// private CCT_DIR, no broker, no installed host. Run: npx tsx test-os-footer.ts
// (The untracked personal-footer contract test, test-os-statusline.ts, is separate.)
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import inboxExtension from "./os-extension.ts";
import { buildOsInboxSnapshot } from "./shared/os-inbox.ts";
import { displayText, identityView, PIDMAP_MAX_BYTES, renderFooter, unreadView } from "./shared/os-footer.ts";
import { formatUnreadFlag, parseUnreadFlag, UNREAD_FLAG_MAX_BYTES, UNREAD_FLAG_STALE_MS, type UnreadEntry } from "./shared/unread-flag.ts";
import type { PollMessage } from "./shared/types.ts";

// ---- Flag contract (writer and reader share shared/unread-flag.ts) ----------
{
  // A real pool named DM is never the same token as direct unread.
  assert.equal(formatUnreadFlag([{ pool_id: null, pool_name: null, count: 2 }, { pool_id: "p1", pool_name: "DM", count: 1 }], 123), "3|DM:2,%44M:1|123");
  assert.deepEqual(parseUnreadFlag("3|DM:2,%44M:1|123"), { total: 3, direct: 2, pools: [{ name: "DM", count: 1 }], timestamp: 123 });
  console.log("PASS real pool named DM is distinct from direct unread");

  // Delimiters, percent signs, controls and Unicode survive exactly; the line keeps 3 fields.
  const names = ["a,b:c|d%e", "%44M", "DM ", "tab\tname", "ünï 🧬", "x:1,DM"];
  const entries: UnreadEntry[] = names.map((name, index) => ({ pool_id: `p${index}`, pool_name: name, count: index + 1 }));
  entries.push({ pool_id: null, pool_name: null, count: 7 });
  const line = formatUnreadFlag(entries, 9);
  assert.equal(line.split("|").length, 3, "delimiters inside names are escaped");
  const parsed = parseUnreadFlag(line);
  assert.equal(parsed.total, 7 + 21);
  assert.equal(parsed.direct, 7);
  assert.deepEqual(parsed.pools, names.map((name, index) => ({ name, count: index + 1 })));
  console.log("PASS pool names with delimiters, percent, controls and Unicode round-trip");

  // Zero counts are never written; equal tokens merge; the total is the entry sum.
  assert.equal(formatUnreadFlag([{ pool_id: "a", pool_name: "alpha", count: 0 }, { pool_id: "a", pool_name: "alpha", count: 2 },
    { pool_id: "b", pool_name: "alpha", count: 1 }, { pool_id: null, pool_name: null, count: 0 }], 5), "3|alpha:3|5");
  assert.equal(formatUnreadFlag([], 5), "0||5");
  // A pool with an ID but no name is a pool, never direct unread.
  assert.deepEqual(parseUnreadFlag(formatUnreadFlag([{ pool_id: "p", pool_name: null, count: 1 }], 1)).pools, [{ name: "(unnamed pool)", count: 1 }]);
  console.log("PASS writer omits zero counts, merges tokens and derives the total");

  // Legacy flags remain readable; zero-count memberships do not render.
  assert.deepEqual(parseUnreadFlag("2|test-pool:2|1700"), { total: 2, direct: 0, pools: [{ name: "test-pool", count: 2 }], timestamp: 1700 });
  assert.deepEqual(parseUnreadFlag("2|alpha:0,DM:2|1"), { total: 2, direct: 2, pools: [], timestamp: 1 });
  assert.deepEqual(parseUnreadFlag("0||1"), { total: 0, direct: 0, pools: [], timestamp: 1 });
  assert.deepEqual(parseUnreadFlag("1|a:b:1|1").pools, [{ name: "a:b", count: 1 }], "legacy colon inside a name");
  assert.deepEqual(parseUnreadFlag("3|pipe|name:3|9").pools, [{ name: "pipe|name", count: 3 }], "legacy pipe inside a name");
  assert.deepEqual(parseUnreadFlag("1|%2Cx:1|1").pools, [{ name: ",x", count: 1 }]);
  for (const bad of ["", "1", "1|DM:1", "2|DM:2|", "x|DM:2|1", "2|DM:1|1", "2|DM:1,DM:1|1", "2|:2|1", "2|a|1",
    "2|a:-1|1", "2|a:2|-1", "99999999999999999999|DM:1|1", "1|DM:1|1|extra"]) {
    assert.throws(() => parseUnreadFlag(bad), Error, `rejects ${JSON.stringify(bad)}`);
  }
  console.log("PASS legacy/zero flags parse; ambiguous, inconsistent and malformed flags are rejected");
}

// ---- Identity and freshness (read-only consumers) ---------------------------
{
  for (const suffix of ["", "|producer-1", "|producer-1|Sat_Sep_26_13:29:06_2026", "|producer-1|start|future-metadata"]) {
    assert.deepEqual(identityView(`peer-42|os-demo${suffix}`, false), { kind: "peer", peerId: "peer-42", name: "os-demo" }, suffix);
  }
  for (const bad of ["peer-42||producer|start", "../bad|os-demo|producer|start", "peer-42", ""]) {
    assert.deepEqual(identityView(bad, true), { kind: "unavailable" }, JSON.stringify(bad));
  }
  assert.deepEqual(identityView(undefined, true), { kind: "pending" });
  assert.deepEqual(identityView(undefined, false), { kind: "none" });
  // Never truncated: a name up to the limit shows in full; a longer one falls back to the unique peer ID.
  assert.deepEqual(identityView(`peer-42|${"n".repeat(40)}|producer|start`, false), { kind: "peer", peerId: "peer-42", name: "n".repeat(40) }, "40 characters are shown in full");
  for (const long of ["n".repeat(41), "long-name-".repeat(6), "é🧬".repeat(30)]) {
    assert.deepEqual(identityView(`peer-42|${long}|producer|start`, false), { kind: "peer", peerId: "peer-42", name: "peer-42" }, `${long.length} code units fall back to the peer ID`);
  }
  assert.deepEqual(identityView(`peer-42|a\u0007${"b".repeat(38)}|p|s`, false), { kind: "peer", peerId: "peer-42", name: `a ${"b".repeat(38)}` }, "controls are cleaned before the limit applies");
  assert.equal(displayText("  a\u0007 b\n ", 40), "a b");
  assert.equal(displayText("x".repeat(50), 40), `${"x".repeat(39)}…`);
  const now = 1_800_000_000_000;
  assert.deepEqual(unreadView(undefined, now), { kind: "absent" });
  assert.deepEqual(unreadView(`1|DM:1|${now - UNREAD_FLAG_STALE_MS}`, now), { kind: "fresh", direct: 1, pools: [] }, "30s is still fresh");
  assert.deepEqual(unreadView(`1|DM:1|${now - UNREAD_FLAG_STALE_MS - 1}`, now), { kind: "stale" });
  assert.deepEqual(unreadView(`1|DM:1|${now + 1}`, now), { kind: "unavailable" }, "future timestamps are not trusted");
  assert.deepEqual(unreadView(`2|DM:1|${now}`, now), { kind: "unavailable" }, "inconsistent summary drops counts");
  console.log("PASS identity tolerates trailing metadata and fails closed; freshness boundaries");
}

// ---- Pure footer composition ------------------------------------------------
{
  const peer = { kind: "peer", peerId: "peer-42", name: "os-demo" } as const;
  const fresh = (direct: number, pools: { name: string; count: number }[]) => ({ kind: "fresh", direct, pools }) as const;
  assert.equal(renderFooter(peer, { kind: "absent" }), "CCT: os-demo", "quiet state keeps identity alone");
  assert.equal(renderFooter(peer, fresh(0, [{ name: "zero", count: 0 }])), "CCT: os-demo", "zero memberships do not render");
  assert.equal(renderFooter(peer, fresh(2, [{ name: "DM", count: 1 }, { name: "alpha", count: 3 }])), "CCT: os-demo | DM(2) | @DM(1) | @alpha(3)");
  assert.equal(renderFooter(peer, fresh(0, [{ name: "DM", count: 1 }])), "CCT: os-demo | @DM(1)", "a pool named DM is not direct unread");
  assert.equal(renderFooter(peer, fresh(1, [])), "CCT: os-demo | DM(1)");
  // Every unread pool is its own segment; none is hidden, merged or space-joined.
  const six = ["a", "b", "c", "d", "e", "f"].map((name, index) => ({ name, count: index + 1 }));
  assert.equal(renderFooter(peer, fresh(0, six)), "CCT: os-demo | @a(1) | @b(2) | @c(3) | @d(4) | @e(5) | @f(6)");
  assert.equal(renderFooter(peer, fresh(2, [{ name: "a|b", count: 2 }, { name: "x".repeat(40), count: 1 }])),
    `CCT: os-demo | DM(2) | @a¦b(2) | @${"x".repeat(23)}…(1)`, "pipe in a name is shown as ¦; long names are bounded");
  assert.equal(renderFooter(peer, fresh(0, [{ name: "q\u0007r", count: 1 }, { name: "", count: 2 }])),
    "CCT: os-demo | @q r(1) | @(unnamed pool)(2)", "controls are stripped; an empty name is labelled");
  assert.equal(renderFooter(peer, { kind: "stale" }), "CCT: os-demo | flags stale");
  assert.equal(renderFooter(peer, { kind: "unavailable" }, "inbox stale"), "CCT: os-demo | flags unavailable | inbox stale");
  assert.equal(renderFooter(peer, fresh(0, []), "3 failures"), "CCT: os-demo | 3 failures");
  assert.equal(renderFooter({ kind: "pending" }, { kind: "absent" }), "CCT: pending");
  assert.equal(renderFooter({ kind: "none" }, { kind: "absent" }), "CCT: —");
  assert.equal(renderFooter({ kind: "unavailable" }, { kind: "absent" }), "CCT: identity unavailable");
  console.log("PASS footer shape: identity prefix, non-zero counts, DM vs @DM, bounded pools, short states");
}

// ---- Real os-extension surface (mock host API) ------------------------------
type Entry = { type: string; customType?: string; data?: any };
const BUDGET = "cct-inbox-budget-v1";
const T0 = 1_800_000_000_000;
let now = T0;
const originalNow = Date.now, originalSetInterval = global.setInterval, originalClearInterval = global.clearInterval;
const timers = new Map<object, () => void>();
Date.now = () => now;
(global as any).setInterval = (fn: () => void) => { const handle = { unref() {} }; timers.set(handle, fn); return handle; };
(global as any).clearInterval = (handle: object) => { timers.delete(handle); };
const envKeys = ["CCT_DIR", "CCT_OS_AUTO_WAKE", "CCT_OS_AUTO_WAKE_REMOTE"] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

function dm(message_id = 1): PollMessage {
  return { message_id, body: `body-${message_id}`, from_id: "sender", from_name: "Sender", from_cwd: "/fixture", from_branch: "test",
    from_summary: null, created_at: "2027-01-15T08:00:00.000Z", pool_id: null, pool_name: null, msg_type: "chat", seq: message_id };
}

class Harness {
  readonly root = mkdtempSync(join(tmpdir(), "cct-footer-"));
  readonly pidmaps = join(this.root, "pidmaps");
  readonly flags = join(this.root, "flags");
  readonly session = "session-footer";
  readonly peer = "peer-42";
  readonly producer = "producer-1";
  readonly marker = join(this.pidmaps, `os_session_${process.pid}`);
  mode = "rpc";
  idle = true;
  entries: Entry[];
  statuses: { key: string; value: string | undefined }[] = [];
  notifications: string[] = [];
  sends = 0;
  private hooks = new Map<string, (event: any, ctx: any) => unknown>();
  private command: (args: string, ctx: any) => void = () => { throw new Error("command not registered"); };
  readonly ctx: any;

  constructor(entries: Entry[] = []) {
    this.entries = structuredClone(entries);
    mkdirSync(this.pidmaps, { recursive: true }); mkdirSync(this.flags);
    process.env.CCT_DIR = this.root;
    const self = this;
    this.ctx = {
      sessionManager: { getSessionId: () => this.session, getEntries: () => this.entries },
      get mode() { return self.mode; }, isIdle: () => this.idle,
      ui: {
        setStatus: (key: string, value: string | undefined) => { this.statuses.push({ key, value }); },
        notify: (text: string) => { this.notifications.push(text); },
      },
    };
    inboxExtension({
      on: (name: string, handler: (event: any, ctx: any) => unknown) => { this.hooks.set(name, handler); },
      sendMessage: () => { this.sends++; },
      appendEntry: (customType: string, data: unknown) => { this.entries.push({ type: "custom", customType, data: structuredClone(data) }); },
      registerMessageRenderer: () => {},
      registerCommand: (_name: string, config: { handler: (args: string, ctx: any) => void }) => { this.command = config.handler; },
    });
  }
  identity(raw: string) { writeFileSync(join(this.pidmaps, `os_${this.session}`), raw); }
  flag(raw: string) { writeFileSync(join(this.flags, `${this.peer}.unread`), raw); }
  inbox(messages: PollMessage[] = [], localBroker = true) {
    const snapshot = buildOsInboxSnapshot({ peerId: this.peer, sessionId: this.session, producer: this.producer }, localBroker, messages, new Set());
    writeFileSync(join(this.flags, `${this.peer}.os-inbox`), JSON.stringify(snapshot));
  }
  event(name: string, data: any = {}) { assert.ok(this.hooks.has(name), `missing hook ${name}`); return this.hooks.get(name)!({ type: name, ...data }, this.ctx); }
  start() { this.event("session_start"); }
  tick(ms = 0) { now += ms; for (const fn of [...timers.values()]) fn(); }
  diagnostic(): string { this.command("status", this.ctx); return this.notifications.at(-1) ?? ""; }
  /** Every `cct` status value, in order, with undefined for clears. */
  footers(): (string | undefined)[] { return this.statuses.map((s) => s.value); }
  footer(): string | undefined { return this.statuses.filter((s) => s.key === "cct").at(-1)?.value; }
  close() { this.event("session_shutdown"); rmSync(this.root, { recursive: true, force: true }); }
}

function run(name: string, body: (h: Harness) => void, options: { entries?: Entry[]; mode?: string; env?: Record<string, string> } = {}) {
  for (const key of envKeys) delete process.env[key];
  Object.assign(process.env, options.env ?? {});
  const h = new Harness(options.entries);
  h.mode = options.mode ?? "rpc";
  try {
    body(h);
    assert.ok(h.statuses.every((s) => s.key === "cct"), `${name}: only the single cct footer key is used`);
  } finally {
    h.close();
    for (const key of envKeys) { if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key]; }
  }
  console.log(`PASS ${name}`);
}

run("quiet registered identity: one footer key, identity retained, no counts", (h) => {
  h.identity(`${h.peer}|os-demo|${h.producer}|start`); h.flag(`0||${now}`); h.inbox();
  h.start(); h.tick();
  assert.equal(h.footer(), "CCT: os-demo");
});

run("trailing pidmap metadata keeps the identity name with valid producer binding", (h) => {
  h.inbox(); h.start();
  for (const suffix of ["|producer-1", "|producer-1|Sat_Sep_26_13:29:06_2026", "|producer-1|start|future-metadata"]) {
    h.identity(`${h.peer}|os-demo${suffix}`); h.tick();
    assert.equal(h.footer(), "CCT: os-demo", suffix);
  }
  h.flag(`0||${now}`);
  h.tick();
  assert.equal(h.footer(), "CCT: os-demo");
});

run("pending before registration and clear on shutdown; no state noise before registration", (h) => {
  h.start();
  assert.equal(h.footer(), "CCT: pending", "file A without file B is pending, not an error");
  assert.ok(!h.footer()!.includes("inbox"), "feed failures before registration are not footer news");
  h.event("session_shutdown");
  assert.equal(h.statuses.at(-1)!.value, undefined, "shutdown clears the footer");
});

run("no marker and no B reports none; malformed B reports identity unavailable", (h) => {
  h.start();
  rmSync(h.marker);
  h.tick();
  assert.equal(h.footer(), "CCT: —");
  h.identity("peer-42||producer|start");
  h.tick();
  assert.equal(h.footer(), "CCT: identity unavailable");
});

run("membership: direct, multiple pools and a real pool named DM are counted from the flag", (h) => {
  h.identity(`${h.peer}|os-demo|${h.producer}|start`);
  h.flag(formatUnreadFlag([{ pool_id: null, pool_name: null, count: 2 }, { pool_id: "p1", pool_name: "DM", count: 1 },
    { pool_id: "p2", pool_name: "alpha", count: 3 }], now));
  h.inbox();
  h.start(); h.tick();
  assert.equal(h.footer(), "CCT: os-demo | DM(2) | @DM(1) | @alpha(3)");
});

run("direct-only DM and a pool-only DM are distinct", (h) => {
  h.identity(`${h.peer}|os-demo|${h.producer}|start`); h.inbox(); h.start();
  h.flag(`1|DM:1|${now}`); h.tick();
  assert.equal(h.footer(), "CCT: os-demo | DM(1)");
  h.flag(`1|%44M:1|${now}`); h.tick();
  assert.equal(h.footer(), "CCT: os-demo | @DM(1)");
});

run("zero-count and legacy pool summaries never invent unread counts", (h) => {
  h.identity(`${h.peer}|os-demo|${h.producer}|start`); h.inbox(); h.start();
  h.flag(`1|alpha:0,DM:1|${now}`); h.tick();
  assert.equal(h.footer(), "CCT: os-demo | DM(1)");
  h.flag(`0||${now}`); h.tick();
  assert.equal(h.footer(), "CCT: os-demo", "no aggregate fallback when the flag is empty");
});

run("stale and inconsistent flags keep identity and drop counts", (h) => {
  h.identity(`${h.peer}|os-demo|${h.producer}|start`); h.inbox(); h.start();
  h.flag(`2|DM:2|${now - UNREAD_FLAG_STALE_MS - 1}`); h.tick();
  assert.equal(h.footer(), "CCT: os-demo | flags stale");
  h.flag(`2|DM:2|${now + 5000}`); h.tick();
  assert.equal(h.footer(), "CCT: os-demo | flags unavailable");
  h.flag(`2|DM:1|${now}`); h.tick();
  assert.equal(h.footer(), "CCT: os-demo | flags unavailable", "summary disagreeing with total is not trusted");
  h.flag(`2|DM:2|${now}`); h.tick();
  assert.equal(h.footer(), "CCT: os-demo | DM(2)", "recovery on the next fresh, consistent flag");
});

run("usual scheduled state is omitted; the diagnostic keeps the full reason", (h) => {
  h.identity(`${h.peer}|os-demo|${h.producer}|start`); h.flag(`1|DM:1|${now}`); h.inbox([dm(1)]);
  h.start(); h.tick();
  assert.equal(h.sends, 1, "delivery behavior is unchanged");
  assert.equal(h.footer(), "CCT: os-demo | DM(1)", "scheduled is not shown in the footer");
  assert.ok(!h.statuses.some((s) => s.value?.includes("scheduled")));
  assert.match(h.diagnostic(), /CCT direct inbox: 1 DM\(s\) scheduled/);
});

run("auto-wake disabled is a short footer state; the verbose reason stays in the diagnostic", (h) => {
  h.identity(`${h.peer}|os-demo|${h.producer}|start`); h.flag(`1|DM:1|${now}`); h.inbox([dm(1)]);
  h.start(); h.tick();
  assert.equal(h.footer(), "CCT: os-demo | DM(1) | auto-wake off");
  assert.ok(!h.footer()!.includes("automatic delivery disabled"));
  assert.match(h.diagnostic(), /automatic delivery disabled; inbox retained/);
  assert.equal(h.sends, 0);
}, { env: { CCT_OS_AUTO_WAKE: "0" } });

run("three failures, paused and remote are visible as short states", (h) => {
  h.identity(`${h.peer}|os-demo|${h.producer}|start`); h.flag(`1|DM:1|${now}`); h.inbox([dm(1)]);
  h.start(); h.tick();
  assert.equal(h.footer(), "CCT: os-demo | DM(1) | 3 failures");
  assert.match(h.diagnostic(), /three delivery failures/);
}, { entries: [{ type: "custom", customType: BUDGET, data: { sessionId: "session-footer", times: [], streak: 0, nextAttempt: 0, failures: 3, paused: false } }] });

run("paused after cancellation is a short state", (h) => {
  h.identity(`${h.peer}|os-demo|${h.producer}|start`); h.flag(`1|DM:1|${now}`); h.inbox([dm(1)]);
  h.start(); h.tick();
  assert.equal(h.footer(), "CCT: os-demo | DM(1) | paused");
}, { entries: [{ type: "custom", customType: BUDGET, data: { sessionId: "session-footer", times: [], streak: 0, nextAttempt: 0, failures: 0, paused: true } }] });

run("remote broker without opt-in is a short footer state", (h) => {
  h.identity(`${h.peer}|os-demo|${h.producer}|start`); h.flag(`1|DM:1|${now}`); h.inbox([dm(1)], false);
  h.start(); h.tick();
  assert.equal(h.footer(), "CCT: os-demo | DM(1) | remote: auto-wake off");
});

run("print mode publishes no footer", (h) => {
  h.identity(`${h.peer}|os-demo|${h.producer}|start`); h.flag(`1|DM:1|${now}`); h.inbox();
  h.start(); h.tick();
  assert.deepEqual(h.statuses, [], "no UI, no status");
}, { mode: "print" });

run("a long pidmap name falls back to the peer ID; the identity is never truncated", (h) => {
  h.identity(`${h.peer}|${"long-name-".repeat(6)}|${h.producer}|start`); h.inbox(); h.start(); h.tick();
  assert.equal(h.footer(), "CCT: peer-42");
});

run("an oversized or malformed file B keeps the identity already resolved in this session", (h) => {
  h.identity(`${h.peer}|os-demo|${h.producer}|start`); h.flag(`1|DM:1|${now}`); h.inbox(); h.start(); h.tick();
  assert.equal(h.footer(), "CCT: os-demo | DM(1)");
  // Delivery cannot resolve the peer from a bad B, so the delivery path reports `inbox stale`
  // (preexisting behavior). The footer keeps the cached identity; no delivery is attempted.
  h.identity("x".repeat(PIDMAP_MAX_BYTES + 1)); h.tick();
  assert.equal(h.footer(), "CCT: os-demo | DM(1) | inbox stale", "oversized B is not read in full and does not replace the identity");
  assert.equal(h.sends, 0, "no delivery from an unresolved B");
  // An empty name is malformed for display only; delivery still resolves peer and producer.
  h.identity(`${h.peer}||${h.producer}|start`); h.tick();
  assert.equal(h.footer(), "CCT: os-demo | DM(1)", "malformed B keeps the cached identity");
  h.identity(`${h.peer}|os-demo|${h.producer}|start`); h.tick();
  assert.equal(h.footer(), "CCT: os-demo | DM(1)", "recovery on a valid B");
});

run("an oversized session marker without B reports identity unavailable, not a guessed identity", (h) => {
  h.start(); writeFileSync(h.marker, "m".repeat(512 + 1)); h.tick();
  assert.equal(h.footer(), "CCT: identity unavailable");
});

run("flag size limit: exactly at the limit is read; one byte more is unavailable, identity kept", (h) => {
  h.identity(`${h.peer}|os-demo|${h.producer}|start`); h.inbox(); h.start();
  const tail = `:1|${now}`, head = "1|";
  const pool = (size: number) => `${head}${"a".repeat(size - head.length - tail.length)}${tail}`;
  h.flag(pool(UNREAD_FLAG_MAX_BYTES)); h.tick();
  assert.equal(h.footer(), `CCT: os-demo | @${"a".repeat(23)}…(1)`, "a flag at the limit is complete and used");
  h.flag(pool(UNREAD_FLAG_MAX_BYTES + 1)); h.tick();
  assert.equal(h.footer(), "CCT: os-demo | flags unavailable", "no truncated summary is trusted");
  h.flag(`1|DM:1|${now}`); h.tick();
  assert.equal(h.footer(), "CCT: os-demo | DM(1)", "recovery on the next valid flag");
});

run("the footer has exactly one identity segment and only the single cct key", (h) => {
  h.identity(`${h.peer}|os-demo|${h.producer}|start`); h.flag(`2|DM:1,alpha:1|${now}`); h.inbox([dm(1)]); h.start(); h.tick();
  for (const value of h.footers().filter((v) => v !== undefined)) {
    assert.ok(value!.startsWith("CCT: "), value);
    assert.equal(value!.split("CCT:").length - 1, 1, `exactly one identity in ${value}`);
  }
});

assert.equal(timers.size, 0, "sessions clear their timers");
Date.now = originalNow;
(global as any).setInterval = originalSetInterval;
(global as any).clearInterval = originalClearInterval;
console.log("PASS canonical os footer: flag/identity contract, freshness, membership, states and single cct key");
