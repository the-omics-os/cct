#!/usr/bin/env python3
"""Installed-os inbox-wake acceptance. --primitive preserves the broker-free Step 0 proof.

Default mode uses installed os bundle + read-only adapter + isolated worktree broker/server.
All inference is an in-process synthetic provider; no real credentials or peers.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "test-fixtures/os/inbox-wake-probe.ts"
TOKEN = "inbox-wake-primitive-v1"


def lines(path):
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def wait(predicate, process, seconds=20):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        if process.poll() is not None:
            raise AssertionError(f"os exited unexpectedly: {process.returncode}")
        time.sleep(0.05)
    raise AssertionError(f"timed out after {seconds}s")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--primitive", action="store_true",
                        help="prove custom-message idle turn without a broker")
    parser.add_argument("--opt-out", action="store_true", help="test CCT_OS_AUTO_WAKE=0 with real DM")
    parser.add_argument("--failed-model", action="store_true", help="failed synthetic provider is not hot-retried")
    parser.add_argument("--abort", action="store_true", help="abort DM-triggered delayed RPC provider request")
    parser.add_argument("--tui", action="store_true", help="installed open TUI under owned PTY; no initial prompt")
    args = parser.parse_args()
    if not args.primitive:
        return acceptance(opt_out=args.opt_out, failed_model=args.failed_model, abort=args.abort, tui=args.tui)
    os_bin = Path(os.environ.get("CCT_OS_BIN") or shutil.which("os") or "").resolve()
    node = shutil.which("node")
    assert os_bin.is_file() and os_bin.name == "cli.js" and "@the-omics-os/os/dist/bundle" in str(os_bin), os_bin
    assert node and FIXTURE.is_file()
    package = os_bin.parents[2] / "package.json"  # package/dist/bundle/cli.js
    version = json.loads(package.read_text())["version"]
    work = Path(tempfile.mkdtemp(prefix="cct-os-inbox-wake-", dir="/private/tmp"))
    home, agent, project = work / "home", work / "home/.os/agent", work / "project"
    agent.mkdir(parents=True, mode=0o700)
    project.mkdir(mode=0o700)
    trigger, marker, events, rpc, stderr = (work / name for name in
        ("external-event", "marker.json", "extension.jsonl", "rpc.jsonl", "stderr.log"))
    (agent / "settings.json").write_text(json.dumps({
        "defaultProvider": "inbox-wake-local", "defaultModel": "local",
        "compaction": {"enabled": False}, "retry": {"enabled": False},
        "defaultProjectTrust": "never", "extensions": [], "packages": [],
    }))
    # No inherited AWS/Anthropic/OpenAI keys, PI_* config, CCT configuration or MCP adapter.
    env = {"PATH": f"{Path(node).parent}:/usr/bin:/bin", "HOME": str(home),
           "TMPDIR": str(work), "TERM": "dumb", "PI_OFFLINE": "1",
           "AWS_EC2_METADATA_DISABLED": "true", "OS_CODING_AGENT_DIR": str(agent),
           "PI_CODING_AGENT_DIR": str(agent), "PI_MCP_CONFIG_MODE": "exclusive",
           "INBOX_WAKE_LOG": str(events), "INBOX_WAKE_TRIGGER": str(trigger),
           "INBOX_WAKE_MARKER": str(marker)}
    invocation = [str(os_bin), "--mode", "rpc", "--provider", "inbox-wake-local",
                  "--model", "local", "--no-builtin-tools", "--no-skills",
                  "--no-prompt-templates", "--no-context-files", "--no-extensions",
                  "--no-approve", "--offline", "-e", str(FIXTURE)]
    manifest = {"package": str(package), "version": version, "binary": str(os_bin),
                "invocation": invocation, "cwd": str(project), "env_keys": sorted(env),
                "sent_rpc_commands": [], "broker_started": False, "external_inference": False,
                "evidence_dir": str(work)}
    (work / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"EVIDENCE {work}", flush=True)
    print("INVOCATION " + " ".join(invocation), flush=True)
    process = None
    output = rpc.open("w")
    error = stderr.open("w")
    try:
        process = subprocess.Popen(invocation, cwd=project, env=env, stdin=subprocess.PIPE,
                                   stdout=output, stderr=error, text=True)
        initial = wait(lambda: lines(events) if marker.exists() else None, process)
        assert initial[0]["kind"] == "session_start" and initial[0]["mode"] == "rpc" and initial[0]["idle"]
        assert json.loads(marker.read_text())["pid"] == process.pid
        # Stay idle with open stdin and no prompt command; verify negative control.
        time.sleep(1.0)
        assert process.poll() is None and not [e for e in lines(events) if e["kind"] == "provider_request"]
        assert not [e for e in lines(rpc) if e.get("type") in ("agent_start", "turn_start")]
        trigger.write_text(TOKEN)
        seen = wait(lambda: next((e for e in lines(events) if e["kind"] == "provider_request"), None), process)
        wait(lambda: any(e["kind"] == "agent_settled" for e in lines(events)), process)
        log = lines(events)
        assert [e["kind"] for e in log].index("external_event") < [e["kind"] for e in log].index("provider_request")
        assert next(e for e in log if e["kind"] == "external_event")["idle"]
        assert seen["lastRole"] == "user" and seen["lastTextContainsToken"], seen
        assert len([e for e in lines(rpc) if e.get("type") == "message_end"
                    and e.get("message", {}).get("customType") == "inbox-wake-proof"
                    and e["message"].get("role") == "custom"]) == 1
        assert seen["model"] == "inbox-wake-local/local", seen
        assert len([e for e in log if e["kind"] == "custom_message_sent"]) == 1
        assert len([e for e in lines(rpc) if e.get("type") == "agent_start"]) == 1
        assert len([e for e in lines(rpc) if e.get("type") == "agent_settled"]) == 1
        assert not [e for e in lines(rpc) if e.get("type") == "response"
                    or (e.get("type") in ("message_start", "message_end")
                        and e.get("message", {}).get("role") == "user")]
        assert any(e.get("type") == "message_end" and e.get("message", {}).get("role") == "assistant"
                   for e in lines(rpc))
        # Unchanged idle polling must not accidentally launch a second provider request.
        time.sleep(1.2)
        assert len([e for e in lines(events) if e["kind"] == "provider_request"]) == 1
        assert len([e for e in lines(rpc) if e.get("type") == "agent_start"]) == 1
        process.stdin.close()  # Graceful RPC EOF, not a model request or user prompt.
        process.wait(timeout=12)
        assert process.returncode == 0, process.returncode
        log = lines(events)
        assert len([e for e in log if e["kind"] == "session_shutdown"]) == 1
        assert len([e for e in log if e["kind"] == "provider_request"]) == 1
        time.sleep(0.3)
        assert process.poll() == 0 and len([e for e in lines(events) if e["kind"] == "provider_request"]) == 1
        summary = {"passed": True, "session": json.loads(marker.read_text()),
                   "events": [{k: v for k, v in e.items() if k != "pid"} for e in log],
                   "rpc_types": [e.get("type") for e in lines(rpc)],
                   "provider_request_count_after_shutdown": 1, "exit_code": process.returncode}
        (work / "result.json").write_text(json.dumps(summary, indent=2))
        print("PASS quiet idle -> external extension event -> custom message -> one local model turn -> clean shutdown", flush=True)
    except BaseException as exc:
        (work / "failure.txt").write_text(repr(exc) + "\n")
        raise
    finally:
        if process is not None and process.poll() is None:
            if process.stdin and not process.stdin.closed:
                process.stdin.close()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=3)
        output.close()
        error.close()


def acceptance(opt_out=False, failed_model=False, abort=False, tui=False):
    """Real resident MCP acceptance. Only this test's broker and private HOME are touched."""
    import socket
    import sqlite3
    import urllib.request
    os_bin = Path(os.environ.get("CCT_OS_BIN") or shutil.which("os") or "").resolve()
    import hashlib
    adapter = Path(os.environ.get("CCT_OS_ADAPTER", "~/GITHUB/AGENTS/pi-mcp-adapter/index.ts")).expanduser().resolve()
    node = shutil.which("node")
    assert os_bin.is_file() and os_bin.name == "cli.js" and "@the-omics-os/os/dist/bundle" in str(os_bin), os_bin
    assert adapter.is_file() and node and (HERE / "node_modules/tsx/dist/loader.mjs").is_file()
    package = os_bin.parents[2] / "package.json"
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    work = Path(tempfile.mkdtemp(prefix="cct-os-inbox-accept-", dir="/private/tmp"))
    work.chmod(0o700)
    # The specified read-only adapter checkout lacks node_modules. Stage byte-identical
    # sources in a private mirror and hydrate production dependencies from the local npm
    # cache ONLY; no registry or external network request is permitted.
    mirror = work / "adapter"
    shutil.copytree(adapter.parent, mirror, ignore=shutil.ignore_patterns(".git", "node_modules", ".venv", "__pycache__", ".pytest_cache", "__tests__", "examples", "conformance"))
    source_hash = hashlib.sha256(adapter.read_bytes()).hexdigest()
    assert hashlib.sha256((mirror / "index.ts").read_bytes()).hexdigest() == source_hash
    install_env = {"PATH": f"{Path(node).parent}:/usr/bin:/bin", "HOME": str(work),
                   "NPM_CONFIG_CACHE": str(Path.home() / ".npm"), "NPM_CONFIG_OFFLINE": "true"}
    subprocess.run([shutil.which("npm"), "ci", "--offline", "--omit=dev", "--legacy-peer-deps",
                    "--ignore-scripts", "--no-audit", "--no-fund"], cwd=mirror, env=install_env,
                   stdout=(work / "adapter-install.log").open("w"), stderr=subprocess.STDOUT, timeout=90, check=True)
    staged_adapter = mirror / "index.ts"
    home, agent, project, cct = work / "home", work / "home/.os/agent", work / "project", work / "cct"
    for directory in (agent, project, cct):
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    url = f"http://127.0.0.1:{port}"
    common = {"PATH": f"{Path(node).parent}:/usr/bin:/bin", "HOME": str(home), "TMPDIR": str(work),
              "TERM": "dumb", "PI_OFFLINE": "1", "AWS_EC2_METADATA_DISABLED": "true",
              "OS_CODING_AGENT_DIR": str(agent), "PI_CODING_AGENT_DIR": str(agent),
              "PI_MCP_CONFIG_MODE": "exclusive", "CCT_DIR": str(cct), "CCT_PORT": str(port),
              "CCT_BROKER": url, "INBOX_WAKE_LOG": str(work / "extension.jsonl"),
              "INBOX_WAKE_MARKER": str(work / "marker.json")}
    assert sum((opt_out, failed_model, abort, tui)) <= 1
    if tui: common["TERM"] = "xterm-256color"
    if opt_out: common["CCT_OS_AUTO_WAKE"] = "0"
    if failed_model: common["INBOX_WAKE_FAIL"] = "1"
    if abort: common["INBOX_WAKE_ABORT"] = "1"
    (agent / "settings.json").write_text(json.dumps({"defaultProvider": "inbox-wake-local", "defaultModel": "local",
        "compaction": {"enabled": False}, "retry": {"enabled": False}, "defaultProjectTrust": "never",
        "extensions": [str(HERE / "os-extension.ts"), str(staged_adapter), str(FIXTURE)], "packages": []}))
    (agent / "mcp.json").write_text(json.dumps({"mcpServers": {"cct": {
        "command": node, "args": ["--import", str(HERE / "node_modules/tsx/dist/loader.mjs"), str(HERE / "server.ts")],
        "env": {"CCT_RUNTIME": "os", "CCT_TOOL_SURFACE": "compact"},
        "lifecycle": "keep-alive", "directTools": True, "toolPrefix": "none", "debug": True}}}))
    invocation = [str(os_bin), *([] if tui else ["--mode", "rpc"]), "--provider", "inbox-wake-local", "--model", "local",
                  "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve", "--offline"]
    manifest = {"package": str(package), "version": json.loads(package.read_text())["version"],
        "binary": str(os_bin), "adapter_source": str(adapter), "adapter_loaded": str(staged_adapter),
        "adapter_sha256": source_hash, "extension": str(HERE / "os-extension.ts"),
        "server": str(HERE / "server.ts"), "broker": str(HERE / "broker.ts"), "invocation": invocation,
        "env_keys": sorted(common), "cwd": str(project), "broker_url": url,
        "evidence_dir": str(work), "provider": "in-process synthetic streamSimple; no HTTP inference"}
    (work / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print("EVIDENCE", work, flush=True)
    broker = host = None
    master = None
    reader = None
    handles = []
    checks = []
    def events():
        return lines(work / "extension.jsonl")
    def rpc():
        return lines(work / "rpc.jsonl")
    def check(name, predicate):
        ok = bool(predicate)
        checks.append({"name": name, "passed": ok, "at": time.time()})
        (work / "result.json").write_text(json.dumps({"checks": checks, "evidence_dir": str(work)}, indent=2))
        print(("PASS " if ok else "FAIL ") + name, flush=True)
        assert ok, name
    def until(fn, seconds=25):
        return wait(fn, host, seconds)
    def count(kind):
        return len([e for e in events() if e["kind"] == kind])
    def post(path, data):
        req = urllib.request.Request(url + path, data=json.dumps(data).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=3) as result:
            response = json.load(result)
        assert response["ok"], (path, response)
        return response
    def peer():
        with sqlite3.connect(cct / "cct.db") as db:
            row = db.execute("SELECT id, name, runtime, session_key, status FROM peers WHERE host_pid=? AND status='active'", (host.pid,)).fetchone()
            return row
    def metadata(peer_id):
        path = cct / "flags" / f"{peer_id}.os-notify"
        try:
            return json.loads(path.read_text())
        except (FileNotFoundError, ValueError):
            return None
    def dm(peer_id, label):
        return post("/message/send-cli", {"to_peer_id": peer_id, "body": label})
    def command(cmd):
        ident = f"cmd-{time.monotonic_ns()}"
        host.stdin.write(json.dumps({"id": ident, **cmd}) + "\n")
        host.stdin.flush()
        response = until(lambda: next((e for e in rpc() if e.get("type") == "response" and e.get("id") == ident), None))
        check(f"RPC {cmd['type']} accepted", response.get("success"))
        return response
    def tool(name, arguments):
        before = len(rpc())
        command({"type": "prompt", "message": "PROBE_TOOL " + json.dumps({"name": name, "arguments": arguments})})
        until(lambda: any(e.get("type") == "agent_settled" for e in rpc()[before:]))
        return [e for e in rpc()[before:] if e.get("type") == "tool_execution_end"][-1]
    try:
        brokerlog = (work / "broker.log").open("w"); handles.append(brokerlog)
        broker = subprocess.Popen([node, "--import", str(HERE / "node_modules/tsx/dist/loader.mjs"),
                                   str(HERE / "broker.ts")], cwd=project, env=common,
                                  stdout=brokerlog, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(url + "/health", timeout=1) as response:
                    if response.status == 200: break
            except Exception:
                if broker.poll() is not None: raise AssertionError("owned broker exited")
                time.sleep(.1)
        else: raise AssertionError("owned broker failed to start")
        if tui:
            import fcntl
            import pty
            import struct
            import termios
            import threading
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
            def capture_pty():
                import select
                # Read output throughout startup and agent run; answer only terminal
                # cursor-position queries, never generate any input/prompt as wake.
                with (work / "tui.raw").open("wb") as raw:
                    tail = b""
                    while True:
                        try:
                            ready, _, _ = select.select([master], [], [], 0.2)
                            if not ready:
                                if host.poll() is not None: break
                                continue
                            chunk = os.read(master, 65536)
                            if not chunk: break
                            raw.write(chunk); raw.flush()
                            data = tail + chunk
                            queries = data.count(b"\x1b[6n")
                            for _ in range(queries): os.write(master, b"\x1b[1;1R")
                            tail = data[-3:]
                        except OSError:
                            break
            host = subprocess.Popen(invocation, cwd=project, env=common, stdin=slave,
                                    stdout=slave, stderr=slave, start_new_session=True)
            os.close(slave)
            reader = threading.Thread(target=capture_pty, daemon=True)
            reader.start()
        else:
            out = (work / "rpc.jsonl").open("w"); err = (work / "stderr.log").open("w")
            handles.extend([out, err])
            host = subprocess.Popen(invocation, cwd=project, env=common, stdin=subprocess.PIPE,
                                    stdout=out, stderr=err, text=True)
        marker = until(lambda: json.loads((work / "marker.json").read_text()) if (work / "marker.json").exists() else None)
        p = until(peer)
        peer_id = p[0]
        check("installed bundle, worktree source, private peer identity", p[2] == "os" and p[3] == "os:" + marker["sessionId"]
              and marker["pid"] == host.pid and not (home / ".pi").exists())
        # Adapter discovery can be later than session_start; status appears in metadata only after MCP registration.
        until(lambda: metadata(peer_id) is not None)
        original = metadata(peer_id)
        check("resident metadata producer and empty baseline", original["count"] == 0 and original["producer"]
              and (cct / "pidmaps" / ("os_" + marker["sessionId"])).exists())
        time.sleep(2.3)
        check("quiet idle: zero automatic provider requests", count("provider_request") == 0 and peer() is not None)
        if tui:
            check("TUI startup was quiet without a supplied prompt", count("provider_request") == 0 and
                  not any(e["kind"] == "agent_start" for e in events()))
            dm(peer_id, "wake-tui-real-dm")
            until(lambda: any(e["kind"] == "tool_result" and e.get("toolName") == "cct_check_messages"
                              and "wake-tui-real-dm" in e.get("content", "") for e in events()))
            until(lambda: count("agent_settled") >= 1)
            check("open TUI DM invokes provider and actual checker without keyboard prompt",
                  any(e["kind"] == "provider_request" and e.get("notice") for e in events())
                  and any(e["kind"] == "message_end" and e.get("customType") == "cct-inbox-notice" for e in events())
                  and not any(e["kind"] == "message_end" and e.get("role") == "user" for e in events()))
            check("TUI rendered notice and collapsed real checker result to PTY",
                  b"[CCT peer inbox notice]" in (work / "tui.raw").read_bytes()
                  and b"cct_check_messages" in (work / "tui.raw").read_bytes()
                  and b"cct_check_messages" in (work / "tui.raw").read_bytes().split(b"[CCT peer inbox notice]")[-1])
            return
        if opt_out or failed_model or abort:
            dm(peer_id, "wake-negative-dm")
            until(lambda: metadata(peer_id) if metadata(peer_id) and metadata(peer_id)["maxDmId"] > 0 else None)
            if opt_out:
                time.sleep(2.4)
                check("explicit opt-out suppresses idle model starts", count("provider_request") == 0)
                result = tool("cct_check_messages", {})
                check("opt-out retains ordinary checker retrieval", "wake-negative-dm" in json.dumps(result))
            elif abort:
                # No checker from this provider mode. Abort only after observing
                # the genuine DM-triggered delayed model request, without a prompt.
                until(lambda: next((e for e in events() if e["kind"] == "provider_request" and e["notice"]), None))
                check("DM started one delayed model request without RPC prompt",
                      count("provider_request") == 1 and not [e for e in rpc() if e.get("type") == "response"])
                command({"type": "abort"})
                until(lambda: count("provider_abort_signal") >= 1)
                until(lambda: count("agent_settled") >= 1)
                check("RPC abort signalled the actual pending provider stream",
                      count("provider_abort_signal") == 1 and
                      events()[next(i for i, e in enumerate(events()) if e["kind"] == "provider_abort_signal")]["at"]
                      < events()[next(i for i, e in enumerate(events()) if e["kind"] == "agent_settled")]["at"])
                time.sleep(3.2)
                check("RPC abort does not reinvoke unchanged batch", count("provider_request") == 1)
                dm(peer_id, "wake-after-abort-before-read")
                until(lambda: metadata(peer_id) if metadata(peer_id) and metadata(peer_id)["count"] >= 2 else None)
                time.sleep(3.2)
                check("second DM before read coalesces after abort", count("provider_request") == 1)
                result = tool("cct_check_messages", {})
                check("aborted run retained both unread DMs for checker",
                      all(label in json.dumps(result) for label in ("wake-negative-dm", "wake-after-abort-before-read")))
            else:
                until(lambda: count("provider_request") > 0)
                until(lambda: count("agent_settled") > 0)
                initial_count = count("provider_request")
                time.sleep(3.2)
                check("failed model same unread batch never hot retries", count("provider_request") == initial_count)
                result = tool("cct_check_messages", {})
                check("failed model does not consume unread", "wake-negative-dm" in json.dumps(result))
            return
        dm(peer_id, "wake-dm-first")
        first = until(lambda: metadata(peer_id) if metadata(peer_id) and metadata(peer_id)["maxDmId"] > 0 else None)
        check("first real chat DM has stable eligible metadata", first["count"] == 1 and first["maxDmId"] > 0)
        until(lambda: any(e["kind"] == "tool_result" and e.get("toolName") == "cct_check_messages"
                          and "wake-dm-first" in e.get("content", "") for e in events()))
        check("no RPC prompt: DM -> notice -> provider -> real checker tool output",
              any(e["kind"] == "provider_request" and e["notice"] for e in events())
              and any(e["kind"] == "message_end" and e.get("customType") == "cct-inbox-notice" for e in events())
              and not [e for e in rpc() if e.get("type") == "response" or
                       (e.get("type") == "message_end" and e.get("message", {}).get("role") == "user")])
        until(lambda: count("agent_settled") >= 1)
        first_calls = count("provider_request")
        time.sleep(2.3)
        check("unchanged batch and polling timestamp refresh do not reinvoke", count("provider_request") == first_calls)
        # A successful checker peeks; the next check acknowledges. The next DM must be detected even
        # while the earlier pendingAckIds excludes the prior message from the derived metadata.
        dm(peer_id, "wake-dm-second-equal-count")
        until(lambda: any(e["kind"] == "tool_result" and e.get("toolName") == "cct_check_messages"
                          and "wake-dm-second-equal-count" in e.get("content", "") for e in events()))
        check("immediate second DM of same outstanding count wakes", count("agent_start") >= 2)
        until(lambda: count("agent_settled") >= 2)
        before_pool = count("provider_request")
        post("/pool/create-cli", {"name": "DM", "purpose": "literal-name negative control"})
        post("/pool/invite-cli", {"pool_name": "DM", "target_peer_id": peer_id})
        post("/message/send", {"peer_id": "cli", "pool_name": "DM", "to_peer_id": peer_id,
                               "body": "pool-directed-literal-DM"})
        until(lambda: metadata(peer_id) and metadata(peer_id)["count"] >= 1)
        time.sleep(2.3)
        check("pool named DM directed chat and system notices do not idle wake", count("provider_request") == before_pool)
        # Normal ordinary work must carry a busy notice without blocking the ordinary call.
        sentinel = project / "ordinary-tool-ran"
        result = tool("bash", {"command": f"touch '{sentinel}'"})
        check("pool notice at ordinary turn, bash not blocked", sentinel.exists() and not result.get("isError")
              and any(e.get("customType") == "cct-inbox-notice" for e in events()))
        check_result = tool("cct_check_messages", {})
        check("pool remains retrievable on normal work", "pool-directed-literal-DM" in json.dumps(check_result))
        check("real broker peer remains active", peer() is not None)
        # Burst coalescing: one unread episode, one custom notice, all IDs in one
        # checker output; a heartbeat/refresh must not schedule another turn.
        settled_before = count("agent_settled")
        notices_before = len([e for e in events() if e.get("customType") == "cct-inbox-notice"])
        for i in range(3): dm(peer_id, f"wake-burst-{i}")
        until(lambda: any(e["kind"] == "tool_result" and e.get("toolName") == "cct_check_messages"
                          and all(f"wake-burst-{i}" in e.get("content", "") for i in range(3)) for e in events()))
        until(lambda: count("agent_settled") > settled_before)
        time.sleep(1.3)
        check("three-DM burst coalesced and no duplicate", len([e for e in events() if e.get("customType") == "cct-inbox-notice"]) == notices_before + 1)
        # While the model is in-flight (3.5s synthetic delay), deliver another DM.
        # The sidecar may notice it during the active request but must not create
        # a concurrent run or block an unrelated ordinary tool.
        request_before = count("provider_request")
        settled_before = count("agent_settled")
        command({"type": "prompt", "message": "PROBE_BUSY await safe boundary"})
        until(lambda: count("provider_request") > request_before)
        check("busy model has no premature agent_settled", count("agent_settled") == settled_before)
        dm(peer_id, "wake-while-busy")
        until(lambda: any(e["kind"] == "tool_result" and e.get("toolName") == "cct_check_messages"
                          and "wake-while-busy" in e.get("content", "") for e in events()), seconds=18)
        check("busy notice reaches provider after safe boundary", any(e["kind"] == "provider_request" and e.get("notice")
              for e in events() if e["at"] >= events()[next(i for i,e in enumerate(events()) if e["kind"] == "tool_result" and "wake-burst-2" in e.get("content", ""))]["at"]))
        until(lambda: count("agent_settled") > settled_before)
        previous_id = marker["sessionId"]
        response = command({"type": "new_session"})
        check("RPC session replacement accepted", response.get("data", {}).get("cancelled") is False)
        replacement = until(lambda: json.loads((work / "marker.json").read_text()) if
                            json.loads((work / "marker.json").read_text()).get("sessionId") != previous_id else None)
        replacement_peer = until(lambda: peer() if peer() and peer()[3] == "os:" + replacement["sessionId"] else None)
        check("new session rebinds to distinct resident peer", replacement_peer[0] != peer_id)
        start_count = count("agent_start")
        dm(replacement_peer[0], "wake-after-session-replacement")
        until(lambda: any(e["kind"] == "tool_result" and e.get("toolName") == "cct_check_messages"
                          and "wake-after-session-replacement" in e.get("content", "") for e in events()))
        check("replacement session wakes only its own new DM", count("agent_start") > start_count)
        (work / "result.json").write_text(json.dumps({"checks": checks, "evidence_dir": str(work),
            "package_version": manifest["version"], "no_rpc_prompt_before_first_dm": True}, indent=2))
    except BaseException as exc:
        (work / "failure.txt").write_text(repr(exc) + "\n")
        raise
    finally:
        if host and host.poll() is None:
            if tui:
                # Ctrl-D exits an idle open TUI; only sent after assertions (not a wake).
                os.write(master, b"\x04")
                try: host.wait(timeout=12)
                except subprocess.TimeoutExpired:
                    host.terminate()
                    try: host.wait(timeout=5)
                    except subprocess.TimeoutExpired: host.kill(); host.wait(timeout=5)
            else:
                try:
                    host.stdin.close(); host.wait(timeout=12)
                except (OSError, subprocess.TimeoutExpired):
                    if host.poll() is None:
                        host.terminate()
                        try: host.wait(timeout=5)
                        except subprocess.TimeoutExpired: host.kill(); host.wait(timeout=5)
        if reader: reader.join(timeout=3)
        if master is not None: os.close(master)
        if broker and broker.poll() is None:
            broker.terminate()
            try: broker.wait(timeout=8)
            except subprocess.TimeoutExpired: broker.kill(); broker.wait(timeout=5)
        for handle in handles: handle.close()
        active_owned_peers = None
        if host and (cct / "cct.db").exists():
            with sqlite3.connect(cct / "cct.db") as db:
                active_owned_peers = db.execute(
                    "SELECT COUNT(*) FROM peers WHERE host_pid=? AND status='active'", (host.pid,)).fetchone()[0]
        cleanup = {"host_exit": host.returncode if host else None,
                   "broker_exit": broker.returncode if broker else None,
                   "pidmaps_remaining": sorted(p.name for p in (cct / "pidmaps").iterdir()) if
                       (cct / "pidmaps").exists() else [],
                   "active_owned_peers": active_owned_peers}
        (work / "cleanup.json").write_text(json.dumps(cleanup, indent=2))
        print("OWNED_CLEANUP", cleanup, flush=True)
        if checks and all(item["passed"] for item in checks):
            assert cleanup == {"host_exit": 0, "broker_exit": 0,
                               "pidmaps_remaining": [], "active_owned_peers": 0}, cleanup
            assert any(e["kind"] == "session_shutdown" for e in events()), "missing host shutdown event"


if __name__ == "__main__":
    main()
