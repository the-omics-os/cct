// Private HOME + synthetic verified adapter; no broker, model, live configs or
// third-party source edits. Optional installed-host checks: CCT_OS_DIST=/.../dist.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import extension, { wrapOsAdapterApi } from "./os-mcp-extension.ts";
import { decorateCctTool } from "./shared/os-cct-send-renderer.ts";
import { osAdapterConfigPath } from "./shared/os-adapter-config.ts";

let passed = 0;
async function test(label: string, run: () => unknown | Promise<unknown>) {
  await run(); passed++; console.log("PASS " + label);
}
const plain = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text };
const colored = {
  fg(color: string, text: string) { assert.equal(color, "text"); return `\x1b[38;2;31;35;40m${text}\x1b[39m`; },
  bg(color: string, text: string) { assert.equal(color, "customMessageBg"); return `\x1b[48;2;246;248;250m${text}\x1b[49m`; },
};
const args = { action: "send", to: "reviewer", message: "hello\nsecond line" };
const options = { expanded: false, isPartial: false };
const result = (text = 'DM sent to "reviewer".', details: any = { server: "cct", tool: "cct" }) =>
  ({ content: [{ type: "text", text }], details });
const callFallback = new Text("original call", 0, 0), resultFallback = new Text("original result", 0, 0);
const calls: any[][] = [], results: any[][] = [];
const original = {
  name: "cct", label: "CCT", description: "original description", renderShell: "self",
  parameters: Object.freeze({ type: "object" }), promptSnippet: "original snippet", promptGuidelines: ["original guideline"],
  prepareArguments(input: unknown) { return input; },
  async execute(...input: unknown[]) { return input; },
  renderCall(this: unknown, ...input: any[]) { assert.equal(this, original); calls.push(input); return callFallback; },
  renderResult(this: unknown, ...input: any[]) { assert.equal(this, original); results.push(input); return resultFallback; },
};
const tool = decorateCctTool(original);
function row(input: any = args): any {
  const context = { isError: false, isPartial: true, args: input, state: {} };
  tool.renderCall(input, plain, context); return context;
}
function view(component: Component, width = 120): string {
  return component.render(width).map(line => stripVTControlCharacters(line).trimEnd()).join("\n");
}
function output(text = 'DM sent to "reviewer".', context = row(), details?: any, expanded = false): string {
  return view(tool.renderResult(result(text, details), { ...options, expanded }, plain, context));
}

const home = mkdtempSync(join(tmpdir(), "cct-mcp-wrapper-"));
const saved = new Map(["HOME", "OS_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR", "CCT_DIR"].map(key => [key, process.env[key]]));
process.env.HOME = home;
process.env.OS_CODING_AGENT_DIR = join(home, ".os", "agent");
process.env.PI_CODING_AGENT_DIR = process.env.OS_CODING_AGENT_DIR;
process.env.CCT_DIR = join(home, ".cct");
const factorySource = `
const fallback = { render: () => ["factory fallback"], invalidate() {} };
const execute = async (...args) => args;
export const original = { name: "cct", description: "fixture", label: "CCT", parameters: { type: "object" },
  promptSnippet: "fixture snippet", promptGuidelines: ["Use cct"], prepareArguments: input => input,
  renderShell: "self", execute, renderCall() { return fallback; }, renderResult() { return fallback; } };
export const other = { ...original, name: "fixture_other" };
export default async function factory(pi) {
  pi.events.emit("fixture-reference", { original, other, pi });
  pi.events.emit("fixture-registration-return", pi.registerTool(original));
  await new Promise(resolve => setTimeout(resolve, 1));
  pi.registerTool(other);
  pi.on("session_start", () => pi.registerTool(original));
  pi.registerCommand("fixture-repeat", { handler: () => pi.registerTool(original) });
  pi.events.emit("fixture-ready", true);
}
`;
function configure(source = factorySource, directory = "pi-mcp-adapter-2.33.0"): string {
  const packageDir = join(home, directory), path = join(packageDir, "index.ts");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "pi-mcp-adapter", version: "2.33.0", type: "module" }));
  writeFileSync(path, source);
  mkdirSync(dirname(osAdapterConfigPath()), { recursive: true });
  writeFileSync(osAdapterConfigPath(), JSON.stringify({ version: 1, adapterEntry: packageDir, adapterPath: realpathSync(path) }));
  return path;
}
try {
  await test("only CCT rendering changes; original definition and all execution/prompt fields stay intact", () => {
    assert.notEqual(tool, original);
    for (const key of Object.keys(original).filter(key => !["renderCall", "renderResult"].includes(key))) {
      assert.equal((tool as any)[key], (original as any)[key], key);
    }
    assert.equal(original.renderCall.call(original), callFallback);
    assert.equal(original.renderResult.call(original), resultFallback);
    assert.notEqual(tool.renderCall, original.renderCall); assert.notEqual(tool.renderResult, original.renderResult);
  });
  await test("non-CCT tool definitions pass through by exact identity", () => {
    for (const name of ["other", "cct_send_message", "cct_cct", "mcp", "mcpScript", "cct_check_messages"]) {
      const definition = { ...original, name }; assert.equal(decorateCctTool(definition), definition);
    }
  });
  await test("API proxy binds all functions to the real target, retaining objects and forwarding symbols", () => {
    const bus = {}, symbol = Symbol("api");
    const api = { bus, number: 3, [symbol](this: unknown) { assert.equal(this, api); return bus; },
      method(this: unknown, ...input: unknown[]) { assert.equal(this, api); return input; },
      get receiver() { assert.equal(this, api); return bus; } };
    const proxy = wrapOsAdapterApi(api), method = proxy.method;
    assert.equal(proxy.bus, bus); assert.equal(proxy.receiver, bus); assert.equal(proxy.number, 3);
    assert.deepEqual(method(1, bus), [1, bus]); assert.equal(proxy[symbol](), bus);
    assert.equal(Object.getPrototypeOf(proxy), Object.getPrototypeOf(api));
  });
  await test("registerTool retains receiver, exact return value and non-CCT identity", () => {
    const token = Object.freeze({ registered: true }), seen: unknown[] = [];
    const api = { registerTool(this: unknown, definition: unknown, extra: unknown) {
      assert.equal(this, api); seen.push(definition, extra); return token;
    } };
    const proxy = wrapOsAdapterApi(api), extra = {};
    assert.equal(proxy.registerTool(original, extra), token); assert.equal((seen[0] as any).execute, original.execute);
    assert.equal(seen[1], extra);
    const other = { ...original, name: "other" };
    assert.equal(proxy.registerTool(other, extra), token); assert.equal(seen[2], other);
  });
  await test("async default factory awaits import + original initialization and intercepts later/repeated registrations", async () => {
    configure(); const definitions: any[] = [], events = new Map<string, any>(), handlers = new Map<string, any>();
    const commands = new Map<string, any>(), token = {};
    const api = {
      events: { emit(name: string, value: any) { events.set(name, value); } },
      registerTool(this: unknown, definition: unknown) { assert.equal(this, api); definitions.push(definition); return token; },
      on(this: unknown, event: string, callback: any) { assert.equal(this, api); handlers.set(event, callback); },
      registerCommand(this: unknown, name: string, command: any) { assert.equal(this, api); commands.set(name, command); },
    };
    const promise = extension(api); assert.ok(promise instanceof Promise); assert.equal(events.get("fixture-ready"), undefined);
    await promise; assert.equal(events.get("fixture-ready"), true); assert.equal(events.get("fixture-registration-return"), token);
    const fixture = events.get("fixture-reference"); assert.equal(fixture.pi.events, api.events);
    assert.equal(definitions.length, 2); assert.notEqual(definitions[0], fixture.original);
    assert.equal(definitions[0].execute, fixture.original.execute); assert.equal(definitions[1], fixture.other);
    handlers.get("session_start")(); commands.get("fixture-repeat").handler();
    assert.equal(definitions.length, 4);
    for (const index of [0, 2, 3]) {
      const definition = definitions[index]; assert.equal(definition.execute, fixture.original.execute);
      assert.match(view(definition.renderCall(args, plain, { isPartial: true, state: {} })), /Sending…/);
    }
  });
  await test("wrapper does not touch executor arguments, updates, signals, context or returned result", async () => {
    const input = Object.freeze({ ...args }), response = Object.freeze(result()), signal = new AbortController().signal, context = {};
    let seen: unknown[] = [];
    const onUpdate = (update: unknown) => assert.equal(update, response);
    const definition = { ...original, async execute(...received: unknown[]) { seen = received; onUpdate(response); return response; } };
    const decorated = decorateCctTool(definition);
    assert.equal(decorated.execute, definition.execute);
    assert.equal(await decorated.execute("id", input, signal, onUpdate, context), response);
    assert.deepEqual(seen, ["id", input, signal, onUpdate, context]); assert.equal(seen[1], input); assert.equal(seen[4], context);
  });
  await test("configuration errors and invalid/missing default factories fail closed", async () => {
    writeFileSync(osAdapterConfigPath(), "{}"); await assert.rejects(extension({}), /Invalid CCT adapter state/);
    configure("export default 42;", "pi-mcp-adapter-invalid"); await assert.rejects(extension({}), /no default factory/);
    configure("throw new Error('fixture import failure');", "pi-mcp-adapter-import-failure");
    await assert.rejects(extension({}), /fixture import failure/);
    configure("export default async function () { throw new Error('fixture factory failure'); }", "pi-mcp-adapter-factory-failure");
    await assert.rejects(extension({}), /fixture factory failure/);
  });
  await test("pending shows target + full body + Sending, with explicit foreground/background", () => {
    const lines = tool.renderCall(args, colored, { isPartial: true, state: {} }).render(80);
    assert.equal(view(tool.renderCall(args, plain, { state: {} })), "CCT → reviewer\nhello\nsecond line\nSending…");
    for (const line of lines) { assert.ok(line.includes("\x1b[38;2;31;35;40m")); assert.ok(line.includes("\x1b[48;2;246;248;250m")); assert.equal(visibleWidth(line), 80); }
    assert.ok(!lines.join("\n").includes("✓ Sent"));
  });
  for (const expanded of [false, true]) await test(`one final card, empty call/partial-result slots, expanded=${expanded}`, () => {
    const context = { ...row(), isPartial: false, expanded };
    assert.deepEqual(tool.renderCall(args, colored, context).render(100), []);
    assert.deepEqual(tool.renderResult(result(), { expanded, isPartial: true }, colored, context).render(100), []);
    assert.equal(view(tool.renderResult(result(), { expanded, isPartial: false }, colored, context)), "CCT → reviewer\nhello\nsecond line\n✓ Sent");
  });
  for (const [to, text] of [
    ["@team", 'Sent to pool "team" (3 recipients, 2 live).'], ["@team", 'Sent to pool "team" (0 recipients, 0 live).'],
    ["@team/reviewer", 'Sent directed message in pool "team" to "reviewer".'],
    ["@team/reviewer/id", 'Sent directed message in pool "team" to "reviewer/id".'],
    ["reviewer/id", 'DM sent to "reviewer/id".'],
  ]) await test(`known direct confirmation for ${to}: ${text}`, () => {
    assert.equal(output(text, row({ ...args, to })), `CCT → ${to}\nhello\nsecond line\n✓ Sent`);
  });
  await test("confirmed send preserves full offline warning, never claims read/receipt", () => {
    const warning = '\n\n⚠️ WARNING: 1 recipient(s) may be OFFLINE and unlikely to respond:\n  - reviewer (last seen 90s ago)\nDo NOT wait for a reply.';
    assert.equal(output(`DM sent to "reviewer".${warning}`), `CCT → reviewer\nhello\nsecond line\n✓ Sent\n${warning.trim()}`);
  });
  for (const text of ["Error: bad input", "Failed to send: broker unavailable"]) await test(`honest failure: ${text}`, () => {
    assert.ok(output(text).includes(`✗ Send failed\n${text}`)); assert.ok(!output(text).includes("✓ Sent"));
  });
  await test("host/adapter/result errors override confirmation and retain full error text", () => {
    for (const context of [row(), { ...row(), isError: true }]) {
      const text = output(undefined, context, { server: "cct", tool: "cct", error: "tool_error" });
      assert.ok(text.includes("✗ Send failed")); assert.ok(text.includes("Error: tool_error")); assert.ok(!text.includes("✓ Sent"));
    }
    assert.ok(output(undefined, { ...row(), isError: true }).includes("✗ Send failed"));
    assert.ok(view(tool.renderResult({ ...result(), isError: true }, options, plain, row())).includes("✗ Send failed"));
    const text = output("Error: denied\nline 2\nline 3\nline 4", { ...row(), isPartial: false, isError: true }, {}, true);
    assert.ok(text.includes("line 4")); assert.ok(!text.includes("Ctrl+O"));
  });
  for (const text of ["", "ok", "sent", '{"ok":true}', 'DM sent to "elsewhere".',
    'DM sent to "reviewer". unexpected tail', 'DM sent to "reviewer".\nError: failure', 'Peer "reviewer" not found.']) {
    await test(`unknown result is not Sent: ${JSON.stringify(text)}`, () => {
      const rendered = output(text); assert.ok(rendered.includes("Send status unknown"));
      assert.ok(rendered.includes(text || "(empty result)")); assert.ok(!rendered.includes("✓ Sent"));
    });
  }
  for (const details of [{}, null, { server: "other", tool: "cct" }, { server: "cct", tool: "other" },
    { server: "cct", tool: "cct", mode: "call" }, { server: "cct", tool: "cct", mode: "script" }, { server: "cct", tool: "cct", mode: "unknown" }]) {
    await test(`Sent requires known direct CCT identity: ${JSON.stringify(details)}`, () => {
      const text = output(undefined, row(), details); assert.ok(text.includes("Send status unknown")); assert.ok(!text.includes("✓ Sent"));
    });
  }
  for (const content of [[], null, [null], [{ type: "text", text: 42 }], [{ type: "unknown", value: "raw" }],
    [{ type: "image", mimeType: "image/png", data: "AA" }], [...result().content, ...result().content]]) {
    await test(`malformed/nontext/mixed content stays honest: ${JSON.stringify(content)}`, () => {
      const text = view(tool.renderResult({ content, details: result().details }, options, plain, row()));
      assert.ok(text.includes("Send status unknown")); assert.ok(!text.includes("✓ Sent"));
    });
  }
  for (const text of ['Sent to pool "team" (oops recipients, 2 live).', 'Sent to pool "team" (3 recipients, 99 live).',
    'Sent to pool "other" (3 recipients, 2 live).', 'Sent to pool "team" (99999999999999999999 recipients, 0 live).']) {
    await test(`malformed pool confirmation rejected: ${text}`, () => {
      assert.ok(output(text, row({ ...args, to: "@team" })).includes("Send status unknown"));
    });
  }
  await test("result-first/history and legacy state-only rows render correctly", () => {
    for (const context of [{ isError: false, args }, { isError: false, args, state: {} }, { ...row(), isPartial: false }]) {
      assert.equal(output(undefined, context), "CCT → reviewer\nhello\nsecond line\n✓ Sent");
    }
    const context = row(); delete context.args;
    assert.equal(output(undefined, context), "CCT → reviewer\nhello\nsecond line\n✓ Sent");
    assert.deepEqual(context.state._cctSend, args);
  });
  await test("current args win over cached state; rendering never changes model args/results", () => {
    const input = Object.freeze({ ...args }), response = Object.freeze(result());
    const before = JSON.stringify([input, response]), context = row(input);
    context.args = { ...args, message: "changed body" };
    const text = view(tool.renderResult(response, options, plain, context));
    assert.ok(text.includes("changed body")); assert.ok(!text.includes("second line"));
    assert.equal(JSON.stringify([input, response]), before);
    context.args = { action: "status" }; assert.equal(tool.renderResult(response, options, plain, context), resultFallback);
    context.args = null; assert.equal(tool.renderResult(response, options, plain, context), resultFallback);
  });
  await test("own row-state key preserves unrelated state, clears stale sends, and isolates concurrent rows", () => {
    const state = { compactTitle: "keep", compactInputPreview: "keep too", cctSend: "not ours" };
    const first = { isPartial: true, state }, second = row({ ...args, message: "other body", to: "other" });
    tool.renderCall(args, plain, first);
    assert.deepEqual({ ...state, _cctSend: undefined }, { compactTitle: "keep", compactInputPreview: "keep too", cctSend: "not ours", _cctSend: undefined });
    assert.ok(!output(undefined, first).includes("other body")); assert.ok(output('DM sent to "other".', second).includes("other body"));
    tool.renderCall({ action: "status" }, plain, first); assert.equal(tool.renderResult(result(), options, plain, first), resultFallback);
  });
  for (const input of [{ action: "status" }, { action: "peers" }, { action: "send", to: 3, message: "hey" },
    { action: "send", to: "peer", message: 3 }, { action: "send", to: "", message: "hey" },
    { action: "send", to: "peer", message: "" }, { action: "send", to: "   ", message: "hey" },
    { action: "send", message: "hey" }, { action: "send", to: "peer" }]) {
    await test(`non-send/invalid args delegate both original renderers unchanged: ${JSON.stringify(input)}`, () => {
      const context = { args: input, state: {} }, response = result(), opts = { ...options, expanded: true };
      assert.equal(tool.renderCall(input, plain, context), callFallback);
      assert.equal(tool.renderResult(response, opts, plain, context), resultFallback);
      const call = calls.at(-1)!, rendered = results.at(-1)!;
      assert.equal(call[0], input); assert.equal(call[1], plain); assert.equal(call[2], context);
      assert.equal(rendered[0], response); assert.equal(rendered[1], opts); assert.equal(rendered[2], plain); assert.equal(rendered[3], context);
    });
  }
  await test("long multiline/Unicode body wraps without truncation or width overflow", () => {
    const message = `first\n${"abc".repeat(5000)}\n你好 🦞 café e\u0301\nlast-marker`;
    const context = row({ ...args, message }), component = tool.renderResult(result(), options, colored, context);
    for (const width of [12, 40, 80]) {
      const lines = component.render(width), text = lines.map(stripVTControlCharacters).join("\n");
      assert.ok(lines.every((line: string) => visibleWidth(line) <= width)); assert.ok(text.includes("last-marker"));
      assert.ok(text.includes("✓ Sent")); assert.ok(text.includes("🦞")); assert.ok(!text.includes("Ctrl+O"));
      assert.ok(lines.map((line: string) => stripVTControlCharacters(line).trimEnd()).join("").includes("abc".repeat(5000)));
      assert.ok(lines.every((line: string) => line.includes("\x1b[48;2;246;248;250m")));
    }
    component.invalidate(); assert.ok(view(component, 80).includes("last-marker"));
  });
  await test("terminal controls sanitized in target/body/output/error without mutating source bytes", () => {
    const unsafe = '\x1b[31mred\x1b[0m\x1b[2J\x1b]8;;https://evil.test\x07link\x1b]8;;\x07\x00\x08\x7f\x9b31m\u202eevil\r\nnext\ttab';
    const input = { ...args, to: "reviewer\x1b[2J", message: unsafe }, response = result(unsafe, { error: "bad\x1b[2J" });
    const before = JSON.stringify([input, response]);
    for (const component of [tool.renderCall(input, plain, row(input)), tool.renderResult(response, options, plain, row(input))]) {
      const text = view(component); assert.ok(!/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(text));
      assert.ok(!text.includes("https://evil.test")); assert.ok(text.includes("redlink")); assert.ok(text.includes("next   tab"));
    }
    assert.equal(JSON.stringify([input, response]), before);
  });
  const dist = process.env.CCT_OS_DIST;
  if (dist) {
    await test("installed host loader preserves its Jiti aliases through the dynamic original import and async factory", async () => {
      const host = await import(join(dist, "index.js"));
      configure(`import { Text } from "@earendil-works/pi-tui";\nimport { Type } from "@sinclair/typebox";\n` +
        factorySource.replace('parameters: { type: "object" }', 'parameters: Type.Object({ action: Type.String() })') +
        '\nexport const hostAliasProof = Text;\n', "pi-mcp-adapter-host-2.33.0");
      const bus = host.createEventBus(), references: any[] = [], ready: unknown[] = [];
      bus.on("fixture-reference", (value: any) => references.push(value)); bus.on("fixture-ready", (value: any) => ready.push(value));
      const loaded = await host.discoverAndLoadExtensions([resolve("os-mcp-extension.ts")], home, process.env.OS_CODING_AGENT_DIR, bus);
      assert.deepEqual(loaded.errors, []); assert.deepEqual(ready, [true]); assert.equal(references.length, 1);
      const wrapped = loaded.extensions.find((item: any) => item.resolvedPath === resolve("os-mcp-extension.ts"));
      const definition = wrapped.tools.get("cct").definition, fixture = references[0];
      assert.equal(definition.execute, fixture.original.execute); assert.equal(wrapped.tools.get("fixture_other").definition, fixture.other);
      assert.match(view(definition.renderCall(args, plain, { isPartial: true, state: {} })), /Sending…/);
      // The public API intentionally records wrapper ownership, not an invented
      // sourceInfo for the delegated adapter factory.
      assert.equal(wrapped.sourceInfo.path, resolve("os-mcp-extension.ts"));
    });
    await test("installed host composes one pending/final/expanded/history/light-theme card", async () => {
      const { ToolExecutionComponent } = await import(join(dist, "modes/interactive/components/tool-execution.js"));
      const { initTheme, theme } = await import(join(dist, "modes/interactive/theme/theme.js"));
      initTheme("light", false);
      const make = () => new ToolExecutionComponent("cct", "fixture-row", args, { showImages: false }, tool, { requestRender() {} }, home);
      // Host rows include their own spacer, independent of the card's content.
      const hostView = (row: Component) => view(row, 80).replace(/^\n+|\n+$/g, "");
      const component = make(); assert.equal(hostView(component), "CCT → reviewer\nhello\nsecond line\nSending…");
      component.updateResult(result(), true); assert.equal((hostView(component).match(/CCT →/g) ?? []).length, 1);
      component.updateResult(result()); const expected = "CCT → reviewer\nhello\nsecond line\n✓ Sent";
      assert.equal(hostView(component), expected); component.setExpanded(true); assert.equal(hostView(component), expected);
      const bg = theme.bg("customMessageBg", "x").split("x")[0], fg = theme.fg("text", "x").split("x")[0];
      for (const line of component.render(80).filter((line: string) => stripVTControlCharacters(line).trim())) {
        assert.ok(line.includes(bg)); assert.ok(line.includes(fg)); assert.ok(visibleWidth(line) <= 80);
      }
      const history = make(); history.updateResult(result()); assert.equal(hostView(history), expected);
      const failure = make(); failure.updateResult({ ...result("Error: denied\nfull error", { error: "tool_error" }), isError: true });
      failure.setExpanded(true); assert.ok(view(failure, 80).includes("✗ Send failed\nError: denied\nfull error\nError: tool_error"));
    });
  } else console.log("SKIP installed-host alias/composer checks (set CCT_OS_DIST to run)");
  console.log(`${passed} os MCP wrapper/send-renderer checks passed`);
} finally {
  for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(home, { recursive: true, force: true });
}
