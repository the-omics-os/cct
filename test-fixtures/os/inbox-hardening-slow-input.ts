// Loaded through actual os extension input ordering; never intercepts the prompt.
import fs from "node:fs";
import type { ExtensionAPI } from "@the-omics-os/os";
export default function (pi: ExtensionAPI) {
  pi.on("input", async (event) => {
    if (event.text !== "SLOW_INPUT_ORDER") return;
    fs.appendFileSync(process.env.HARDENING_LOG!, JSON.stringify({kind: "slow_input_enter", at: Date.now()}) + "\n");
    await new Promise(resolve => setTimeout(resolve, 7200));
    fs.appendFileSync(process.env.HARDENING_LOG!, JSON.stringify({kind: "slow_input_exit", at: Date.now()}) + "\n");
  });
}
