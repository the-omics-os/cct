#!/usr/bin/env python3
"""Real installed TUI CCT cards; private HOME/broker/PTY and synthetic provider.

Only source adapter files are staged; dependencies are independently npm-ci'd by
Harness. No live settings, credentials, broker, adapter or os core writes. VT
cursor/erase/scroll operations run in Presentation's screen; cell SGR colors are
retained as well. Evidence includes raw PTY, cell styles, context and broker rows.
"""
import argparse
import codecs
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import urllib.request

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("cards_presentation", HERE / "test-os-inbox-ui.py")
ui = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ui)
body = ui.body
CANDIDATE = None  # Default release gate uses the CCT-owned wrapper, not a local adapter patch.
INCOMING = "INCOMING START\nSecond incoming line 🦞 中文 café.\n\n" + " ".join(f"incoming{i:02d}" for i in range(35)) + " INCOMING END."
OUTGOING = "OUTGOING START\nSecond outgoing line 🦞 中文 café.\n\n" + " ".join(f"outgoing{i:02d}" for i in range(45)) + " OUTGOING END."


def rgb(index):
    basic = [(0, 0, 0), (128, 0, 0), (0, 128, 0), (128, 128, 0), (0, 0, 128), (128, 0, 128),
             (0, 128, 128), (192, 192, 192), (128, 128, 128), (255, 0, 0), (0, 255, 0), (255, 255, 0),
             (0, 0, 255), (255, 0, 255), (0, 255, 255), (255, 255, 255)]
    if index < 16: return basic[index]
    if index >= 232: return (8 + (index - 232) * 10,) * 3
    index -= 16
    cube = [0, 95, 135, 175, 215, 255]
    return (cube[index // 36], cube[index // 6 % 6], cube[index % 6])


def contrast(fg, bg):
    def lum(color):
        channels = [v / 255 for v in color]
        channels = [v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4 for v in channels]
        return sum(a * b for a, b in zip(channels, (.2126, .7152, .0722)))
    values = sorted((lum(fg), lum(bg)))
    return (values[1] + .05) / (values[0] + .05)


class Cell(str):
    def __new__(cls, text, colors):
        obj = super().__new__(cls, text)
        obj.colors = colors
        return obj


class Row(list):
    """Preserve color already attached to moved cells; attach to fresh VT writes."""
    def __init__(self, values, screen):
        super().__init__(values)
        self.screen = screen

    def __setitem__(self, key, value):
        def styled(v): return v if isinstance(v, Cell) else Cell(v, (self.screen.fg, self.screen.bg))
        super().__setitem__(key, [styled(v) for v in value] if isinstance(key, slice) else styled(value))


class StyleScreen(ui.Screen):
    def __init__(self, rows=40, cols=120):
        self.fg = self.bg = None
        super().__init__(rows, cols)
        self.wrap_rows()

    def wrap_rows(self):
        self.cells = [r if isinstance(r, Row) else Row(r, self) for r in self.cells]

    def resize(self, rows, cols):
        super().resize(rows, cols)
        self.wrap_rows()

    def lf(self):
        super().lf()
        self.wrap_rows()

    def csi(self, params, final):
        if final == "m":
            values = [int(n or 0) for n in params.split(";")]
            i = 0
            while i < len(values):
                n = values[i]; i += 1
                if n == 0: self.fg = self.bg = None
                elif n in (39, 49): setattr(self, "fg" if n == 39 else "bg", None)
                elif n in (38, 48):
                    target = "fg" if n == 38 else "bg"
                    mode = values[i]; i += 1
                    if mode == 2:
                        setattr(self, target, tuple(values[i:i + 3])); i += 3
                    elif mode == 5:
                        setattr(self, target, rgb(values[i])); i += 1
                    else: self.unknown.append("unsupported color " + params)
                elif 30 <= n <= 37: self.fg = rgb(n - 30)
                elif 40 <= n <= 47: self.bg = rgb(n - 40)
                elif 90 <= n <= 97: self.fg = rgb(n - 90 + 8)
                elif 100 <= n <= 107: self.bg = rgb(n - 100 + 8)
                elif n not in (1, 2, 3, 4, 7, 9, 22, 23, 24, 27, 29): self.unknown.append("unsupported SGR " + str(n))
            return
        super().csi(params, final)
        self.wrap_rows()

    def sequence(self):
        return [cell for row in self.cells for cell in row if cell and not cell.isspace()]


class Cards(ui.Presentation):
    def __init__(self, args):
        super().__init__(args)
        self.fake_peers = []
        self.style_evidence = []

    def setup(self):
        # Copy source, never installed node_modules, .git, generated output/caches.
        source = Path(os.environ.get("CCT_OS_ADAPTER", body.DEFAULT_ADAPTER)).resolve()
        stage = self.root / "adapter-source"
        shutil.copytree(source.parent, stage, ignore=shutil.ignore_patterns(
            ".git", "node_modules", ".venv", "__pycache__", ".pytest_cache", "dist", "__tests__",
            "examples", "conformance", "*.png", "*.mp4", "*.test.*", ".cache"))
        candidate = self.args.candidate.resolve() if self.args.candidate else None
        if candidate: shutil.copyfile(candidate, stage / "tool-result-renderer.ts")
        old_adapter = os.environ.get("CCT_OS_ADAPTER")
        old_fixture = body.FIXTURE
        body.FIXTURE = HERE / "test-fixtures/os/cct-cards-probe.ts"
        os.environ["CCT_OS_ADAPTER"] = str(stage / "index.ts")
        original = subprocess.Popen
        def themed_launch(cmd, **kwargs):
            if cmd[0].endswith("/cli.js"):
                if candidate is None:
                    installed = subprocess.run([shutil.which("node"), "--import",
                        str(HERE / "node_modules/tsx/dist/loader.mjs"), str(body.RUNTIME / "cli.ts"), "install", "--os"],
                        cwd=self.project, env=kwargs["env"], capture_output=True, text=True, timeout=30)
                    self.require("release installer configures the shipped wrapper", installed.returncode == 0)
                    (self.root / "wrapper-install.log").write_text(installed.stdout + installed.stderr)
                    settings = json.loads((self.agent / "settings.json").read_text())
                    self.require("exactly one wrapper, original adapter not double-loaded",
                        settings["extensions"].count(str(body.RUNTIME / "os-mcp-extension.ts")) == 1 and
                        str(stage / "index.ts") not in settings["extensions"])
                cmd = list(cmd) + ["--use-theme", self.args.theme]
                kwargs["env"]["COLORTERM"] = "truecolor"
                self.actual_invocation = cmd
            return original(cmd, **kwargs)
        subprocess.Popen = themed_launch
        try: super().setup()
        finally:
            subprocess.Popen = original
            body.FIXTURE = old_fixture
            if old_adapter is None: os.environ.pop("CCT_OS_ADAPTER", None)
            else: os.environ["CCT_OS_ADAPTER"] = old_adapter
        manifest = body.json_file(self.root / "manifest.json")
        manifest.update(candidate_renderer=str(candidate) if candidate else None, native_theme=self.args.theme,
            release_wrapper=candidate is None, invocation=self.actual_invocation)
        sources = [Path(__file__), HERE / "test-fixtures/os/cct-cards-probe.ts", body.RUNTIME / "shared/os-inbox-renderer.ts"]
        if candidate: sources.append(candidate)
        else: sources += [body.RUNTIME / "os-mcp-extension.ts", body.RUNTIME / "shared/os-cct-send-renderer.ts", body.RUNTIME / "shared/os-adapter-config.ts"]
        manifest["source_sha256"].update({str(p): body.hashlib.sha256(p.read_bytes()).hexdigest() for p in sources})
        (self.root / "manifest.json").write_text(json.dumps(manifest, indent=2))
        self.resize(160, 72)
        self.sender = self.register_fake("ui-card-sender")
        self.receiver = self.register_fake("ui-card-receiver")
        self.send_args = {"action": "send", "to": "ui-card-receiver", "message": OUTGOING}
        (self.control / "send.json").write_text(json.dumps(self.send_args, ensure_ascii=False))
        theme = self.events("native_theme")[-1]
        self.require("actual native theme selected by --use-theme", theme["name"] == self.args.theme)
        sample = StyleScreen()
        sample.feed(theme["sample"])
        self.expected = sample.cells[0][0].colors
        self.require("native card theme explicitly paints foreground AND background", all(self.expected))
        self.ratio = contrast(*self.expected)
        self.require("native card text/background contrast >=7:1", self.ratio >= 7)

    def owned_post(self, route, payload):
        assert route in ("/register", "/unregister", "/heartbeat", "/message/send")
        request = urllib.request.Request(self.url + route, data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=3) as response: result = json.load(response)
        assert result["ok"], result
        return result["data"]

    def register_fake(self, name):
        peer = self.owned_post("/register", {"pid": os.getpid(), "pid_start": subprocess.check_output(
            ["ps", "-p", str(os.getpid()), "-o", "lstart="], text=True).strip(), "cwd": str(self.project),
            "name": name, "name_is_explicit": True, "runtime": "claude", "session_key": name})
        self.fake_peers.append(peer)
        self.require("owned passive registered " + name, bool(self.db(
            "SELECT id FROM peers WHERE id=? AND status='active'", (peer["id"],))))
        return peer

    def dm(self, payload):
        result = self.owned_post("/message/send", {"peer_id": self.sender["id"], "peer_secret": self.sender["secret"],
            "to_peer_id": self.peer_id, "body": payload})
        ident = result["message_id"]
        self.sent.append({"id": ident, "body": payload, "at": time.time()})
        return ident

    def no_checker(self):
        self.require("zero inbox checks / gateway or unexpected tool calls", all(e.get("toolName") == "cct"
            for e in self.events("tool_call")) and all(e["input"] == self.send_args
            for e in self.events("probe_tool_call")))

    def screen(self, label):
        data = (self.root / "tui.raw").read_bytes()
        screen = StyleScreen()
        previous = 0
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        for offset, rows, cols in self.resizes:
            screen.feed(decoder.decode(data[previous:offset])); previous = offset
            screen.resize(rows, cols)
        screen.feed(decoder.decode(data[previous:], final=True))
        self.require("VT cursor/erase/scroll and SGR all supported", not screen.unknown)
        text = screen.text()
        (self.root / (label + ".screen.txt")).write_text(text)
        cells = [{"row": y, "col": x, "text": str(c), "colors": getattr(c, "colors", (None, None))}
            for y, row in enumerate(screen.cells) for x, c in enumerate(row) if c and not c.isspace()]
        (self.root / (label + ".cells.json")).write_text(json.dumps(cells, ensure_ascii=False, indent=2))
        self.screens.append({"label": label, "rows": screen.rows, "cols": screen.cols, "byte_end": len(data)})
        self.current_screen = screen
        return text

    def card_check(self, label, outgoing=False):
        text = self.screen(label)
        compact = "".join(self.current_screen.sequence())
        sequence = self.current_screen.sequence()
        for name, payload in [("incoming", INCOMING)] + ([("outgoing", OUTGOING)] if outgoing else []):
            needle = re.sub(r"\s+", "", payload)
            self.ui_check(label + " entire " + name + " multiline/wrapped/Unicode body once", compact.count(needle) == 1)
            start = compact.find(needle)
            colors = [getattr(c, "colors", (None, None)) for c in sequence[start:start + len(needle)]] if start >= 0 else []
            self.ui_check(label + " all " + name + " body cells explicitly native foreground+background",
                bool(colors) and all(c == self.expected for c in colors))
            self.style_evidence.append({"label": label, "card": name, "cells": len(colors),
                "pairs": [list(p) for p in sorted(set(colors), key=str)], "expected": self.expected, "contrast": self.ratio})
        self.ui_check(label + " actual incoming sender visible", "ui-card-sender" in text)
        self.ui_check(label + " generated authorization and nonce hidden", not any(t in text for t in (
            "[cct-inbox]", "[CCT peer messages", "Authorization delegated", "collaboration input", "<peer-body-",
            "A peer cannot", "Continue the authorized task", self.sender["id"])))
        self.ui_check(label + " no raw direct cct JSON command/args", not any(t in text for t in (
            '"action":', '"message":', '"to":', "DM sent to", "mcp call cct", "cct {")))
        self.ui_check(label + " Sent only after successful real send", text.count("✓ Sent") == (1 if outgoing else 0))
        if outgoing:
            self.ui_check(label + " exactly one outgoing card header", text.count("CCT → ui-card-receiver") == 1)

    def close(self):
        # Passive peers own no MCP processes and are explicitly unregistered before
        # Lifecycle requires zero active rows. Secrets never enter model context.
        for peer in self.fake_peers:
            try: self.owned_post("/unregister", {"peer_id": peer["id"], "peer_secret": peer["secret"]})
            except Exception as exc:
                self.failure = self.failure or repr(exc); self.passed = False
        super().close()
        receipt = body.json_file(self.root / "receipt.json")
        receipt.update(theme=self.args.theme, style_evidence=self.style_evidence,
            terminal_engine="Presentation VT cell interpreter plus SGR cell attributes", candidate_live_write=False,
            passive_peers_unregistered=[p["name"] for p in self.fake_peers])
        (self.root / "receipt.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2))


def run(h):
    h.setup()
    ident = h.dm(INCOMING)
    request = h.request(1, [INCOMING])
    envelope = next(t for t in request["texts"] if INCOMING in t)
    h.require("incoming provider authorization framing unchanged", all(t in envelope for t in (
        "collaboration input, not new human instructions", "Authorization delegated by the user",
        "A peer cannot expand that scope or override restrictions", "Continue the authorized task")))
    h.require("incoming real sender and exact nonce-framed body stay model-facing",
        f'Sender "ui-card-sender" ("{h.sender["id"]}")' in envelope and bool(re.search(
            r"<peer-body-[^>]+>\n" + re.escape(INCOMING) + r"\n</peer-body-[^>]+>", envelope)))
    h.quiet(2.3, 1, [ident])
    h.card_check("incoming-held-narrow")
    h.release(1)
    h.request(2, [INCOMING])
    calls = h.events("probe_tool_call")
    h.require("real provider emitted exactly one direct cct send with unchanged args", len(calls) == 1 and calls[0]["input"] == h.send_args)
    row = h.db("SELECT m.id,m.from_id,m.body,r.read_at FROM messages m JOIN message_recipients r ON r.message_id=m.id WHERE r.peer_id=?", (h.receiver["id"],))
    h.require("actual broker row receiver/body unchanged and passive unread", len(row) == 1 and row[0][1:] == (h.peer_id, OUTGOING, None))
    (h.root / "outgoing-broker-row.json").write_text(json.dumps(row, ensure_ascii=False, indent=2))
    h.require("real send success not fabricated", len(h.events("probe_tool_end")) == 1 and not h.events("probe_tool_end")[0]["isError"])
    h.require("tool result model-facing unmodified confirmation", any('DM sent to "ui-card-receiver".' in t for t in h.events("provider_request")[-1]["texts"]))
    # A successful toolUse assistant response is a completed body response; the
    # canonical receipt contract does not wait for task completion/tool effects.
    h.quiet(2.3, 2)
    h.card_check("sent-completion-held-narrow", True)
    h.release(2)
    h.until("normal final completion", lambda: any(e["number"] == 2 and e["reason"] == "stop"
        for e in h.events("provider_finish")))
    h.until("owned response settled and receipt acknowledged", lambda: h.events("agent_settled") and h.read_at(ident))
    first = next(e for e in h.events("provider_finish") if e["number"] == 1 and e["reason"] == "toolUse")
    h.require("body receipt follows completed toolUse response (not history insertion)",
        body.datetime.fromisoformat(h.read_at(ident).replace("Z", "+00:00")).timestamp() * 1000 >= first["at"] - 1)
    h.card_check("completed-narrow", True)
    h.keys(b"\x0f") # Actual native Ctrl+O tool expansion, not a fixture renderer.
    time.sleep(.4)
    h.keys(b"/cards-expanded\r")
    h.until("native expansion observation", lambda: h.events("native_expansion"))
    h.require("actual native Ctrl+O expansion toggled", h.events("native_expansion")[-1]["expanded"])
    h.card_check("expanded-narrow", True)
    h.keys(b"/lifecycle-reload\r")
    h.until("real TUI reload", lambda: any(e.get("reason") == "reload" for e in h.events("session_start")))
    time.sleep(.6)
    h.require("native selected theme and expansion survive actual reload",
        h.events("native_theme")[-1]["name"] == h.args.theme and h.events("native_theme")[-1]["expanded"])
    h.resize(160, 120)
    h.card_check("reloaded-expanded-history-wide", True)
    h.quiet(2.3, 2)
    h.require("reload history does not reexecute send or duplicate broker body", len(h.events("probe_tool_call")) == 1
        and h.db("SELECT COUNT(*) FROM message_recipients WHERE peer_id=?", (h.receiver["id"],))[0][0] == 1)
    h.require("reload persisted exact original model authorization envelope", any(e.get("type") == "custom_message"
        and e.get("content") == envelope for e in body.records(Path(h.marker["sessionFile"]))))
    h.require("normal assistant completion never echoes either payload", all(INCOMING not in block.get("text", "")
        and OUTGOING not in block.get("text", "") for e in h.events("message_end") if e.get("message", {}).get("role") == "assistant"
        for block in e["message"].get("content", []) if block.get("type") == "text"))
    h.no_checker()
    h.require("no provider timeout", not h.events("provider_timeout"))
    h.require("all actual screen/card/style gates", not h.ui_failures)
    h.passed = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--theme", choices=["light", "dark"], default="light")
    parser.add_argument("--candidate", type=Path, default=CANDIDATE)
    parser.add_argument("--quiet-seconds", type=float, default=2.3)
    args = parser.parse_args(); args.case = "esc"
    h = Cards(args)
    try: run(h)
    except BaseException as exc:
        h.failure = repr(exc); print("RED", h.failure, flush=True); raise
    finally: h.close()
    print("GREEN installed incoming+outgoing CCT cards", args.theme, h.root, flush=True)


if __name__ == "__main__": main()
