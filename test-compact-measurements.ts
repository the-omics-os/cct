import { buildCompactTool, CHECK_MESSAGES_TOOL, formatCompactStatus } from "./shared/compact.ts";
const members = Array.from({ length: 25 }, (_, index) => ({
  peer_name: `peer-${String(index).padStart(2, "0")}`,
  peer_id: `id-${String(index).padStart(2, "02")}`,
}));
const status = formatCompactStatus({
  id: "compact-peer-id", name: "os-measure", runtime: "os", keySource: "marker",
  pools: [{ name: "measure-pool", purpose: "PHASE_3 25-member cap", status: "active", members }],
  unread: 0, unreadByPool: [],
});
const compactTools = [CHECK_MESSAGES_TOOL, buildCompactTool()].map((tool) => ({
  name: tool.name, description: tool.description, input_schema: tool.inputSchema,
}));
const providerTools = [CHECK_MESSAGES_TOOL, buildCompactTool()].map((tool) => ({
  name: tool.name, description: tool.description, parameters: tool.inputSchema,
}));
const measurement = {
  eager_schema_bytes: compactTools.map((tool) => Buffer.byteLength(JSON.stringify(tool))).reduce((a, b) => a + b, 0),
  cct_schema_bytes: Buffer.byteLength(JSON.stringify(compactTools[1])),
  check_schema_bytes: Buffer.byteLength(JSON.stringify(compactTools[0])),
  status_25_members: { bytes: Buffer.byteLength(status), text: status },
  provider_tool_definitions_bytes: Buffer.byteLength(JSON.stringify(providerTools)),
  routine_workflows: [
    { workflow: "who am I + my pools", calls: 1, compact_sequence: ["cct(action=status)"] },
    { workflow: "create -> invite -> send", calls: 3, compact_sequence: ["cct(action=create)", "cct(action=invite)", "cct(action=send)"] },
    { workflow: "receive -> read -> reply", calls: 2, compact_sequence: ["cct_check_messages", "cct(action=send)"] },
  ],
};
console.log(JSON.stringify(measurement, null, 2));
