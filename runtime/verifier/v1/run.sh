#!/usr/bin/env bash
set -uo pipefail
ROOT=/opt/rebuild/workspaces/runtime-container
cd "$ROOT"
export PATH=/opt/node22/bin:$PATH
TS=$(date -u +%Y%m%dT%H%M%S_%6NZ)
LOG="verifier/runs/${TS}_v1.log"
JSON="verifier/runs/${TS}_v1.json"
{
  echo "command=node verifier/v1/static-check.mjs && npm run check && npx vitest run api/runtimeContainer/service.test.ts api/runtimeContainer/planner.test.ts --maxWorkers=1"
  node verifier/v1/static-check.mjs
  static_rc=$?
  if [ "$static_rc" -eq 0 ]; then npm run check; check_rc=$?; else check_rc=125; fi
  if [ "$check_rc" -eq 0 ]; then npx vitest run api/runtimeContainer/service.test.ts api/runtimeContainer/planner.test.ts --maxWorkers=1; test_rc=$?; else test_rc=125; fi
  echo "static_rc=$static_rc check_rc=$check_rc unit_rc=$test_rc"
  overall=0
  if [ "$static_rc" -ne 0 ] || [ "$check_rc" -ne 0 ] || [ "$test_rc" -ne 0 ]; then overall=1; fi
  echo "overall_rc=$overall"
} > >(tee "$LOG") 2>&1
overall=$(tail -1 "$LOG" | sed -n 's/overall_rc=//p')
python3 - "$LOG" "$JSON" "$overall" <<'PY'
import json,sys,datetime
log,output,rc=sys.argv[1],sys.argv[2],int(sys.argv[3])
with open(output,'w') as f:
    json.dump({'schema':'numx.runtime-container.verifier-run.v1','version':'v1','createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'command':'bash verifier/v1/run.sh','exitCode':rc,'log':log},f,indent=2)
PY
exit "${overall:-1}"
