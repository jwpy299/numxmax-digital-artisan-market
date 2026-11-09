#!/usr/bin/env bash
set -uo pipefail
ROOT=/opt/rebuild/workspaces/runtime-container
TS=$(date -u +%Y%m%dT%H%M%S_%6NZ)
LOG="$ROOT/verifier/runs/${TS}_v2_mysql.log"
JSON="$ROOT/verifier/runs/${TS}_v2_mysql.json"
export PATH=/opt/node22/bin:$PATH
{
  echo "command=clone isolated MySQL + additive migrations + vitest agentRuntimeContainer.mysql.integration"
  cd /opt/rebuild/portal
  set -a; . /opt/rebuild/portal-run.env; set +a
  PROD_DATABASE_URL=$DATABASE_URL
  exec 9>/tmp/numx-agent-mysql-test.lock
  flock 9
  export DATABASE_URL=$PROD_DATABASE_URL
  export TEST_DB=numx_agent_employment_test_runtime_container
  python3 /opt/rebuild/clone_production_to_isolated_test.py || exit 1
  cd "$ROOT"
  export NODE_PATH="$ROOT/node_modules"
  export DATABASE_URL="$(node /opt/rebuild/rewrite_numx_test_url.cjs)"
  export ECONOMY_MODE=test NODE_ENV=test AGENT_EMPLOYMENT_TEST_DATABASE=1 AGENT_EMPLOYMENT_MYSQL_TEST=1 WECHAT_PAYMENTS_ENABLED=0
  for migration in db/sync-agent-employment.mts db/sync-agent-plugins.mts db/sync-agent-plugin-payments.mts db/sync-agent-market-live.mts db/sync-runtime-outbox.mts db/sync-agent-runtime-container.mts; do
    node --import tsx "$migration" || exit 1
  done
  node /opt/rebuild/seed_numx_integration_base.cjs || exit 1
  npx vitest run api/routers/agentRuntimeContainer.mysql.integration.test.ts --reporter=verbose --maxWorkers=1 --testTimeout=120000
  rc=$?
  echo "mysql_rc=$rc"
  exit "$rc"
} > >(tee "$LOG") 2>&1
rc=$?
python3 - "$LOG" "$JSON" "$rc" <<'PY'
import json,sys,datetime
log,output,rc=sys.argv[1],sys.argv[2],int(sys.argv[3])
with open(output,'w') as f: json.dump({'schema':'numx.runtime-container.verifier-run.v1','version':'v2-mysql','createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'command':'bash verifier/v2/run-mysql.sh','exitCode':rc,'log':log},f,indent=2)
PY
exit "$rc"
