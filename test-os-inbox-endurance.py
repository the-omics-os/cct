#!/usr/bin/env python3
"""Owned installed-os synthetic acceptance. Private HOME/broker, no inherited credentials.

Run --case budgets|consecutive|fork|pingpong|reconnect|locality|reload|install|calibration|endurance.
Endurance requires 900s quiet then 7200s periodic synthetic DMs with real MCP
reconnect; keep process/log/result and verify final exit.
"""
import argparse
import json
import os
from pathlib import Path
import hashlib
import signal
import subprocess
import sys
import time
import importlib.util
spec = importlib.util.spec_from_file_location("inbox_hardening", Path(__file__).with_name("test-os-inbox-hardening.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
Harness, records, HERE = module.Harness, module.records, module.HERE
FROZEN_FILES = ("os-extension.ts", "server.ts", "broker.ts", "cli.ts",
                "test-os-inbox-endurance.py", "test-os-inbox-hardening.py",
                "test-fixtures/os/inbox-hardening-probe.ts", "test-fixtures/os/inbox-hardening-slow-input.ts")

def digests():
    return {name: hashlib.sha256((HERE / name).read_bytes()).hexdigest() for name in FROZEN_FILES}

def reconnect(h, expected_digest):
    h.require("source digests unchanged before reconnect", digests() == expected_digest)
    old_id = h.peer_id
    old_session = json.loads(h.marker.read_text())["sessionId"]
    marker = h.cct / "pidmaps" / f"os_{old_session}"
    old_producer = marker.read_text().split("|")[2]
    h.command("/mcp reconnect cct")
    wait(h, "actual MCP reconnect changed MCP producer, retained original peer and session",
         lambda: marker.exists() and len(marker.read_text().split("|")) >= 3 and
                 marker.read_text().split("|")[2] != old_producer and h.peer() and
                 h.peer()[0] == old_id and h.peer()[3] == "os:" + old_session and
                 h.metadata() and h.metadata().get("producer") == marker.read_text().split("|")[2], seconds=35)
    h.require("source digests unchanged after reconnect", digests() == expected_digest)


def owned_signal(signum, _frame):
    raise RuntimeError(f"owned harness received signal {signum}; cleanup required")

signal.signal(signal.SIGTERM, owned_signal)
signal.signal(signal.SIGINT, owned_signal)


def wait(h, label, fn, seconds=22):
    result = h.await_(fn, seconds=seconds)
    h.require(label, result)
    return result


def checker(h, label):
    return [e for e in h.kind("tool_result") if e.get("toolName") == "cct_check_messages" and label in e.get("content", "")]


def send_and_check(source, target, label):
    before = len(target.kind("provider_request"))
    settled = len(target.kind("agent_settled"))
    source.post("/message/send-cli", {"to_peer_id": target.peer_id, "body": label})
    wait(target, f"{label}: actual checker result", lambda: checker(target, label))
    target.await_(lambda: len(target.kind("agent_settled")) > settled)
    target.require(f"{label}: one actual automatic run",
                   len(target.kind("agent_start")) == len(target.kind("agent_settled")) and
                   len(target.kind("provider_request")) > before)


def quiet(h, duration, label):
    before = len(h.kind("provider_request"))
    deadline = time.monotonic() + duration
    while time.monotonic() < deadline:
        h.require(label + " host alive", h.host.poll() is None)
        if len(h.kind("provider_request")) != before: raise AssertionError(label + ": unsolicited provider run")
        time.sleep(min(2, max(.05, deadline - time.monotonic())))
    h.require(label + " no unsolicited provider run", len(h.kind("provider_request")) == before)


def run(case):
    # Two distinct installed os hosts; separate HOME/agent dirs, common owned SQLite broker.
    a = Harness("endurance-a")
    b = None
    outcome = "FAIL"
    frozen = digests()
    try:
        a.setup()
        if case in ("budgets", "consecutive", "fork", "reload", "endurance", "calibration", "pingpong", "reconnect"):
            b = Harness("endurance-b", shared=a)
            b.setup()
            a.require("different real os sessions and peer identities", a.peer_id != b.peer_id and
                      json.loads(a.marker.read_text())["sessionId"] != json.loads(b.marker.read_text())["sessionId"])
        if case == "locality":
            for mode, expected in (("locality-remote", False), ("locality-optin", True),
                                   ("locality-master-off", False)):
                h = Harness(mode, shared=a)
                try:
                    h.setup()
                    h.require("resolved locality is nonloopback-name despite loopback DNS",
                              h.metadata().get("localBroker") is False if mode != "locality-master-off" else
                              h.metadata().get("localBroker") is True)
                    h.dm("policy-" + mode)
                    if expected: wait(h, "remote opt-in actual checker", lambda: checker(h, "policy-" + mode))
                    else: quiet(h, 3, mode + " suppressed")
                finally: h.close()
        elif case in ("endurance", "calibration"):
            quiet_seconds = 900 if case == "endurance" else 5
            soak_seconds = 7200 if case == "endurance" else 18
            interval_seconds = 70 if case == "endurance" else 7
            initial_a, initial_b = len(a.kind("provider_request")), len(b.kind("provider_request"))
            until = time.monotonic() + quiet_seconds
            while time.monotonic() < until:
                a.require("pre-delivery quiet hosts alive and frozen source", a.host.poll() is None and b.host.poll() is None and digests() == frozen)
                if len(a.kind("provider_request")) != initial_a or len(b.kind("provider_request")) != initial_b:
                    raise AssertionError("unsolicited provider during 900-second quiet")
                time.sleep(min(5, max(.05, until - time.monotonic())))
            a.require("both hosts stayed quiet for requested interval", len(a.kind("provider_request")) == initial_a and
                      len(b.kind("provider_request")) == initial_b)
            send_and_check(b, a, "after-quiet-idle")
            reconnect(a, frozen)
            send_and_check(b, a, "after-first-reconnect")
            start = time.monotonic()
            n = 0
            while time.monotonic() - start < soak_seconds:
                # Initial after-quiet and after-reconnect starts count too. Reset
                # after seven periodic starts (2 + 7 = 9), before the tenth.
                if n and n % 7 == 0:
                    settled = len(a.kind("agent_settled"))
                    ident = a.rpc_send({"type": "prompt", "message": "HUMAN_ENDURANCE_RESET"})
                    a.require("human reset accepted", a.response(ident).get("success"))
                    a.await_(lambda: len(a.kind("agent_settled")) > settled)
                label = f"soak-{n:04d}"
                if n and n % 7 == 0:
                    reconnect(a, frozen)
                send_and_check(b, a, label)
                a.require("frozen source digest during soak", digests() == frozen)
                n += 1
                interval = min(interval_seconds, max(0, soak_seconds - (time.monotonic() - start)))
                quiet(a, interval, "soak quiet")
            a.require("requested monotonic soak elapsed", time.monotonic() - start >= soak_seconds)
        elif case == "fork":
            for i in range(5): send_and_check(b, a, f"fork-before-{i}")
            old = json.loads(a.marker.read_text())["sessionId"]
            old_peer = a.peer_id
            ident = a.rpc_send({"type": "clone"})
            a.require("real installed clone succeeded", a.response(ident).get("success"))
            wait(a, "fork has a distinct logical os session marker", lambda:
                 a.marker.exists() and json.loads(a.marker.read_text())["sessionId"] != old)
            wait(a, "fork has distinct keyed CCT peer", lambda: a.peer() and
                 a.peer()[0] != old_peer and a.peer()[3] == "os:" + json.loads(a.marker.read_text())["sessionId"], seconds=20)
            a.peer_id = a.peer()[0]
            a.dm("fork-new-logical-budget")
            wait(a, "new logical session starts despite inherited old rate history",
                 lambda: checker(a, "fork-new-logical-budget"), seconds=20)
        elif case == "reconnect":
            send_and_check(b, a, "before-calibration-reconnect")
            reconnect(a, frozen)
            send_and_check(b, a, "after-calibration-reconnect")
        elif case == "pingpong":
            (a.root / "pong-target").write_text(b.peer_id)
            (b.root / "pong-target").write_text(a.peer_id)
            a.dm("PINGPONG:0")
            wait(a, "first real checker", lambda: checker(a, "PINGPONG:0"))
            wait(b, "second real checker from model-generated peer reply", lambda: checker(b, "PINGPONG:1"), seconds=20)
            # Observe genuine CCT tool send and reciprocal check, not a CLI
            # series mislabeled ping-pong. Rate limits should bound it.
            # Replies continue during this observation interval; they are NOT
            # unsolicited runs. Assert only bounded counts and no mid-run steer.
            until = time.monotonic() + 16
            while time.monotonic() < until:
                a.require("pingpong hosts alive", a.host.poll() is None and b.host.poll() is None)
                time.sleep(min(2, until - time.monotonic()))
            sends = a.kind("pong_send") + b.kind("pong_send")
            a.require("model CCT peer-send tool actually executed", bool(sends) and
                      any(e.get("toolName") == "cct" for e in a.kind("tool_result")))
            a.require("two host automatic start bound", len(a.kind("agent_start")) <= 5 and len(b.kind("agent_start")) <= 5)
            a.require("no busy notice steered inside autonomous runs",
                      len([e for e in a.kind("message_end") if e.get("customType") == "cct-inbox-notice"]) <= len(a.kind("agent_start")) and
                      len([e for e in b.kind("message_end") if e.get("customType") == "cct-inbox-notice"]) <= len(b.kind("agent_start")))
        elif case == "consecutive":
            for i in range(5): send_and_check(b, a, f"consecutive-first-{i}")
            quiet(a, 62, "rolling cap expires without blocked message")
            for i in range(5): send_and_check(b, a, f"consecutive-second-{i}")
            count = len(a.kind("agent_start"))
            a.require("ten genuine automatic starts without human input", count == 10)
            a.dm("consecutive-blocked")
            quiet(a, 4, "consecutive ceiling")
            a.require("tenth start ceiling enforced", len(a.kind("agent_start")) == count)
            # A trusted RPC prompt starts a genuine human run; /cct-wake status
            # is an extension command and must NOT count as a human reset.
            ident = a.rpc_send({"type": "prompt", "message": "HUMAN_CONSECUTIVE_RESET"})
            a.require("trusted human prompt accepted", a.response(ident).get("success"))
            wait(a, "trusted human model run", lambda: any(e.get("lastText") == "HUMAN_CONSECUTIVE_RESET" for e in a.kind("provider_request")))
            a.await_(lambda: len(a.kind("agent_settled")) >= count + 1)
            a.dm("after-human-reset")
            quiet(a, 62, "rolling budget still refuses fresh DM after human reset")
            a.require("fresh DM remains rate-refused even after its window elapses",
                      len(a.kind("agent_start")) == count + 1)
            a.dm("after-human-reset-newer")
            wait(a, "strictly newer DM wakes after genuine human reset and elapsed rate window",
                 lambda: checker(a, "after-human-reset-newer"), seconds=18)
        elif case == "budgets":
            # Drive real peer-to-peer messages without RPC prompts; automatic
            # starts alone must not reset the consecutive counter.
            for i in range(5): send_and_check(b, a, f"budget-first-{i}")
            before = len(a.kind("provider_request"))
            b.dm("separate-peer-is-alive")
            wait(b, "peer B independent checker", lambda: checker(b, "separate-peer-is-alive"))
            a.dm("budget-rate-limited")
            quiet(a, 3, "rolling five-in-sixty cap")
            a.require("rate cap suppressed next start", len(a.kind("provider_request")) == before)
            # Must wait a full rolling minute, then use fresh unread episodes.
            quiet(a, 62, "rolling window elapsed")
            for i in range(5): send_and_check(b, a, f"budget-second-{i}")
            before = len(a.kind("provider_request"))
            a.dm("budget-consecutive-limited")
            quiet(a, 3, "consecutive ten-start cap")
            a.require("consecutive cap did not wake", len(a.kind("provider_request")) == before)
        elif case == "reload":
            for i in range(5): send_and_check(b, a, f"reload-budget-{i}")
            count = len(a.kind("provider_request"))
            a.command("/hardening-reload")
            wait(a, "real reload command completed", lambda: a.kind("reload_done"))
            wait(a, "same session peer re-registered after reload", lambda: a.peer() and
                 a.peer()[3] == "os:" + json.loads(a.marker.read_text())["sessionId"], seconds=18)
            a.peer_id = a.peer()[0]
            count = len(a.kind("provider_request"))
            a.dm("reload-budget-limited")
            quiet(a, 4, "reload retained rate budget")
            a.require("reload did not bypass rolling cap", len(a.kind("provider_request")) == count)
        elif case == "install":
            # Separate scratch installer operation uses exactly the fixture's
            # private OS/PI agent dir and private HOME, never operator settings.
            installed = subprocess.run([a.node, "--import", str(HERE / "node_modules/tsx/dist/loader.mjs"),
                                        str(HERE / "cli.ts"), "install", "--os"], cwd=a.project,
                env={**a.env, "PI_CODING_AGENT_DIR": str(a.agent), "PI_MCP_CONFIG_MODE": "exclusive"},
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=40)
            (a.root / "scratch-install.log").write_text(installed.stdout)
            a.require("actual scratch cct install --os exited 0", installed.returncode == 0)
            settings = json.loads((a.agent / "mcp.json").read_text())
            a.require("scratch installer uses same isolated adapter/server MCP surface",
                      settings["mcpServers"]["cct"]["env"]["CCT_TOOL_SURFACE"] == "compact")
        else: raise ValueError(case)
        a.require("source digests frozen through test", digests() == frozen)
        outcome = "PASS"
        print("GREEN", case, flush=True)
    finally:
        if b: b.close()
        a.close()
        (a.root / "endurance-result.json").write_text(json.dumps({"case": case, "outcome": outcome,
            "finished": time.time(), "source_sha256": frozen,
            "final_source_sha256": digests(), "source_unchanged": digests() == frozen}, indent=2))
        print("RESULT", a.root / "endurance-result.json", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", choices=["budgets", "consecutive", "fork", "pingpong", "reconnect", "locality", "reload", "install", "calibration", "endurance"], required=True)
    args = parser.parse_args()
    if args.case == "endurance":
        def deadline(_signal, _frame): raise TimeoutError("owned endurance deadline 8700 seconds")
        signal.signal(signal.SIGALRM, deadline)
        signal.alarm(8700)
    run(args.case)
