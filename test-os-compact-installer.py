#!/usr/bin/env python3
"""Verify compact os installer settings and runtime isolation in a synthetic HOME."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

REPO = Path(__file__).resolve().parent
NODE = shutil.which("node")
WORK = Path(tempfile.mkdtemp(prefix="cct-compact-install-", dir="/private/tmp"))
HOME_DIR = WORK / "home"
AGENT = HOME_DIR / ".os/agent"
AGENT.mkdir(parents=True)
settings_path, mcp_path = AGENT / "settings.json", AGENT / "mcp.json"
settings = {"extensions": ["/synthetic/adapter/index.ts", "/synthetic/footer.ts"], "unrelated": True}
mcp = {"settings": {"toolPrefix": "server"}, "mcpServers": {
    "other": {"command": "unrelated", "lifecycle": "lazy"},
    "cct": {"lifecycle": "lazy-keep-alive", "env": {"PRESERVE_ME": "synthetic"}},
}}
settings_path.write_text(json.dumps(settings))
mcp_path.write_text(json.dumps(mcp))
protected = [HOME_DIR / ".claude.json", HOME_DIR / ".claude/settings.json", HOME_DIR / ".codex/config.toml"]
for path in protected:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('{"synthetic":"unchanged"}\n')
before = {str(path): path.read_bytes() for path in protected}
env = {"PATH": os.environ["PATH"], "HOME": str(HOME_DIR),
       "OS_CODING_AGENT_DIR": str(AGENT), "PI_CODING_AGENT_DIR": str(AGENT),
       "PI_MCP_CONFIG_MODE": "exclusive"}


def install():
    return subprocess.run([NODE, "--import", str(REPO / "node_modules/tsx/dist/loader.mjs"),
                           str(REPO / "cli.ts"), "install", "--os"],
                          env=env, cwd=WORK, capture_output=True, text=True, timeout=25)


try:
    result = install()
    assert result.returncode == 0, result.stderr
    first_settings = json.loads(settings_path.read_text())
    first_mcp = json.loads(mcp_path.read_text())
    cct = first_mcp["mcpServers"]["cct"]
    assert cct["env"] == {"PRESERVE_ME": "synthetic", "CCT_RUNTIME": "os",
                          "CCT_TOOL_SURFACE": "compact"}, cct["env"]
    assert cct["lifecycle"] == "keep-alive", cct["lifecycle"]
    assert cct["directTools"] is True
    assert cct["toolPrefix"] == "none"
    assert first_mcp["mcpServers"]["other"] == mcp["mcpServers"]["other"]
    assert first_mcp["settings"] == mcp["settings"]
    assert first_settings["extensions"] == settings["extensions"] + [str(REPO / "os-extension.ts")]
    assert first_settings["unrelated"] is True
    saved = {path: path.read_bytes() for path in [settings_path, mcp_path, settings_path.with_suffix(".json.bak"),
                                                mcp_path.with_suffix(".json.bak")]}
    result = install()
    assert result.returncode == 0, result.stderr
    assert all(path.read_bytes() == value for path, value in saved.items())
    assert all(Path(path).read_bytes() == value for path, value in before.items())
    assert not (HOME_DIR / ".pi").exists()
    print("PASS compact os installer env/lifecycle/tools, preservation, idempotence, and Claude/Codex isolation")
finally:
    print("EVIDENCE " + str(WORK))
