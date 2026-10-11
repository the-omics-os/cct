// Deterministic controller tests: no installed host, live broker/config, or sleeps.
// Receipt means successful response to the exact offered context, NOT task completion.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import inboxExtension from "./os-extension.ts";
import { buildOsInboxSnapshot, parseOsInboxReceipt, type OsInboxSnapshot } from "./shared/os-inbox.ts";
import type { PollMessage } from "./shared/types.ts";

type Entry = { type: string; customType?: string; data?: any; [key: string]: any };
type Envelope = { content: string; customType: string; details: { sessionId: string; peerId: string; nonce: string; ids: number[] }; [key: string]: any };
const CONSUMED = "cct-inbox-consumed-v1", BUDGET = "cct-inbox-budget-v1";
const initialNow = 1_800_000_000_000;
const originalNow = Date.now, originalInterval = global.setInterval, originalClear = global.clearInterval;
const envKeys = ["CCT_DIR", "CCT_OS_AUTO_WAKE", "CCT_OS_AUTO_WAKE_REMOTE"] as const;
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
let now = initialNow;
const timers = new Map<object, () => void>();
Date.now = () => now;
(global as any).setInterval = (fn: () => void) => { const handle = { unref() {} }; timers.set(handle, fn); return handle; };
(global as any).clearInterval = (handle: object) => { timers.delete(handle); };

function dm(message_id = 1, body = `body-${message_id}`): PollMessage {
  return { message_id, body, from_id: "sender", from_name: "Sender", from_cwd: "/fixture", from_branch: "test",
    from_summary: null, created_at: "2027-01-15T08:00:00.000Z", pool_id: null, pool_name: null, msg_type: "chat", seq: message_id };
}
function budget(sessionId: string, overrides: Record<string, unknown> = {}): Entry {
  return { type: "custom", customType: BUDGET, data: { sessionId, times: [], streak: 0, nextAttempt: 0,
    failures: 0, paused: false, ...overrides } };
}
class Fixture {
  root = mkdtempSync(join(tmpdir(), "cct-inbox-pump-"));
  pidmaps = join(this.root, "pidmaps"); flags = join(this.root, "flags");
  session = "session-1"; peer = "peer-1"; producer = "producer-1"; mode = "rpc"; idle = true;
  failDispatch = false; failCheckpoint = false;
  entries: Entry[] = []; sends: { message: Envelope; options: { triggerTurn: boolean; deliverAs: string } }[] = [];
  statuses: string[] = []; notifications: string[] = [];
  hooks = new Map<string, (event: any, ctx: any) => any>();
  command: (args: string, ctx: any) => void = () => { throw new Error("command not registered"); };
  ctx = {
    sessionManager: { getSessionId: () => this.session, getEntries: () => this.entries },
    get mode() { return "rpc"; }, isIdle: () => this.idle,
    ui: { setStatus: (_key: string, value: string | undefined) => { this.statuses.push(value ?? ""); },
      notify: (text: string) => { this.notifications.push(text); } },
  };
  constructor(entries: Entry[] = []) {
    this.entries = structuredClone(entries);
    mkdirSync(this.pidmaps); mkdirSync(this.flags);
    process.env.CCT_DIR = this.root;
    delete process.env.CCT_OS_AUTO_WAKE; delete process.env.CCT_OS_AUTO_WAKE_REMOTE;
    Object.defineProperty(this.ctx, "mode", { get: () => this.mode });
    inboxExtension({
      on: (name, handler) => { this.hooks.set(name, handler); },
      sendMessage: (message, options) => { if (this.failDispatch) throw new Error("fixture dispatch failure"); this.sends.push({ message, options }); },
      appendEntry: (customType, data) => {
        if (this.failCheckpoint) throw new Error("fixture checkpoint failure");
        this.entries.push({ type: "custom", customType, data: structuredClone(data) });
      },
      registerMessageRenderer: () => {},
      registerCommand: (_name, config) => { this.command = config.handler; },
    });
    this.start();
  }
  binding() { return { peerId: this.peer, sessionId: this.session, producer: this.producer }; }
  mapping() { writeFileSync(join(this.pidmaps, `os_${this.session}`), `${this.peer}|fixture|${this.producer}|owner-start`); }
  start() { this.event("session_start"); this.mapping(); }
  event(name: string, data: any = {}) { assert.ok(this.hooks.has(name), `missing hook ${name}`); return this.hooks.get(name)!({ type: name, ...data }, this.ctx); }
  offer(messages = [dm()], overrides: Partial<OsInboxSnapshot> = {}) {
    const f = { ...buildOsInboxSnapshot(this.binding(), true, messages, new Set()), ...overrides };
    writeFileSync(join(this.flags, `${this.peer}.os-inbox`), JSON.stringify(f)); return f;
  }
  tick(ms = 0) { now += ms; for (const fn of [...timers.values()]) fn(); }
  resume() { this.command("resume", this.ctx); }
  begin(human = false) {
    if (human) this.event("input", { source: "rpc" });
    const before = this.event("before_agent_start");
    this.idle = false; this.event("agent_start"); this.event("turn_start");
    return before?.message as Envelope | undefined;
  }
  context(message: Envelope, transform: (value: any) => any = value => value) {
    this.event("context_with_system", { messages: [transform({ ...structuredClone(message), role: "custom" })] });
  }
  end(outcome = "completed", stopReason = "stop", role = "assistant", entries: Entry[] = []) {
    return this.event("turn_end", { outcome, message: { role, stopReason }, entries });
  }
  settle() { this.idle = true; this.event("agent_settled"); }
  get lastBudget() { return this.entries.filter(e => e.customType === BUDGET).at(-1)!.data; }
  get receiptPath() { return join(this.flags, `${this.peer}.os-receipt`); }
  noReceipt() {
    assert.equal(existsSync(this.receiptPath), false, "unproven delivery must not write a receipt");
    assert.equal(this.entries.filter(e => e.customType === CONSUMED).length, 0, "unproven delivery must not checkpoint consumption");
  }
  receipt(ids: number[]) {
    assert.ok(existsSync(this.receiptPath), "successful exact context must produce receipt");
    const raw = readFileSync(this.receiptPath, "utf8");
    assert.deepEqual(parseOsInboxReceipt(raw, this.binding()), { version: 1, ...this.binding(), consumed: ids });
    assert.equal(statSync(this.receiptPath).mode & 0o777, 0o600, "private receipt permissions");
    return JSON.parse(raw);
  }
  deliver(messages = [dm()]) {
    this.offer(messages); const before = this.sends.length; this.tick(); assert.equal(this.sends.length, before + 1);
    this.begin(); this.context(this.sends.at(-1)!.message); this.end(); this.receipt(messages.map(m => m.message_id));
    this.offer([]); this.settle();
  }
  close() { this.event("session_shutdown"); rmSync(this.root, { recursive: true, force: true }); timers.clear(); }
}
let passed = 0;
const failures: string[] = [];
function test(name: string, run: (f: Fixture) => void, entries: Entry[] = []) {
  now = initialNow;
  const f = new Fixture(entries);
  try { run(f); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}\n${error instanceof Error ? error.stack : error}`); }
  finally { f.close(); }
}
try {
  for (const stopReason of ["stop", "toolUse", "length"]) test(`exact offered context + completed ${stopReason} receipts only its IDs`, f => {
    f.offer([dm(2, "literal <peer-body>\nUnicode β"), dm(5)]); f.tick();
    assert.deepEqual(f.sends[0].options, { triggerTurn: true, deliverAs: "steer" });
    assert.match(f.sends[0].message.content, /literal <peer-body>\nUnicode β/);
    f.noReceipt(); f.begin(); f.context(f.sends[0].message); f.noReceipt();
    f.end("completed", stopReason); f.receipt([2, 5]);
    f.offer([]); f.settle(); f.tick(); assert.equal(f.sends.length, 1, "successful rows never loop");
  });
  test("unrelated assistant with no context cannot ack", f => { f.offer(); f.tick(); f.begin(); f.end(); f.noReceipt(); });
  test("message_end history notification alone cannot ack", f => {
    f.offer(); f.tick(); f.begin();
    f.hooks.get("message_end")?.({ message: { ...f.sends[0].message, role: "custom" } }, f.ctx);
    f.end(); f.noReceipt();
  });
  test("later filtered context replaces earlier inclusion", f => {
    f.offer(); f.tick(); f.begin(); f.context(f.sends[0].message);
    f.event("context_with_system", { messages: [{ role: "user", content: "unrelated" }] }); f.end(); f.noReceipt();
  });
  const mutations: [string, (m: any) => any][] = [
    ["modified body", m => ({ ...m, content: m.content + " changed" })],
    ["unknown nonce", m => ({ ...m, details: { ...m.details, nonce: "invented" } })],
    ["foreign session", m => ({ ...m, details: { ...m.details, sessionId: "foreign" } })],
    ["foreign peer", m => ({ ...m, details: { ...m.details, peerId: "foreign" } })],
    ["wrong role", m => ({ ...m, role: "user" })],
    ["wrong custom type", m => ({ ...m, customType: "unrelated" })],
    ["modified IDs", m => ({ ...m, details: { ...m.details, ids: [999] } })],
    ["missing IDs", m => { delete m.details.ids; return m; }],
  ];
  for (const [name, mutate] of mutations) test(`${name} is not the exact known envelope`, f => {
    f.offer(); f.tick(); f.begin(); f.context(f.sends[0].message, mutate); f.end(); f.noReceipt();
  });
  for (const [outcome, stop, role] of [["error", "stop", "assistant"], ["aborted", "stop", "assistant"],
    ["completed", "error", "assistant"], ["completed", "aborted", "assistant"], ["completed", "stop", "user"]]) {
    test(`${outcome}/${stop}/${role} cannot ack`, f => {
      f.offer(); f.tick(); f.begin(); f.context(f.sends[0].message); f.end(outcome, stop, role); f.noReceipt();
    });
  }
  test("turn_start clears prior response evidence", f => {
    f.offer(); f.tick(); f.begin(); f.context(f.sends[0].message); f.event("turn_start"); f.end(); f.noReceipt();
  });
  test("receipt uses CURRENT producer and offered subset, not stale envelope union", f => {
    f.offer([dm(1), dm(2)]); f.tick(); f.begin(); f.context(f.sends[0].message);
    f.producer = "producer-2"; f.mapping(); f.offer([dm(2), dm(3)]); f.end();
    const receipt = f.receipt([2]); assert.equal(receipt.producer, "producer-2");
    assert.equal(parseOsInboxReceipt(JSON.stringify(receipt), { ...f.binding(), producer: "producer-1" }), null);
  });
  test("owner mismatch cannot publish receipt; current offered generation recovers", f => {
    f.offer(); f.tick(); f.begin(); f.context(f.sends[0].message);
    f.producer = "producer-2"; f.mapping(); f.end();
    assert.equal(existsSync(f.receiptPath), false, "stale producer snapshot is not authority");
    f.offer([dm(1), dm(2)]); f.settle(); f.receipt([1]);
  });
  test("provider error retries same DM after backoff, no newer DM required", f => {
    f.offer(); f.tick(); f.begin(); f.context(f.sends[0].message); f.end("error");
    assert.equal(f.event("agent_before_settle", { outcome: "error", entries: [] }), undefined);
    f.settle(); f.noReceipt(); f.tick(1_999); assert.equal(f.sends.length, 1);
    f.tick(1); assert.equal(f.sends.length, 2); assert.deepEqual(f.sends[1].message.details.ids, [1]);
    f.begin(); f.context(f.sends[1].message); f.end(); f.receipt([1]);
  });
  test("throwing dispatch retries same DM with persisted attempt accounting", f => {
    f.failDispatch = true; f.offer(); f.tick(); f.noReceipt();
    assert.equal(f.entries.at(-1)!.data.streak, 1);
    f.failDispatch = false; f.tick(1_999); assert.equal(f.sends.length, 0);
    f.tick(1); assert.equal(f.sends.length, 1); assert.equal(f.entries.at(-1)!.data.streak, 2);
  });
  test("three failed responses visibly block costly retry loops until explicit recovery", f => {
    for (let i = 0; i < 3; i++) {
      f.offer(); f.tick(); assert.equal(f.sends.length, i + 1);
      f.begin(); f.context(f.sends.at(-1)!.message); f.end("error", "error"); f.settle();
      now += 65_000;
    }
    f.offer(); f.tick(); assert.equal(f.sends.length, 3); f.noReceipt();
    assert.match(f.statuses.at(-1)!, /three delivery failures/);
    f.resume(); f.tick(); assert.equal(f.sends.length, 4);
  });
  test("human-origin final continuations cannot evade the automatic budget", f => {
    f.offer([]); f.begin(true); f.offer();
    const before = f.entries.length;
    const result = f.event("agent_before_settle", { outcome: "completed", entries: [] });
    assert.equal(result.continue, true);
    assert.ok(f.entries.length > before);
    assert.equal(f.lastBudget.times.length, 1);
  });
  test("late unread DM at settle is not misclassified as a failed delivery", f => {
    f.offer([]); f.begin(true); f.offer(); f.settle();
    assert.equal(f.lastBudget.failures, 0);
  });
  test("rolling capacity defers same DM instead of permanently disqualifying it", f => {
    for (let i = 1; i <= 5; i++) f.deliver([dm(i)]);
    f.offer([dm(6)]); f.tick(); assert.equal(f.sends.length, 5);
    now += 59_999; f.offer([dm(6)]); f.tick(); assert.equal(f.sends.length, 5);
    f.tick(1); assert.equal(f.sends.length, 6); assert.deepEqual(f.sends[5].message.details.ids, [6]);
  });
  test("consecutive cooldown eventually permits same DM without human reset", f => {
    f.deliver([dm(1)]); assert.equal(f.lastBudget.streak, 20);
    f.offer([dm(2)]); f.tick(); assert.equal(f.sends.length, 1);
    now += 59_999; f.offer([dm(2)]); f.tick(); assert.equal(f.sends.length, 1);
    f.tick(1); assert.equal(f.sends.length, 2);
    assert.equal(f.lastBudget.streak, 21);
  }, [budget("session-1", { streak: 19 })]);
  for (const recovery of ["human", "resume"]) test(`Esc pauses same DM until ${recovery}`, f => {
    f.mode = "tui"; f.offer(); f.tick(); f.begin(); f.context(f.sends[0].message); f.end("aborted"); f.settle();
    now += 600_000; f.offer(); f.tick(); f.noReceipt(); assert.equal(f.sends.length, 1);
    f.event("input", { source: "extension" }); f.tick(); assert.equal(f.sends.length, 1, "extension cannot unpause Esc");
    if (recovery === "resume") { f.resume(); f.tick(); assert.equal(f.sends.length, 2); }
    else {
      f.event("input", { source: "interactive" }); f.tick(); assert.equal(f.sends.length, 1, "human preflight still has priority");
      const message = f.begin()!; f.context(message); f.end(); f.receipt([1]);
    }
  });
  test("master opt-out wins over remote opt-in/resume; human work still sees body", f => {
    process.env.CCT_OS_AUTO_WAKE = "0"; process.env.CCT_OS_AUTO_WAKE_REMOTE = "1";
    f.offer([dm()], { localBroker: false }); f.tick(); f.resume(); f.tick(); assert.equal(f.sends.length, 0);
    const message = f.begin(true)!; assert.deepEqual(message.details.ids, [1]); f.context(message); f.end(); f.receipt([1]);
  });
  test("remote idle defaults closed, explicit opt-in permits same DM", f => {
    f.offer([dm()], { localBroker: false }); f.tick(); assert.equal(f.sends.length, 0);
    process.env.CCT_OS_AUTO_WAKE_REMOTE = "1"; f.tick(); assert.equal(f.sends.length, 1);
  });
  test("pool-only idle stays quiet and manual notice coalesces by generation", f => {
    f.offer([{ ...dm(), pool_id: "pool-id", pool_name: "DM" }]);
    for (let i = 0; i < 10; i++) f.tick(1_000);
    assert.equal(f.sends.length, 0); f.noReceipt();
    writeFileSync(join(f.flags, `${f.peer}.os-notify`), JSON.stringify({ readGeneration: 0 }));
    const notice = f.begin(true)!; assert.equal(notice.customType, "cct-inbox-notice");
    assert.match(notice.content, /cct_check_messages/);
    assert.equal(f.event("before_agent_start"), undefined);
    writeFileSync(join(f.flags, `${f.peer}.os-notify`), JSON.stringify({ readGeneration: 1 }));
    assert.equal(f.event("before_agent_start").message.customType, "cct-inbox-notice");
  });
  test("safe boundaries preserve all existing entries and require context for receipt", f => {
    f.offer(); f.begin(true);
    const entries: Entry[] = [{ type: "message", content: "assistant tool call" }, { type: "custom", customType: "other-extension", data: { keep: true } }];
    const saved = structuredClone(entries);
    const result = f.end("completed", "toolUse", "assistant", entries);
    assert.equal(result.continue, true); assert.deepEqual(entries, saved); assert.deepEqual(result.entries.slice(0, 2), saved);
    assert.equal(result.entries[0], entries[0], "preserve original entry objects");
    assert.equal(result.entries.length, 3); f.noReceipt();
    f.event("turn_start"); f.context(result.entries[2]); f.end(); f.receipt([1]);
  });
  test("final continuation belongs to before-settle, not turn_end stop", f => {
    f.offer(); f.begin(true);
    assert.equal(f.end(), undefined);
    const entries = [{ type: "message", content: "final assistant" }];
    const result = f.event("agent_before_settle", { outcome: "completed", entries });
    assert.deepEqual(result.entries.slice(0, 1), entries); assert.equal(result.entries.length, 2); assert.equal(result.continue, true);
  });
  test("autonomous safe-boundary continuations consume rolling capacity", f => {
    f.offer(); f.tick(); f.begin();
    for (let i = 0; i < 4; i++) assert.equal(f.end("completed", "toolUse")?.continue, true);
    assert.equal(f.end("completed", "toolUse"), undefined);
    assert.equal(f.lastBudget.times.length, 5);
    f.noReceipt();
  });
  for (const pause of ["preflight", "UI", "replacement", "fork", "non-idle"]) test(`${pause} prevents unsafe timer startup`, f => {
    f.offer();
    if (pause === "preflight") f.event("input", { source: "rpc" });
    if (pause === "UI") f.event("ui_prompt_start");
    if (pause === "replacement") f.event("session_before_switch");
    if (pause === "fork") f.event("session_before_fork");
    if (pause === "non-idle") f.idle = false;
    now += 120_000; f.offer(); f.tick(); assert.equal(f.sends.length, 0);
    assert.equal(f.entries.filter(e => e.customType === BUDGET && e.data.streak > 0).length, 0);
    if (pause === "UI" || pause === "non-idle") {
      f.resume(); f.tick(); assert.equal(f.sends.length, 0, "resume cannot override UI/non-idle");
      f.event("ui_prompt_end"); f.idle = true;
    } else f.resume();
    f.tick(); assert.equal(f.sends.length, 1);
  });
  for (const event of ["ui_prompt_start", "session_before_switch", "session_before_fork"]) test(`${event} blocks safe-boundary additions too`, f => {
    f.offer(); f.begin(true); f.event(event);
    assert.equal(f.end("completed", "toolUse"), undefined);
    assert.equal(f.event("agent_before_settle", { outcome: "completed", entries: [] }), undefined);
  });
  test("shutdown stops observer, removes only own marker, ignores late callbacks", f => {
    f.offer(); f.tick(); const message = f.sends[0].message;
    f.event("session_shutdown"); assert.equal(timers.size, 0);
    assert.equal(existsSync(join(f.pidmaps, `os_session_${process.pid}`)), false);
    f.context(message); f.end(); f.tick(10_000); f.noReceipt(); assert.equal(f.sends.length, 1);
  });
  test("shutdown does not remove replacement session's marker", f => {
    const marker = join(f.pidmaps, `os_session_${process.pid}`); writeFileSync(marker, "replacement");
    f.event("session_shutdown"); assert.equal(readFileSync(marker, "utf8"), "replacement");
  });
  test("fork ignores copied parent budget/consumption and old known envelope", f => {
    f.offer(); f.tick(); const old = f.sends[0].message;
    f.entries.push(budget(f.session, { paused: true, nextAttempt: now + 600_000, streak: 99 }));
    f.entries.push({ type: "custom", customType: CONSUMED, data: { sessionId: f.session, peerId: f.peer, ids: [1] } });
    f.event("session_before_fork"); f.session = "child-session"; f.start(); f.offer(); f.tick();
    assert.equal(f.sends.length, 2, "parent receipt and budget cannot suppress child delivery");
    f.begin(); f.context(old); f.end();
    assert.equal(existsSync(f.receiptPath), false, "parent envelope cannot prove child context");
    f.context(f.sends[1].message); f.end(); f.receipt([1]);
  });
  test("same-session reload restores consumed IDs only against current offer", f => {
    f.offer([dm(1), dm(2)]); f.tick(); f.receipt([1]);
    assert.deepEqual(f.sends[0].message.details.ids, [2]);
  }, [{ type: "custom", customType: CONSUMED, data: { sessionId: "session-1", peerId: "peer-1", ids: [1, 99] } }]);
  test("same-session reload restores rolling budget", f => {
    f.offer(); f.tick(); assert.equal(f.sends.length, 0);
    now += 60_000; f.offer(); f.tick(); assert.equal(f.sends.length, 1);
  }, [budget("session-1", { times: Array(5).fill(initialNow), streak: 5 })]);
  test("malformed own budget fails closed but human body delivery remains available", f => {
    f.offer(); f.tick(); assert.equal(f.sends.length, 0);
    const message = f.begin(true)!; f.context(message); f.end(); f.receipt([1]);
  }, [budget("session-1", { times: "invalid" })]);
  test("failed budget persistence cannot start autonomous work", f => {
    f.failCheckpoint = true; f.offer(); f.tick(); f.tick(); assert.equal(f.sends.length, 0); f.noReceipt();
  });
  for (const mode of ["print", "json"]) test(`${mode} has no observer or receipts`, f => {
    f.event("session_shutdown"); f.mode = mode; f.start(); f.offer(); f.tick();
    assert.equal(timers.size, 0); assert.equal(f.sends.length, 0); assert.equal(f.event("before_agent_start"), undefined); f.noReceipt();
  });
  for (const [name, patch] of [
    ["stale", { timestamp: initialNow - 30_001 }], ["future", { timestamp: initialNow + 1 }],
    ["wrong session", { sessionId: "foreign" }], ["wrong producer", { producer: "foreign" }],
    ["missing locality", { localBroker: undefined }], ["pool disguised as DM", { messages: [{ ...dm(), pool_id: "pool" }] }],
    ["system sender", { messages: [{ ...dm(), from_id: "system" }] }], ["duplicate IDs", { messages: [dm(), dm()] }],
  ] as [string, Partial<OsInboxSnapshot>][]) test(`${name} snapshot fails closed`, f => {
    f.offer([dm()], patch); f.tick(); assert.equal(f.sends.length, 0); f.noReceipt();
  });
} finally {
  Date.now = originalNow; global.setInterval = originalInterval; global.clearInterval = originalClear;
  for (const key of envKeys) { if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key]; }
}
console.log(`\n${passed} passed; ${failures.length} failed`);
if (failures.length) { console.error(`Failures:\n${failures.map(name => `- ${name}`).join("\n")}`); process.exitCode = 1; }
