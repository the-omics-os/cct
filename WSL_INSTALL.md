# CCT for os on WSL2

Install from a reviewed CCT npm tarball without a source checkout. Target:
Windows 11, WSL2 Ubuntu, **Node.js 22.19.0 or newer**, and all working files on
the WSL Linux filesystem (for example `$HOME/companions`, not `/mnt/c`).

The 0.2.1 release is being prepared; publication verification is pending. Use
the reviewed `omicsos-cct-0.2.1.tgz` supplied for this version, not an assumption
that npm `latest` already points to it. Runtime dependencies are pinned to
SDK 1.30.1 and tsx 4.23.15.

## Install the supported adapter

CCT's outgoing formatter requires the original **`pi-mcp-adapter@2.33.0`**,
enabled as one explicit global file/directory extension outside autoextensions.
Package activation through `os install npm:...`, global autoextensions,
CLI flags or project settings is not supported by this initial wrapper.

```bash
node --version                 # must be v22.19.0 or newer
mkdir -p "$HOME/companions/cct" "$HOME/companions/os-mcp-adapter"
npm install --prefix "$HOME/companions/os-mcp-adapter" --save-exact pi-mcp-adapter@2.33.0
```

Add the following string to the existing `extensions` array in your global os
agent `settings.json` (normally `$HOME/.os/agent/settings.json`). Preserve all
other settings and extension entries. If the adapter is already activated
elsewhere, remove that activation first so exactly one remains:

```json
"~/companions/os-mcp-adapter/node_modules/pi-mcp-adapter/index.ts"
```

Do not place the adapter or wrapper in `$HOME/.os/agent/extensions/`. Installing
files with npm into the companions directory does not itself activate an os
package; the explicit settings entry is what enables the factory.

## Install CCT

Copy the reviewed `omicsos-cct-0.2.1.tgz` into `$HOME/companions/cct/` within WSL:

```bash
npm install --global "$HOME/companions/cct/omicsos-cct-0.2.1.tgz"

# Use the same directories/config mode for both installer and os host.
export OS_CODING_AGENT_DIR="$HOME/.os/agent"
export PI_CODING_AGENT_DIR="$OS_CODING_AGENT_DIR"
export PI_MCP_CONFIG_MODE=exclusive

# Local-only setup: no remote broker/token; ensure saved CCT config is local too.
unset CCT_BROKER CCT_TOKEN
cct config show
cct install --os
```

The os host must retain this environment when it starts. The installer prints
resolved settings, MCP config, cache/onboarding and wrapper state paths and
refuses writes under `.pi`. Confirm paths match the intended profile. Keep
package artifacts, npm cache, CCT state and project checkouts on the Linux
filesystem, not `/mnt/c`.

The installer configures the compact CCT server (`keep-alive`, `directTools`,
no prefix, `CCT_RUNTIME=os`, `CCT_TOOL_SURFACE=compact`, `CCT_OS_INBOX_BODY=1`).
It puts the body extension first and replaces the explicit adapter at its slot
with CCT's shipped outgoing wrapper. Per-profile `cct-adapter.json` beside
settings records the exact original entry and factory; it is outside
`extensions/`. Known ambiguity or invalid saved state fails before config writes.
No os-core or adapter source edits occur. All delegated MCP tools/commands have
the wrapper's `sourceInfo`; their original provenance cannot be retained through
the public API. Non-CCT execution and renderers remain unchanged.

This command configures only os; it does not acquire the adapter or start the
broker. Start a **new** os session after installing.

## Start and verify (local broker only)

```bash
cct start
cct status
os
```

In the new session call `cct` with `action: status`. Active CCT tools should be
exactly `cct_check_messages` and `cct`, with a registered os peer. Eligible chat
DM bodies arrive automatically; pool messages and recovery retain the check.
Send cards confirm broker send status, not recipient reading or task completion.

No remote broker, shared token or cross-machine service is part of this setup.
The local broker binds to `127.0.0.1` and stores its database under `~/.cct/`.

## Uninstall

Close os sessions first and use the same environment:

```bash
export OS_CODING_AGENT_DIR="$HOME/.os/agent"
export PI_CODING_AGENT_DIR="$OS_CODING_AGENT_DIR"
export PI_MCP_CONFIG_MODE=exclusive
cct uninstall --os
cct kill                            # optional; stop broker before removing CLI
npm uninstall --global @omicsos/cct
```

CCT uninstall restores the exact original adapter entry at the wrapper's slot,
removes its MCP/body/wrapper registrations and owned wrapper state, and preserves
unrelated settings and `~/.cct/` history. The adapter remains installed and active
for other workflows. To remove it too, remove its explicit settings entry before
removing its companions installation. Restart os to apply changed settings.
