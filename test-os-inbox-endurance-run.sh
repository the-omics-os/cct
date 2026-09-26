#!/usr/bin/env bash
# Private, bounded, foreground runner. Start ONLY after RED acceptance is resolved.
set -euo pipefail
cd "$(dirname "$0")"
root=$(mktemp -d /private/tmp/cct-final-endurance.XXXXXX)
chmod 700 "$root"
export CCT_ENDURANCE_RECEIPT="$root"
python3 - "$root" <<'PY'
import hashlib,json,pathlib,sys,time
p=pathlib.Path(sys.argv[1]); names=['os-extension.ts','server.ts','broker.ts','cli.ts','test-os-inbox-endurance.py','test-os-inbox-hardening.py','test-fixtures/os/inbox-hardening-probe.ts','test-fixtures/os/inbox-hardening-slow-input.ts']
(p/'launch.json').write_text(json.dumps({'started':time.time(),'source_sha256':{name:hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest() for name in names}},indent=2))
PY
printf 'RECEIPT %s\n' "$root"
# Python SIGALRM=8700 seconds (900+7200+600 setup/cleanup allowance).
# Python SIGTERM/SIGINT handlers throw into its finally to close only owned hosts/broker.
python3 -u test-os-inbox-endurance.py --case endurance >"$root/run.log" 2>&1 &
pid=$!
python3 - "$root" "$pid" <<'PY'
import json,pathlib,sys,time
pathlib.Path(sys.argv[1],'pid.json').write_text(json.dumps({'pid':int(sys.argv[2]),'started':time.time(),'command':'python3 -u test-os-inbox-endurance.py --case endurance'},indent=2))
PY
trap 'kill -TERM "$pid" 2>/dev/null || true' TERM INT
set +e
wait "$pid"
status=$?
set -e
trap - TERM INT
python3 - "$root" "$status" <<'PY'
import json,pathlib,sys,time
root=pathlib.Path(sys.argv[1]); code=int(sys.argv[2]); text=(root/'run.log').read_text(); receipts=[]
for line in text.splitlines():
 if line.startswith('RESULT '): receipts.append(line[7:])
result=None
if receipts:
 p=pathlib.Path(receipts[-1]);
 if p.exists(): result=json.loads(p.read_text())
passed=(code==0 and result is not None and result.get('outcome')=='PASS' and result.get('source_unchanged') is True and 'GREEN endurance' in text)
(root/'final.json').write_text(json.dumps({'finished':time.time(),'exit_code':code,'passed':passed,'result_paths':receipts,'result':result,'failure_tail':None if passed else text[-3500:]},indent=2))
print('FINAL',root/'final.json','PASS' if passed else 'FAIL')
sys.exit(0 if passed else 1)
PY
