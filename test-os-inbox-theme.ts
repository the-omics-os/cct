// Installed-host contrast acceptance; no configuration writes or live sessions.
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { renderInboxMessage } from "./shared/os-inbox-renderer.ts";
const dist = process.env.CCT_OS_DIST ?? "/Users/tyo/.local/share/os-releases/1.1.3/lib/node_modules/@the-omics-os/os/dist";
const { loadThemeFromPath } = await import(`${dist}/modes/interactive/theme/theme.js`);
const nonce = "theme-test";
const message = { content: `Sender "os-test" ("id"), message 1, time "now"\n<peer-body-${nonce}>\nBody contrast text wraps across the card.\n</peer-body-${nonce}>`,
  details: { version: 1, nonce, ids: [1] } };
function luminance(ansi: string): number {
  const m = /(?:38|48);2;(\d+);(\d+);(\d+)m/.exec(ansi);
  assert.ok(m, "explicit truecolor, not an unknown terminal default");
  const rgb = m.slice(1).map(v => { const x = Number(v) / 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; });
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}
for (const name of ["light", "dark"]) {
  const theme = loadThemeFromPath(`${dist}/modes/interactive/theme/${name}.json`, "truecolor");
  const fg = theme.getFgAnsi("text"), bg = theme.getBgAnsi("customMessageBg");
  const a = luminance(fg), b = luminance(bg), ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
  assert.ok(ratio >= 7, `${name} card body contrast ${ratio}`);
  const rows = renderInboxMessage(message, { outputPad: 1 }, theme).render(24);
  assert.ok(rows.every(row => row.includes(bg)), "EVERY card row paints its background");
  for (const row of rows.filter(row => stripVTControlCharacters(row).trim())) assert.ok(row.includes(fg), "body/sender foreground explicitly painted");
  console.log(`PASS installed ${name} theme: foreground + background painted, body contrast ${ratio.toFixed(2)}:1`);
}
