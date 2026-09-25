#!/usr/bin/env python3
"""Installed-os behavioral acceptance, using a local provider and an isolated broker.

Run CCT_OS_ADAPTER=/absolute/adapter/index.ts python3 test-os-runtime-live.py.
The selected os launcher must set Q7 in its host environment. The default idle
interval is 900 seconds; OS_IDLE_SECONDS changes it for calibration only.
This macOS harness preserves evidence under /private/tmp and never queries the
live CCT database, reads another agent's messages, or calls an external model.
"""
from pathlib import Path
import subprocess, tempfile, json, time, urllib.request, sqlite3, os, re, shutil, sys
REPO=Path(__file__).resolve().parent
ROOT=REPO/"test-fixtures/os"
NODE=shutil.which("node")
OS_BIN=os.environ.get("CCT_OS_BIN") or shutil.which("os")
ADAPTER=Path(os.environ["CCT_OS_ADAPTER"]).expanduser().resolve()
assert NODE and OS_BIN and ADAPTER.is_file(), "Installed node, os launcher, and adapter index.ts are required"
PORT=int(os.environ.get("CCT_OS_TEST_PORT", "17893"))
# Never connect to an existing broker or kill a process by its port.
import socket
with socket.socket() as port_probe:
    port_probe.bind(("127.0.0.1", PORT))
WORK=Path(tempfile.mkdtemp(prefix="cct-os-live-",dir="/private/tmp"))
CCT=WORK/"cct";CCT.mkdir()
URL=f"http://127.0.0.1:{PORT}"
BASE={"PATH":str(Path(NODE).parent)+":/usr/bin:/bin","CCT_DIR":str(CCT),"CCT_PORT":str(PORT),"CCT_BROKER":URL}
sessions=[];checks=[]
def check(name,condition):
    checks.append({"name":name,"passed":bool(condition),"timestamp":time.time()})
    (WORK/"checks.json").write_text(json.dumps(checks,indent=2))
    print(("PASS " if condition else "FAIL ")+name,flush=True)
    assert condition,name
def post(path,body):
    req=urllib.request.Request(URL+path,data=json.dumps(body).encode(),headers={"Content-Type":"application/json"})
    with urllib.request.urlopen(req,timeout=3) as res:return json.load(res)
def sql(query,args=()):
    with sqlite3.connect(CCT/"cct.db") as db:
        db.row_factory=sqlite3.Row
        return [dict(r) for r in db.execute(query,args)]
def wait(fn,timeout=20):
    stop=time.monotonic()+timeout
    while time.monotonic()<stop:
        try:
            result=fn()
            if result:return result
        except (OSError,urllib.error.URLError,sqlite3.Error,json.JSONDecodeError):pass
        time.sleep(.1)
    raise AssertionError("timed out")
def count(peer):
    p=CCT/"flags"/(peer+".unread")
    return int(p.read_text().split("|")[0]) if p.exists() else 0
class Session:
    def __init__(self,name,variant="normal",resume=None,agent=None):
        self.dir=WORK/name;self.dir.mkdir();self.home=self.dir/"home";self.home.mkdir()
        self.agent=agent or self.home/".os/agent";self.agent.mkdir(parents=True,exist_ok=True)
        self.cwd=self.dir/"project";self.cwd.mkdir()
        self.log=self.dir/"observations.jsonl";self.marker=self.dir/"marker.json";self.marker.write_text("{}")
        self.rpc=self.dir/"rpc.jsonl";self.err=self.dir/"stderr.log"
        extension=str(REPO/"os-extension.ts")
        if variant in ["delayed","missing"]:
            wrapper=self.dir/"wrapped.ts"
            # Build explicit valid syntax; the wrapper changes only marker timing.
            body='import extension from '+json.dumps(extension)+';\\nexport default function(pi:any) { extension(new Proxy(pi, { get(target,key) { if(key !== "on") return target[key]; return (event:any,handler:any)=>target.on(event,event==="session_start"?((e:any,c:any)=>{'+('setTimeout(()=>handler(e,c),5000);' if variant=="delayed" else '')+'}):handler); } })); }'
            wrapper.write_text(body.replace("\\n","\n"));extension=str(wrapper)
        extensions=[extension,str(ADAPTER),str(ROOT/"probe.ts")]
        if variant=="reverse":extensions=[str(ADAPTER),extension,str(ROOT/"probe.ts")]
        (self.agent/"settings.json").write_text(json.dumps({"extensions":extensions,"defaultProvider":"cct-probe","defaultModel":"local","compaction":{"enabled":False},"retry":{"enabled":False}}))
        (self.agent/"mcp.json").write_text(json.dumps({"mcpServers":{"cct":{"command":NODE,"args":["--import",str(REPO/"node_modules/tsx/dist/loader.mjs"),str(REPO/"server.ts")],"env":{"CCT_RUNTIME":"os"},"lifecycle":"keep-alive","directTools":True,"toolPrefix":"none","debug":True}}}))
        env={**BASE,"HOME":str(self.home),"TMPDIR":str(self.dir),"TERM":"dumb","OS_CODING_AGENT_DIR":str(self.agent),"PROBE_ROOT":str(ROOT),"PROBE_LOG":str(self.log),"PROBE_MARKER":str(self.marker)}
        self.handles=[self.rpc.open("w"),self.err.open("w")]
        args=[OS_BIN,"--mode","rpc","--provider","cct-probe","--model","local"]
        if resume:args+=["--session",str(resume)]
        self.p=subprocess.Popen(args,cwd=self.cwd,env=env,stdin=subprocess.PIPE,stdout=self.handles[0],stderr=self.handles[1],text=True)
        sessions.append(self)
        wait(lambda: self.marker.exists() and json.loads(self.marker.read_text()).get("sessionId"))
        self.meta=json.loads(self.marker.read_text());self.sid=self.meta["sessionId"];self.seq=0
    def events(self):
        result=[]
        for line in self.rpc.read_text().splitlines():
            try:result.append(json.loads(line))
            except json.JSONDecodeError:pass
        return result
    def command(self,text):
        self.seq+=1; ident=str(self.seq);self.p.stdin.write(json.dumps({"type":"prompt","id":ident,"message":text})+"\n");self.p.stdin.flush()
        wait(lambda:any(e.get("id")==ident and e.get("type")=="response" for e in self.events()))
        time.sleep(.1)
    def tool(self,name,args):
        before=len(self.events());self.command("PROBE_TOOL "+json.dumps({"name":name,"arguments":args}))
        wait(lambda:any(e.get("type")=="agent_settled" for e in self.events()[before:]))
        events=self.events()[before:]
        ends=[e for e in events if e.get("type")=="tool_execution_end"]
        assert ends,events[-4:]
        return ends[-1]
    def peer(self):
        return sql("select id,name,runtime,session_key,host_pid,pid,cwd,status from peers where host_pid=? and status='active'",(self.p.pid,))
    def ready(self):
        wait(lambda:self.log.exists() and any(e.get("kind")=="tools" and "cct_check_messages" in e.get("active",[]) for e in map(json.loads,self.log.read_text().splitlines())))
        result=self.tool("cct_whoami",{})
        assert not result.get("isError"),result
        return wait(self.peer)[0]
    def stop(self):
        if self.p.poll() is None:
            self.p.stdin.close()
            try:self.p.wait(timeout=12)
            except subprocess.TimeoutExpired:self.p.terminate();self.p.wait(timeout=10)
        for h in self.handles:h.close()
def messageText(result):
    return "\n".join(c.get("text","") for c in result.get("result",{}).get("content",[]))
brokerlog=(WORK/"broker.log").open("w")
broker=subprocess.Popen([NODE,"--import",str(REPO/"node_modules/tsx/dist/loader.mjs"),str(REPO/"broker.ts")],cwd=WORK,env={**BASE,"HOME":str(WORK)},stdout=brokerlog,stderr=brokerlog)
try:
    wait(lambda:urllib.request.urlopen(URL+"/health",timeout=1).status==200)
    main=Session("main");peer=main.ready();pid=peer["id"]
    host=next(e for e in map(json.loads,main.log.read_text().splitlines()) if e["kind"]=="host")
    check("Q7 launcher sets matching adapter/os directories",host["values"]["PI_CODING_AGENT_DIR"]==str(main.agent) and host["values"]["OS_CODING_AGENT_DIR"]==str(main.agent))
    check("row1 runtime/name/cwd",peer["runtime"]=="os" and re.fullmatch(r"os-[a-z0-9]{4}",peer["name"]) and peer["cwd"]==str(main.cwd.resolve()))
    check("row9 strict marker session key",peer["session_key"]=="os:"+main.sid)
    check("row10 cold cache becomes usable in this session","cct_check_messages" in main.log.read_text() and not (main.home/".pi").exists())
    # A real CCT MCP server with a scripted host is a fixture, not another agent.
    fixtureEnv={**BASE,"HOME":str(WORK),"CCT_RUNTIME":"claude","CLAUDE_CODE_SESSION_ID":"os-live-fixture","CCT_PEER_NAME":"os-test-recipient"}
    fixtureOut=(WORK/"fixture-rpc.log").open("w");fixtureErr=(WORK/"fixture.log").open("w")
    fixture=subprocess.Popen([NODE,"--import",str(REPO/"node_modules/tsx/dist/loader.mjs"),str(REPO/"server.ts")],cwd=WORK,env=fixtureEnv,stdin=subprocess.PIPE,stdout=fixtureOut,stderr=fixtureErr,text=True)
    recipient=wait(lambda:sql("select id,secret from peers where name='os-test-recipient' and status='active'"))[0]
    def incoming():
        assert post("/message/send",{"peer_id":recipient["id"],"peer_secret":recipient["secret"],"to_peer_id":pid,"body":"synthetic acceptance message"})["ok"]
        wait(lambda:count(pid)>0)
    incoming()
    sentinel=main.cwd/"ordinary-ran"
    result=main.tool("bash",{"command":f"touch '{sentinel}'"})
    check("row2 unread causes real block with callable tool",result.get("isError") and f"CCT: {count(pid)} unread" in messageText(result) and "cct_check_messages" in messageText(result) and not sentinel.exists())
    main.tool("cct_check_messages",{})
    check("row3 read clears flag",count(pid)==0)
    result=main.tool("bash",{"command":f"touch '{sentinel}'"})
    check("row4 next ordinary tool runs",not result.get("isError") and sentinel.exists())
    before=count(recipient["id"])
    main.tool("cct_send_message",{"to":"os-test-recipient","message":"synthetic MCP outbound"})
    wait(lambda:count(recipient["id"])>before)
    check("row5 MCP outbound increments recipient flag",True)
    before=count(recipient["id"])
    result=main.tool("bash",{"command":f"'{REPO}/node_modules/.bin/tsx' '{REPO}/cli.ts' send os-test-recipient 'synthetic CLI outbound'"})
    check("row5 CLI command succeeded",not result.get("isError"))
    wait(lambda:count(recipient["id"])>before)
    check("row5 CLI outbound increments recipient flag",True)
    incoming()
    check("second DM remains visible after a deferred-ack read",count(pid)>0)
    mapping=CCT/"pidmaps"/("os_"+main.sid);saved=mapping.read_bytes();mapping.unlink()
    result=main.tool("bash",{"command":"true"})
    check("row6 missing pidmap fails open and diagnoses",not result.get("isError") and "pidmap unavailable" in main.err.read_text())
    mapping.write_bytes(saved)
    main.command("/probe-disable-cct")
    result=main.tool("bash",{"command":"true"})
    check("row10 unavailable direct tool fails open without ack",not result.get("isError") and count(pid)>0)
    main.command("/probe-enable-cct");main.tool("cct_check_messages",{})
    # Start real wall-clock idle interval now; other cases run independently.
    idleStart=time.monotonic();idleWall=time.time()
    initialCalls=sum(1 for e in map(json.loads,main.log.read_text().splitlines()) if e["kind"]=="tool_call")
    (WORK/"idle-start.json").write_text(json.dumps({"wall":idleWall,"hostPid":main.p.pid,"peerId":pid,"toolCalls":initialCalls}))
    print("IDLE_STARTED "+str(WORK),flush=True)
    for variant in ["reverse","delayed","missing"]:
        s=Session(variant,variant);r=s.ready()
        if variant=="reverse":check("row11 reversed order retains marker identity",r["session_key"]=="os:"+s.sid)
        else:
            check("row11/12 "+variant+" fallback remains callable",r["session_key"].startswith("os-host:") and "source=fallback" in s.err.read_text())
        s.stop()
    resume=Session("resume-first");r=resume.ready();original=(r["id"],r["name"]);sessionFile=resume.meta["sessionFile"];agent=resume.agent
    oldpid=r["pid"];os.kill(oldpid,15)
    wait(lambda:resume.peer() and resume.peer()[0]["pid"]!=oldpid,timeout=40)
    r=resume.ready()
    check("row13 MCP respawn stable identity",len(resume.peer())==1 and (r["id"],r["name"])==original)
    resume.stop()
    resumed=Session("resume-second",resume=sessionFile,agent=agent);r=resumed.ready()
    check("row13 actual os resume stable identity",resumed.sid==resume.sid and (r["id"],r["name"])==original and len(resumed.peer())==1)
    resumed.stop()
    waitSeconds=int(os.environ.get("OS_IDLE_SECONDS","900"))
    while time.monotonic()-idleStart<waitSeconds:
        remaining=waitSeconds-(time.monotonic()-idleStart)
        (WORK/"progress.json").write_text(json.dumps({"elapsedSeconds":time.monotonic()-idleStart,"remainingSeconds":remaining,"hostAlive":main.p.poll() is None}))
        time.sleep(min(5,remaining))
    r=main.peer()
    finalCalls=sum(1 for e in map(json.loads,main.log.read_text().splitlines()) if e["kind"]=="tool_call")
    (WORK/"idle-end.json").write_text(json.dumps({"elapsedSeconds":time.monotonic()-idleStart,"peers":r,"initialToolCalls":initialCalls,"finalToolCalls":finalCalls},indent=2))
    check("row8 "+str(waitSeconds)+" seconds idle: peer active, zero tools",len(r)==1 and r[0]["id"]==pid and finalCalls==initialCalls and main.p.poll() is None)
    result={"work":str(WORK),"passed":len(checks),"requestedIdleSeconds":waitSeconds,"idleSeconds":time.monotonic()-idleStart}
    (WORK/"result.json").write_text(json.dumps(result,indent=2))
    print(json.dumps(result),flush=True)
finally:
    for s in sessions:s.stop()
    if "fixture" in locals():
        fixture.stdin.close()
        try:fixture.wait(timeout=12)
        except subprocess.TimeoutExpired:fixture.terminate();fixture.wait(timeout=10)
        fixtureOut.close();fixtureErr.close()
    broker.terminate();broker.wait(timeout=10);brokerlog.close()
    print("Evidence: "+str(WORK),flush=True)
