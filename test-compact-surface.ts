import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { DatabaseSync } from "node:sqlite";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CCT_COMPACT_ACTIONS, type CompactActionDefinition } from "./shared/constants.ts";
import {
  buildCompactTool,
  CHECK_MESSAGES_TOOL,
  compactToolByteSizes,
  dispatchCompactAction,
  formatCompactStatus,
  mapCompactAction,
  toolRef,
  validateCompactArgs,
} from "./shared/compact.ts";

let passed = 0;
const tests: Promise<void>[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push(Promise.resolve().then(fn).then(() => {
    passed++;
    console.log(`  PASS: ${name}`);
  }));
}
function validArgs(action: CompactActionDefinition): Record<string, unknown> {
  const args: Record<string, unknown> = { action: action.action };
  for (const field of action.required) args[field] = field === "minutes" ? 10 : field === "force" ? false : field === "vote" ? "yes" : `${field}-value`;
  return args;
}

console.log("=== Compact surface unit tests ===");
for (const entry of CCT_COMPACT_ACTIONS) {
  const action: CompactActionDefinition = entry;
  const args = validArgs(action);
  test(`${action.action}: valid fields accepted`, () => assert.equal(validateCompactArgs(args).ok, true));
  if (action.required.length) {
    const missing = { ...args };
    for (const field of action.required) delete missing[field];
    const result = validateCompactArgs(missing);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, `cct action "${action.action}" requires field(s): ${[...action.required].sort().join(", ")}.`);
    passed++;
    console.log(`  PASS: ${action.action}: required fields enforced`);
  }
  const globalFields = [...new Set(CCT_COMPACT_ACTIONS.flatMap((entry) => [...entry.required, ...entry.optional]))];
  const disallowed = globalFields.find((field) => !action.required.includes(field) && !action.optional.includes(field));
  if (disallowed) {
    const result = validateCompactArgs({ ...args, [disallowed]: "irrelevant" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, `cct action "${action.action}" does not accept field(s): ${disallowed}.`);
    passed++;
    console.log(`  PASS: ${action.action}: irrelevant fields rejected`);
  }
  const unknownResult = validateCompactArgs({ ...args, unknown_compact_field: "x" });
  assert.equal(unknownResult.ok, false);
  if (!unknownResult.ok) assert.equal(unknownResult.error, "cct received unknown field(s): unknown_compact_field.");
  passed++;
  console.log(`  PASS: ${action.action}: unknown fields rejected`);
  for (const [field, type] of Object.entries(action.types)) {
    const wrong = type === "vote" ? "maybe" : type === "number" ? "wrong" : type === "boolean" ? "wrong" : { bad: true };
    const result = validateCompactArgs({ ...args, [field]: wrong });
    assert.equal(result.ok, false);
    if (!result.ok) {
      const expected = type === "vote"
        ? 'cct field "vote" must be "yes" or "no".'
        : field === "minutes"
          ? 'cct field "minutes" must be a finite number greater than 0 and at most 120.'
          : `cct field "${field}" must be ${type}.`;
      assert.equal(result.error, expected);
    }
    passed++;
    console.log(`  PASS: ${action.action}: ${field} type/enum checked`);
  }
}

test("root/action validation error precedence and exact messages", () => {
  assert.equal(validateCompactArgs(null).ok, false);
  assert.deepEqual(validateCompactArgs(null), { ok: false, error: "cct arguments must be a JSON object." });
  assert.deepEqual(validateCompactArgs({}), { ok: false, error: "cct requires field: action." });
  assert.deepEqual(validateCompactArgs({ action: 1 }), { ok: false, error: 'cct field "action" must be string.' });
  assert.deepEqual(validateCompactArgs({ action: "bad" }), { ok: false, error: 'cct action "bad" is invalid. Allowed actions: send, status, peers, pools, create, join, leave, invite, summary, idle, resume, release, vote, services, terminate.' });
  assert.deepEqual(validateCompactArgs({ action: "send", z: 1, pool: "bad" }), { ok: false, error: "cct received unknown field(s): z." });
  assert.deepEqual(validateCompactArgs({ action: "send", to: 42, purpose: "bad" }), { ok: false, error: 'cct action "send" does not accept field(s): purpose.' });
  assert.deepEqual(validateCompactArgs({ action: "send", to: 42 }), { ok: false, error: 'cct action "send" requires field(s): message.' });
  const wrongAction = validateCompactArgs({ action: "idle", pool: "p", minutes: "2" });
  assert.deepEqual(wrongAction, { ok: false, error: 'cct field "minutes" must be a finite number greater than 0 and at most 120.' });
});

test("unknown and irrelevant field names sort lexicographically", () => {
  assert.deepEqual(validateCompactArgs({ action: "send", x: 1, z: 2 }), { ok: false, error: "cct received unknown field(s): x, z." });
  assert.deepEqual(validateCompactArgs({ action: "send", purpose: "p", pool: "p" }), { ok: false, error: 'cct action "send" does not accept field(s): pool, purpose.' });
});

test("minutes accepts positive finite numbers through 120 and rejects boundaries", () => {
  for (const minutes of [0, -1, 121, Infinity, NaN, "2"]) {
    const result = validateCompactArgs({ action: "idle", pool: "p", minutes });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, 'cct field "minutes" must be a finite number greater than 0 and at most 120.');
  }
  assert.equal(validateCompactArgs({ action: "idle", pool: "p", minutes: 0.5 }).ok, true);
  assert.equal(validateCompactArgs({ action: "idle", pool: "p", minutes: 120 }).ok, true);
});

test("vote enum exact message", () => {
  assert.deepEqual(validateCompactArgs({ action: "vote", release_id: "x", vote: "maybe" }), { ok: false, error: 'cct field "vote" must be "yes" or "no".' });
});

test("compact schema derives actions and field types from the action table", () => {
  const schema = buildCompactTool().inputSchema;
  assert.deepEqual(schema.properties.action.enum, CCT_COMPACT_ACTIONS.map((entry) => entry.action));
  const tableFields = [...new Set(CCT_COMPACT_ACTIONS.flatMap((entry) => [...entry.required, ...entry.optional]))].sort();
  assert.deepEqual(Object.keys(schema.properties).filter((field) => field !== "action").sort(), tableFields);
  assert.deepEqual(schema.required, ["action"]);
  assert.equal(schema.additionalProperties, false);
  for (const entry of CCT_COMPACT_ACTIONS) {
    for (const [field, type] of Object.entries(entry.types)) {
      const property = schema.properties[field as keyof typeof schema.properties] as { type?: string; enum?: readonly string[] };
      assert.equal(property.type, type === "vote" ? "string" : type);
      if (type === "vote") assert.deepEqual(property.enum, ["yes", "no"]);
    }
  }
});

test("compact tool schema byte budgets", () => {
  const sizes = compactToolByteSizes();
  assert.ok(sizes.cct <= 2000, `cct schema ${sizes.cct} exceeds 2000 bytes`);
  assert.ok(sizes.total <= 2500, `combined schemas ${sizes.total} exceeds 2500 bytes`);
  assert.doesNotMatch(buildCompactTool().description, /kills|terminate/i);
  assert.match(buildCompactTool().inputSchema.properties.action.description, /terminate\(reason; ends this agent's own host session\)/);
  assert.equal("required" in CHECK_MESSAGES_TOOL.inputSchema, false);
});

test("every action maps to its declared handler arguments through mocked handlers", async () => {
  const captures: { handler: string; args: Record<string, unknown> }[] = [];
  const handlers: Record<string, (args: Record<string, unknown>) => string> = {};
  for (const entry of CCT_COMPACT_ACTIONS) {
    const action: CompactActionDefinition = entry;
    for (const handlerName of [action.handler, "listPools", "poolStatus"]) handlers[handlerName] = (args) => {
      captures.push({ handler: handlerName, args });
      return handlerName;
    };
    const args = { ...validArgs(action), ...Object.fromEntries(action.optional.map((field) => [field, action.types[field] === "number" ? 5 : action.types[field] === "boolean" ? true : action.types[field] === "vote" ? "no" : `${field}-optional`])) };
    const mapping = mapCompactAction(action, args);
    const result = await dispatchCompactAction(args, handlers);
    assert.equal(result.isError, false);
    assert.equal(result.text, mapping.handler);
    const captured = captures.at(-1)!;
    assert.equal(captured.handler, mapping.handler);
    assert.deepEqual(captured.args, mapping.args);
    const expected: Record<string, unknown> = {};
    for (const [input, output] of Object.entries(action.handlerArgs)) if (input in args) expected[output] = args[input];
    if (action.action === "pools") {
      assert.equal(mapping.handler, "poolStatus");
      assert.deepEqual(mapping.args, { pool_name: args.pool });
    } else assert.deepEqual(mapping.args, expected);
  }
  const pools = CCT_COMPACT_ACTIONS.find((action) => action.action === "pools")!;
  assert.deepEqual(mapCompactAction(pools, { action: "pools" }), { handler: "listPools", args: {} });
});

test("status formatter handles zero pools and omits empty unread breakdown", () => {
  assert.equal(formatCompactStatus({ id: "id", name: "me", runtime: "os", keySource: "marker", pools: [], unread: 0, unreadByPool: [] }),
    "you: id/me runtime=os key=marker\npools (0):\nunread: 0");
});

test("status formatter sorts one pool, members and unread breakdown, and renders idle timestamp", () => {
  const out = formatCompactStatus({
    id: "id", name: "me", runtime: "os", keySource: "marker", unread: 3,
    pools: [{ name: "zeta", purpose: "", status: "active", members: [{ peer_name: "Zed", peer_id: "z" }, { peer_name: "Amy", peer_id: "a" }] }],
    unreadByPool: [{ pool_name: "zeta", count: 2 }, { pool_name: "alpha", count: 1 }],
    poolThrottles: [{ pool_name: "zeta", idle_until: "2099-01-01T00:00:00.000Z" }],
  });
  assert.equal(out, "you: id/me runtime=os key=marker\npools (1):\n- zeta | purpose: (none) | idle: until 2099-01-01T00:00:00.000Z | members: Amy/a, Zed/z\nunread: 3\nunread by pool: alpha:1, zeta:2");
});

test("status formatter caps members at 20 and reports exact overflow", () => {
  const members = Array.from({ length: 25 }, (_, i) => ({ peer_name: `peer-${String(i).padStart(2, "0")}`, peer_id: `id-${String(i).padStart(2, "02")}` }));
  const out = formatCompactStatus({ id: "me", name: "self", runtime: "os", keySource: "marker", pools: [{ name: "p", purpose: "test", status: "active", members }], unread: 0, unreadByPool: [] });
  assert.match(out, /members: peer-00\/id-00, peer-01\/id-01/);
  assert.match(out, /peer-19\/id-19, \+5 more/);
  assert.doesNotMatch(out, /peer-20\/id-20/);
});

test("toolRef is byte-preserving for legacy and maps every tool in compact", () => {
  for (const action of CCT_COMPACT_ACTIONS) {
    const legacyTools = Array.isArray(action.legacyTool) ? action.legacyTool : [action.legacyTool];
    for (const name of legacyTools) {
      assert.equal(toolRef(name, "legacy"), name);
      if (name !== "cct_check_messages") assert.match(toolRef(name, "compact"), /^cct action=/);
    }
  }
  assert.equal(toolRef("cct_check_messages", "compact"), "cct_check_messages");
});

async function compactIntegration() {
  const broker = process.env.CCT_BROKER ?? `http://127.0.0.1:${process.env.CCT_PORT ?? "17888"}`;
  const post = async (path: string, body: Record<string, unknown>) => {
    const response = await fetch(`${broker}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json() as any;
    assert.equal(data.ok, true, `${path}: ${data.error}`);
    return data.data;
  };
  const start = String(Date.now());
  const owner = await post("/register", { pid: process.pid, pid_start: start, host_pid: process.pid, host_pid_start: start, runtime: "claude", session_key: `compact-test-${start}`, cwd: process.cwd(), name: `compact-owner-${start}`, name_is_explicit: true });
  let transport: StdioClientTransport | undefined;
  let client: Client | undefined;
  try {
    const joinPool = `compact-join-${start}`;
    await post("/pool/create", { peer_id: owner.id, peer_secret: owner.secret, name: joinPool, purpose: "join target" });
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    env.CCT_TOOL_SURFACE = "compact";
    env.CCT_RUNTIME = "os";
    env.CCT_BROKER = broker;
    env.CCT_PORT = process.env.CCT_PORT ?? "17888";
    env.CCT_DIR = process.env.CCT_DIR!;
    env.CCT_TOKEN = "";
    transport = new StdioClientTransport({ command: "npx", args: ["tsx", resolve("server.ts")], env });
    client = new Client({ name: "compact-surface-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), ["cct_check_messages", "cct"]);
    const call = async (args: Record<string, unknown>) => {
      const result: any = await client!.callTool({ name: "cct", arguments: args });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      return (result.content?.[0] as { text?: string })?.text ?? "";
    };
    const pool = `compact-created-${start}`;
    const createText = await call({ action: "create", pool, purpose: "compact integration" });
    assert.match(createText, /created/);
    const joinText = await call({ action: "join", pool: joinPool });
    assert.match(joinText, /Joined pool/);
    const inviteText = await call({ action: "invite", pool, peer: owner.name });
    assert.match(inviteText, /Invited/);
    const poolsText = await call({ action: "pools" });
    assert.match(poolsText, new RegExp(pool));
    const detailText = await call({ action: "pools", pool });
    assert.match(detailText, new RegExp(`Pool: ${pool}`));
    const statusText = await call({ action: "status" });
    assert.match(statusText, /you: .+\/os-/);
    assert.match(statusText, new RegExp(pool));
    const identityLine = statusText.split("\n", 1)[0];
    const identity = /^you: ([^/]+)\/([^ ]+)/.exec(identityLine);
    assert.ok(identity, "compact status has an identity header");
    assert.match(statusText, new RegExp(`${owner.name}\\/${owner.id}`), "status pool members include peer name/id pairs");
    const identityPeer = (await post("/list-peers", {})).find((peer: any) => peer.id === identity[1]);
    assert.ok(identityPeer, "status identity must be a registered peer");
    assert.match(identityLine, new RegExp(`${identityPeer.id}\\/${identityPeer.name}`));
    const identityHeader = identityLine.split(" runtime=")[0];
    const checked = await client.callTool({ name: "cct_check_messages", arguments: {} }) as any;
    assert.ok((checked.content?.[0]?.text ?? "").startsWith(`${identityHeader}\n`), "check_messages must start with id/name identity header");
    // Regression (live os test 2026-09-25): a batch returned by check_messages is
    // pending ack until the next check, and status must not report it as unread.
    await post("/message/send", { peer_id: owner.id, peer_secret: owner.secret, to_peer_id: identityPeer.id, body: `status-unread-${start}` });
    assert.match(await call({ action: "status" }), /\nunread: 1\nunread by pool: DM:1$/);
    const readBatch = await client.callTool({ name: "cct_check_messages", arguments: {} }) as any;
    assert.match(readBatch.content?.[0]?.text ?? "", new RegExp(`status-unread-${start}`));
    const afterRead = await call({ action: "status" });
    assert.match(afterRead, /\nunread: 0$/, `status after check must exclude the pending-ack batch: ${afterRead}`);
    const sent = `compact-message-${start}`;
    const sendText = await call({ action: "send", to: `@${pool}`, message: sent });
    assert.match(sendText, /Sent to pool/);
    const directed = `compact-directed-${start}`;
    assert.match(await call({ action: "send", to: `@${pool}/${owner.name}`, message: directed }), /Sent directed message/);
    const dm = `compact-dm-${start}`;
    assert.match(await call({ action: "send", to: owner.name, message: dm }), /DM sent/);
    const members = await post("/pool/status", { pool_name: pool });
    assert.ok(members.members.some((member: any) => member.peer_id === owner.id), "invite must create owner membership");
    const delivered = await post("/message/poll", { peer_id: owner.id });
    for (const expected of [sent, directed, dm]) assert.ok(delivered.some((message: any) => message.body === expected), `compact send did not deliver ${expected}`);

    // Preserve established stale-recipient and ambiguous-prefix handling through compact actions.
    const registerPeer = async (name: string) => post("/register", { pid: process.pid, pid_start: `${Date.now()}-${Math.random()}`, host_pid: process.pid, host_pid_start: `${Date.now()}-${Math.random()}`, runtime: "claude", session_key: `compact-extra-${name}-${start}`, cwd: process.cwd(), name, name_is_explicit: true });
    await registerPeer(`ambig-${start}-alpha`);
    await registerPeer(`ambig-${start}-alpine`);
    const ambiguous = await client.callTool({ name: "cct", arguments: { action: "send", to: `ambig-${start}-al`, message: "must not deliver" } }) as any;
    assert.match(String(ambiguous.content?.[0]?.text ?? ""), /Ambiguous match/);
    const stale = await registerPeer(`stale-compact-${start}`);
    const db = new DatabaseSync(process.env.CCT_DIR + "/cct.db");
    db.prepare("UPDATE peers SET last_seen=? WHERE id=?").run(new Date(Date.now() - 3600_000).toISOString(), stale.id);
    const peersText = await call({ action: "peers" });
    assert.match(peersText, new RegExp(`stale-compact-${start}`));
    const staleSend = await call({ action: "send", to: stale.name, message: `stale-dm-${start}` });
    assert.match(staleSend, /WARNING: 1 recipient/);
    db.close();

    console.log("  PASS: compact MCP integration (status identity/member pairs; pool, directed and DM effects; stale and ambiguous recipients)");
    passed++;
  } finally {
    await client?.close().catch(() => undefined);
    await transport?.close().catch(() => undefined);
    await post("/unregister", { peer_id: owner.id, peer_secret: owner.secret, pid: process.pid, pid_start: start }).catch(() => undefined);
  }

  // Preserve a compact-json snapshot of the legacy list (baseline.json values;
  // check_messages is the intentional A5 description change).
  const legacySizes: Record<string, number> = {
    cct_check_messages: 169, cct_whoami: 208, cct_send_message: 736, cct_list_peers: 175,
    cct_list_pools: 138, cct_create_pool: 275, cct_join_pool: 207, cct_leave_pool: 200,
    cct_invite_to_pool: 300, cct_set_summary: 223, cct_pool_status: 236, cct_list_services: 243,
    cct_propose_release: 514, cct_vote_release: 460, cct_set_pool_idle: 750,
    cct_clear_pool_idle: 275, cct_self_terminate: 314,
  };
  const expectedNames = Object.keys(legacySizes);
  const legacyEnv = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  legacyEnv.CCT_TOOL_SURFACE = "legacy";
  legacyEnv.CCT_RUNTIME = "os";
  legacyEnv.CCT_BROKER = broker;
  legacyEnv.CCT_PORT = process.env.CCT_PORT ?? "17888";
  legacyEnv.CCT_DIR = process.env.CCT_DIR!;
  legacyEnv.CCT_TOKEN = "";
  const legacyTransport = new StdioClientTransport({ command: "npx", args: ["tsx", resolve("server.ts")], env: legacyEnv });
  const legacyClient = new Client({ name: "legacy-snapshot-test", version: "1.0.0" }, { capabilities: {} });
  try {
    await legacyClient.connect(legacyTransport);
    const legacyTools = (await legacyClient.listTools()).tools;
    assert.deepEqual(legacyTools.map((tool) => tool.name), expectedNames);
    for (const tool of legacyTools) {
      const bytes = Buffer.byteLength(JSON.stringify({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }));
      assert.equal(bytes, legacySizes[tool.name], `${tool.name} legacy snapshot size changed`);
    }
    assert.equal(legacyTools[0].description, CHECK_MESSAGES_TOOL.description);
    assert.equal(legacyTools.find((tool) => tool.name === "cct_send_message")?.description,
      'Send a message. Use "@<pool-name>" for a pool broadcast (for example, "@reachability-fix"), "@<pool-name>/<peer-name-or-id>" for a pool-scoped directed message, or "<peer-name-or-id>" for a private DM. Replace placeholders with actual names; "pool" is not a literal address.');
    console.log("  PASS: legacy MCP snapshot (17 names/sizes; A5 description is the sole intended change)");
    passed++;
  } finally {
    await legacyClient.close().catch(() => undefined);
    await legacyTransport.close().catch(() => undefined);
  }
}

await Promise.all(tests);
if (process.argv.includes("--integration")) {
  await compactIntegration();
}
console.log(`Compact tests: ${passed} passed`);
