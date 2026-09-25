#!/bin/bash
set -euo pipefail
# Source identity regression; the installed-runtime delivery/idle harness is separate.
export CCT_TEST_REPO="$(cd "$(dirname "$0")" && pwd)"
npx tsx "$CCT_TEST_REPO/test-os-extension.ts"
python3 "$CCT_TEST_REPO/test-os-compact-installer.py"
OS_TEST_WORK=$(mktemp -d /tmp/cct-os-e2e.XXXXXX)
trap 'if [ "${CCT_OS_KEEP_EVIDENCE:-0}" != 1 ]; then rm -rf "$OS_TEST_WORK"; else echo "Evidence: $OS_TEST_WORK"; fi' EXIT
cat > "$OS_TEST_WORK/identity-host.mjs" <<'OS_HOST_EOF'
import fs from "node:fs";
import { spawn } from "node:child_process";
import readline from "node:readline";
process.title = "os";
const session = process.argv[2];
const marker = `${process.env.CCT_DIR}/pidmaps/os_session_${process.pid}`;
fs.mkdirSync(`${process.env.CCT_DIR}/pidmaps`, { recursive: true, mode: 0o700 });
if (session !== "missing") fs.writeFileSync(marker, session, { mode: 0o600 });
const children = new Set();
function start() {
  const child = spawn(process.execPath, ["--import", `${process.env.CCT_REPO}/node_modules/tsx/dist/loader.mjs`, `${process.env.CCT_REPO}/server.ts`], { stdio:["pipe","ignore","inherit"], env:process.env });
  children.add(child);
  child.on("exit",()=>children.delete(child));
}
start();
readline.createInterface({input:process.stdin}).on("line",line=>{
  if (line === "respawn") {
    const old = [...children];
    let left = old.length;
    for (const child of old) {
      child.once("exit",()=>{if (--left===0) start();});
      child.stdin.end();
    }
  } else if (line === "second") start();
});
async function shutdown() {
  for (const child of children) child.stdin.end();
  while (children.size) await new Promise(r=>setTimeout(r,20));
  try { fs.unlinkSync(marker); } catch {}
  process.exit(0);
}
process.on("SIGTERM",shutdown);
process.stdin.on("end",shutdown);
OS_HOST_EOF
cat > "$OS_TEST_WORK/identity-probe.py" <<'OS_PROBE_EOF'
from pathlib import Path
import subprocess,tempfile,json,time,urllib.request,sqlite3,os,shutil
ROOT=Path(__file__).resolve().parent
REPO=Path(os.environ["CCT_TEST_REPO"])
NODE=shutil.which("node")
PORT=int(os.environ.get("CCT_OS_TEST_PORT","17890"))
WORK=Path(tempfile.mkdtemp(prefix="cct-os-identity-",dir=ROOT))
CCT=WORK/"cct";CCT.mkdir();PROJECT=WORK/"project";PROJECT.mkdir()
URL=f"http://127.0.0.1:{PORT}"
env={"PATH":"/opt/homebrew/bin:/usr/bin:/bin","HOME":str(WORK),"CCT_DIR":str(CCT),"CCT_PORT":str(PORT),"CCT_BROKER":URL,"CCT_RUNTIME":"os","CCT_REPO":str(REPO)}
hosts=[];handles=[];checks=[]
def check(name,condition):
    checks.append({"name":name,"passed":bool(condition)})
    print(("PASS " if condition else "FAIL ")+name,flush=True)
    assert condition,name
def post(path,body):
    req=urllib.request.Request(URL+path,data=json.dumps(body).encode(),headers={"Content-Type":"application/json"})
    with urllib.request.urlopen(req,timeout=3) as res:return json.load(res)
def rows():
    with sqlite3.connect(CCT/"cct.db") as db:
        db.row_factory=sqlite3.Row
        return [dict(r) for r in db.execute("select id,name,runtime,session_key,host_pid,status,pid from peers where status='active'")]
def wait(fn,timeout=12):
    stop=time.monotonic()+timeout
    while time.monotonic()<stop:
        try:
            v=fn()
            if v:return v
        except (ConnectionError,urllib.error.URLError,sqlite3.Error):pass
        time.sleep(.1)
    raise AssertionError("timed out")
def launch(session):
    f=(WORK/f"host-{len(hosts)}.log").open("w");handles.append(f)
    p=subprocess.Popen([NODE,str(ROOT/"identity-host.mjs"),session],cwd=PROJECT,env=env,stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=f,text=True)
    hosts.append(p);return p
def stop(p):
    p.stdin.close();p.wait(timeout=12)
brokerlog=(WORK/"broker.log").open("w");handles.append(brokerlog)
broker=subprocess.Popen([NODE,"--import",str(REPO/"node_modules/tsx/dist/loader.mjs"),str(REPO/"broker.ts")],cwd=PROJECT,env=env,stdout=brokerlog,stderr=brokerlog)
try:
    wait(lambda:urllib.request.urlopen(URL+"/health",timeout=1).status==200)
    session="01a09000-0000-7000-8000-000000000010"
    a=launch(session);r=wait(lambda:rows());r=r[0]
    check("marker produces strict os session key",r["session_key"]=="os:"+session)
    check("os runtime, prefix and actual host",r["runtime"]=="os" and r["name"].startswith("os-") and r["host_pid"]==a.pid)
    identity=(r["id"],r["name"]);oldpid=r["pid"]
    a.stdin.write("respawn\n");a.stdin.flush()
    wait(lambda:rows() and rows()[0]["pid"]!=oldpid)
    check("MCP respawn keeps id/name and exactly one peer",len(rows())==1 and (rows()[0]["id"],rows()[0]["name"])==identity)
    check("MCP cleanup preserves extension marker",(CCT/"pidmaps"/f"os_session_{a.pid}").exists())
    a.stdin.write("second\n");a.stdin.flush();time.sleep(1.3)
    check("two same-session MCP connections retain one peer",len(rows())==1)
    stop(a);wait(lambda:not rows())
    a=launch(session);r=wait(lambda:rows())[0]
    check("resume on new host keeps id/name",(r["id"],r["name"])==identity)
    stop(a);wait(lambda:not rows())
    b=launch("missing");r=wait(lambda:rows())[0]
    check("missing marker uses explicit os-host fallback",r["session_key"].startswith("os-host:"+str(b.pid)+"_"))
    fallbackId=r["id"]
    b.stdin.write("second\n");b.stdin.flush();time.sleep(1.3)
    check("fallback MCP siblings share identity",len(rows())==1 and rows()[0]["id"]==fallbackId)
    stop(b);wait(lambda:not rows())
    logs="".join(p.read_text() for p in WORK.glob("host-*.log"))
    check("marker and fallback both diagnosed","source=marker" in logs and "source=fallback" in logs)
    # Direct broker exercise uses this controlled driver's real pid/start.
    pid=os.getpid()
    start=subprocess.check_output(["ps","-o","lstart=","-p",str(pid)],text=True).strip()
    start="_".join(start.split())
    base={"pid":pid,"pid_start":start,"host_pid":pid,"host_pid_start":start,"cwd":str(PROJECT)}
    c=post("/register",{**base,"runtime":"claude","session_key":"claude-control","name":"control"})["data"]
    w=post("/register",{**base,"runtime":"os","session_key":"os-host:controlled","name":"os-weak"})["data"]
    s=post("/register",{**base,"runtime":"os","session_key":"os:controlled-a","name":"os-first"})["data"]
    check("weak os identity upgrades without changing peer",w["id"]==s["id"])
    t=post("/register",{**base,"runtime":"os","session_key":"os:controlled-b","name":"os-second"})["data"]
    check("distinct strong os sessions on one host stay separate",s["id"]!=t["id"])
    with sqlite3.connect(CCT/"cct.db") as db:
        unchanged=db.execute("select status,runtime,session_key from peers where id=?",(c["id"],)).fetchone()
        check("SQL: os adoption leaves Claude row unchanged",unchanged==("active","claude","claude-control"))
    print(json.dumps({"work":str(WORK),"passed":len(checks)}),flush=True)
finally:
    for p in hosts:
        if p.poll() is None:
            p.terminate()
            try:p.wait(timeout=12)
            except subprocess.TimeoutExpired:p.kill();p.wait()
    broker.terminate();broker.wait(timeout=10)
    for f in handles:f.close()
    (WORK/"result.json").write_text(json.dumps(checks,indent=2))
    (ROOT/"identity-latest.txt").write_text(str(WORK)+"\n")
OS_PROBE_EOF
python3 "$OS_TEST_WORK/identity-probe.py"
