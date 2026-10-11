#!/usr/bin/env python3
"""Reversible os adapter wrapping: private HOME, fake os, synthetic third party.

No broker/model runs, npm calls, real config edits or third-party source patches.
The installer is invoked by Node even with a hostile tsx shim on PATH (WSL
launcher regression). Evidence is retained under a private temporary directory.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

REPO = Path(__file__).resolve().parent
NODE = shutil.which("node")
LOADER = REPO / "node_modules/tsx/dist/loader.mjs"
BODY = str(REPO / "os-extension.ts")
PROTOTYPE = str(REPO / "os-inbox-extension.ts")
WRAPPER = str(REPO / "os-mcp-extension.ts")
HELPER = (REPO / "shared/os-adapter-config.ts").as_uri()
WORK = Path(tempfile.mkdtemp(prefix="cct-adapter-install-"))
CHECKS = 0


def check(condition, message):
    global CHECKS
    assert condition, message
    CHECKS += 1


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n")


class Fixture:
    def __init__(self, name, custom=None, entry_kind="file", version="2.33.0"):
        self.root = WORK / name
        self.home = self.root / "home"
        self.home.mkdir(parents=True)
        self.agent = self.home / ".os/agent" if custom is None else self.home / custom
        self.agent.mkdir(parents=True)
        self.settings_path = self.agent / "settings.json"
        self.mcp_path = self.agent / "mcp.json"
        self.state_path = self.agent / "cct-adapter.json"
        self.package = self.home / "third party/pi-mcp-adapter"
        self.package.mkdir(parents=True)
        write_json(self.package / "package.json", {"name": "pi-mcp-adapter", "version": version,
                   "type": "module", "pi": {"extensions": ["index.ts"]}})
        self.factory = self.package / "index.ts"
        self.factory.write_text("export default function adapter(pi) { pi.registerCommand('fixture', {handler() {}}); }\n")
        if entry_kind == "directory":
            self.entry = str(self.package)
        elif entry_kind == "relative":
            self.entry = os.path.relpath(self.factory, self.agent)
        elif entry_kind == "tilde":
            self.entry = "~/" + str(self.factory.relative_to(self.home))
        elif entry_kind == "url":
            self.entry = self.factory.as_uri()
        elif entry_kind == "symlink":
            alias = self.home / "adapter alias.ts"
            alias.symlink_to(self.factory)
            self.entry = str(alias)
        else:
            self.entry = str(self.factory)
        self.unrelated = ["/synthetic/footer.ts", {"path": "/synthetic/ext.ts", "options": {"keep": True}},
                          "/synthetic/footer.ts", "/unrelated/os-mcp-extension.ts"]
        self.settings = {"extensions": [self.unrelated[0], PROTOTYPE, self.entry, *self.unrelated[1:],
                                       BODY, PROTOTYPE, BODY], "keep": {"data": [1, 2]},
                         "packages": ["npm:unrelated-package@1.0.0"]}
        self.cct = {"command": "old", "args": ["old"], "lifecycle": "lazy", "custom": {"keep": True},
                    "env": {"PRESERVE_ME": "yes", "CCT_OS_INBOX_BODY": "0", "CCT_BROKER": "http://127.0.0.1:1",
                            "CCT_TOKEN": "synthetic-only"}}
        self.mcp = {"version": 7, "settings": {"toolPrefix": "server", "keep": True},
                    "mcpServers": {"cct": self.cct, "other": {"command": "unrelated", "keep": True}}}
        write_json(self.settings_path, self.settings)
        write_json(self.mcp_path, self.mcp)
        # findOsPackage must succeed without consulting npm or a real os package.
        fake_os = self.home / "fake-os"
        fake_os.mkdir()
        write_json(fake_os / "package.json", {"name": "@the-omics-os/os", "bin": {"os": "os"}})
        (fake_os / "os").write_text("#!/bin/sh\nexit 88\n")
        (fake_os / "os").chmod(0o755)
        bin_dir = self.home / "bin"
        bin_dir.mkdir()
        (bin_dir / "os").symlink_to(fake_os / "os")
        for name in ["npm", "tsx"]:
            (bin_dir / name).write_text("#!/bin/sh\necho forbidden-test-launch >&2\nexit 89\n")
            (bin_dir / name).chmod(0o755)
        self.env = {"PATH": str(bin_dir) + os.pathsep + os.environ["PATH"], "HOME": str(self.home),
                    "PI_CODING_AGENT_DIR": str(self.agent), "PI_MCP_CONFIG_MODE": "exclusive",
                    "WSL_DISTRO_NAME": "CCT-synthetic", "WSL_INTEROP": "/synthetic/interop"}
        if custom is not None:
            self.env["OS_CODING_AGENT_DIR"] = str(self.agent)
        self.protected = [self.home / ".claude.json", self.home / ".claude/settings.json",
                          self.home / ".codex/config.toml"]
        for path in self.protected:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("unrelated config unchanged\n")
        self.untouched = {path: path.read_bytes() for path in self.protected}
        self.third_party = {path: path.read_bytes() for path in self.package.rglob("*") if path.is_file()}

    def cli(self, action, success=True, error=None):
        result = subprocess.run([NODE, "--import", str(LOADER), str(REPO / "cli.ts"), action, "--os"],
                                cwd=self.root, env=self.env, capture_output=True, text=True, timeout=25)
        if success:
            check(result.returncode == 0, result.stdout + result.stderr)
        else:
            check(result.returncode != 0, "Unexpected success: " + result.stdout)
            if error:
                check(error.lower() in result.stderr.lower(), result.stdout + result.stderr)
        return result

    def state(self):
        return {"version": 1, "adapterEntry": self.entry, "adapterPath": str(self.factory.resolve())}

    def reader(self, success=True):
        result = subprocess.run([NODE, "--import", str(LOADER), "--input-type=module", "--eval",
                                 f"import {{ readOsAdapterConfig }} from {json.dumps(HELPER)}; "
                                 "console.log(JSON.stringify(readOsAdapterConfig()));"],
                                cwd=self.root, env=self.env, capture_output=True, text=True, timeout=25)
        check((result.returncode == 0) == success, result.stdout + result.stderr)
        if success:
            check(json.loads(result.stdout) == self.state(), "Reader did not return original/canonical paths")

    def snapshot(self):
        # Include backups and sentinels, but never follow symlinks outside the fixture.
        return {str(path.relative_to(self.home)): ("link", os.readlink(path)) if path.is_symlink()
                else ("bytes", path.read_bytes()) for path in self.home.rglob("*") if path.is_file() or path.is_symlink()}

    def no_mutations(self, action="install", error=None):
        before = self.snapshot()
        self.cli(action, success=False, error=error)
        check(self.snapshot() == before, "Failed preflight mutated config/state/backups")

    def unchanged(self):
        check(all(path.read_bytes() == value for path, value in self.untouched.items()), "Claude/Codex config changed")
        check(all(path.read_bytes() == value for path, value in self.third_party.items()), "Third-party adapter changed")
        check(not (self.home / ".cct/cct.db").exists(), "Installer started a broker")


def roundtrip(f):
    before_settings = f.settings_path.read_bytes()
    before_mcp = f.mcp_path.read_bytes()
    f.cli("install")
    installed_settings = json.loads(f.settings_path.read_text())
    check(installed_settings == {**f.settings, "extensions": [BODY, f.unrelated[0], WRAPPER, *f.unrelated[1:]]},
          "Wrapper did not replace original slot or unrelated duplicates/order changed")
    check(json.loads(f.state_path.read_text()) == f.state(), "Missing exact original/canonical state")
    check(f.state_path.parent == f.agent and f.state_path.parent.name != "extensions", "State in autoextension directory")
    check(f.state_path.stat().st_mode & 0o777 == 0o600, "State is not mode 0600")
    f.reader()
    installed_mcp = json.loads(f.mcp_path.read_text())
    cct = installed_mcp["mcpServers"]["cct"]
    check(Path(cct["command"]).resolve() == Path(NODE).resolve(), "WSL regression: CCT command must be process.execPath")
    expected_tsx = subprocess.check_output([NODE, "--input-type=module", "--eval",
                                          "import {createRequire} from 'node:module'; console.log(createRequire("
                                          + json.dumps((REPO / "cli.ts").as_uri()) + ").resolve('tsx/cli'));"],
                                         env=f.env, cwd=f.root, text=True).strip()
    check(cct["args"] == [expected_tsx, str(REPO / "server.ts")], "WSL regression: unresolved tsx/cli args")
    check(cct == {**f.cct, "command": cct["command"], "args": cct["args"], "lifecycle": "keep-alive",
                  "directTools": True, "toolPrefix": "none", "env": {**f.cct["env"], "CCT_RUNTIME": "os",
                  "CCT_TOOL_SURFACE": "compact", "CCT_OS_INBOX_BODY": "1"}}, "CCT field/env compatibility lost")
    check(installed_mcp == {**f.mcp, "mcpServers": {**f.mcp["mcpServers"], "cct": cct}}, "Unrelated MCP/version fields changed")
    check(Path(str(f.settings_path) + ".bak").read_bytes() == before_settings, "Settings backup not preserved")
    check(Path(str(f.mcp_path) + ".bak").read_bytes() == before_mcp, "MCP backup not preserved")
    installed = f.snapshot()
    f.cli("install")
    check(f.snapshot() == installed, "Reinstall is not byte-idempotent, including backups/state")
    f.cli("uninstall")
    check(json.loads(f.settings_path.read_text()) == {**f.settings, "extensions": [f.unrelated[0], f.entry, *f.unrelated[1:]]},
          "Uninstall did not restore exact original slot/entry")
    check(json.loads(f.mcp_path.read_text()) == {**f.mcp, "mcpServers": {"other": f.mcp["mcpServers"]["other"]}},
          "Uninstall disturbed unrelated MCP/version fields")
    check(not f.state_path.exists(), "Uninstall left active owned state")
    uninstalled = f.snapshot()
    f.cli("uninstall")
    check(f.snapshot() == uninstalled, "Repeated uninstall changed bytes/backups")
    f.cli("install")
    check(json.loads(f.state_path.read_text()) == f.state(), "Fresh reinstall lost exact original")
    saved = f.snapshot()
    f.cli("install")
    check(f.snapshot() == saved, "Fresh reinstall was not byte-idempotent")
    f.unchanged()


try:
    for kind in ["file", "directory", "relative", "tilde", "url", "symlink"]:
        roundtrip(Fixture("roundtrip-" + kind, entry_kind=kind))
    for name, value in [("tilde", "~/profiles/custom agent"), ("url", "file"), ("relative", "relative")]:
        f = Fixture("custom-" + name, custom="profiles/custom agent")
        f.env["OS_CODING_AGENT_DIR"] = value if value.startswith("~") else f.agent.as_uri() if value == "file" else os.path.relpath(f.agent, f.root)
        roundtrip(f)

    f = Fixture("fresh-empty")
    f.settings_path.unlink()
    f.mcp_path.unlink()
    f.cli("install")
    check(json.loads(f.settings_path.read_text()) == {"extensions": [BODY]}, "Empty settings install changed legacy behavior")
    check(not f.state_path.exists(), "Empty install fabricated adapter state")
    before = f.snapshot()
    f.cli("install")
    check(f.snapshot() == before, "Fresh empty install not byte-idempotent")
    f.cli("uninstall")
    before = f.snapshot()
    f.cli("uninstall")
    check(f.snapshot() == before, "Fresh empty uninstall not byte-idempotent")

    f = Fixture("missing-adapter")
    f.settings["extensions"] = ["/synthetic/adapter/index.ts", *f.unrelated, BODY, BODY, PROTOTYPE]
    write_json(f.settings_path, f.settings)
    result = f.cli("install")
    check("Missing CCT outgoing wrapper capability" in result.stdout, "Missing capability warning absent")
    check(json.loads(f.settings_path.read_text())["extensions"] == [BODY, "/synthetic/adapter/index.ts", *f.unrelated],
          "Synthetic unrelated extension behavior regressed")
    check(not f.state_path.exists(), "Missing adapter fabricated state")
    f.unchanged()

    for name, entries in [("originals", "originals"), ("wrapper-original", "mixed"), ("wrappers", "wrappers")]:
        f = Fixture("duplicates-" + name)
        write_json(f.state_path, f.state())
        f.settings["extensions"] = [f.entry, f.package.as_uri()] if entries == "originals" else [WRAPPER, f.entry] if entries == "mixed" else [WRAPPER, Path(WRAPPER).as_uri()]
        write_json(f.settings_path, f.settings)
        for action in ["install", "uninstall"]:
            f.no_mutations(action, "Ambiguous")

    # Replacing an explicit entry must not leave a known auto-discovered original
    # (or wrapper) activated from a symlink/file/directory alongside it.
    for kind in ["file", "directory", "wrapper", "only-auto"]:
        f = Fixture("auto-" + kind)
        auto = f.agent / "extensions"
        auto.mkdir()
        if kind in ["directory", "only-auto"]:
            (auto / "adapter").symlink_to(f.package, target_is_directory=True)
        else:
            (auto / "adapter.ts").symlink_to(REPO / "os-mcp-extension.ts" if kind == "wrapper" else f.factory)
        if kind == "only-auto":
            f.settings["extensions"] = list(f.unrelated)
            write_json(f.settings_path, f.settings)
        for action in ["install", "uninstall"]:
            f.no_mutations(action, "autoextensions")
    f = Fixture("unfamiliar-auto")
    auto = f.agent / "extensions"
    auto.mkdir()
    unknown = auto / "unrelated.ts"
    unknown.write_text("export default function unrelated() {}\n")
    roundtrip(f)
    check(unknown.read_text() == "export default function unrelated() {}\n", "Unrelated autoextension changed")

    for activation in ["npm:pi-mcp-adapter@2.33.0", {"source": "npm:pi-mcp-adapter@2.33.0", "extensions": []},
                       "git:github.com/example/pi-mcp-adapter@v2.33.0", "local", WRAPPER,
                       {"source": WRAPPER}]:
        f = Fixture("package-" + str(CHECKS))
        f.settings["packages"] += [str(f.package) if activation == "local" else activation]
        write_json(f.settings_path, f.settings)
        for action in ["install", "uninstall"]:
            f.no_mutations(action, "settings.packages")
    for source in ["npm:pi-mcp-adapter@2.33.0", {"path": "fixture"}, {"path": WRAPPER}]:
        f = Fixture("unsupported-extension-" + str(CHECKS))
        f.settings["extensions"] = [source if isinstance(source, str) or source.get("path") == WRAPPER else {"path": f.entry}]
        write_json(f.settings_path, f.settings)
        f.no_mutations(error="wrapper")
    for version in ["2.32.0", "2.34.0", 2.33]:
        f = Fixture("unsupported-version-" + str(CHECKS), version=version)
        f.no_mutations(error="2.33.0")
    f = Fixture("nonfactory")
    (f.package / "other.ts").write_text("export default function other() {}\n")
    f.settings["extensions"] = [str(f.package / "other.ts")]
    write_json(f.settings_path, f.settings)
    f.no_mutations(error="index.ts")
    for entries in [["other.ts"], ["index.ts", "other.ts"]]:
        f = Fixture("unsupported-directory-manifest-" + str(CHECKS), entry_kind="directory")
        (f.package / "other.ts").write_text("export default function other() {}\n")
        write_json(f.package / "package.json", {"name": "pi-mcp-adapter", "version": "2.33.0", "pi": {"extensions": entries}})
        f.no_mutations(error="index.ts")
    f = Fixture("escaping-directory-index")
    second = f.home / "other-package"
    second.mkdir()
    shutil.copyfile(f.package / "package.json", second / "package.json")
    shutil.copyfile(f.factory, second / "index.ts")
    f.factory.unlink()
    f.factory.symlink_to(second / "index.ts")
    f.settings["extensions"] = [str(f.package)]
    write_json(f.settings_path, f.settings)
    f.no_mutations(error="index.ts")

    f = Fixture("missing-state")
    f.settings["extensions"] = [BODY, WRAPPER, *f.unrelated]
    write_json(f.settings_path, f.settings)
    for action in ["install", "uninstall"]:
        f.no_mutations(action, "missing")
    f.reader(success=False)
    f = Fixture("moved-wrapper")
    f.cli("install")
    state_bytes = json.dumps(f.state(), separators=(",", ":")).encode()
    f.state_path.write_bytes(state_bytes)
    moved = [*f.unrelated, Path(WRAPPER).as_uri(), BODY, BODY]
    write_json(f.settings_path, {**f.settings, "extensions": moved})
    f.cli("install")
    check(json.loads(f.settings_path.read_text())["extensions"] == [BODY, *f.unrelated, WRAPPER], "Reinstall moved wrapper slot")
    check(f.state_path.read_bytes() == state_bytes, "Reinstall normalized existing valid state bytes")
    f.cli("uninstall")
    check(json.loads(f.settings_path.read_text())["extensions"] == [*f.unrelated, f.entry], "Uninstall ignored current wrapper slot")
    f = Fixture("dangling-state")
    f.state_path.symlink_to(f.home / "missing-state-target.json")
    f.no_mutations(error="state")

    invalid_states = ["{", [], None, {}, {"version": "1"}, {"version": 2},
                      {"adapterEntry": ""}, {"adapterEntry": 4}, {"adapterPath": ""},
                      {"adapterPath": 4}, {"adapterPath": "relative/index.ts"},
                      {"adapterPath": "alias"}, {"adapterEntry": "self"}]
    for delta in invalid_states:
        f = Fixture("bad-state-" + str(CHECKS))
        if isinstance(delta, dict) and delta:
            state = {**f.state(), **delta}
            if state["adapterPath"] == "alias":
                alias = f.home / "factory-alias.ts"
                alias.symlink_to(f.factory)
                state["adapterPath"] = str(alias)
            if state["adapterEntry"] == "self":
                state["adapterEntry"] = WRAPPER
        else:
            state = delta
        f.state_path.write_text("{" if delta == "{" else json.dumps(state))
        for action in ["install", "uninstall"]:
            f.no_mutations(action, "state")
        f.reader(success=False)
    # A source symlink masquerading as index.ts must not recurse into CCT.
    f = Fixture("self-loop-index")
    f.factory.unlink()
    f.factory.symlink_to(REPO / "os-extension.ts")
    write_json(f.state_path, {"version": 1, "adapterEntry": f.entry, "adapterPath": BODY})
    f.no_mutations(error="self-loop")
    f.reader(success=False)
    f = Fixture("stale-state")
    write_json(f.state_path, f.state())
    f.settings["extensions"] = list(f.unrelated)
    write_json(f.settings_path, f.settings)
    f.no_mutations(error="no matching")
    f.cli("uninstall")
    check(json.loads(f.settings_path.read_text()) == f.settings, "Stale-state uninstall disturbed original/unrelated extensions")
    check(not f.state_path.exists(), "Validated stale state not removed")
    f = Fixture("conflicting-state")
    write_json(f.state_path, {**f.state(), "adapterEntry": f.package.as_uri()})
    f.no_mutations(error="conflicts")

    # Owned backup cleanup vs an unknown backup, without claiming arbitrary files.
    for owned in [True, False]:
        f = Fixture("backup-" + str(owned))
        f.cli("install")
        backup = Path(str(f.state_path) + ".bak")
        backup.write_text(f.state_path.read_text() if owned else "unknown backup must remain\n")
        before = backup.read_bytes()
        f.cli("uninstall")
        check(not backup.exists() if owned else backup.read_bytes() == before, "Incorrect wrapper-state backup cleanup")

    # Every write and backup destination must resolve outside protected .pi,
    # including symlink ancestors and dangling destination links.
    for destination in ["settings.json", "settings.json.bak", "mcp.json", "mcp.json.bak", "cct-adapter.json", "cct-adapter.json.bak"]:
        f = Fixture("protected-" + destination)
        target = f.home / ".pi/agent" / destination
        target.parent.mkdir(parents=True)
        link = f.agent / destination
        if link.exists():
            link.unlink()
        link.symlink_to(target)  # target intentionally missing
        for action in ["install", "uninstall"]:
            f.no_mutations(action, "protected")
        check(not target.exists(), "Protected target was created")
    f = Fixture("protected-ancestor")
    alias = f.home / "profile-link"
    alias.symlink_to(f.home / ".pi/agent")
    f.env["OS_CODING_AGENT_DIR"] = str(alias)
    f.no_mutations(error="protected")
    f = Fixture("protected-default-adapter-env")
    del f.env["PI_CODING_AGENT_DIR"]
    f.no_mutations(error="protected")
    # Preserve custom adapter package-env resolution and MCP fields/version.
    f = Fixture("custom-adapter-environment", custom="profiles/os")
    pi_package = f.home / "custom-host-package"
    write_json(pi_package / "package.json", {"piConfig": {"name": "custom", "configDir": ".custom"}})
    adapter_dir = f.home / "adapter-config"
    adapter_dir.mkdir()
    f.mcp_path.rename(adapter_dir / "mcp.json")
    f.mcp_path = adapter_dir / "mcp.json"
    f.env["PI_PACKAGE_DIR"] = str(pi_package)
    f.env["CUSTOM_CODING_AGENT_DIR"] = "~/adapter-config"
    f.cli("install")
    check(json.loads(f.mcp_path.read_text())["version"] == 7, "Custom adapter MCP version lost")
    check(f.state_path.exists(), "State followed adapter directory rather than os profile")
    f.cli("uninstall")
    f.unchanged()
    print(f"PASS {CHECKS} reversible adapter installer checks (private HOME/synthetic adapters; no npm/model/broker)")
finally:
    print("EVIDENCE " + str(WORK))
