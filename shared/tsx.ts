import { createRequire } from "node:module";

/** CCT's own pinned tsx CLI. Spawn with process.execPath; `npx tsx` may fetch an unpinned tsx. */
export const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli");
