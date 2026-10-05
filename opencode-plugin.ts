// CCT opencode plugin — the fourth CCT runtime (claude | codex | os | opencode).
//
// Loaded by the opencode server process per instance: a tiny ESM stub at
// `<global config dir>/plugins/cct.js` (written by `cct install --opencode`,
// PHASE_4) re-exports this file's default export. Under Bun that stub can
// import .ts directly, so the plugin ships as TypeScript source.
//
// PHASE_1 scope (this file): identity + registration + lifecycle only.
//   - identity   : one peer per opencode INSTANCE (per project directory), not
//                  per chat session. session_key = "opencode:<sanitized dir>"
//                  (PLAN OC-3, Q1). Two concurrent processes in the same
//                  directory converge on one peer row (broker dedupe on
//                  (runtime, session_key) revives the row and shares the id).
//   - lifecycle  : register -> /set-summary -> 15s heartbeat -> dispose ->
//                  unregister. A heartbeat "peer not found or not active"
//                  re-registers the same session_key (revive restores dropped
//                  pool memberships; ARCHITECTURE D11b).
//   - fail-open  : the plugin NEVER throws, never blocks instance startup, and
//                  never keeps the process alive (all timers unref'd) — a
//                  one-shot `opencode run` must exit exactly as without CCT.
//   - no sidecars : unlike os/codex there are no flag files, pidmaps, or
//                  notify-metadata files for opencode (PLAN OC-11) — nothing
//                  outside this process consumes them; identity lives in the
//                  broker row only.
//
// Tools (`cct`, `cct_check_messages`), the busy gate, and idle wake arrive in
// PHASE_2/PHASE_3. Design + decision register: .planning/opencode-runtime/PLAN.md

import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { createHash } from "node:crypto";
import {
  getGitInfo,
  getPidStartForPid,
  registerPeer,
  sendHeartbeat,
  setSummary,
  unregisterPeer,
} from "./shared/broker-client.ts";
import { generateSummary } from "./shared/summarize.ts";
import type { RegisterRequest, RegisterResponse } from "./shared/types.ts";

const RUNTIME = "opencode" as const;
const DEFAULT_HEARTBEAT_MS = 15_000;

/** Test-only override for the heartbeat interval (mirrors the constant in
 *  shared/constants.ts:58). Production keeps the default. */
function heartbeatMs(): number {
  const raw = Number(process.env.CCT_OPENCODE_HEARTBEAT_MS ?? "");
  return Number.isFinite(raw) && raw >= 100 ? raw : DEFAULT_HEARTBEAT_MS;
}

/**
 * Stable broker identity key for one opencode instance directory.
 * Returns the FULL session_key ("opencode:<key>") or null when the directory
 * is unusable. The <key> part is sanitized to ^[a-zA-Z0-9_-]{1,150}$ so the
 * full key always fits the marker validation style used by server.ts (200)
 * with room for the "opencode:" prefix. Long directories are truncated and
 * disambiguated with an 8-char sha1 of the ORIGINAL path.
 */
export function sanitizeInstanceKey(directory: string): string | null {
  if (typeof directory !== "string" || directory.length === 0) return null;
  let key = directory.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (key.length > 150) {
    const hash = createHash("sha1").update(directory).digest("hex").slice(0, 8);
    key = `${key.slice(0, 141)}-${hash}`;
  }
  if (!/^[a-zA-Z0-9_-]{1,150}$/.test(key)) return null;
  return `opencode:${key}`;
}

interface InstanceState {
  input: PluginInput;
  directory: string;
  sessionKey: string;
  /** Current broker identity; null while (re-)registering. */
  identity: RegisterResponse | null;
  registerBody: RegisterRequest;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  stopped: boolean;
  /** Log a broker-unreachable line once per failure streak, not every tick. */
  loggedUnreachable: boolean;
}

function log(msg: string): void {
  try {
    process.stderr.write(`CCT opencode: ${msg}\n`);
  } catch {}
}

async function register(state: InstanceState): Promise<boolean> {
  try {
    const res = await registerPeer(state.registerBody);
    if (!res.ok || !res.data) {
      if (!state.loggedUnreachable) {
        log(`register rejected (${res.error ?? "no data"}); retrying on next heartbeat`);
        state.loggedUnreachable = true;
      }
      return false;
    }
    state.identity = res.data;
    state.loggedUnreachable = false;
    const reg = res.data;
    log(`registered as ${reg.id}/${reg.name} (key ${state.sessionKey})`);
    // Summary is best-effort; a failed set-summary never blocks registration.
    void (async () => {
      try {
        const summary = await generateSummary(state.directory);
        await setSummary({ peer_id: reg.id, peer_secret: reg.secret, summary });
      } catch {}
    })();
    return true;
  } catch (e) {
    if (!state.loggedUnreachable) {
      log(`register failed (broker unreachable: ${String(e)}); retrying on next heartbeat`);
      state.loggedUnreachable = true;
    }
    return false;
  }
}

async function tick(state: InstanceState): Promise<void> {
  if (state.stopped) return;
  if (!state.identity) {
    await register(state);
    return;
  }
  try {
    const res = await sendHeartbeat({
      peer_id: state.identity.id,
      peer_secret: state.identity.secret,
      pid: state.registerBody.pid,
      pid_start: state.registerBody.pid_start,
    });
    if (res.ok) return;
    // "peer not found or not active": the row was reaped (45s staleness sweep
    // after a broker restart, or a same-directory sibling retired it). Re-
    // registering the SAME session_key revives the row with the same id and
    // restores dropped pool memberships — the converge-not-fork rule.
    // "invalid peer_secret": a sibling in this directory now owns the live
    // row; re-registering adopts that row and returns ITS secret, so both
    // processes converge on one identity instead of fighting.
    log(`heartbeat rejected (${res.error ?? "unknown"}); re-registering`);
    state.identity = null;
    await register(state);
  } catch {
    // Broker unreachable: keep ticking quietly. This plugin never spawns a
    // broker (see the init note below); a broker that appears later is
    // picked up by the next register attempt on the heartbeat tick.
  }
}

async function shutdown(state: InstanceState, reason: string): Promise<void> {
  if (state.stopped) return;
  state.stopped = true;
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
  const identity = state.identity;
  state.identity = null;
  if (!identity) {
    log(`shutting down (${reason}); never registered`);
    return;
  }
  try {
    const res = await unregisterPeer({
      peer_id: identity.id,
      peer_secret: identity.secret,
      pid: state.registerBody.pid,
      pid_start: state.registerBody.pid_start,
    });
    if (res.ok && res.data) {
      log(`unregistered (${reason}); ${res.data.connections_remaining ?? 0} connection(s) remain`);
    } else {
      log(`unregister failed (${res.error ?? "unknown"}) (${reason})`);
    }
  } catch (e) {
    log(`unregister error (${String(e)}) (${reason})`);
  }
}

/**
 * Build the broker registration body for an instance. Exported for tests —
 * pure except for pid/pid_start/name sampling, which tests pin via env+pid.
 */
export async function buildRegisterBody(input: PluginInput, sessionKey: string): Promise<RegisterRequest> {
  const directory = input.directory ?? "";
  const explicitName = process.env.CCT_PEER_NAME?.trim() || undefined;
  const pidStart = getPidStartForPid(process.pid);
  const git = await getGitInfo(directory);
  return {
    pid: process.pid,
    pid_start: pidStart,
    runtime: RUNTIME,
    session_key: sessionKey,
    // The opencode server process IS the host process (plugins are in-process,
    // no MCP child), so host fences are self-fences.
    host_pid: process.pid,
    host_pid_start: pidStart,
    cwd: directory,
    name: explicitName ?? `oc-${Math.random().toString(36).slice(2, 6)}`,
    name_is_explicit: Boolean(explicitName),
    git_root: git.gitRoot || input.worktree || undefined,
    git_branch: git.gitBranch ?? undefined,
  };
}

export default {
  id: "cct",

  async server(input: PluginInput): Promise<Hooks> {
    try {
      const directory = input.directory ?? "";
      const sessionKey = sanitizeInstanceKey(directory);
      if (!directory || !sessionKey) {
        log("no usable instance directory; plugin inert");
        return {};
      }

      const state: InstanceState = {
        input,
        directory,
        sessionKey,
        identity: null,
        registerBody: await buildRegisterBody(input, sessionKey),
        heartbeatTimer: null,
        stopped: false,
        loggedUnreachable: false,
      };

      // Fire-and-forget init: instance startup must never wait on the broker.
      // NOTE: unlike the MCP server.ts path, this plugin NEVER auto-launches a
      // broker. It is a guest inside the user's harness process; spawning
      // `npx tsx broker.ts` from here measurably wedges one-shot `opencode
      // run` sessions when the broker is down and the npm cache is cold
      // (probe4, 2026-10-02). If no broker is up, log once and let the
      // heartbeat tick retry — registration converges when one appears.
      void (async () => {
        try {
          await register(state);
        } catch (e) {
          log(`init failed (${String(e)}); retrying on next heartbeat`);
        }
      })();

      const interval = heartbeatMs();
      state.heartbeatTimer = setInterval(() => void tick(state), interval);
      try {
        state.heartbeatTimer.unref?.();
      } catch {}

      return {
        dispose: async () => {
          await shutdown(state, "dispose");
        },
      };
    } catch (e) {
      // Absolute fail-open: an inert plugin beats a broken instance.
      log(`plugin init error (${String(e)}); plugin inert`);
      return {};
    }
  },
};
