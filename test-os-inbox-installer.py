#!/usr/bin/env python3
"""Private installer migration/package checks; never launch os or a broker."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

REPO = Path(__file__).resolve().parent
NODE = shutil.which("node")
WORK = Path(tempfile.mkdtemp(prefix="cct-inbox-install-"))
HOME_DIR = WORK / "home"
AGENT = HOME_DIR / ".os/agent"
AGENT.mkdir(parents=True)
settings_path, mcp_path = AGENT / "settings.json", AGENT / "mcp.json"
canonical = str(REPO / "os-extension.ts")
prototype = str(REPO / "os-inbox-extension.ts")
# Same basename elsewhere is not an owned path. Non-string entries also survive.
unrelated = ["/synthetic/adapter/index.ts", "/unrelated/os-inbox-extension.ts",
             {"path": "/synthetic/extension.ts", "options": {"keep": True}},
             "/synthetic/footer.ts"]
settings = {"extensions": [unrelated[0], prototype, canonical, *unrelated[1:],
                           prototype, canonical], "unrelated": {"keep": [1, 2]}}
cct = {"command": "old-command", "args": ["old-server"], "lifecycle": "lazy",
       "customField": {"keep": True}, "env": {"PRESERVE_ME": "synthetic",
       "CCT_OS_INBOX_BODY": "0", "CCT_BROKER": "http://127.0.0.1:1",
       "CCT_TOKEN": "synthetic-only"}}
mcp = {"settings": {"toolPrefix": "server"}, "mcpServers": {
    "other": {"command": "unrelated", "env": {"keep": "yes"}}, "cct": cct}}
settings_path.write_text(json.dumps(settings))
mcp_path.write_text(json.dumps(mcp))
protected = [HOME_DIR / ".claude.json", HOME_DIR / ".claude/settings.json",
             HOME_DIR / ".codex/config.toml"]
for path in protected:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('synthetic unchanged\n')
before = {path: path.read_bytes() for path in protected}
env = {"PATH": os.environ["PATH"], "HOME": str(HOME_DIR),
       "OS_CODING_AGENT_DIR": str(AGENT), "PI_CODING_AGENT_DIR": str(AGENT),
       "PI_MCP_CONFIG_MODE": "exclusive", "npm_config_cache": str(WORK / "npm-cache")}


def run_cli(action):
    result = subprocess.run([NODE, "--import", str(REPO / "node_modules/tsx/dist/loader.mjs"),
                             str(REPO / "cli.ts"), action, "--os"],
                            cwd=WORK, env=env, capture_output=True, text=True, timeout=25)
    assert result.returncode == 0, result.stdout + result.stderr


def config_and_backups():
    return {path: path.read_bytes() for path in [settings_path, mcp_path,
            settings_path.with_suffix(".json.bak"), mcp_path.with_suffix(".json.bak")]}


try:
    run_cli("install")
    installed_settings = json.loads(settings_path.read_text())
    installed_mcp = json.loads(mcp_path.read_text())
    assert installed_settings == {**settings, "extensions": [canonical, *unrelated]}
    installed_cct = installed_mcp["mcpServers"]["cct"]
    resolved_tsx = subprocess.check_output([NODE, "--input-type=module", "-e",
        "import {createRequire} from 'node:module'; console.log(createRequire(" + json.dumps((REPO / "cli.ts").as_uri()) + ").resolve('tsx/cli'));"], text=True).strip()
    assert installed_cct == {**cct, "command": str(Path(NODE).resolve()),
        "args": [resolved_tsx, str(REPO / "server.ts")], "lifecycle": "keep-alive",
        "directTools": True, "toolPrefix": "none", "env": {**cct["env"],
        "CCT_RUNTIME": "os", "CCT_TOOL_SURFACE": "compact", "CCT_OS_INBOX_BODY": "1"}}
    assert installed_mcp == {**mcp, "mcpServers": {**mcp["mcpServers"], "cct": installed_cct}}
    saved = config_and_backups()
    run_cli("install")
    assert config_and_backups() == saved
    run_cli("uninstall")
    assert json.loads(settings_path.read_text()) == {**settings, "extensions": unrelated}
    assert json.loads(mcp_path.read_text()) == {**mcp, "mcpServers": {"other": mcp["mcpServers"]["other"]}}
    saved = config_and_backups()
    run_cli("uninstall")
    assert config_and_backups() == saved
    # Uninstall also removes a leftover prototype without a canonical entry/MCP entry.
    settings_path.write_text(json.dumps({**settings, "extensions": [prototype, *unrelated, prototype]}))
    run_cli("uninstall")
    assert json.loads(settings_path.read_text()) == {**settings, "extensions": unrelated}
    assert all(path.read_bytes() == value for path, value in before.items())
    assert not (HOME_DIR / ".pi").exists()
    assert not (HOME_DIR / ".cct/cct.db").exists()

    # npm's actual allowlist resolution: shared/ already includes the new protocol.
    result = subprocess.run([shutil.which("npm"), "pack", "--dry-run", "--json", "--ignore-scripts"],
                            cwd=REPO, env=env, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    packed = json.loads(result.stdout)
    files = {entry["path"] for entry in packed[0]["files"]}
    assert {"os-extension.ts", "os-mcp-extension.ts", "shared/os-inbox.ts", "shared/os-adapter-config.ts", "shared/os-cct-send-renderer.ts", "server.ts", "cli.ts"} <= files, files
    assert "os-inbox-extension.ts" not in files
    (WORK / "pack-dry-run.json").write_text(result.stdout)
    print("PASS inbox opt-in, canonical-only migration, field/order preservation, install/uninstall idempotence, runtime isolation, package allowlist")
finally:
    print("EVIDENCE " + str(WORK))
