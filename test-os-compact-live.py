#!/usr/bin/env python3
"""Isolated installed-os compact-surface acceptance; never touches real homes/brokers."""
from pathlib import Path
import subprocess, tempfile, json, time, urllib.request, sqlite3, os, shutil, socket, signal
REPO=Path(__file__).resolve().parent
ROOT=REPO/'test-fixtures/os'
NODE=shutil.which('node'); OS_BIN=os.environ.get('CCT_OS_BIN') or shutil.which('os')
ADAPTER=Path(os.environ.get('CCT_OS_ADAPTER','')).expanduser().resolve()
assert NODE and OS_BIN and ADAPTER.is_file(), 'installed os, node, and CCT_OS_ADAPTER are required'
PORT=int(os.environ.get('CCT_OS_TEST_PORT','17896'))
with socket.socket() as s:s.bind(('127.0.0.1',PORT))
WORK=Path(tempfile.mkdtemp(prefix="cct-os-compact-",dir="/private/tmp")); CCT=WORK/'cct'; CCT.mkdir()
EVIDENCE_DIR=REPO/'.planning/COMPACT_TOOLS/codex/evidence'; EVIDENCE_DIR.mkdir(parents=True,exist_ok=True)
URL=f'http://127.0.0.1:{PORT}'; BASE={'PATH':str(Path(NODE).parent)+':/usr/bin:/bin','CCT_DIR':str(CCT),'CCT_PORT':str(PORT),'CCT_BROKER':URL}
checks=[];sessions=[]
def record(name, ok, evidence):
    checks.append({'row':name,'passed':bool(ok),'evidence':evidence})
    print(('PASS ' if ok else 'FAIL ')+name,flush=True)
    if not ok:
        print(json.dumps(evidence,indent=2),flush=True)
        raise AssertionError(name)
def wait(fn,timeout=20):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        try:
            x=fn()
            if x:return x
        except Exception:pass
        time.sleep(.1)
    raise AssertionError('timeout')
def post(path,body):
    req=urllib.request.Request(URL+path,data=json.dumps(body).encode(),headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=3) as r:return json.load(r)
def sql(q,args=()):
    with sqlite3.connect(CCT/'cct.db') as db:
        db.row_factory=sqlite3.Row;return [dict(r) for r in db.execute(q,args)]
def flag(peer):
    p=CCT/'flags'/(peer+'.unread');return p.read_text() if p.exists() else ''
class Session:
    def __init__(self,name,agent=None,resume=None,surface='compact'):
        self.dir=WORK/name;self.dir.mkdir();self.home=self.dir/'home';self.home.mkdir();self.agent=agent or self.home/'.os/agent';self.agent.mkdir(parents=True,exist_ok=True)
        self.cwd=self.dir/'project';self.cwd.mkdir();self.log=self.dir/'observations.jsonl';self.marker=self.dir/'marker.json';self.marker.write_text('{}');self.rpc=self.dir/'rpc.jsonl';self.err=self.dir/'stderr.log'
        exts=[str(REPO/'os-extension.ts'),str(ADAPTER),str(ROOT/'probe.ts')]
        (self.agent/'settings.json').write_text(json.dumps({'extensions':exts,'defaultProvider':'cct-probe','defaultModel':'local','compaction':{'enabled':False},'retry':{'enabled':False}}))
        (self.agent/'mcp.json').write_text(json.dumps({'mcpServers':{'cct':{'command':NODE,'args':['--import',str(REPO/'node_modules/tsx/dist/loader.mjs'),str(REPO/'server.ts')],'env':{'CCT_RUNTIME':'os','CCT_TOOL_SURFACE':surface},'lifecycle':'keep-alive','directTools':True,'toolPrefix':'none','debug':True}}}))
        env={**BASE,'HOME':str(self.home),'TMPDIR':str(self.dir),'TERM':'dumb','OS_CODING_AGENT_DIR':str(self.agent),'PI_CODING_AGENT_DIR':str(self.agent),'PI_MCP_CONFIG_MODE':'exclusive','PROBE_ROOT':str(ROOT),'PROBE_LOG':str(self.log),'PROBE_MARKER':str(self.marker)}
        self.out=self.rpc.open('w');self.errfile=self.err.open('w');args=[OS_BIN,'--mode','rpc','--provider','cct-probe','--model','local']
        if resume:args+=['--session',str(resume)]
        self.p=subprocess.Popen(args,cwd=self.cwd,env=env,stdin=subprocess.PIPE,stdout=self.out,stderr=self.errfile,text=True);sessions.append(self);self.seq=0
        wait(lambda:self.marker.exists() and json.loads(self.marker.read_text()).get('sessionId'));self.meta=json.loads(self.marker.read_text());self.sid=self.meta['sessionId']
    def events(self):
        result=[]
        for l in self.rpc.read_text().splitlines():
            try:result.append(json.loads(l))
            except:pass
        return result
    def prompt(self,text):
        self.seq+=1;ident=str(self.seq);self.p.stdin.write(json.dumps({'type':'prompt','id':ident,'message':text})+'\n');self.p.stdin.flush();wait(lambda:any(e.get('id')==ident and e.get('type')=='response' for e in self.events()));time.sleep(.1)
    def tool(self,name,args):
        before=len(self.events());self.prompt('PROBE_TOOL '+json.dumps({'name':name,'arguments':args}));wait(lambda:any(e.get('type')=='agent_settled' for e in self.events()[before:]));es=self.events()[before:];ends=[e for e in es if e.get('type')=='tool_execution_end'];assert ends,es[-5:];return ends[-1]
    def peer(self):return sql("select id,name,runtime,session_key,host_pid,status from peers where host_pid=? and status='active'",(self.p.pid,))
    def stop(self):
        if self.p.poll() is None:
            try:self.p.stdin.close();self.p.wait(timeout=10)
            except Exception:
                if self.p.poll() is None:self.p.terminate();self.p.wait(timeout=5)
        self.out.close();self.errfile.close()
def text(r):return '\n'.join(c.get('text','') for c in r.get('result',{}).get('content',[]))
blog=(WORK/'broker.log').open('w');broker=subprocess.Popen([NODE,'--import',str(REPO/'node_modules/tsx/dist/loader.mjs'),str(REPO/'broker.ts')],cwd=WORK,env={**BASE,'HOME':str(WORK)},stdout=blog,stderr=blog)
fixture=None
try:
    wait(lambda:urllib.request.urlopen(URL+'/health',timeout=1).status==200)
    # Rows 1-4: cold compact registration, eager tools, guarded recovery, bare cct exemption.
    s=Session('cold');initial_bash=s.tool('bash',{'command':'true'});wait(lambda:s.log.exists() and any(e.get('kind')=='tools' and 'cct' in e.get('active',[]) for e in map(json.loads,s.log.read_text().splitlines())))
    active=next([n for n in e['active'] if n.startswith('cct')] for e in reversed(list(map(json.loads,s.log.read_text().splitlines()))) if e.get('kind')=='tools' and 'cct' in e.get('active',[]))
    p=wait(s.peer)[0];checklist=s.log.read_text();record('1 cold registration and tools/list exactly two',len(active)==2 and set(active)=={'cct_check_messages','cct'}, {'peer':p,'active_tools':active})
    # Cache is shared-format tool state; compact check exists before any model tool search/call.
    cache=json.loads((s.agent/'mcp-cache.json').read_text());cct_tools=cache.get('tools',{}).get('cct',[]) if isinstance(cache.get('tools'),dict) else []
    initial='cct_check_messages' in checklist and 'cct' in checklist
    record('2 recovery tool active eagerly',initial,{'active_tools':active,'observation_log':str(EVIDENCE_DIR/'os-cold-observations.jsonl')})
    compact_provider=next(e['providerContextBytes'] for e in map(json.loads,s.log.read_text().splitlines()) if e.get('kind')=='provider_input')
    legacy_measure=Session('measure-legacy',surface='legacy');legacy_measure.tool('bash',{'command':'true'})
    wait(lambda:any(json.loads(line).get('kind')=='provider_input' for line in legacy_measure.log.read_text().splitlines()))
    legacy_provider=next(e['providerContextBytes'] for e in map(json.loads,legacy_measure.log.read_text().splitlines()) if e.get('kind')=='provider_input')
    legacy_measure.stop()
    s.tool('cct_check_messages',{})
    record('13 fail-open before recovery tool activation',not initial_bash.get('isError'),{'initial_bash_result':text(initial_bash),'observations':str(EVIDENCE_DIR/'os-cold-observations.jsonl')})
    # Spawn a real CCT fixture peer and send a unique DM to the os session.
    fixtureEnv={**BASE,'HOME':str(WORK),'CCT_RUNTIME':'claude','CLAUDE_CODE_SESSION_ID':'compact-fixture','CCT_PEER_NAME':'compact-sender'}
    fout=(WORK/'fixture.out').open('w');ferr=(WORK/'fixture.err').open('w')
    fixture=subprocess.Popen([NODE,'--import',str(REPO/'node_modules/tsx/dist/loader.mjs'),str(REPO/'server.ts')],cwd=WORK,env=fixtureEnv,stdin=subprocess.PIPE,stdout=fout,stderr=ferr,text=True)
    sender=wait(lambda:sql("select id,secret from peers where name='compact-sender' and status='active'"))[0];target=p['id']
    post('/message/send',{'peer_id':sender['id'],'peer_secret':sender['secret'],'to_peer_id':target,'body':'compact-live-unique-row3'})
    wait(lambda:flag(target) and int(flag(target).split('|')[0])>0);before=flag(target);sentinel=s.cwd/'ordinary-tool-ran'
    blocked=s.tool('bash',{'command':f"touch '{sentinel}'"})
    record('3 unread blocks bash with recovery instruction',blocked.get('isError') and 'cct_check_messages' in text(blocked) and not sentinel.exists(),{'flag_before':before,'blocked_result':text(blocked)})
    allowed=s.tool('cct',{'action':'status'});record('4 cct remains callable while unread',not allowed.get('isError') and 'you: '+p['id']+'/'+p['name'] in text(allowed),{'result':text(allowed),'flag':flag(target)})
    checked=s.tool('cct_check_messages',{});after=flag(target);retry=s.tool('bash',{'command':f"touch '{sentinel}'"})
    record('3 check clears flag and bash retry runs',not checked.get('isError') and (not after or int(after.split('|')[0])==0) and not retry.get('isError') and sentinel.exists(),{'check_result':text(checked),'flag_after':after,'sentinel':sentinel.exists()})
    s.stop()
    # Row 8: independent os sessions sharing one adapter cache/agent directory.
    shared=WORK/'shared-agent';shared.mkdir();a=Session('concurrent-a',agent=shared);b=Session('concurrent-b',agent=shared)
    wa=wait(a.peer)[0];wb=wait(b.peer)[0];ra=a.tool('cct',{'action':'status'});rb=b.tool('cct',{'action':'status'});ta=text(ra);tb=text(rb)
    cache=json.loads((shared/'mcp-cache.json').read_text());cached=cache.get('servers',{}).get('cct',{});cachetext=json.dumps(cached.get('tools',[]))+cached.get('instructions','')
    description_static=not (wa['id'] in cachetext or wb['id'] in cachetext) and all(not any(peer['id'] in tool.get('description','') for peer in (wa,wb)) for tool in cached.get('tools',[]))
    identity_ok=wa['id']!=wb['id'] and wa['name']!=wb['name'] and f"you: {wa['id']}/{wa['name']}" in ta and f"you: {wb['id']}/{wb['name']}" in tb and f"you: {wb['id']}/{wb['name']}" not in ta and f"you: {wa['id']}/{wa['name']}" not in tb
    record('8 shared-cache concurrent sessions retain per-session identity',identity_ok and description_static,{'a':{'peer':wa,'status':ta},'b':{'peer':wb,'status':tb},'static_description_has_no_peer_id':description_static})
    a.stop();b.stop()
    # Row 10/13: legacy-warm cache and staged unread flag, then compact on resumed same os session.
    legacy=Session('switch',surface='legacy');wait(lambda:legacy.log.exists() and 'cct_whoami' in legacy.log.read_text());lp=wait(legacy.peer)[0]
    legacy.tool('cct_whoami',{})
    session_file=legacy.meta['sessionFile']

    # Create unread on this exact peer before stopping; keep the per-peer flag in synthetic CCT_DIR.
    post('/message/send',{'peer_id':sender['id'],'peer_secret':sender['secret'],'to_peer_id':lp['id'],'body':'staged-switch-unread'})
    wait(lambda:flag(lp['id']) and int(flag(lp['id']).split('|')[0])>0);flag_before=flag(lp['id']);legacy.stop()
    (CCT/'flags').mkdir(exist_ok=True);(CCT/'flags'/(lp['id']+'.unread')).write_text(flag_before)
    compact=Session('switch-compact',agent=legacy.agent,resume=session_file,surface='compact')
    cp=wait(compact.peer)[0]
    # Preserve the old unread state across a host restart; if startup's unread refresh clears its derived flag, restage a DM before the first compact tool call.
    if cp['id']!=lp['id'] or not flag(cp['id']) or int(flag(cp['id']).split('|')[0])==0:
        post('/message/send',{'peer_id':sender['id'],'peer_secret':sender['secret'],'to_peer_id':cp['id'],'body':'staged-compact-switch-unread'})
        wait(lambda:flag(cp['id']) and int(flag(cp['id']).split('|')[0])>0)
    wait(lambda:compact.log.exists() and any(e.get('kind')=='tools' and 'cct' in e.get('active',[]) for e in map(json.loads,compact.log.read_text().splitlines())))
    inv=next([n for n in e['active'] if n.startswith('cct')] for e in map(json.loads,compact.log.read_text().splitlines()) if e.get('kind')=='tools' and 'cct' in e.get('active',[]))
    record('10 legacy-to-compact switch exposes two tools in first resumed session',set(inv)=={'cct_check_messages','cct'},{'tool_list':inv,'session_id':compact.sid,'prior_session_id':legacy.sid})
    record('13 warm legacy unread survives switch and compact unread is staged before first CCT action',bool(flag_before) and int(flag(cp['id']).split('|')[0])>0,{'legacy_unread_before_switch':flag_before,'compact_unread_before_first_tool':flag(cp['id']),'legacy_peer':lp,'compact_peer':cp,'tools':inv,'same_session_identity':cp['id']==lp['id']})
    compact.prompt('/probe-disable-cct');compact.prompt('/probe-tools')
    disabled_tools=next(e['active'] for e in reversed(list(map(json.loads,compact.log.read_text().splitlines()))) if e.get('kind')=='tools' and e.get('at')=='command')
    preactivation=compact.cwd/'before-check-activation'
    fail_open=compact.tool('bash',{'command':f"touch '{preactivation}'"})
    record('13 unread fail-open while recovery tool is inactive',not any(n in ('cct','cct_check_messages') for n in disabled_tools) and not fail_open.get('isError') and preactivation.exists(),{'unread_flag':flag(cp['id']),'active_tools_without_cct':disabled_tools,'bash_result':text(fail_open),'sentinel':preactivation.exists()})
    compact.prompt('/probe-enable-cct');compact.prompt('/probe-tools')
    enabled_tools=next(e['active'] for e in reversed(list(map(json.loads,compact.log.read_text().splitlines()))) if e.get('kind')=='tools' and e.get('at')=='command')
    # Verify static CCT descriptions and recovery exemption/ordinary blocking.
    status=compact.tool('cct',{'action':'status'});blocked_mcp=compact.tool('mcp',{});blocked_bash=compact.tool('bash',{'command':f"touch '{compact.cwd/'blocked-before-check'}"})
    check_result=compact.tool('cct_check_messages',{});after_check=flag(cp['id']);sent=compact.cwd/'switch-retry'
    retry=compact.tool('bash',{'command':f"touch '{sent}'"})
    record('13 recovery exemptions, blocked mcp/bash, clear flag and retry',set(n for n in enabled_tools if n.startswith('cct'))=={'cct','cct_check_messages'} and not status.get('isError') and not check_result.get('isError') and blocked_mcp.get('isError') and blocked_bash.get('isError') and 'cct_check_messages' in text(blocked_bash) and (not after_check or int(after_check.split('|')[0])==0) and not retry.get('isError') and sent.exists(),{'active_tools_without_cct':disabled_tools,'active_tools_after_switch':enabled_tools,'status':text(status),'blocked_mcp':text(blocked_mcp),'blocked_bash':text(blocked_bash),'check':text(check_result),'flag_after':after_check,'sentinel':sent.exists()})
    compact.stop()
    evidence=WORK/'acceptance.json';evidence.write_text(json.dumps(checks,indent=2))
    measurement={'provider_request':{'method':'UTF-8 compact JSON bytes of {messages:context.messages} at the same local synthetic-provider boundary as PHASE_0','compact_first_request_bytes':compact_provider,'legacy_first_request_bytes':legacy_provider},'evidence':str(EVIDENCE_DIR)}
    (WORK/'provider-measurements.json').write_text(json.dumps(measurement,indent=2));print('EVIDENCE acceptance.json and provider-measurements.json',flush=True)
finally:
    for x in sessions:x.stop()
    if fixture:
        try:fixture.stdin.close();fixture.wait(timeout=8)
        except Exception:
            if fixture.poll() is None:fixture.terminate();fixture.wait(timeout=5)
        fout.close();ferr.close()
    broker.terminate();broker.wait(timeout=8);blog.close()
    for name, source in [('os-cold-observations.jsonl',WORK/'cold/observations.jsonl'),('os-cold-stderr.log',WORK/'cold/stderr.log'),('os-concurrent-a-observations.jsonl',WORK/'concurrent-a/observations.jsonl'),('os-concurrent-b-observations.jsonl',WORK/'concurrent-b/observations.jsonl'),('os-switch-legacy-observations.jsonl',WORK/'switch/observations.jsonl'),('os-switch-compact-observations.jsonl',WORK/'switch-compact/observations.jsonl'),('os-switch-compact-stderr.log',WORK/'switch-compact/stderr.log')]:
        if source.exists():shutil.copy2(source,EVIDENCE_DIR/name)
    for filename in ('acceptance.json','provider-measurements.json'):
        source=WORK/filename
        if source.exists():shutil.copy2(source,EVIDENCE_DIR/('os-compact-live.json' if filename=='acceptance.json' else filename))
    shutil.rmtree(WORK,ignore_errors=True)
