import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Historical notice-only controller regressions. Canonical body delivery is
// exercised by test-os-inbox-pump.ts and installed body/lifecycle acceptance.
import cctExtension from "./test-fixtures/os/legacy-notice-extension.ts";

const root = mkdtempSync(join(tmpdir(), "cct-os-notices-"));
const pidmaps = join(root, "pidmaps"), flags = join(root, "flags");
mkdirSync(pidmaps); mkdirSync(flags);
process.env.CCT_DIR = root;
const originalNow = Date.now, originalInterval = global.setInterval, originalClear = global.clearInterval;
let now = 1_800_000_000_000;
Date.now = () => now;
const timers = new Map<object, () => void>();
(global as any).setInterval = (fn: () => void) => { const handle = { unref() {} }; timers.set(handle, fn); return handle; };
(global as any).clearInterval = (handle: object) => { timers.delete(handle); };
const tick = () => { for (const fn of [...timers.values()]) fn(); };
type Notice = { message: { customType: string; content: string; details: { source: string; attempt: number } }; options: { triggerTurn: boolean } };
let failDispatch = false, failCurrent = false;
let session = "session-1", peer = "peer-1", mode = "rpc", idle = true, active = true;
let notices: Notice[] = [], statuses: string[] = [], entries: Array<{ type: string; customType: string; data: unknown }> = [];
const hooks = new Map<string, (event: any, ctx: any) => unknown>();
let command: (args: string, ctx: any) => void = () => {};
const ctx = {
  sessionManager: { getSessionId: () => { if (failCurrent) throw new Error("invalidated context"); return session; }, getEntries: () => entries },
  get mode() { return mode; }, isIdle: () => idle,
  ui: { setStatus: (_key: string, value: string | undefined) => { if (value) statuses.push(value); }, notify: (text: string) => { statuses.push(text); } },
};
function install() {
  cctExtension({
    on: (event: string, handler: (event: any, ctx: any) => unknown) => { hooks.set(event, handler); },
    getActiveTools: () => active ? ["cct_check_messages"] : [],
    sendMessage: (message: Notice["message"], options: Notice["options"]) => { if (failDispatch) throw new Error("dispatch failed"); notices.push({ message, options }); },
    appendEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); },
    registerCommand: (_name: string, config: { handler: typeof command }) => { command = config.handler; },
  } as never);
}
const event = (name: string, data: object = {}) => hooks.get(name)?.(data, ctx);
function mapping(producer = "producer-1") { writeFileSync(join(pidmaps, `os_${session}`), `${peer}|name|${producer}|opaque-start`); }
function meta({ generation = 0, dm = 1, dmId, count = 1, local = true, producer = "producer-1" }: { generation?: number; dm?: number; dmId?: number; count?: number; local?: boolean | null; producer?: string } = {}) {
  writeFileSync(join(flags, `${peer}.os-notify`), JSON.stringify({
    version: 1, peerId: peer, producer, readGeneration: generation, count,
    maxId: count ? Math.max(generation + 1, dmId ?? 0) : 0, maxDmId: dm && count ? dmId ?? generation + 1 : 0,
    timestamp: now, ...(local === null ? {} : { localBroker: local }),
  }));
}
function start() { event("session_start"); mapping(); }
function delivered(index = notices.length - 1) {
  event("message_end", { message: { role: "custom", customType: "cct-inbox-notice", details: notices[index].message.details } });
}
function human() { event("input", { source: "rpc" }); idle = false; event("agent_start"); event("context"); }
function settle() { idle = true; event("agent_settled"); }
try {
  install(); start(); tick(); assert.equal(notices.length, 0);
  meta({ dm: 0 }); tick(); assert.equal(notices.length, 0, "pool-only idle stays quiet");
  idle = false; tick(); assert.equal(notices.length, 0, "non-idle summary without known run cannot send");
  human(); tick(); assert.equal(notices.length, 1, "known human busy run gets pool notice");
  assert.equal(notices[0].options.triggerTurn, true);
  delivered(); settle();
  meta({ dm: 1 }); tick(); assert.equal(notices.length, 2, "first DM after pool notice can wake");
  delivered(); settle(); tick(); assert.equal(notices.length, 2, "dequeued episode never retries");
  meta({ generation: 1 }); tick(); assert.equal(notices.length, 3, "successful read generation rearms");
  delivered(); settle();
  // Unseen TUI steer: Esc drops the queue, but no autonomous restart on settle.
  mode = "tui"; human(); meta({ generation: 2 }); tick();
  assert.equal(notices.length, 4); settle(); tick(); assert.equal(notices.length, 4);
  event("input", { source: "interactive" }); idle = false; event("agent_start"); event("context");
  assert.equal(notices.length, 5, "one bounded later human-run recovery");
  assert.equal(notices[4].message.details.attempt, 2);
  settle(); human(); tick(); assert.equal(notices.length, 5, "no third re-offer"); settle();
  // RPC retained custom queue: no duplicate after settle or subsequent human run.
  mode = "rpc"; human(); meta({ generation: 3 }); tick(); settle(); human(); tick();
  assert.equal(notices.length, 6); settle();
  // Human prompt preflight retains priority for longer than five seconds, including failure.
  event("input", { source: "rpc" }); now += 7_500; meta({ generation: 4 }); tick();
  assert.equal(notices.length, 6); assert.match(statuses.at(-1) ?? "", /preflight/);
  command("status", ctx); assert.match(statuses.at(-1) ?? "", /preflight/);
  command("resume", ctx); tick(); assert.equal(notices.length, 7, "human explicit resume only after operation finished");
  delivered(); settle();
  // A failed/handled preflight can only be explicitly recovered: another input does not clear it.
  const preflightEntries = entries.length;
  event("input", { source: "rpc" }); tick(); event("input", { source: "rpc" }); tick();
  assert.equal(entries.length, preflightEntries + 1, "only the changed consecutive counter checkpoints, not every human input");
  assert.equal(notices.length, 7); command("resume", ctx);
  event("session_before_switch"); meta({ generation: 5 }); tick(); assert.equal(notices.length, 7);
  event("input", { source: "rpc" }); tick(); assert.equal(notices.length, 7, "input is NOT replacement completion");
  command("status", ctx); assert.match(statuses.at(-1) ?? "", /replacement pending/);
  command("resume", ctx); tick(); assert.equal(notices.length, 8, "explicit replacement recovery");
  delivered(); settle();
  // Remote/unknown locality: busy still works; no idle unless explicitly opted in.
  meta({ generation: 6, local: false }); tick(); assert.equal(notices.length, 8);
  meta({ generation: 6, local: null }); tick(); assert.equal(notices.length, 8);
  human(); tick(); assert.equal(notices.length, 9);
  delivered(); settle();
  process.env.CCT_OS_AUTO_WAKE_REMOTE = "1"; meta({ generation: 7, local: false }); tick(); assert.equal(notices.length, 10);
  delivered(); settle();
  process.env.CCT_OS_AUTO_WAKE = "0"; meta({ generation: 8, local: false }); tick(); assert.equal(notices.length, 10);
  delete process.env.CCT_OS_AUTO_WAKE; delete process.env.CCT_OS_AUTO_WAKE_REMOTE;
  // New isolated logical session starts fresh. Count only idle starts, not busy.
  event("session_shutdown"); session = "session-budget"; peer = "peer-budget"; entries = []; start();
  for (let i = 0; i < 5; i++) { meta({ generation: i }); tick(); assert.equal(notices.length, 11 + i); delivered(); settle(); }
  meta({ generation: 5 }); tick(); assert.equal(notices.length, 15, "rolling limit");
  assert.match(statuses.at(-1) ?? "", /budget/);
  now += 60_001; tick(); assert.equal(notices.length, 15, "rate-refused DM cannot wake merely when the window expires");
  meta({ generation: 5, dmId: 7 }); tick(); assert.equal(notices.length, 16, "strictly new DM after rolling window gets a fresh budget decision");
  delivered(); settle();
  // Four further starts reach the consecutive cap (no human input).
  for (let i = 7; i < 11; i++) { meta({ generation: i }); tick(); assert.equal(notices.length, 10 + i); delivered(); settle(); now += 60_001; }
  meta({ generation: 11 }); tick(); assert.equal(notices.length, 20, "ten consecutive cap survives many rate windows");
  now += 60_001; tick(); assert.equal(notices.length, 20, "consecutive-refused DM does not retry on expiry");
  meta({ generation: 11, dmId: 13 }); tick(); assert.equal(notices.length, 20, "new DM still blocked at ten consecutive even with a free rolling window");
  event("input", { source: "extension" }); tick(); assert.equal(notices.length, 20, "peer input does not reset consecutive");
  const beforeReset = entries.length;
  event("input", { source: "rpc" }); tick(); assert.equal(notices.length, 20, "human reset never retries already-refused DM");
  assert.equal(entries.length, beforeReset + 1, "changed consecutive counter is checkpointed once");
  event("input", { source: "rpc" }); assert.equal(entries.length, beforeReset + 1, "second human input with zero consecutive is not checkpointed");
  command("status", ctx); assert.match(statuses.at(-1) ?? "", /resume clears lifecycle pauses only/);
  command("resume", ctx); tick(); assert.equal(notices.length, 20, "resume does not override budget-refused DM");
  // Human work may still see a refused episode; a DM-containing delivery then
  // stays claimed even when new DMs arrive without a successful check.
  event("input", { source: "rpc" }); idle = false; event("agent_start"); event("context");
  assert.equal(notices.length, 21, "budget-refused source remains eligible during human busy work"); delivered(); settle();
  meta({ generation: 11, dmId: 14 }); tick(); assert.equal(notices.length, 21, "delivered DM notice does not rearm on another DM");
  meta({ generation: 12 }); tick(); assert.equal(notices.length, 22, "human input reset consecutive and the rolling window is free");
  mode = "print"; meta({ generation: 13 }); tick(); assert.equal(notices.length, 22);
  mode = "json"; tick(); assert.equal(notices.length, 22);
  active = false; mode = "rpc"; tick(); assert.equal(notices.length, 22);
  // A peer-triggered autonomous run cannot chain unbudgeted busy continuations.
  active = true;
  event("session_shutdown"); session = "autonomous"; peer = "peer-auto"; entries = []; start();
  meta({ generation: 0 }); tick(); assert.equal(notices.length, 23);
  assert.match(notices.at(-1)!.message.content, /Handle available inbox work, then stop this turn; do not poll or wait for peer replies\. No response is required\./);
  idle = false; event("agent_start");
  for (let i = 1; i <= 8; i++) { meta({ generation: i }); tick(); event("context"); }
  assert.equal(notices.length, 23, "fresh peer messages cannot extend autonomous run by busy steer");
  settle(); tick(); assert.equal(notices.length, 24, "latest source gets separately budgeted after settle");
  // Fork copies parent history, including an exhausted parent checkpoint:
  // valid other-session entries must not poison the child's independent budget.
  entries.push({ type: "custom", customType: "cct-os-wake-budget-v1", data: { session: "autonomous", times: [], consecutive: 10 } });
  event("session_shutdown"); session = "forked"; peer = "peer-fork"; start();
  meta({ generation: 0 }); tick(); assert.equal(notices.length, 25, "fork starts with independent budget");
  delivered(); settle(); event("session_shutdown"); start();
  meta({ generation: 1 }); tick(); assert.equal(notices.length, 26, "same-session fork reload restores its budget");
  // A later copied foreign checkpoint does not override this session's latest checkpoint.
  entries.push({ type: "custom", customType: "cct-os-wake-budget-v1", data: { session: "autonomous", times: [now], consecutive: 10 } });
  event("session_shutdown"); start(); meta({ generation: 2 }); tick();
  assert.equal(notices.length, 27, "well-formed foreign checkpoint ignored on same-session reload");
  entries.push({ type: "custom", customType: "cct-os-wake-budget-v1", data: { session: "forked", times: [], consecutive: 10 } });
  event("session_shutdown"); start(); meta({ generation: 3 }); tick();
  assert.equal(notices.length, 27, "valid same-session cap survives reload");
  entries.push({ type: "custom", customType: "cct-os-wake-budget-v1", data: { session: "forked", times: "bad", consecutive: 0 } });
  event("session_shutdown"); start(); meta({ generation: 4 }); tick();
  assert.equal(notices.length, 27, "malformed own checkpoint fails closed");
  assert.match(statuses.at(-1) ?? "", /budget unavailable/);
  // Opt-out leaves the episode eligible; removing the opt-out permits it later.
  event("session_shutdown"); session = "opt-out"; peer = "peer-opt"; entries = []; start();
  process.env.CCT_OS_AUTO_WAKE = "0"; meta({ generation: 0 }); tick();
  assert.equal(notices.length, 27);
  const statusCount = statuses.length;
  tick(); tick(); assert.equal(statuses.length, statusCount, "unchanged opt-out status is not emitted every poll");
  command("resume", ctx); tick(); assert.equal(notices.length, 27, "resume cannot override master opt-out");
  delete process.env.CCT_OS_AUTO_WAKE; tick(); assert.equal(notices.length, 28, "opt-out did not spend source");
  event("session_shutdown"); session = "rate-busy"; peer = "peer-rate"; entries = []; start();
  for (let i = 0; i < 5; i++) { meta({ generation: i }); tick(); delivered(); settle(); }
  meta({ generation: 5 }); tick(); assert.equal(notices.length, 33, "rate-refused source is quiet while idle");
  human(); tick(); assert.equal(notices.length, 34, "rate-refused source remains visible to human busy run");
  assert.doesNotMatch(notices.at(-1)!.message.content, /do not poll or wait/);
  settle(); meta({ generation: 6 }); tick(); assert.equal(notices.length, 34, "human input does not clear rolling rate history");
  now += 65_000; tick(); assert.equal(notices.length, 34, "same rate-refused DM stays quiet after window expiry");
  meta({ generation: 6, dmId: 8 }); tick(); assert.equal(notices.length, 35, "fresh DM becomes eligible once rolling budget permits");
  event("session_shutdown"); idle = true;
  // A handled/failed human input never starts a run. Resume must not leave
  // human provenance on the next autonomous wake, even after a slow preflight.
  session = "handled"; peer = "peer-handled"; entries = []; start();
  event("input", { source: "rpc" }); now += 7_500; meta(); tick();
  assert.equal(notices.length, 35, "pending human preflight is not subject to arbitrary expiry");
  command("resume", ctx); tick(); assert.equal(notices.length, 36);
  idle = false; event("agent_start");
  meta({ generation: 1 }); event("context"); tick();
  assert.equal(notices.length, 36, "handled human input and resume cannot authorize autonomous busy steering");
  event("input", { source: "extension" }); event("context");
  assert.equal(notices.length, 36, "extension-origin input cannot relabel an autonomous run");
  settle(); tick(); assert.equal(notices.length, 37, "deferred peer source consumes a separate idle start");
  delivered(); settle();
  // A real human steer during an active run is human provenance; so is a
  // pending prompt that actually reaches agent_start.
  event("input", { source: "interactive" }); idle = false; event("agent_start");
  meta({ generation: 2 }); tick(); assert.equal(notices.length, 38, "started human prompt receives busy notice");
  event("input", { source: "rpc" }); meta({ generation: 3 }); tick();
  assert.equal(notices.length, 39, "active human steering keeps busy delivery available");
  settle();
  // Human steering can intentionally take ownership of an already running
  // autonomous exchange; unlike extension-origin input it is trusted input.
  event("session_shutdown"); idle = true; session = "steered"; peer = "peer-steered"; entries = []; start();
  meta(); tick(); assert.equal(notices.length, 40);
  idle = false; event("agent_start"); event("input", { source: "interactive" });
  meta({ generation: 1 }); event("context");
  assert.equal(notices.length, 41, "real human steering of active run permits busy notice");
  settle();
  // Esc may discard a pool-only queued steer without message_end. Recover
  // once on later human work; it must never initiate an idle pool wake.
  event("session_shutdown"); session = "pool-esc"; peer = "peer-pool-esc"; entries = []; mode = "tui"; start();
  meta({ dm: 0 }); tick(); assert.equal(notices.length, 41, "pool-only cannot idle wake");
  event("input", { source: "interactive" }); idle = false; event("agent_start"); tick(); assert.equal(notices.length, 42);
  settle(); tick(); assert.equal(notices.length, 42, "Esc-dropped pool-only notice cannot restart idle work");
  event("input", { source: "interactive" }); idle = false; event("agent_start"); tick();
  assert.equal(notices.length, 43, "pool-only uncertain notice is re-offered on later human work");
  assert.equal(notices.at(-1)!.message.details.attempt, 2);
  settle(); human(); tick(); assert.equal(notices.length, 43, "pool-only recovery remains bounded");
  settle();
  // Synchronous dispatch failure spends one start. The source cannot loop,
  // and its budget checkpoint must survive a same-session reload.
  event("session_shutdown"); session = "failed-dispatch"; peer = "peer-failed"; entries = []; mode = "rpc"; start();
  failDispatch = true; meta(); tick(); tick();
  assert.equal(notices.length, 43, "failed dispatch does not retry this source");
  assert.match(statuses.at(-1) ?? "", /dispatch uncertain/);
  assert.equal((entries.at(-1)!.data as { consecutive: number }).consecutive, 1, "failed dispatch consumes one start");
  failDispatch = false; event("session_shutdown"); start();
  meta({ generation: 1 }); tick(); assert.equal(notices.length, 44, "new source may wake after failed dispatch");
  assert.equal((entries.at(-1)!.data as { consecutive: number }).consecutive, 2, "reload cannot reset failed-dispatch budget");
  // One outer human run can contain several low-level agent starts: provider
  // auto-retry and queued continuation must preserve the original provenance.
  event("session_shutdown"); idle = true; session = "human-retry"; peer = "peer-retry"; entries = []; start();
  event("input", { source: "rpc" }); idle = false; event("agent_start");
  event("agent_start"); // provider auto-retry, no new input
  meta({ generation: 0 }); event("context"); assert.equal(notices.length, 45, "retry retains human busy delivery");
  event("agent_start"); // late queued continuation before outer settle
  meta({ generation: 1 }); event("context"); assert.equal(notices.length, 46, "queued continuation retains human provenance");
  settle();
  // Conversely, repeated autonomous starts never gain human provenance.
  event("session_shutdown"); idle = true; session = "auto-retry"; peer = "peer-auto-retry"; entries = []; start();
  meta(); tick(); assert.equal(notices.length, 47);
  idle = false; event("agent_start"); event("agent_start");
  meta({ generation: 1 }); event("context"); assert.equal(notices.length, 47, "auto retry cannot steer without budget");
  settle(); tick(); assert.equal(notices.length, 48, "auto continuation waits for separately budgeted idle start");
  // Timer must tolerate a host context invalidated between ticks.
  failCurrent = true; assert.doesNotThrow(tick); failCurrent = false;
  event("session_shutdown"); assert.equal(timers.size, 0);
  console.log("PASS os controller: queue/history, DM watermark budgets, retry provenance, guarded timer, fork/reload, preflight, locality");
} finally {
  Date.now = originalNow; global.setInterval = originalInterval; global.clearInterval = originalClear;
  delete process.env.CCT_DIR; delete process.env.CCT_OS_AUTO_WAKE; delete process.env.CCT_OS_AUTO_WAKE_REMOTE;
  rmSync(root, { recursive: true, force: true });
}
