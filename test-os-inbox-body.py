#!/usr/bin/env python3
"""Private installed-os DM body acceptance; never calls cct_check_messages.

Default: idle body -> held synthetic response (SQLite still unread) -> success ->
receipt/SQLite ack; second DM; duplicate polls and quiet interval. Extra cases:
error (same-DM automatic retry), abort (no unsolicited restart; human recovery), busy,
burst and settle-boundary arrivals. All inference is in-process synthetic. Evidence is retained in /private/tmp.
CCT_OS_BIN and CCT_OS_ADAPTER override read-only installed runtime/source paths.
"""
import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.request

HERE = Path(__file__).resolve().parent
RUNTIME = Path(os.environ.get("CCT_PACKAGE_ROOT", HERE)).resolve()
FIXTURE = HERE / "test-fixtures/os/inbox-body-probe.ts"
DEFAULT_ADAPTER = "/Users/tyo/.os/agent/packages/pi-mcp-adapter-2.33.0-cfbade44/index.ts"


def records(path):
    if not path.exists():
        return []
    # Ignore only an in-progress final record; JSONL uses LF, not Unicode separators.
    data = path.read_text()
    return [json.loads(line) for line in data.split("\n")[:-1] if line.strip()]


def json_file(path):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return None


class Harness:
    def __init__(self, args):
        self.args = args
        self.root = Path(tempfile.mkdtemp(prefix="cct-inbox-body-", dir="/private/tmp"))
        self.root.chmod(0o700)
        self.home = self.root / "home"
        self.agent = self.home / ".os/agent"
        self.project = self.root / "project"
        self.cct = self.root / "cct"
        self.control = self.root / "control"
        for directory in (self.agent, self.project, self.cct, self.control):
            directory.mkdir(parents=True, mode=0o700)
        self.host = self.broker = None
        self.handles = []
        self.checks = []
        self.sent = []
        self.peer_id = None
        self.failure = None
        self.passed = False
        self.sidecars = []
        self.last_sidecars = {}
        print("EVIDENCE", self.root, flush=True)

    def events(self, kind=None):
        events = records(self.root / "provider.jsonl")
        return [e for e in events if e["kind"] == kind] if kind else events

    def rpc(self, kind=None):
        events = records(self.root / "rpc.jsonl")
        return [e for e in events if e.get("type") == kind] if kind else events

    def require(self, label, value):
        self.checks.append({"label": label, "passed": bool(value), "at": time.time()})
        print(("PASS " if value else "RED ") + label, flush=True)
        assert value, label

    def observe(self):
        if not self.peer_id:
            return
        for suffix in ("os-inbox", "os-receipt", "os-notify"):
            value = json_file(self.cct / "flags" / f"{self.peer_id}.{suffix}")
            if value != self.last_sidecars.get(suffix):
                event = {"at": time.time(), "suffix": suffix, "value": value}
                self.sidecars.append(event)
                self.last_sidecars[suffix] = value
                with (self.root / "sidecars.jsonl").open("a") as out:
                    out.write(json.dumps(event) + "\n")

    def until(self, label, predicate, seconds=25, process=None):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.observe()
            result = predicate()
            if result:
                return result
            proc = process or self.host
            if proc and proc.poll() is not None:
                raise AssertionError(f"{label}: owned process exited {proc.returncode}")
            time.sleep(.025)
        raise AssertionError(f"{label}: timeout after {seconds}s")

    def quiet(self, seconds, requests, ids=()):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.observe()
            assert self.host.poll() is None, "owned host exited during quiet interval"
            assert len(self.events("provider_request")) == requests, "duplicate/unsolicited provider request"
            assert not self.events("provider_timeout"), "synthetic provider control timed out"
            for ident in ids:
                assert self.read_at(ident) is None, f"DM {ident} acknowledged before successful response"
            time.sleep(.05)

    def db(self, sql, params=()):
        # Read-only SQLite verification, never the fixture or harness doing the ack.
        with sqlite3.connect(f"file:{self.cct / 'cct.db'}?mode=ro", uri=True) as db:
            return db.execute(sql, params).fetchall()

    def peer(self):
        rows = self.db("SELECT id,runtime,session_key,pid FROM peers WHERE host_pid=? AND status='active'", (self.host.pid,))
        return rows[0] if rows else None

    def read_at(self, ident):
        rows = self.db("SELECT read_at FROM message_recipients WHERE peer_id=? AND message_id=?", (self.peer_id, ident))
        assert len(rows) == 1, (ident, rows)
        return rows[0][0]

    def post(self, route, payload):
        # No message/read, message/check, or message/peek call exists in this harness.
        assert route == "/message/send-cli"
        request = urllib.request.Request(self.url + route, data=json.dumps(payload).encode(),
                                         headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=3) as response:
            result = json.load(response)
        assert result["ok"], result
        return result

    def dm(self, body):
        result = self.post("/message/send-cli", {"to_peer_id": self.peer_id, "body": body})
        rows = self.db("SELECT m.id FROM messages m JOIN message_recipients r ON m.id=r.message_id "
                       "WHERE r.peer_id=? AND m.body=?", (self.peer_id, body))
        assert len(rows) == 1, result
        ident = rows[0][0]
        self.sent.append({"id": ident, "body": body, "at": time.time()})
        assert self.read_at(ident) is None
        return ident

    def command(self, kind, **kwargs):
        cmd = {"id": f"body-{time.monotonic_ns()}", "type": kind, **kwargs}
        with (self.root / "commands.jsonl").open("a") as out:
            out.write(json.dumps(cmd) + "\n")
        self.host.stdin.write(json.dumps(cmd) + "\n")
        self.host.stdin.flush()
        result = self.until(f"RPC {kind}", lambda: next((e for e in self.rpc("response") if e.get("id") == cmd["id"]), None))
        self.require(f"RPC {kind} accepted", result.get("success"))

    def release(self, number):
        (self.control / f"release-{number}").touch()

    def request(self, number, bodies):
        result = self.until(f"provider request {number}", lambda: next(
            (e for e in self.events("provider_request") if e["number"] == number), None))
        self.require(f"request {number} contains actual DM BODY (not a check-inbox notice)",
                     all(any(body in text for text in result["texts"]) for body in bodies))
        self.require("synthetic local model only", result["model"] == "inbox-body-local/local")
        self.no_checker()
        return result

    def no_checker(self):
        self.require("zero cct_check_messages calls (including gateway-mediated calls)", all(
            e.get("toolName") == "inbox_body_wait" for e in self.events("tool_call") + self.rpc("tool_execution_start")))

    def custom(self, ident, body):
        messages = [e["message"] for e in self.rpc("message_end") if e.get("message", {}).get("customType") == "cct-inbox"]
        # Boundary drafts are persisted via entry_appended, not message_end.
        messages += [e["entry"] for e in self.rpc("entry_appended") if
                     e.get("entry", {}).get("type") == "custom_message" and
                     e["entry"].get("customType") == "cct-inbox"]
        matches = [m for m in messages if ident in m.get("details", {}).get("ids", [])]
        self.require(f"DM {ident} in genuine cct-inbox custom message", bool(matches) and all(
            m["details"].get("version") == 1 and m["details"].get("peerId") == self.peer_id and
            m["details"].get("sessionId") == self.marker["sessionId"] and body in json.dumps(m["content"], ensure_ascii=False)
            for m in matches))

    def ack(self, ids, response):
        self.until(f"successful assistant response {response}", lambda: any(
            e.get("message", {}).get("role") == "assistant" and
            e["message"].get("stopReason") == "stop" and
            f"Synthetic response {response} complete." in json.dumps(e["message"]) for e in self.rpc("message_end")))
        self.until(f"server acknowledges only completed response {response}", lambda: all(self.read_at(i) is not None for i in ids))
        self.require("successful response followed by authoritative read_at", all(self.read_at(i) is not None for i in ids))
        finish = next(e for e in self.events("provider_finish") if e["number"] == response and e["reason"] == "stop")
        self.require("read_at timestamp is not earlier than successful provider completion", all(
            datetime.fromisoformat(self.read_at(i).replace("Z", "+00:00")).timestamp() * 1000 >= finish["at"] - 1
            for i in ids))
        # Snapshot receipt when observable; read_at is the authoritative acceptance gate.
        # The resident server may atomically consume/delete a receipt between observer ticks.
        self.observe()
        self.until("agent settled", lambda: len(self.events("agent_settled")) >=
                   (1 if self.args.case in ("busy", "settle") else response))

    def setup(self):
        node = shutil.which("node")
        os_bin = Path(os.environ.get("CCT_OS_BIN") or shutil.which("os") or "").resolve()
        assert node and os_bin.is_file() and os_bin.name == "cli.js" and "@the-omics-os/os/dist/bundle" in str(os_bin), os_bin
        loader = Path(subprocess.check_output([node, "--input-type=module", "-e",
            "import {createRequire} from 'node:module'; process.stdout.write(createRequire(" +
            json.dumps((RUNTIME / "package.json").as_uri()) + ").resolve('tsx'));"], text=True))
        assert loader.is_file()
        adapter = Path(os.environ.get("CCT_OS_ADAPTER", DEFAULT_ADAPTER)).expanduser().resolve()
        assert adapter.is_file()
        loaded = adapter
        if not (adapter.parent / "node_modules").is_dir():
            mirror = self.root / "adapter"
            shutil.copytree(adapter.parent, mirror, ignore=shutil.ignore_patterns(
                ".git", "node_modules", ".venv", "__pycache__", ".pytest_cache", "__tests__", "examples", "conformance"))
            with (self.root / "adapter-install.log").open("w") as out:
                subprocess.run([shutil.which("npm"), "ci", "--offline", "--omit=dev", "--legacy-peer-deps",
                    "--ignore-scripts", "--no-audit", "--no-fund"], cwd=mirror,
                    env={"PATH": f"{Path(node).parent}:/usr/bin:/bin", "HOME": str(self.home),
                         "NPM_CONFIG_CACHE": str(Path.home() / ".npm"), "NPM_CONFIG_OFFLINE": "true"},
                    stdout=out, stderr=subprocess.STDOUT, timeout=90, check=True)
            loaded = mirror / "index.ts"
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        self.url = f"http://127.0.0.1:{port}"
        env = {"PATH": f"{Path(node).parent}:/usr/bin:/bin", "HOME": str(self.home), "TMPDIR": str(self.root),
               "TERM": "dumb", "PI_OFFLINE": "1", "AWS_EC2_METADATA_DISABLED": "true",
               "OS_CODING_AGENT_DIR": str(self.agent), "PI_CODING_AGENT_DIR": str(self.agent),
               "PI_MCP_CONFIG_MODE": "exclusive", "CCT_DIR": str(self.cct), "CCT_PORT": str(port),
               "CCT_BROKER": self.url, "INBOX_BODY_CONTROL": str(self.control),
               "INBOX_BODY_LOG": str(self.root / "provider.jsonl"), "INBOX_BODY_MARKER": str(self.root / "marker.json")}
        extension = RUNTIME / os.environ.get("CCT_INBOX_EXTENSION", "os-extension.ts")
        extensions = [str(extension), str(loaded), str(FIXTURE)]
        (self.agent / "settings.json").write_text(json.dumps({"defaultProvider": "inbox-body-local", "defaultModel": "local",
            "defaultProjectTrust": "never", "compaction": {"enabled": False}, "retry": {"enabled": False},
            "extensions": extensions, "packages": []}))
        (self.agent / "mcp.json").write_text(json.dumps({"mcpServers": {"cct": {
            "command": node, "args": ["--import", str(loader), str(RUNTIME / "server.ts")],
            "env": {"CCT_RUNTIME": "os", "CCT_TOOL_SURFACE": "compact", "CCT_OS_INBOX_BODY": "1"},
            "lifecycle": "keep-alive", "directTools": True, "toolPrefix": "none", "debug": True}}}))
        cmd = [str(os_bin), "--mode", "rpc", "--provider", "inbox-body-local", "--model", "local",
               "--no-builtin-tools", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve", "--offline"]
        manifest = {"case": self.args.case, "os": str(os_bin),
                    "version": json_file(os_bin.parents[2] / "package.json")["version"],
                    "adapter_source": str(adapter), "adapter_loaded": str(loaded), "extensions": extensions,
                    "source_sha256": {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in
                                      (adapter, RUNTIME / "server.ts", RUNTIME / "broker.ts", extension, FIXTURE)},
                    "invocation": cmd, "env_keys": sorted(env), "broker_url": self.url,
                    "external_inference": False, "quiet_seconds": self.args.quiet_seconds}
        (self.root / "manifest.json").write_text(json.dumps(manifest, indent=2))
        def output(name):
            handle = (self.root / name).open("w")
            self.handles.append(handle)
            return handle
        self.broker = subprocess.Popen([node, "--import", str(loader), str(RUNTIME / "broker.ts")],
            cwd=self.project, env=env, stdout=output("broker.log"), stderr=subprocess.STDOUT)
        def health():
            try:
                with urllib.request.urlopen(self.url + "/health", timeout=1) as response:
                    return response.status == 200
            except OSError:
                return False
        self.until("private broker startup", health, process=self.broker, seconds=15)
        self.host = subprocess.Popen(cmd, cwd=self.project, env=env, stdin=subprocess.PIPE,
            stdout=output("rpc.jsonl"), stderr=output("stderr.log"), text=True)
        self.marker = self.until("installed extension startup", lambda: json_file(self.root / "marker.json"))
        peer = self.until("resident MCP registration", self.peer)
        self.peer_id = peer[0]
        self.require("private installed RPC session + resident MCP identity", peer[1] == "os" and
                     peer[2] == "os:" + self.marker["sessionId"] and self.marker["pid"] == self.host.pid)
        # Accept old metadata here so the RED baseline reaches the body assertion,
        # rather than stopping early merely because the new feed is not implemented.
        self.until("resident metadata", lambda: json_file(self.cct / "flags" / f"{self.peer_id}.os-notify") or
                   json_file(self.cct / "flags" / f"{self.peer_id}.os-inbox"))
        self.quiet(2.3, 0)
        self.require("quiet startup without user prompt", not self.rpc("agent_start"))

    def close(self):
        self.observe()
        if self.host and self.host.poll() is None:
            try:
                self.host.stdin.close()
                self.host.wait(timeout=8)
            except (OSError, subprocess.TimeoutExpired):
                self.host.terminate()
                try:
                    self.host.wait(timeout=4)
                except subprocess.TimeoutExpired:
                    self.host.kill()
                    self.host.wait(timeout=4)
        if self.broker and self.broker.poll() is None:
            self.broker.terminate()
            try:
                self.broker.wait(timeout=6)
            except subprocess.TimeoutExpired:
                self.broker.kill()
                self.broker.wait(timeout=4)
        for handle in self.handles:
            handle.close()
        active = self.db("SELECT COUNT(*) FROM peers WHERE host_pid=? AND status='active'", (self.host.pid,))[0][0] if self.host else None
        cleanup = {"host_exit": self.host.returncode if self.host else None,
                   "broker_exit": self.broker.returncode if self.broker else None, "active_owned_peers": active,
                   "pidmaps_remaining": sorted(p.name for p in (self.cct / "pidmaps").glob("*"))}
        cleanup_ok = cleanup == {"host_exit": 0, "broker_exit": 0, "active_owned_peers": 0, "pidmaps_remaining": []}
        receipt = {"passed": self.passed and cleanup_ok, "case": self.args.case, "failure": self.failure,
                   "checks": self.checks, "sent": self.sent, "cleanup": cleanup,
                   "read_at": {str(m["id"]): self.read_at(m["id"]) for m in self.sent},
                   "provider_requests": len(self.events("provider_request")),
                   "evidence_dir": str(self.root), "sidecar_snapshots": self.sidecars}
        (self.root / "receipt.json").write_text(json.dumps(receipt, indent=2))
        print("OWNED_CLEANUP", json.dumps(cleanup), flush=True)
        if self.passed:
            assert cleanup_ok, cleanup


def run(h):
    h.setup()
    if h.args.case == "busy":
        h.command("prompt", message="BODY_BUSY")
        h.until("initial busy request", lambda: h.events("provider_request"))
        h.release(1)
        h.until("ordinary tool pending", lambda: h.events("tool_enter"))
        body = "body-busy-payload-42"
        ident = h.dm(body)
        h.quiet(3.2, 1, [ident])
        (h.control / "release-tool").touch()
        h.request(2, [body])
        h.custom(ident, body)
        h.require("ordinary tool completed before body model request", bool(h.events("tool_exit")))
        h.quiet(2.3, 2, [ident])
        h.release(2)
        h.ack([ident], 2)
        h.quiet(h.args.quiet_seconds, 2)
    else:
        bodies = ["body-first-payload-7f2b"] if h.args.case != "burst" else [f"body-burst-payload-{i}" for i in range(3)]
        ids = [h.dm(body) for body in bodies]
        h.request(1, bodies)
        h.require("first body request had no user prompt", not (h.root / "commands.jsonl").exists() and
                  not [e for e in h.rpc("message_end") if e.get("message", {}).get("role") == "user"])
        for ident, body in zip(ids, bodies):
            h.custom(ident, body)
        h.quiet(3.2, 1, ids)
        h.require("body delivery/history and repeated polls do not acknowledge held response", all(h.read_at(i) is None for i in ids))
        if h.args.case in ("error", "abort"):
            if h.args.case == "error":
                (h.control / "error-once").touch()
                h.release(1)
                h.until("deliberate provider error", lambda: any(e["reason"] == "error" for e in h.events("provider_finish")))
            else:
                h.command("abort")
                h.until("real AbortSignal", lambda: h.events("provider_abort_signal"))
            h.until("failed/aborted run settled", lambda: h.events("agent_settled"))
            h.require("failed/aborted DM remains unread", all(h.read_at(i) is None for i in ids))
            if h.args.case == "abort":
                h.quiet(3.2, 1, ids)
                h.require("abort does not restart automatically", len(h.events("provider_request")) == 1)
                h.command("prompt", message="Human retry of pending inbox work; no new DM.")
            h.request(2, bodies)
            if h.args.case == "error":
                h.require("same-DM retry needs no human input or newer DM", not (h.root / "commands.jsonl").exists())
            h.quiet(2.3, 2, ids)
            h.release(2)
            h.ack(ids, 2)
            h.quiet(h.args.quiet_seconds, 2)
        elif h.args.case == "settle":
            body = "body-arrived-before-settle-18c"
            ident = h.dm(body)
            h.quiet(3.2, 1, ids + [ident])
            h.release(1)
            h.request(2, [body])
            h.custom(ident, body)
            h.require("settle continuation occurs before outer settlement", not h.events("agent_settled"))
            h.quiet(2.3, 2, [ident])
            h.release(2)
            h.ack([ident], 2)
            h.require("first batch acknowledged after first response", all(h.read_at(i) is not None for i in ids))
            h.quiet(h.args.quiet_seconds, 2)
        else:
            h.release(1)
            h.ack(ids, 1)
            h.quiet(3.2, 1)
            body = "body-second-payload-e91a"
            ident = h.dm(body)
            h.request(2, [body])
            h.custom(ident, body)
            h.quiet(2.3, 2, [ident])
            h.release(2)
            h.ack([ident], 2)
            h.quiet(h.args.quiet_seconds, 2)
            messages = [e["message"] for e in h.rpc("message_end") if e.get("message", {}).get("customType") == "cct-inbox"]
            delivered = [i for message in messages for i in message["details"]["ids"]]
            h.require("each DM body injected exactly once", sorted(delivered) == sorted(ids + [ident]))
    h.no_checker()
    h.require("no fixture timeout or extension error", not h.events("provider_timeout") and not h.rpc("extension_error"))
    h.require("private quiet interval produced no extra runs", True)
    h.passed = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", choices=["idle", "error", "abort", "busy", "burst", "settle"], default="idle")
    parser.add_argument("--quiet-seconds", type=float, default=6.2, help="private final idle observation (not long-soak acceptance)")
    args = parser.parse_args()
    if not 2 <= args.quiet_seconds <= 900:
        parser.error("--quiet-seconds must be between 2 and 900")
    h = Harness(args)
    try:
        run(h)
    except BaseException as exc:
        h.failure = repr(exc)
        print("RED", h.failure, flush=True)
        raise
    finally:
        h.close()
    print("GREEN", args.case, flush=True)


if __name__ == "__main__":
    main()
