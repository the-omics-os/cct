#!/usr/bin/env python3
"""Installed os 0.2.0 hardening RED cases. Expected exit 1 on unfixed CCT.

Each invocation owns a private HOME, OS/PI dirs, broker, CCT_DIR, os host, and
synthetic provider. No inherited credentials or real peer/model operations.
Use --case esc|tree-dm|tree-pool|preflight|preflight-fail|handled|replacement.
Evidence retained under /private/tmp/cct-hardening-* for inspection.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import shutil
import socket
import sqlite3
import struct
import subprocess
import tempfile
import threading
import time
import urllib.request
import fcntl
import termios

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "test-fixtures/os/inbox-hardening-probe.ts"
SLOW_INPUT = HERE / "test-fixtures/os/inbox-hardening-slow-input.ts"


def records(path):
    if not path.exists(): return []
    return [json.loads(s) for s in path.read_text().splitlines() if s.strip()]


class Harness:
    def __init__(self, case, shared=None):
        self.case = case
        self.shared = shared
        self.root = Path(tempfile.mkdtemp(prefix="cct-hardening-", dir="/private/tmp"))
        self.root.chmod(0o700)
        self.home = self.root / "home"
        self.agent = self.home / ".os/agent"
        self.project = self.root / "project"
        self.cct = self.root / "cct"
        if shared:
            self.cct = shared.cct
        for p in (self.agent, self.project, self.cct): p.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.log = self.root / "events.jsonl"
        self.rpc_log = self.root / "rpc.jsonl"
        self.marker = self.root / "marker.json"
        self.node = shutil.which("node")
        os_bin = Path(os.environ.get("CCT_OS_BIN") or shutil.which("os") or "").resolve()
        assert self.node and os_bin.is_file() and os_bin.name == "cli.js" and "@the-omics-os/os/dist/bundle" in str(os_bin)
        assert json.loads((os_bin.parents[2] / "package.json").read_text())["version"] == "0.2.0"
        self.os_bin = os_bin
        self.adapter_source = Path(os.environ.get("CCT_OS_ADAPTER", "~/GITHUB/AGENTS/pi-mcp-adapter/index.ts")).expanduser().resolve()
        assert self.adapter_source.is_file() and FIXTURE.is_file()
        if shared:
            self.port, self.url = shared.port, shared.url
        else:
            with socket.socket() as s:
                s.bind(("127.0.0.1", 0)); self.port = s.getsockname()[1]
            self.url = f"http://127.0.0.1:{self.port}"
        self.env = {"PATH": f"{Path(self.node).parent}:/usr/bin:/bin", "HOME": str(self.home),
                    "TMPDIR": str(self.root), "TERM": "xterm-256color" if case == "esc" else "dumb",
                    "PI_OFFLINE": "1", "AWS_EC2_METADATA_DISABLED": "true",
                    "OS_CODING_AGENT_DIR": str(self.agent), "PI_CODING_AGENT_DIR": str(self.agent),
                    "PI_MCP_CONFIG_MODE": "exclusive", "CCT_DIR": str(self.cct),
                    "CCT_PORT": str(self.port), "CCT_BROKER": self.url,
                    "HARDENING_LOG": str(self.log), "HARDENING_MARKER": str(self.marker),
                    "HARDENING_PONG_TARGET_FILE": str(self.root / "pong-target") }
        if self.case == "locality-remote": self.env["CCT_BROKER"] = f"http://localhost.:{self.port}"
        if self.case == "locality-optin":
            self.env["CCT_BROKER"] = f"http://localhost.:{self.port}"
            self.env["CCT_OS_AUTO_WAKE_REMOTE"] = "1"
        if self.case == "locality-master-off": self.env["CCT_OS_AUTO_WAKE"] = "0"
        if case == "preflight-auth": self.env["HARDENING_AUTH_TEST"] = "1"
        self.env["HARDENING_TSX_LOADER"] = str(HERE / "node_modules/tsx/dist/loader.mjs")
        self.env["HARDENING_SERVER"] = str(HERE / "server.ts")
        self.env["HARDENING_SIBLING_LOG"] = str(self.root / "sibling.log")
        if case == "replacement": self.env["HARDENING_CANCEL_SWITCH"] = "1"
        if case in ("preflight", "preflight-fail"): self.env["HARDENING_DELAY_NOTICE"] = "1"
        self.host = self.broker = self.master = self.reader = None
        self.handles = []
        self.checks = []

    def setup(self):
        # Only adapter source files are staged; npm ci reads local cache offline,
        # never copies dependency trees or changes operator adapter/configuration.
        mirror = self.root / "adapter"
        shutil.copytree(self.adapter_source.parent, mirror,
            ignore=shutil.ignore_patterns(".git", "node_modules", ".venv", "__pycache__", ".pytest_cache", "__tests__", "examples", "conformance"))
        digest = hashlib.sha256(self.adapter_source.read_bytes()).hexdigest()
        assert digest == hashlib.sha256((mirror / "index.ts").read_bytes()).hexdigest()
        npm = shutil.which("npm")
        assert npm
        install_env = {"PATH": self.env["PATH"], "HOME": str(self.root),
                       "NPM_CONFIG_CACHE": str(Path.home() / ".npm"), "NPM_CONFIG_OFFLINE": "true"}
        with (self.root / "adapter-install.log").open("w") as out:
            subprocess.run([npm, "ci", "--offline", "--omit=dev", "--legacy-peer-deps",
                "--ignore-scripts", "--no-audit", "--no-fund"], cwd=mirror, env=install_env,
                stdout=out, stderr=subprocess.STDOUT, check=True, timeout=90)
        extensions = ([str(SLOW_INPUT)] if self.case in ("order", "order-red") else []) + [str(HERE / "os-extension.ts"), str(mirror / "index.ts"), str(FIXTURE)]
        (self.agent / "settings.json").write_text(json.dumps({
            "defaultProvider": "hardening-local", "defaultModel": "local",
            "defaultProjectTrust": "never", "compaction": {"enabled": False, "keepRecentTokens": 100}, "retry": {"enabled": False},
            "extensions": extensions, "packages": []}))
        if self.case == "order":
            installed = subprocess.run([self.node, "--import", str(HERE / "node_modules/tsx/dist/loader.mjs"),
                str(HERE / "cli.ts"), "install", "--os"], cwd=self.project,
                env=self.env, capture_output=True, text=True, timeout=40)
            (self.root / "scratch-install.log").write_text(installed.stdout + installed.stderr)
            assert installed.returncode == 0, installed.stdout + installed.stderr
            actual = json.loads((self.agent / "settings.json").read_text())["extensions"]
            assert actual == [str(HERE / "os-extension.ts"), str(SLOW_INPUT), str(mirror / "index.ts"), str(FIXTURE)], actual
        if self.case == "order-red":
            assert extensions.index(str(SLOW_INPUT)) < extensions.index(str(HERE / "os-extension.ts"))
        loader = HERE / "node_modules/tsx/dist/loader.mjs"
        assert loader.is_file()
        (self.agent / "mcp.json").write_text(json.dumps({"mcpServers": {"cct": {
            "command": self.node, "args": ["--import", str(loader), str(HERE / "server.ts")],
            "env": {"CCT_RUNTIME": "os", "CCT_TOOL_SURFACE": "compact"},
            "lifecycle": "keep-alive", "directTools": True, "toolPrefix": "none", "debug": True}}}))
        cmd = [str(self.os_bin), *([] if self.case == "esc" else ["--mode", "rpc"]),
               "--provider", "hardening-local", "--model", "local", "--no-skills",
               "--no-prompt-templates", "--no-context-files", "--no-approve", "--offline"]
        (self.root / "manifest.json").write_text(json.dumps({"case": self.case, "os": str(self.os_bin),
            "adapter_source": str(self.adapter_source), "adapter_loaded": str(mirror / "index.ts"),
            "adapter_sha256": digest, "source_sha256": {name: hashlib.sha256((HERE / name).read_bytes()).hexdigest()
                for name in ("os-extension.ts", "server.ts", "broker.ts", "test-fixtures/os/inbox-hardening-probe.ts")},
            "extension": str(HERE / "os-extension.ts"),
            "server": str(HERE / "server.ts"), "broker": str(HERE / "broker.ts"),
            "effective_global_extensions": json.loads((self.agent / "settings.json").read_text())["extensions"],
            "env_keys": sorted(self.env), "invocation": cmd, "broker_url": self.url}, indent=2))
        print("EVIDENCE", self.root, flush=True)
        if not self.shared:
            f = (self.root / "broker.log").open("w"); self.handles.append(f)
            self.broker = subprocess.Popen([self.node, "--import", str(loader), str(HERE / "broker.ts")],
                cwd=self.project, env=self.env, stdout=f, stderr=subprocess.STDOUT)
            self.await_(lambda: self.health(), process=self.broker, seconds=15)
        else:
            self.require("shared test-owned broker healthy", self.health())
        if self.case == "esc":
            self.master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
            self.host = subprocess.Popen(cmd, cwd=self.project, env=self.env, stdin=slave,
                stdout=slave, stderr=slave, start_new_session=True,
                preexec_fn=lambda: fcntl.ioctl(slave, termios.TIOCSCTTY, 0))
            os.close(slave)
            def capture():
                tail = b""
                with (self.root / "tui.raw").open("wb") as raw:
                    while True:
                        try:
                            ready, _, _ = select.select([self.master], [], [], .2)
                            if not ready:
                                if self.host.poll() is not None: break
                                continue
                            chunk = os.read(self.master, 65536)
                            if not chunk: break
                            raw.write(chunk); raw.flush()
                            data = tail + chunk
                            for _ in range(data.count(b"\x1b[6n")): os.write(self.master, b"\x1b[1;1R")
                            tail = data[-3:]
                        except OSError: break
            self.reader = threading.Thread(target=capture, daemon=True); self.reader.start()
        else:
            out = self.rpc_log.open("w"); err = (self.root / "stderr.log").open("w")
            self.handles += [out, err]
            self.host = subprocess.Popen(cmd, cwd=self.project, env=self.env, stdin=subprocess.PIPE,
                stdout=out, stderr=err, text=True)
        marker = self.await_(lambda: json.loads(self.marker.read_text()) if self.marker.exists() else None)
        row = self.await_(self.peer)
        self.peer_id = row[0]
        self.require("real installed session/peer", row[3] == "os:" + marker["sessionId"] and
            marker["pid"] == self.host.pid and not (self.home / ".pi").exists())
        self.await_(lambda: self.metadata() if self.metadata() and self.metadata()["producer"] else None)
        if self.case != "esc":
            self.require("quiet baseline", not self.kind("provider_request") and not self.rpc_type("agent_start"))
        else:
            import tty
            # Installed TUI under this PTY doesn't put its slave in raw mode;
            # make input byte-oriented at the harness boundary (not an os edit).
            tty.setraw(self.master)
            self.require("PTY is byte-oriented for real keyboard Esc",
                         not (termios.tcgetattr(self.master)[3] & termios.ICANON))

    def health(self):
        try:
            with urllib.request.urlopen(self.url + "/health", timeout=1) as r: return r.status == 200
        except Exception: return False

    def await_(self, fn, process=None, seconds=24):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            val = fn()
            if val: return val
            if (process or self.host).poll() is not None: raise RuntimeError("owned process exited while waiting")
            time.sleep(.05)
        raise TimeoutError(f"{self.case}: timeout {seconds}s waiting for concrete event; recent={self.kind()[-8:]}")

    def kind(self, name=None):
        data = records(self.log)
        return [e for e in data if e["kind"] == name] if name else data

    def rpc_type(self, name): return [e for e in records(self.rpc_log) if e.get("type") == name]

    def ui(self, method=None):
        events = [e for e in records(self.rpc_log) if e.get("type") == "extension_ui_request"]
        return [e for e in events if e.get("method") == method] if method else events

    def command(self, text):
        ident = self.rpc_send({"type": "prompt", "message": text})
        response = self.response(ident)
        self.require(f"real user command {text} accepted", response.get("success"))
        return response

    def peer(self):
        with sqlite3.connect(self.cct / "cct.db") as db:
            return db.execute("SELECT id,name,runtime,session_key FROM peers WHERE host_pid=? AND status='active'",
                              (self.host.pid,)).fetchone()

    def metadata(self):
        try: return json.loads((self.cct / "flags" / f"{self.peer_id}.os-notify").read_text())
        except (OSError, ValueError): return None

    def post(self, path, payload):
        req = urllib.request.Request(self.url + path, data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=3) as r: result = json.load(r)
        assert result["ok"], result
        return result

    def dm(self, label): return self.post("/message/send-cli", {"to_peer_id": self.peer_id, "body": label})

    def pool(self, label):
        self.post("/pool/create-cli", {"name": "hardening", "purpose": "isolated test"})
        self.post("/pool/invite-cli", {"pool_name": "hardening", "target_peer_id": self.peer_id})
        self.post("/message/send", {"peer_id": "cli", "pool_name": "hardening",
                                   "to_peer_id": self.peer_id, "body": label})

    def rpc_send(self, cmd):
        ident = f"hardening-{time.monotonic_ns()}"
        self.host.stdin.write(json.dumps({"id": ident, **cmd}) + "\n"); self.host.stdin.flush()
        return ident

    def response(self, ident):
        return self.await_(lambda: next((e for e in self.rpc_type("response") if e.get("id") == ident), None))

    def require(self, label, value):
        ok = bool(value)
        self.checks.append({"label": label, "pass": ok, "at": time.time()})
        print(("PASS " if ok else "RED ") + label, flush=True)
        if not ok: raise AssertionError(label)

    def close(self):
        if self.host and self.host.poll() is None:
            if self.master is not None:
                try: os.write(self.master, b"\x04")
                except OSError: pass
            else:
                try: self.host.stdin.close()
                except OSError: pass
            try: self.host.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.host.terminate()
                try: self.host.wait(timeout=4)
                except subprocess.TimeoutExpired: self.host.kill(); self.host.wait(timeout=4)
        if self.reader: self.reader.join(timeout=3)
        if self.master is not None: os.close(self.master)
        if self.broker and self.broker.poll() is None:
            self.broker.terminate()
            try: self.broker.wait(timeout=6)
            except subprocess.TimeoutExpired: self.broker.kill(); self.broker.wait(timeout=4)
        for f in self.handles: f.close()
        result = {"case": self.case, "checks": self.checks, "host_exit": self.host.returncode if self.host else None,
                  "broker_exit": self.broker.returncode if self.broker else None,
                  "events": self.kind(), "rpc_responses": self.rpc_type("response")}
        (self.root / "result.json").write_text(json.dumps(result, indent=2))
        print("OWNED_CLEANUP", json.dumps({k: result[k] for k in ("host_exit", "broker_exit")}), flush=True)


def run(h):
    h.setup()
    if h.case == "esc":
        os.write(h.master, b"HOLD")
        time.sleep(.3)
        os.write(h.master, b"\r")
        h.await_(lambda: h.kind("hold_enter"))
        h.dm("queued-before-esc")
        h.await_(lambda: h.metadata() if h.metadata()["maxDmId"] else None)
        # Three observer ticks before Esc while the tool stays pending. The
        # installed queue has no public observable custom-steer source API.
        time.sleep(3.2)
        h.require("DM eligible and notice not dequeued before Esc",
                  not h.kind("hold_exit") and not [e for e in h.kind("message_end")
                  if e.get("customType") == "cct-inbox-notice"])
        h.require("busy notice queued before Esc, hold not completed", len(h.kind("hold_exit")) == 0)
        h.require("TUI slave is in raw input mode before Esc",
                  not (termios.tcgetattr(h.master)[3] & termios.ICANON))
        os.write(h.master, b"\x1b")
        h.await_(lambda: h.kind("hold_abort") or h.kind("hold_exit"), seconds=9)
        h.require("real TUI Esc aborts still-pending tool", bool(h.kind("hold_abort")))
        h.await_(lambda: h.kind("agent_settled"))
        h.require("Esc discarded custom notice before model history",
                  not [e for e in h.kind("message_end") if e.get("customType") == "cct-inbox-notice"])
        time.sleep(2.5)
        h.require("Esc does not immediately restart cancelled task", len(h.kind("provider_request")) <= 1)
        os.write(h.master, b"HUMAN_AFTER_ESC")
        time.sleep(.25)
        os.write(h.master, b"\r")
        h.await_(lambda: any(e["lastText"] == "HUMAN_AFTER_ESC" for e in h.kind("provider_request")))
        h.await_(lambda: len(h.kind("agent_settled")) >= 2)
        time.sleep(2.2)
        h.require("later human work recovers queued notice via real checker",
                  any(e.get("toolName") == "cct_check_messages" and "queued-before-esc" in e.get("content", "")
                      for e in h.kind("tool_result")))
    elif h.case == "compaction":
        for i in range(5):
            ident = h.rpc_send({"type": "prompt", "message": f"COMPACTION_SEED_{i} " +
                                " ".join(f"word{j+i*12000}" for j in range(12000))})
            h.require("compaction seed accepted", h.response(ident).get("success"))
            h.await_(lambda: len(h.kind("agent_settled")) >= i + 1)
        baseline = len(h.kind("provider_request"))
        ident = h.rpc_send({"type": "compact", "customInstructions": "local fixture summary"})
        enter_at = h.await_(lambda: h.kind("compact_enter"))[0]["at"]
        h.dm("during-manual-compaction")
        time.sleep(max(0, 5.5 - (time.time() - enter_at / 1000)))
        h.require("actual manual compaction hook pending beyond five seconds", not h.kind("compact_exit"))
        h.require("no concurrent provider while compaction pending", len(h.kind("provider_request")) == baseline)
        h.await_(lambda: h.kind("compact_exit"))
        result = h.response(ident)
        h.require("manual compaction RPC completed successfully", result.get("success"))
        h.await_(lambda: checker_result(h, "during-manual-compaction"), seconds=18)
    elif h.case in ("tree-dm", "tree-pool"):
        ident = h.rpc_send({"type": "prompt", "message": "TREE_SEED"})
        h.require("seed human prompt accepted", h.response(ident).get("success"))
        h.await_(lambda: h.kind("agent_settled"))
        baseline = len(h.kind("provider_request"))
        ident = h.rpc_send({"type": "prompt", "message": "/hardening-tree"})
        h.await_(lambda: h.kind("tree_enter"))
        if h.case == "tree-dm": h.dm("during-tree-dm")
        else: h.pool("during-tree-pool")
        h.await_(lambda: h.metadata() if h.metadata()["count"] else None)
        time.sleep(2.5)
        h.require("non-running tree window has no concurrent provider request",
                  not h.kind("tree_exit") and len(h.kind("provider_request")) == baseline)
        h.await_(lambda: h.kind("tree_done"), seconds=12)
        h.require("tree command completed", h.response(ident).get("success"))
        if h.case == "tree-dm":
            h.await_(lambda: [e for e in h.kind("tool_result") if e.get("toolName") == "cct_check_messages"
                                    and "during-tree-dm" in e.get("content", "")], seconds=12)
        else:
            time.sleep(2.5)
            h.require("pool-only remains quiet after tree", len(h.kind("provider_request")) == baseline)
    elif h.case in ("order", "order-red"):
        ident = h.rpc_send({"type": "prompt", "message": "SLOW_INPUT_ORDER"})
        enter_at = h.await_(lambda: h.kind("slow_input_enter"))[0]["at"]
        h.dm("during-installed-slow-input")
        h.await_(lambda: h.metadata() if h.metadata()["maxDmId"] else None)
        time.sleep(max(0, 5.5 - (time.time() - enter_at / 1000)))
        h.require("installed slow input actually pending beyond five seconds", not h.kind("slow_input_exit"))
        if h.case == "order": h.require("no model request while slow input unresolved", not h.kind("provider_request"))
        exit_at = h.await_(lambda: h.kind("slow_input_exit"))[0]["at"]
        response = h.response(ident)
        h.require("actual human prompt succeeds after installed slow input", response.get("success"))
        h.await_(lambda: any(e.get("lastText") == "SLOW_INPUT_ORDER" for e in h.kind("provider_request")))
        h.require("human request first; no autonomous request before slow handler exits",
                  not [e for e in h.kind("provider_request") if e["at"] < exit_at])
        h.await_(lambda: checker_result(h, "during-installed-slow-input"), seconds=20)
    elif h.case in ("preflight", "preflight-fail"):
        prompt = "PREFLIGHT_SLOW" if h.case == "preflight" else "PREFLIGHT_FAIL"
        ident = h.rpc_send({"type": "prompt", "message": prompt})
        h.await_(lambda: h.kind("preflight_enter"))
        h.dm("during-slow-preflight")
        h.await_(lambda: h.metadata() if h.metadata()["maxDmId"] else None)
        remaining = 5.5 - (time.time() - h.kind("preflight_enter")[0]["at"] / 1000)
        time.sleep(max(0, remaining))
        h.require("human preflight still pending >5s", not h.kind("preflight_exit"))
        exit_at = h.await_(lambda: h.kind("preflight_exit"))[0]["at"]
        competing = [e for e in h.kind("provider_request") if e["at"] < exit_at]
        result = h.response(ident)
        h.require("no competing provider during trusted human preflight", not competing)
        if h.case == "preflight":
            h.require("human prompt accepted", result.get("success"))
            h.await_(lambda: any(e["lastText"] == prompt for e in h.kind("provider_request")))
        else:
            # Installed os catches before_agent_start handler exceptions and proceeds;
            # this is NOT a failed RPC preflight. Check the observed host behavior
            # explicitly rather than relabel a successful human run as failure.
            h.require("installed host swallowed handler throw and human request ran",
                      result.get("success") and any(e["lastText"] == prompt for e in h.kind("provider_request")))
            print("GAP preflight-fail: handler throw is not an installed failed-preflight path", flush=True)
    elif h.case == "preflight-auth":
        h.require("fixture starts with no synthetic auth and no inherited provider credentials",
                  "HARDENING_SYNTHETIC_AUTH" not in h.env and not h.kind("provider_request"))
        ident = h.rpc_send({"type": "prompt", "message": "AUTH_FAILURE_REAL_PROMPT"})
        result = h.response(ident)
        h.require("installed host genuinely rejected unauthenticated prompt before provider",
                  result.get("success") is False and not h.kind("provider_request"))
        h.dm("auth-failed-preflight-dm")
        h.await_(lambda: h.metadata() if h.metadata() and h.metadata()["maxDmId"] else None)
        quiet_before = len(h.kind("provider_request"))
        time.sleep(3)
        h.require("no unauthorized provider while failed preflight paused", len(h.kind("provider_request")) == quiet_before)
        h.command("/cct-wake status")
        h.await_(lambda: [e for e in h.ui("notify") if "prompt preflight pending/failed" in e.get("message", "")])
        h.command("/hardening-enable-auth")
        h.require("synthetic auth enabled by real fixture command, never real credentials", bool(h.kind("auth_enabled")))
        h.command("/cct-wake resume")
        h.await_(lambda: checker_result(h, "auth-failed-preflight-dm"), seconds=18)
        h.require("real resume recovers paused DM using synthetic-only auth",
                  bool(h.kind("provider_request")) and bool(checker_result(h, "auth-failed-preflight-dm")))
    elif h.case == "owner-recovery":
        original = (h.cct / "pidmaps" / f"os_{json.loads(h.marker.read_text())['sessionId']}").read_text().split("|")[2]
        h.command("/hardening-owner-spawn")
        event = h.await_(lambda: h.kind("owner_sibling_spawn"))[-1]
        sibling_pid = event["pid"]
        h.require("fixture spawned real owned server under installed os host", sibling_pid > 0)
        wait_for_owner = lambda: h.metadata() and h.metadata().get("producer", "").startswith(f"{sibling_pid}-")
        h.await_(wait_for_owner, seconds=22)
        h.require("fixture child is actual metadata B owner, original adapter MCP still alive",
                  wait_for_owner() and h.peer() and h.peer()[0] == h.peer_id)
        h.command("/hardening-owner-stop")
        h.await_(lambda: h.metadata() and h.metadata().get("producer") == original, seconds=22)
        h.require("original adapter MCP automatically reclaimed metadata B without checker or reconnect",
                  h.metadata()["producer"] == original and not h.kind("provider_request"))
        h.dm("owner-recovered-dm")
        h.await_(lambda: checker_result(h, "owner-recovered-dm"), seconds=18)
    elif h.case == "handled":
        ident = h.rpc_send({"type": "prompt", "message": "PREFLIGHT_HANDLED"})
        h.require("handled input returned without model", h.response(ident).get("success") and h.kind("input_handled"))
        h.dm("after-handled")
        h.await_(lambda: h.metadata() if h.metadata()["maxDmId"] else None)
        h.require("swallowed preflight leaves no model run", not h.kind("provider_request"))
        h.command("/cct-wake status")
        h.await_(lambda: [e for e in h.ui("notify") if "prompt preflight pending/failed" in e.get("message", "")])
        h.require("handled preflight exposes visible pause", not h.kind("provider_request"))
        h.command("/cct-wake resume")
        h.await_(lambda: checker_result(h, "after-handled"), seconds=18)
        h.require("explicit resume recovers unread handled-input DM", bool(checker_result(h, "after-handled")))
    else:  # replacement
        h.dm("replacement-pending")
        h.await_(lambda: h.metadata() if h.metadata()["maxDmId"] else None)
        ident = h.rpc_send({"type": "new_session"})
        h.await_(lambda: h.kind("switch_cancel"))
        h.require("replacement cancelled in installed host", h.response(ident).get("data", {}).get("cancelled") is True)
        time.sleep(2.2)
        h.command("/cct-wake status")
        h.await_(lambda: [e for e in h.ui("notify") if "replacement pending" in e.get("message", "")])
        h.require("cancelled replacement visibly paused", not h.kind("provider_request"))
        h.command("/cct-wake resume")
        h.await_(lambda: checker_result(h, "replacement-pending"), seconds=18)
        h.require("resume after cancelled operation recovers pending DM", bool(checker_result(h, "replacement-pending")))


def checker_result(h, label):
    return [e for e in h.kind("tool_result") if e.get("toolName") == "cct_check_messages" and label in e.get("content", "")]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", choices=["esc", "tree-dm", "tree-pool", "preflight", "preflight-fail", "preflight-auth", "owner-recovery",
                                           "handled", "replacement", "order", "order-red", "compaction"], required=True)
    args = parser.parse_args()
    h = Harness(args.case)
    try:
        run(h)
        if args.case == "preflight-fail":
            print("GAP preflight-fail: exception swallowed by installed host, not failed preflight", flush=True)
        else:
            print("GREEN", args.case, flush=True)
    except BaseException as e:
        print("FAIL", args.case, repr(e), flush=True)
        (h.root / "failure.txt").write_text(repr(e) + "\n")
        raise
    finally: h.close()


if __name__ == "__main__": main()
