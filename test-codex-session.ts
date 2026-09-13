#!/usr/bin/env tsx
// Unit tests for codex session identity resolution (shared/codex-session.ts).
// Run: npx tsx test-codex-session.ts   (also invoked by test-integration.sh)

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findLatestSessionIdForCwd,
  findRolloutById,
  parseResumeSessionId,
  readSessionMeta,
  resolveCodexSessionIdentity,
  resolveRootSessionId,
} from "./shared/codex-session.ts";

const ROOT_ID = "01a09bf3-1014-7ac2-a910-d3e5ab14d32f";
const FORK_ID = "01a09c07-81b6-7931-98c9-71b81f9b6a15";
const FORK2_ID = "01a09d11-2222-7931-98c9-71b81f9b6a99";
const CWD = "/Users/tyo/Omics-OS/lobster-cloud";

let pass = 0;
let fail = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    fail++;
    console.log(`  ✗ ${name}\n      ${e?.message ?? e}`);
  }
}

const base = mkdtempSync(join(tmpdir(), "cct-codex-session-"));
const sessionsDir = join(base, "sessions");
const dayDir = join(sessionsDir, "2026", "09", "13");
mkdirSync(dayDir, { recursive: true });

function writeRollout(
  timestamp: string,
  sessionId: string,
  opts: { forkedFrom?: string; cwd?: string; extraLines?: number } = {},
): string {
  const meta = {
    timestamp: `2026-09-13T${timestamp.slice(11).replace(/-/g, ":")}.000Z`,
    type: "session_meta",
    payload: {
      session_id: sessionId,
      id: sessionId,
      ...(opts.forkedFrom ? { forked_from_id: opts.forkedFrom, forked_from_ordinal_exclusive: 5294 } : {}),
      cwd: opts.cwd ?? CWD,
      originator: "codex-tui",
      cli_version: "0.0.0-test",
    },
  };
  const lines = [JSON.stringify(meta)];
  for (let i = 0; i < (opts.extraLines ?? 3); i++) {
    lines.push(JSON.stringify({ type: "message", payload: { text: "x".repeat(200) } }));
  }
  const file = join(dayDir, `rollout-${timestamp}-${sessionId}.jsonl`);
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

const rootFile = writeRollout("2026-09-13T14-06-32", ROOT_ID);
const forkFile = writeRollout("2026-09-13T14-28-52", FORK_ID, { forkedFrom: ROOT_ID });

console.log("codex-session resolution");

test("parseResumeSessionId extracts the id from a resume command line", () => {
  assert.equal(
    parseResumeSessionId(`/opt/homebrew/bin/codex resume ${ROOT_ID} --dangerously-bypass-approvals-and-sandbox`),
    ROOT_ID,
  );
});

test("parseResumeSessionId returns null for a fresh (non-resume) command line", () => {
  assert.equal(parseResumeSessionId("/opt/homebrew/bin/codex --dangerously-bypass-approvals-and-sandbox"), null);
});

test("readSessionMeta reads session_id, cwd and forked_from_id from the head", () => {
  assert.deepEqual(readSessionMeta(forkFile), { sessionId: FORK_ID, forkedFromId: ROOT_ID, cwd: CWD });
  assert.deepEqual(readSessionMeta(rootFile), { sessionId: ROOT_ID, forkedFromId: null, cwd: CWD });
});

test("findRolloutById locates a rollout by session id", () => {
  assert.equal(findRolloutById(sessionsDir, FORK_ID), forkFile);
  assert.equal(findRolloutById(sessionsDir, "does-not-exist"), null);
});

test("resolveRootSessionId follows the fork chain to the root", () => {
  assert.equal(resolveRootSessionId(sessionsDir, FORK_ID), ROOT_ID);
  assert.equal(resolveRootSessionId(sessionsDir, ROOT_ID), ROOT_ID);
});

test("resolveRootSessionId returns the input when no rollout exists (graceful)", () => {
  assert.equal(resolveRootSessionId(sessionsDir, "11111111-2222-3333-4444-555555555555"), "11111111-2222-3333-4444-555555555555");
});

test("findLatestSessionIdForCwd returns the newest session for that cwd", () => {
  assert.equal(findLatestSessionIdForCwd(sessionsDir, CWD)?.sessionId, FORK_ID);
});

test("findLatestSessionIdForCwd returns null for an unrelated cwd", () => {
  assert.equal(findLatestSessionIdForCwd(sessionsDir, "/tmp/some-other-dir"), null);
});

test("resume of a forked session resolves to the root key (identity survives resume)", () => {
  const identity = resolveCodexSessionIdentity({
    sessionsDir,
    cwd: CWD,
    hostCommand: `codex resume ${FORK_ID}`,
  });
  assert.equal(identity.sessionId, FORK_ID);
  assert.equal(identity.rootSessionId, ROOT_ID);
  assert.equal(identity.source, "host-argv-resume+fork-root");
});

test("fresh start resolves via rollout cwd scan", () => {
  const identity = resolveCodexSessionIdentity({ sessionsDir, cwd: CWD, hostCommand: "codex" });
  assert.equal(identity.sessionId, FORK_ID);
  assert.equal(identity.rootSessionId, ROOT_ID);
  assert.equal(identity.source, "rollout-cwd+fork-root");
});

test("env session id wins when present", () => {
  const identity = resolveCodexSessionIdentity({
    sessionsDir,
    cwd: CWD,
    hostCommand: `codex resume ${FORK_ID}`,
    envSessionId: ROOT_ID,
  });
  assert.equal(identity.sessionId, ROOT_ID);
  assert.equal(identity.rootSessionId, ROOT_ID);
  assert.equal(identity.source, "env");
});

test("unresolvable session yields a null identity, not a throw", () => {
  const identity = resolveCodexSessionIdentity({ sessionsDir, cwd: "/nope", hostCommand: "codex" });
  assert.deepEqual(identity, { sessionId: null, rootSessionId: null, source: "unresolved" });
});

test("a second fork of the same lineage still maps to the root", () => {
  writeRollout("2026-09-13T15-10-00", FORK2_ID, { forkedFrom: FORK_ID });
  assert.equal(resolveRootSessionId(sessionsDir, FORK2_ID), ROOT_ID);
});

// Regression: real codex session_meta records are ~22KB (they carry the
// environment context). A fixed-size head read truncated the line, readSessionMeta
// returned null, and every forked session looked like its own root — the exact
// identity churn this module exists to prevent.
test("a >16KB session_meta first line is still parsed (fork chain intact)", () => {
  const bigDir = join(base, "big", "2026", "09", "13");
  mkdirSync(bigDir, { recursive: true });
  const bigRoot = "cccccccc-1111-2222-3333-444444444444";
  const bigFork = "dddddddd-1111-2222-3333-444444444444";
  const write = (ts: string, id: string, from?: string) =>
    writeFileSync(
      join(bigDir, `rollout-${ts}-${id}.jsonl`),
      JSON.stringify({
        type: "session_meta",
        payload: {
          session_id: id,
          ...(from ? { forked_from_id: from } : {}),
          cwd: CWD,
          environment_context: "e".repeat(40000),
        },
      }) + "\n" + JSON.stringify({ type: "message", payload: { text: "later" } }) + "\n",
    );
  write("2026-09-13T09-00-00", bigRoot);
  write("2026-09-13T09-30-00", bigFork, bigRoot);
  const bigSessions = join(base, "big");
  assert.equal(readSessionMeta(join(bigDir, `rollout-2026-09-13T09-30-00-${bigFork}.jsonl`))?.forkedFromId, bigRoot);
  assert.equal(resolveRootSessionId(bigSessions, bigFork), bigRoot);
  assert.equal(findLatestSessionIdForCwd(bigSessions, CWD)?.sessionId, bigFork);
});

test("a fork cycle terminates instead of looping", () => {
  const cycleDir = join(base, "cycle", "2026", "09", "13");
  mkdirSync(cycleDir, { recursive: true });
  const a = "aaaaaaaa-1111-2222-3333-444444444444";
  const b = "bbbbbbbb-1111-2222-3333-444444444444";
  const write = (ts: string, id: string, from: string) =>
    writeFileSync(
      join(cycleDir, `rollout-${ts}-${id}.jsonl`),
      JSON.stringify({ type: "session_meta", payload: { session_id: id, forked_from_id: from, cwd: CWD } }) + "\n",
    );
  write("2026-09-13T10-00-00", a, b);
  write("2026-09-13T10-00-01", b, a);
  const root = resolveRootSessionId(join(base, "cycle"), a);
  assert.ok(root === a || root === b, `expected a or b, got ${root}`);
});

rmSync(base, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
