#!/usr/bin/env python3
"""Verify `cct status --json` and `cct version` in a synthetic HOME with no broker."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

REPO = Path(__file__).resolve().parent
NODE = shutil.which("node")
WORK = Path(tempfile.mkdtemp(prefix="cct-status-json-"))
HOME_DIR = WORK / "home"
AGENT = HOME_DIR / ".os/agent"
AGENT.mkdir(parents=True)
settings_path, mcp_path = AGENT / "settings.json", AGENT / "mcp.json"
settings_path.write_text(json.dumps({"extensions": ["/synthetic/footer.ts"]}))
env = {"PATH": os.environ["PATH"], "HOME": str(HOME_DIR),
       "OS_CODING_AGENT_DIR": str(AGENT), "PI_CODING_AGENT_DIR": str(AGENT),
       "PI_MCP_CONFIG_MODE": "exclusive", "CCT_BROKER": "http://127.0.0.1:1"}


def cli(*args):
    result = subprocess.run([NODE, "--import", str(REPO / "node_modules/tsx/dist/loader.mjs"),
                             str(REPO / "cli.ts"), *args],
                            env=env, cwd=WORK, capture_output=True, text=True, timeout=25)
    assert result.returncode == 0, (args, result.stderr)
    return result.stdout


def status():
    return json.loads(cli("status", "--json"))


try:
    version = json.loads((REPO / "package.json").read_text())["version"]
    assert cli("version").strip() == version
    assert cli("--version").strip() == version

    before = status()
    assert before["schema"] == 1 and before["version"] == version
    assert Path(before["package_dir"]) == REPO
    assert before["broker"] == {"url": "http://127.0.0.1:1", "mode": "local", "running": False,
                                "peers": None, "pools": None}, before["broker"]
    assert before["os"]["settings_path"] == str(settings_path)
    assert before["os"]["mcp_path"] == str(mcp_path)
    assert not before["os"]["connected"] and not before["os"]["stale"]
    assert before["os"]["errors"] == []

    cli("install", "--os")
    after = status()["os"]
    assert after["extension"] and after["mcp_server"] and after["mcp_command_ok"] and after["mcp_env_ok"], after
    assert after["connected"] and not after["stale"] and not after["wrapper"], after

    # Entries from another CCT package (old prefix or version) are stale, not connected.
    foreign = "/old/prefix/lib/node_modules/@omicsos/cct"
    s = json.loads(settings_path.read_text())
    s["extensions"] = [f"{foreign}/os-extension.ts", *s["extensions"][1:]]
    settings_path.write_text(json.dumps(s))
    m = json.loads(mcp_path.read_text())
    m["mcpServers"]["cct"]["args"][-1] = f"{foreign}/server.ts"
    mcp_path.write_text(json.dumps(m))
    moved = status()["os"]
    assert moved["stale"] and not moved["connected"] and not moved["extension"], moved

    # Unreadable config is reported, never fatal.
    settings_path.write_text("{not json")
    broken = status()["os"]
    assert broken["errors"] and not broken["connected"], broken
    print("status --json: all checks passed")
finally:
    shutil.rmtree(WORK, ignore_errors=True)
