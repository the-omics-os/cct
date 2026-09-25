import { CCT_COMPACT_ACTIONS, type CompactActionDefinition } from "./constants.ts";

export const COMPACT_ACTION_NAMES = CCT_COMPACT_ACTIONS.map((entry) => entry.action);
const FIELD_ORDER = ["to", "message", "pool", "peer", "purpose", "text", "minutes", "reason", "force", "release_id", "vote", "service_id"];
const GLOBAL_FIELD_TYPES: Record<string, string> = Object.assign({}, ...CCT_COMPACT_ACTIONS.map((action) => action.types));
const ORDERED_FIELDS = [
  ...FIELD_ORDER.filter((field) => field in GLOBAL_FIELD_TYPES),
  ...Object.keys(GLOBAL_FIELD_TYPES).filter((field) => !FIELD_ORDER.includes(field)).sort(),
];
const ACTIONS_DESCRIPTION = "Action; inputs: send(to,message), status, peers, pools(pool?), create(pool,purpose?), join/leave(pool), invite(pool,peer), summary(text), idle(pool,minutes,reason?,force?), resume(pool), release(pool,peer,reason?), vote(release_id,vote), services(service_id?), terminate(reason; warning: this kills this agent's host session).";

export function buildCompactTool() {
  return {
    name: "cct",
    description: "Run CCT actions. Warning: this kills this agent's host session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: { type: "string" as const, enum: COMPACT_ACTION_NAMES, description: ACTIONS_DESCRIPTION },
        ...Object.fromEntries(ORDERED_FIELDS.map((field) => [field, field === "vote"
          ? { type: "string" as const, enum: ["yes", "no"] as const }
          : { type: GLOBAL_FIELD_TYPES[field] as "string" | "number" | "boolean" }])) ,
      },
      required: ["action"],
      additionalProperties: false,
    },
  };
}

export const CHECK_MESSAGES_TOOL = {
  name: "cct_check_messages",
  description: "Read unread CCT messages. Acknowledges the previous read on the next call.",
  inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
};

export function compactToolByteSizes(): { cct: number; total: number } {
  const cct = buildCompactTool();
  const check = CHECK_MESSAGES_TOOL;
  const size = (tool: typeof cct | typeof check, name: string) => Buffer.byteLength(JSON.stringify({
    name: tool.name,
    description: tool.description,
    input_schema: "inputSchema" in tool ? tool.inputSchema : {},
  }));
  const cctBytes = size(cct, "cct");
  return { cct: cctBytes, total: cctBytes + size(check, "cct_check_messages") };
}

const ACTION_LOOKUP = new Map<string, CompactActionDefinition>(CCT_COMPACT_ACTIONS.map((action) => [action.action, action]));

export function validateCompactArgs(value: unknown): { ok: true; action: CompactActionDefinition; args: Record<string, unknown> } | { ok: false; error: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Error: cct arguments must be a JSON object." };
  }
  const args = value as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(args, "action")) return { ok: false, error: "Error: cct requires field: action." };
  if (typeof args.action !== "string") return { ok: false, error: 'Error: cct field "action" must be string.' };
  const action = ACTION_LOOKUP.get(args.action);
  if (!action) return { ok: false, error: `Error: cct action "${args.action}" is invalid. Allowed actions: ${COMPACT_ACTION_NAMES.join(", ")}.` };

  const keys = Object.keys(args).filter((key) => key !== "action");
  const unknown = keys.filter((key) => !(key in GLOBAL_FIELD_TYPES)).sort();
  if (unknown.length) return { ok: false, error: `Error: cct received unknown field(s): ${unknown.join(", ")}.` };
  const allowed = new Set([...action.required, ...action.optional]);
  const irrelevant = keys.filter((key) => !allowed.has(key)).sort();
  if (irrelevant.length) return { ok: false, error: `Error: cct action "${action.action}" does not accept field(s): ${irrelevant.join(", ")}.` };
  const missing = action.required.filter((field) => !Object.prototype.hasOwnProperty.call(args, field)).sort();
  if (missing.length) return { ok: false, error: `Error: cct action "${action.action}" requires field(s): ${missing.join(", ")}.` };

  // Definition order is contract table order (required first, then optional).
  for (const field of [...action.required, ...action.optional]) {
    if (!Object.prototype.hasOwnProperty.call(args, field)) continue;
    const type = action.types[field];
    if (type === "vote") {
      if (args[field] !== "yes" && args[field] !== "no") return { ok: false, error: 'Error: cct field "vote" must be "yes" or "no".' };
    } else if (type === "number") {
      if (field === "minutes") {
        const minutes = args[field];
        if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0 || minutes > 120) {
          return { ok: false, error: 'Error: cct field "minutes" must be a finite number greater than 0 and at most 120.' };
        }
      } else if (typeof args[field] !== "number") {
        return { ok: false, error: `Error: cct field "${field}" must be number.` };
      }
    } else if (typeof args[field] !== type) {
      return { ok: false, error: `Error: cct field "${field}" must be ${type}.` };
    }
  }
  return { ok: true, action, args };
}

export function mapCompactAction(action: CompactActionDefinition, args: Record<string, unknown>): { handler: string; args: Record<string, unknown> } {
  const handlerArgs: Record<string, unknown> = {};
  for (const [input, output] of Object.entries(action.handlerArgs)) {
    if (Object.prototype.hasOwnProperty.call(args, input)) handlerArgs[output] = args[input];
  }
  if (action.action === "pools") return { handler: args.pool === undefined ? "listPools" : "poolStatus", args: args.pool === undefined ? {} : { pool_name: args.pool } };
  return { handler: action.handler, args: handlerArgs };
}

export async function dispatchCompactAction(
  value: unknown,
  handlers: Record<string, (args: Record<string, unknown>) => Promise<string> | string>,
): Promise<{ text: string; isError: boolean }> {
  const validated = validateCompactArgs(value);
  if (!validated.ok) return { text: validated.error, isError: true };
  const mapped = mapCompactAction(validated.action, validated.args);
  const handler = handlers[mapped.handler];
  if (!handler) throw new Error(`Missing compact handler: ${mapped.handler}`);
  return { text: await handler(mapped.args), isError: false };
}

const TOOL_ACTION: Record<string, string> = {
  cct_check_messages: "cct_check_messages",
  cct_whoami: 'cct action="status"',
  cct_send_message: 'cct action="send"',
  cct_list_peers: 'cct action="peers"',
  cct_list_pools: 'cct action="pools"',
  cct_create_pool: 'cct action="create"',
  cct_join_pool: 'cct action="join"',
  cct_leave_pool: 'cct action="leave"',
  cct_invite_to_pool: 'cct action="invite"',
  cct_set_summary: 'cct action="summary"',
  cct_pool_status: 'cct action="pools"',
  cct_list_services: 'cct action="services"',
  cct_propose_release: 'cct action="release"',
  cct_vote_release: 'cct action="vote"',
  cct_set_pool_idle: 'cct action="idle"',
  cct_clear_pool_idle: 'cct action="resume"',
  cct_self_terminate: 'cct action="terminate"',
};
export function toolRef(legacyName: string, surface: "legacy" | "compact", detail?: string): string {
  if (surface === "legacy") return legacyName;
  const label = TOOL_ACTION[legacyName] ?? legacyName;
  if (legacyName === "cct_check_messages" || detail === undefined) return label;
  return `${label} (${detail})`;
}

export interface CompactStatusPool {
  name: string;
  purpose: string;
  status: string;
  idle_until?: string | null;
  members: { peer_name: string; peer_id: string }[];
}
export interface CompactStatusInput {
  id: string;
  name: string;
  runtime: string;
  keySource: string;
  pools: CompactStatusPool[];
  unread: number;
  unreadByPool: { pool_name: string | null; count: number }[];
  poolThrottles?: { pool_name: string; idle_until: string }[];
}
export function formatCompactStatus(input: CompactStatusInput): string {
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const throttleMap = new Map((input.poolThrottles ?? []).map((item) => [item.pool_name, item.idle_until]));
  const pools = [...input.pools].sort((a, b) => compare(a.name, b.name));
  const lines = [`you: ${input.id}/${input.name} runtime=${input.runtime} key=${input.keySource}`, `pools (${pools.length}):`];
  for (const pool of pools) {
    const sortedMembers = [...pool.members].sort((a, b) => compare(a.peer_name, b.peer_name) || compare(a.peer_id, b.peer_id));
    const shown = sortedMembers.slice(0, 20).map((member) => `${member.peer_name}/${member.peer_id}`);
    const hidden = sortedMembers.length - shown.length;
    if (hidden > 0) shown.push(`+${hidden} more`);
    const idleUntil = throttleMap.get(pool.name) ?? pool.idle_until;
    const idle = idleUntil && new Date(idleUntil).getTime() > 0 ? `until ${idleUntil}` : "active";
    lines.push(`- ${pool.name} | purpose: ${pool.purpose || "(none)"} | idle: ${idle} | members: ${shown.join(", ")}`);
  }
  lines.push(`unread: ${input.unread}`);
  const unreadPools = input.unreadByPool.filter((item) => item.count > 0).sort((a, b) => compare(a.pool_name ?? "DM", b.pool_name ?? "DM"));
  if (unreadPools.length) lines.push(`unread by pool: ${unreadPools.map((item) => `${item.pool_name ?? "DM"}:${item.count}`).join(", ")}`);
  return lines.join("\n");
}
