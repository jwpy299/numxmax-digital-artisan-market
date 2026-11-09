#!/usr/bin/env bash
set -uo pipefail
cd /opt/rebuild/workspaces/runtime-container
export PATH=/opt/node22/bin:$PATH
TS=$(date -u +%Y%m%dT%H%M%S_%6NZ); LOG="verifier/runs/${TS}_v4.log"; JSON="verifier/runs/${TS}_v4.json"
{
  node verifier/v4/static-check.mjs; a=$?
  npm run check; b=$?
  npx vitest run api/runtimeContainer/adapters.test.ts api/runtimeContainer/service.test.ts api/runtimeContainer/planner.test.ts --maxWorkers=1; c=$?
  overall=0; if [ "$a" -ne 0 ] || [ "$b" -ne 0 ] || [ "$c" -ne 0 ]; then overall=1; fi
  echo "static_rc=$a check_rc=$b unit_rc=$c overall_rc=$overall"
} > >(tee "$LOG") 2>&1
overall=$(tail -1 "$LOG" | sed -n 's/.*overall_rc=//p')
python3 - "$LOG" "$JSON" "$overall" <<'PY'
import json,sys,datetime
log,out,rc=sys.argv[1],sys.argv[2],int(sys.argv[3])
with open(out,'w') as f: json.dump({'schema':'numx.runtime-container.verifier-run.v1','version':'v4','createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'command':'bash verifier/v4/run.sh','exitCode':rc,'log':log},f,indent=2)
PY
exit "${overall:-1}"
