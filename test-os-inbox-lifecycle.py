#!/usr/bin/env python3
"""Private installed-os lifecycle acceptance (canonical extension selected).

Actual keyboard Esc over PTY; graceful process restart with --session; actual
/reload; native RPC compact while cancelled body is pending. No inbox tool or
message-read endpoint is called. Provider input + read-only SQLite are the gates.
Evidence stays in /private/tmp; no operator config or credentials are imported.
"""
import argparse
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import pty
import select
import struct
import subprocess
import sys
import termios
import threading
import time
import tty

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True  # Import reuse must not leave files outside our two owned sources.
spec = importlib.util.spec_from_file_location("body_harness", HERE / "test-os-inbox-body.py")
body = importlib.util.module_from_spec(spec)
spec.loader.exec_module(body)
body.FIXTURE = HERE / "test-fixtures/os/inbox-lifecycle-probe.ts"
# Exercise the canonical source that the installer selects.
os.environ.setdefault("CCT_INBOX_EXTENSION", "os-extension.ts")


class Lifecycle(body.Harness):
    def __init__(self, args):
        super().__init__(args)
        self.master = None
        self.reader = None
        self.launch_cmd = self.launch_env = None
        self.log_name = "provider.jsonl"
        self.rpc_name = "rpc.jsonl"
        self.hosts = []
        self.owned_seen = set()

    def observe_children(self):
        owned = self.owned_seen | {p.pid for p in self.hosts}
        if self.broker: owned.add(self.broker.pid)
        rows = [line.split() for line in subprocess.check_output(["ps", "-axo", "pid=,ppid="], text=True).splitlines()]
        while True:
            expanded = owned | {int(pid) for pid, parent in rows if int(parent) in owned}
            if expanded == owned: break
            owned = expanded
        self.owned_seen = owned
        return owned

    def events(self, kind=None):
        events = body.records(self.root / self.log_name)
        return [e for e in events if e["kind"] == kind] if kind else events

    def rpc(self, kind=None):
        events = body.records(self.root / self.rpc_name)
        return [e for e in events if e.get("type") == kind] if kind else events

    def setup(self):
        # Reuse the isolated broker/adapter/settings setup, modifying only the
        # private launch before Popen. No source/installed configuration writes.
        original = subprocess.Popen
        def launch(cmd, **kwargs):
            if cmd[0].endswith("/cli.js"):
                settings = self.agent / "settings.json"
                value = json.loads(settings.read_text())
                value["compaction"] = {"enabled": False, "keepRecentTokens": 64, "reserveTokens": 1024}
                settings.write_text(json.dumps(value))
                kwargs["env"]["OS_MODEL_CATALOG_DISABLE"] = "1"
                self.launch_cmd, self.launch_env = list(cmd), dict(kwargs["env"])
                if self.args.case == "esc":
                    cmd = [p for i, p in enumerate(cmd) if i not in (1, 2)]
                    self.launch_cmd = list(cmd)
                    kwargs["env"]["TERM"] = "xterm-256color"
                    first_run = self.home / ".os/first-run.json"
                    first_run.parent.mkdir(parents=True, exist_ok=True)
                    first_run.write_text(json.dumps({"shownAt": "2026-01-01T00:00:00Z", "completedAt": "2026-01-01T00:00:00Z"}))
                    self.master, slave = pty.openpty()
                    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
                    kwargs.update(stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
                                  preexec_fn=lambda: fcntl.ioctl(slave, termios.TIOCSCTTY, 0))
                    kwargs.pop("text", None)
                    proc = original(cmd, **kwargs)
                    os.close(slave)
                    def capture():
                        tail = b""
                        with (self.root / "tui.raw").open("wb") as raw:
                            while True:
                                try:
                                    ready, _, _ = select.select([self.master], [], [], .2)
                                    if not ready:
                                        if proc.poll() is not None: break
                                        continue
                                    chunk = os.read(self.master, 65536)
                                    if not chunk: break
                                    raw.write(chunk); raw.flush()
                                    data = tail + chunk
                                    for _ in range(data.count(b"\x1b[6n")):
                                        os.write(self.master, b"\x1b[1;1R")
                                    tail = data[-3:]
                                except OSError: break
                    self.reader = threading.Thread(target=capture, daemon=True)
                    self.reader.start()
                else:
                    proc = original(cmd, **kwargs)
                self.hosts.append(proc)
                return proc
            return original(cmd, **kwargs)
        subprocess.Popen = launch
        try:
            super().setup()
        finally:
            subprocess.Popen = original
        if self.master is not None:
            tty.setraw(self.master)
            self.require("genuine installed TUI and byte-oriented PTY", self.marker["mode"] == "tui" and
                         not (termios.tcgetattr(self.master)[3] & termios.ICANON))
        manifest = body.json_file(self.root / "manifest.json")
        manifest.update(invocation=self.launch_cmd, lifecycle_fixture=str(body.FIXTURE),
                        mode=self.marker["mode"], lifecycle="real host, no mocked APIs")
        manifest["source_sha256"].update({str(p): body.hashlib.sha256(p.read_bytes()).hexdigest() for p in
            (Path(__file__), HERE / "test-os-inbox-body.py", HERE / "test-fixtures/os/inbox-body-probe.ts")})
        (self.root / "manifest.json").write_text(json.dumps(manifest, indent=2))

    def keys(self, data):
        with (self.root / "keyboard.jsonl").open("a") as out:
            out.write(json.dumps({"at": time.time(), "hex": data.hex()}) + "\n")
        os.write(self.master, data)

    def prompt(self, text):
        if self.master is not None:
            self.keys(text.encode() + b"\r")
        else:
            self.command("prompt", message=text)

    def no_checker(self):
        all_events = []
        for name in ("provider.jsonl", "provider-resumed.jsonl"):
            all_events += body.records(self.root / name)
        all_rpc = body.records(self.root / "rpc.jsonl") + body.records(self.root / "rpc-resumed.jsonl")
        calls = [e for e in all_events if e["kind"] == "tool_call"] + [e for e in all_rpc if e.get("type") == "tool_execution_start"]
        self.require("zero model tool calls, including cct_check_messages", not calls)

    def ack(self, ids, response):
        self.until("successful response", lambda: any(e["number"] == response and e["reason"] == "stop"
                                                     for e in self.events("provider_finish")))
        self.until("authoritative server read_at", lambda: all(self.read_at(i) is not None for i in ids))
        finish = next(e for e in self.events("provider_finish") if e["number"] == response and e["reason"] == "stop")
        self.require("SQLite ack only after successful body response", all(
            body.datetime.fromisoformat(self.read_at(i).replace("Z", "+00:00")).timestamp() * 1000 >= finish["at"] - 1
            for i in ids))
        self.until("real response run settles", lambda: any(e["at"] >= finish["at"] for e in self.events("agent_settled")))

    def cancel(self, number, ids):
        if self.master is not None:
            self.keys(b"\x1b")  # Actual app keybinding, NOT ctx.abort or RPC abort.
        else:
            self.command("abort")
        self.until("real provider AbortSignal", lambda: any(e["number"] == number for e in self.events("provider_abort_signal")))
        self.until("cancelled host settles", lambda: self.events("agent_settled"))
        self.quiet(self.args.quiet_seconds, number, ids)
        self.require("cancellation preserves unread and prevents unsolicited restart", all(self.read_at(i) is None for i in ids))

    def stop_host(self):
        self.observe_children()  # Include the old MCP children before restart reparents anything.
        if self.host.poll() is None:
            if self.master is not None:
                self.keys(b"/lifecycle-quit\r")
            else:
                self.command("prompt", message="/lifecycle-quit")
            self.host.wait(timeout=10)
        self.require("owned host graceful exit", self.host.returncode == 0)

    def restart(self):
        old_session, old_peer = self.marker["sessionId"], self.peer_id
        session_file = self.marker["sessionFile"]
        self.require("real persisted session exists before restart", Path(session_file).is_file())
        self.stop_host()
        self.require("process exit has not acknowledged cancelled body", all(self.read_at(m["id"]) is None for m in self.sent))
        self.log_name, self.rpc_name = "provider-resumed.jsonl", "rpc-resumed.jsonl"
        control = self.root / "control-resumed"; control.mkdir(mode=0o700)
        self.control = control
        env = dict(self.launch_env, INBOX_BODY_CONTROL=str(control), INBOX_BODY_LOG=str(self.root / self.log_name))
        (self.root / "marker.json").unlink()
        out = (self.root / self.rpc_name).open("w"); err = (self.root / "stderr-resumed.log").open("w")
        self.handles.extend([out, err])
        cmd = self.launch_cmd + ["--session", session_file]
        self.host = subprocess.Popen(cmd, cwd=self.project, env=env, stdin=subprocess.PIPE, stdout=out, stderr=err, text=True)
        self.hosts.append(self.host)
        self.marker = self.until("same-session installed restart", lambda: body.json_file(self.root / "marker.json"))
        peer = self.until("resident MCP revival", self.peer)
        self.peer_id = peer[0]
        self.require("same logical session and CCT identity revived in NEW process", self.marker["sessionId"] == old_session and
                     self.peer_id == old_peer and self.marker["pid"] == self.host.pid and self.host.pid != self.hosts[0].pid)
        self.until("fresh resumed feed", lambda: (body.json_file(self.cct / "flags" / f"{self.peer_id}.os-inbox") or {}).get("sessionId") == old_session)
        self.quiet(self.args.quiet_seconds, 0, [m["id"] for m in self.sent])
        self.require("same-session restart retains cancellation until human resumes", not self.events("provider_request"))

    def close(self):
        # Base harness owns broker cleanup. Gracefully stop TUI before its RPC-only
        # fallback; retain keyboard capture and all prior process exit receipts.
        owned = self.observe_children()
        try:
            if self.master is not None and self.host and self.host.poll() is None:
                self.stop_host()
        except Exception as exc:
            self.failure = self.failure or repr(exc)
            self.passed = False
        finally:
            super().close()
            if self.master is not None:
                if self.reader: self.reader.join(timeout=2)
                os.close(self.master)
            exits = [{"pid": p.pid, "exit": p.poll()} for p in self.hosts]
            active = self.db("SELECT id,pid,host_pid FROM peers WHERE status='active'") if self.broker else []
            receipt = body.json_file(self.root / "receipt.json")
            receipt["owned_host_exits"] = exits
            receipt["all_private_active_peers"] = active
            deadline = time.monotonic() + 6
            leftovers = []
            while time.monotonic() < deadline:
                live = {int(line.strip()) for line in subprocess.check_output(["ps", "-axo", "pid="], text=True).splitlines()}
                leftovers = sorted(owned & live)
                if not leftovers: break
                time.sleep(.1)
            receipt["observed_owned_pids"] = sorted(owned)
            receipt["owned_processes_remaining"] = leftovers
            receipt["passed"] = receipt["passed"] and all(e["exit"] == 0 for e in exits) and not active and not leftovers
            (self.root / "receipt.json").write_text(json.dumps(receipt, indent=2))
            if self.passed: assert receipt["passed"], receipt


def run(h):
    h.setup()
    pending_response = 1
    if h.args.case == "compact":
        # A genuine completed human turn provides history to summarize. A lone
        # cancelled custom message is correctly refused as too small by os.
        h.prompt("Seed authorized lifecycle work. " + "Private synthetic history for native compaction. " * 100)
        h.until("seed provider request", lambda: h.events("provider_request"))
        h.release(1)
        h.until("seed human turn settled", lambda: h.events("agent_settled"))
        pending_response = 2
    payload = "lifecycle-pending-body-" + h.args.case
    ident = h.dm(payload)
    h.request(pending_response, [payload])
    h.quiet(2.3, pending_response, [ident])
    settled_before = len(h.events("agent_settled"))
    h.cancel(pending_response, [ident])
    h.until("cancelled body run settles", lambda: len(h.events("agent_settled")) > settled_before)
    if h.args.case == "restart":
        h.restart()
        h.prompt("Human resumes the cancelled inbox after process restart.")
        response = 1
    elif h.args.case == "reload":
        h.command("prompt", message="/lifecycle-reload")
        h.until("actual installed reload event", lambda: any(e.get("reason") == "reload" for e in h.events("session_start")))
        # The reused provider numbers restart after extension reload.
        h.quiet(h.args.quiet_seconds, 1, [ident])
        h.require("reload retains cancellation", True)
        h.prompt("Human resumes inbox after reload.")
        response = 1
    elif h.args.case == "compact":
        # Native compaction: asynchronous RPC response waits for the real provider.
        cmd = {"id": "lifecycle-compact", "type": "compact", "customInstructions": "Summarize older context, retain constraints."}
        h.host.stdin.write(json.dumps(cmd) + "\n"); h.host.stdin.flush()
        h.until("real session_before_compact", lambda: h.events("lifecycle_before_compact"))
        summary = h.until("native compaction provider request", lambda: next((e for e in h.events("provider_request") if e["number"] == 3), None))
        h.require("native compaction uses only synthetic provider", summary["model"] == "inbox-body-local/local")
        h.quiet(2.3, 3, [ident])
        h.release(3)
        result = h.until("native RPC compact completed", lambda: next((e for e in h.rpc("response") if e.get("id") == cmd["id"]), None))
        h.require("actual native compaction succeeded", result.get("success"))
        h.require("host persisted compaction entry", any(e["type"] == "compaction" for e in body.records(Path(h.marker["sessionFile"]))))
        h.require("compaction summary is not DM acknowledgment", h.read_at(ident) is None)
        h.quiet(h.args.quiet_seconds, 3, [ident])
        h.prompt("Human resumes cancelled inbox after compaction.")
        response = 4
    else:
        h.prompt("Human resumes the cancelled inbox after actual TUI Escape.")
        response = 2
    # Reload can have repeated local number 1; select only the new request.
    baseline = 1 if h.args.case == "reload" else 0
    request = h.until("resumed provider input contains pending BODY", lambda: next((e for e in h.events("provider_request")[baseline:]
        if e["number"] == response and any(payload in t for t in e["texts"])), None))
    h.require("post-lifecycle provider receives actual pending body", bool(request))
    h.require("human input (not inbox check) resumes pending work", bool(h.events("lifecycle_input")))
    h.require("pending body still unread while resumed response held", h.read_at(ident) is None)
    h.quiet(2.3, len(h.events("provider_request")), [ident])
    h.release(response)
    h.ack([ident], response)
    count = len(h.events("provider_request"))
    h.quiet(h.args.quiet_seconds, count)
    h.no_checker()
    h.require("no synthetic timeout or host extension error", not h.events("provider_timeout") and not h.rpc("extension_error"))
    h.passed = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", choices=["esc", "restart", "compact", "reload"], required=True)
    parser.add_argument("--quiet-seconds", type=float, default=6.2)
    args = parser.parse_args()
    if not 2 <= args.quiet_seconds <= 60: parser.error("quiet interval must be 2..60 seconds")
    h = Lifecycle(args)
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
