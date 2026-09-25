#!/usr/bin/env python3
"""Automatic os registration: real installed host/adapter, isolated broker/provider.

CCT_OS_ADAPTER=/path/to/index.ts python3 test-os-autostart.py
No external model, production broker, or real peer messages are used.
"""
import json
import os
from datetime import datetime
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.request

REPO = Path(__file__).resolve().parent
NODE = shutil.which("node")
OS_BIN = os.environ.get("CCT_OS_BIN") or shutil.which("os")
ADAPTER = Path(os.environ["CCT_OS_ADAPTER"]).resolve()
FOOTER = Path(os.environ.get("CCT_OS_FOOTER", str(Path.home() / ".os/extensions/statusline.ts")))
PORT = int(os.environ.get("CCT_OS_TEST_PORT", "17934"))
with socket.socket() as probe:
    probe.bind(("127.0.0.1", PORT))
WORK = Path(tempfile.mkdtemp(prefix="cct-autostart-", dir="/private/tmp"))
CCT = WORK / "cct"
CCT.mkdir(mode=0o700)
URL = f"http://127.0.0.1:{PORT}"
LOADER = str(REPO / "node_modules/tsx/dist/loader.mjs")
BASE = {"PATH": f"{Path(NODE).parent}:/usr/bin:/bin", "CCT_DIR": str(CCT),
        "CCT_PORT": str(PORT), "CCT_BROKER": URL}
sessions, checks = [], []


def wait(fn, timeout=25):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            result = fn()
            if result:
                return result
        except (OSError, sqlite3.Error, ValueError):
            pass
        time.sleep(0.1)
    raise AssertionError(f"Timed out after {timeout}s")


def check(name, passed):
    checks.append({"name": name, "passed": bool(passed)})
    (WORK / "checks.json").write_text(json.dumps(checks, indent=2))
    print(("PASS " if passed else "FAIL ") + name, flush=True)
    assert passed, name


def rows(query, args=()):
    with sqlite3.connect(CCT / "cct.db") as db:
        db.row_factory = sqlite3.Row
        return [dict(row) for row in db.execute(query, args)]


def jsonlines(path):
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


LAUNCHER = WORK / "server-observer.mjs"
LAUNCHER.write_text("""import fs from "node:fs";
let marker=null;
try { marker=fs.readFileSync(`${process.env.CCT_DIR}/pidmaps/os_session_${process.ppid}`,"utf8").trim(); } catch {}
fs.appendFileSync(process.env.PROBE_LAUNCH_LOG,JSON.stringify({pid:process.pid,ppid:process.ppid,at:Date.now(),marker})+"\\n");
await import(""" + json.dumps(str(REPO / "server.ts")) + ");\n")
FOOTER_PROBE = WORK / "footer-observer.ts"
FOOTER_PROBE.write_text("import footer from " + json.dumps(str(FOOTER)) + """;
import fs from "node:fs";
export default function(pi:any) {
  footer({on(event:any,handler:any) {
    pi.on(event,(e:any,ctx:any)=>handler(e,{...ctx,hasUI:true,ui:{...ctx.ui,setStatus(key:string,text:string|undefined) {
      const cct=text?.split(" | ").find((s:string)=>s.startsWith("CCT:"));
      fs.appendFileSync(process.env.PROBE_LOG!,JSON.stringify({kind:"footer",at:Date.now(),cct})+"\\n");
    }}}));
  }});
}
""")


class Session:
    def __init__(self, name, order="adapter-first", lifecycle="keep-alive", agent=None, resume=None):
        self.dir = WORK / name
        self.dir.mkdir()
        self.home = self.dir / "home"
        self.home.mkdir()
        (self.home / ".cct").symlink_to(CCT, target_is_directory=True)
        self.agent = agent or self.home / ".os/agent"
        self.agent.mkdir(parents=True, exist_ok=True)
        self.cwd = self.dir / "project"
        self.cwd.mkdir()
        self.log, self.marker = self.dir / "events.jsonl", self.dir / "session.json"
        self.rpc_log, self.launch_log = self.dir / "rpc.jsonl", self.dir / "launches.jsonl"
        extensions = [str(ADAPTER), str(REPO / "os-extension.ts")]
        if order == "marker-first":
            extensions.reverse()
        extensions += [str(REPO / "test-fixtures/os/probe.ts"), str(FOOTER_PROBE)]
        (self.agent / "settings.json").write_text(json.dumps({
            "extensions": extensions, "compaction": {"enabled": False}, "retry": {"enabled": False},
            "defaultProvider": "cct-probe", "defaultModel": "local",
        }))
        (self.agent / "mcp.json").write_text(json.dumps({"mcpServers": {"cct": {
            "command": NODE, "args": ["--import", LOADER, str(LAUNCHER)],
            "env": {"CCT_RUNTIME": "os"}, "lifecycle": lifecycle,
            "directTools": True, "toolPrefix": "none", "debug": True,
        }}}))
        env = {**BASE, "HOME": str(self.home), "TMPDIR": str(self.dir), "TERM": "dumb",
               "OS_CODING_AGENT_DIR": str(self.agent), "PROBE_LOG": str(self.log),
               "PROBE_ROOT": str(REPO / "test-fixtures/os"), "PROBE_MARKER": str(self.marker),
               "PROBE_LAUNCH_LOG": str(self.launch_log)}
        self.handles = [self.rpc_log.open("w"), (self.dir / "stderr.log").open("w")]
        args = [OS_BIN, "--mode", "rpc", "--provider", "cct-probe", "--model", "local"]
        if resume:
            assert Path(resume).is_file(), "Resume requires a persisted session"
            args += ["--session", str(resume)]
        self.p = subprocess.Popen(args, cwd=self.cwd, env=env, stdin=subprocess.PIPE,
                                  stdout=self.handles[0], stderr=self.handles[1], text=True)
        sessions.append(self)
        self.sequence = 0
        wait(self.refresh_meta)

    def refresh_meta(self):
        self.meta = json.loads(self.marker.read_text())
        self.sid = self.meta["sessionId"]
        return self.sid

    def rpc(self, kind, **args):
        self.sequence += 1
        ident = str(self.sequence)
        self.p.stdin.write(json.dumps({"type": kind, "id": ident, **args}) + "\n")
        self.p.stdin.flush()
        response = wait(lambda: next((e for e in jsonlines(self.rpc_log)
                                      if e.get("type") == "response" and e.get("id") == ident), None))
        assert response.get("success"), response
        return response.get("data", {})

    def prompt(self, text):
        start = len(jsonlines(self.rpc_log))
        self.rpc("prompt", message=text)
        if text.startswith("/"):
            return
        wait(lambda: any(e.get("type") == "agent_settled" for e in jsonlines(self.rpc_log)[start:]))

    def tool(self, name, args):
        start = len(jsonlines(self.rpc_log))
        self.prompt("PROBE_TOOL " + json.dumps({"name": name, "arguments": args}))
        return [e for e in jsonlines(self.rpc_log)[start:] if e.get("type") == "tool_execution_end"][-1]

    def peers(self):
        return rows("select id,name,runtime,session_key,host_pid,pid,status,last_seen from peers "
                    "where host_pid=? and status='active'", (self.p.pid,))

    def calls(self):
        return [e for e in jsonlines(self.log) if e.get("kind") == "tool_call"]

    def footer(self):
        return next((e["cct"] for e in reversed(jsonlines(self.log))
                     if e.get("kind") == "footer" and e.get("cct")), None)

    def ready(self):
        peer = wait(lambda: next((p for p in self.peers() if p["session_key"] == "os:" + self.sid), None))
        wait(lambda: self.footer() == "CCT:" + peer["name"], timeout=20)
        return peer

    def snapshot(self, name):
        a, b = CCT / "pidmaps" / f"os_session_{self.p.pid}", CCT / "pidmaps" / f"os_{self.sid}"
        launches = jsonlines(self.launch_log)
        pids = ",".join(str(p["pid"]) for p in launches)
        processes = subprocess.run(["ps", "-p", pids, "-o", "pid=,ppid=,stat=,rss=,%cpu=,comm="],
                                   capture_output=True, text=True).stdout.strip() if pids else ""
        result = {"host": self.p.pid, "sid": self.sid, "A": a.read_text() if a.exists() else None,
                  "B": b.read_text() if b.exists() else None, "peers": self.peers(),
                  "launches": launches, "processes": processes, "footer": self.footer(),
                  "toolCalls": self.calls()}
        (WORK / f"{name}.json").write_text(json.dumps(result, indent=2))
        print(json.dumps({"snapshot": name, **result}), flush=True)
        return result

    def stop(self):
        if self.p.poll() is None:
            self.p.stdin.close()
            try:
                self.p.wait(timeout=12)
            except subprocess.TimeoutExpired:
                self.p.terminate()
                self.p.wait(timeout=10)
        for handle in self.handles:
            handle.close()


broker_log = (WORK / "broker.log").open("a")


def start_broker():
    process = subprocess.Popen([NODE, "--import", LOADER, str(REPO / "broker.ts")],
                               cwd=WORK, env={**BASE, "HOME": str(WORK)},
                               stdout=broker_log, stderr=broker_log)
    wait(lambda: urllib.request.urlopen(URL + "/health", timeout=1).status == 200)
    return process


broker = start_broker()
try:
    for order in ["adapter-first", "marker-first"]:
        agent = None
        for cache in ["cold", "warm"]:
            s = Session(f"{order}-{cache}", order=order, agent=agent)
            agent = s.agent
            peer = s.ready()
            snap = s.snapshot(f"{order}-{cache}")
            check(f"{order}/{cache}: automatic real identity, zero tools",
                  len(snap["peers"]) == 1 and not snap["toolCalls"])
            live = snap["processes"].splitlines()
            check(f"{order}/{cache}: one surviving server after supersede", len(live) == 1)
            check(f"{order}/{cache}: active read tool",
                  any(e.get("kind") == "tools" and "cct_check_messages" in e.get("active", [])
                      for e in jsonlines(s.log)))
            s.prompt("Synthetic local turn to persist the session.")
            session_file, identity, old_sid = s.meta["sessionFile"], (peer["id"], peer["name"]), s.sid
            wait(lambda: Path(session_file).exists())
            s.stop()
            wait(lambda: not s.peers())
            check(f"{order}/{cache}: host cleanup removes A and B",
                  not (CCT / "pidmaps" / f"os_session_{s.p.pid}").exists()
                  and not (CCT / "pidmaps" / f"os_{s.sid}").exists())

    s = Session("resume", agent=agent, resume=session_file)
    peer = s.ready()
    check("resume automatically reclaims same session and peer",
          s.sid == old_sid and (peer["id"], peer["name"]) == identity and not s.calls())
    s.snapshot("resume")
    # A persisted user turn supplies a real fork entry; no CCT tool triggers startup.
    messages = s.rpc("get_fork_messages")["messages"]
    old_peer, old_sid = peer["id"], s.sid
    s.rpc("fork", entryId=messages[0]["entryId"])
    wait(lambda: s.refresh_meta() != old_sid)
    peer = s.ready()
    check("fork registers a distinct session without retaining the old peer",
          peer["id"] != old_peer and len(s.peers()) == 1 and not s.calls())
    s.snapshot("fork")
    old_peer, old_sid = peer["id"], s.sid
    s.rpc("new_session")
    wait(lambda: s.refresh_meta() != old_sid)
    peer = s.ready()
    check("new session replaces identity automatically",
          peer["id"] != old_peer and len(s.peers()) == 1 and not s.calls())
    s.snapshot("new-session")

    before_calls = len(s.calls())
    broker.terminate()
    broker.wait(timeout=10)
    time.sleep(2)
    restarted_at = int(time.time() * 1000)
    broker = start_broker()
    wait(lambda: s.peers() and datetime.fromisoformat(s.peers()[0]["last_seen"]).timestamp() * 1000
         >= restarted_at, timeout=40)
    check("broker restart recovers without a tool call",
          s.peers()[0]["id"] == peer["id"] and len(s.calls()) == before_calls)
    s.snapshot("broker-recovered")
    child = s.peers()[0]["pid"]
    os.kill(child, 15)
    wait(lambda: s.peers() and s.peers()[0]["pid"] != child, timeout=65)
    check("local stdio child restarts with the same peer automatically",
          s.peers()[0]["id"] == peer["id"] and len(s.calls()) == before_calls)
    s.snapshot("child-recovered")
    s.prompt("/probe-disable-cct")
    flag = CCT / "flags" / f"{peer['id']}.unread"
    flag.write_text(f"1||{int(time.time() * 1000)}")
    check("inactive check_messages does not block ordinary tools",
          not s.tool("bash", {"command": "true"}).get("isError"))
    s.prompt("/probe-enable-cct")
    check("CCT read remains callable", not s.tool("cct_check_messages", {}).get("isError"))
    s.stop()
    wait(lambda: not s.peers())

    # Same binary/adapter with the old lifecycle: warm cache still waits.
    lazy = Session("lazy-seed", lifecycle="lazy-keep-alive")
    lazy.ready()
    lazy.stop()
    lazy = Session("lazy-warm", lifecycle="lazy-keep-alive", agent=lazy.agent)
    wait(lambda: lazy.footer() == "CCT:pending")
    time.sleep(2)
    snap = lazy.snapshot("lazy-differential")
    check("old warm lazy mode remains pending without registration",
          not snap["peers"] and not snap["B"] and not snap["launches"] and not snap["toolCalls"])
    check("ordinary tools still work before CCT is active",
          not lazy.tool("bash", {"command": "true"}).get("isError"))
    check("0700 directories retained", all((p.stat().st_mode & 0o777) == 0o700
          for p in [CCT, CCT / "pidmaps", CCT / "flags"]))
finally:
    for session in sessions:
        session.stop()
    broker.terminate()
    broker.wait(timeout=10)
    broker_log.close()
    print("EVIDENCE " + str(WORK), flush=True)
