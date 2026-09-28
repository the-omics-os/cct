# CCT for os on WSL2 (contractor install)

This guide installs the current CCT os integration from the supplied npm tarball. It does not require a CCT source checkout or access to internal repositories. Target: Windows 11, WSL2 Ubuntu, Node.js 22.19 or newer, and all working files under the WSL Linux filesystem (for example, `$HOME/companions`, not `/mnt/c`).

## Install

Copy the reviewed `omicsos-cct-0.2.0.tgz` into `$HOME/companions/cct/` from within WSL. Then run:

```bash
node --version                 # must be v22.19.0 or newer
mkdir -p "$HOME/companions/cct"

# Install/enable the public adapter in os.
os install npm:pi-mcp-adapter@3.1.0

# Install the reviewed CCT package and its runtime dependencies.
npm install --global "$HOME/companions/cct/omicsos-cct-0.2.0.tgz"

# Point the installer and adapter at the same global os agent directory.
export OS_CODING_AGENT_DIR="$HOME/.os/agent"
export PI_CODING_AGENT_DIR="$OS_CODING_AGENT_DIR"
export PI_MCP_CONFIG_MODE=exclusive

# Local-only configuration: do not set CCT_BROKER or CCT_TOKEN.
unset CCT_BROKER CCT_TOKEN
cct install --os
```

The os host must use the same `PI_CODING_AGENT_DIR` when it starts (the approved os launcher normally sets Q7 to `${OS_CODING_AGENT_DIR:-$HOME/.os/agent}`). Keep the supplied artifact, npm cache, CCT state, and project checkouts on the WSL Linux filesystem. Do not put source checkouts or runtime databases under `/mnt/c`.

`cct install --os` writes the compact CCT adapter entry (`keep-alive`, `directTools`, no prefix, `CCT_RUNTIME=os`, and `CCT_TOOL_SURFACE=compact`) and adds the CCT extension. It only configures os; it does not install the adapter or start a broker. It prints the resolved settings, adapter config, and state paths. Confirm they are under the intended `~/.os/agent` directory, then start a **new** os session.

## Start and verify (local broker only)

```bash
cct start
cct status
```

In the new os session, check the discovered tools and call `cct` with `action: status`. The active CCT tools should be exactly `cct_check_messages` and `cct`; status should report a registered `os` peer and the local pool state. No remote broker, shared token, cross-machine broker, or internal service is part of this setup. The broker binds to `127.0.0.1` by default and stores its database under `~/.cct/`.

## Uninstall

Close os sessions first, then remove the CCT configuration and extension. Remove the adapter only if it is not needed by another os workflow.

```bash
export OS_CODING_AGENT_DIR="$HOME/.os/agent"
export PI_CODING_AGENT_DIR="$OS_CODING_AGENT_DIR"
export PI_MCP_CONFIG_MODE=exclusive
cct uninstall --os
os remove npm:pi-mcp-adapter@3.1.0  # optional; removes the adapter from os settings
npm uninstall --global @omicsos/cct
cct kill                            # optional; stops the local broker
```

CCT uninstall removes its os MCP entry and extension registration. It does not remove `~/.cct/` state or unrelated os extensions/settings. Back up or deliberately remove local CCT data separately if desired.
