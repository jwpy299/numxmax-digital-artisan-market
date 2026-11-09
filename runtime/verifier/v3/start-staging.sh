#!/usr/bin/env bash
set -euo pipefail
ROOT=/opt/rebuild/workspaces/runtime-container
E=/opt/rebuild/verification-evidence/runtime-container
mkdir -p "$E"; chmod 700 "$E"
export PATH=/opt/node22/bin:$PATH
cd /opt/rebuild/portal
set -a; . /opt/rebuild/portal-run.env; set +a
PROD_DATABASE_URL=$DATABASE_URL
exec 9>/tmp/numx-agent-mysql-test.lock; flock 9
export DATABASE_URL=$PROD_DATABASE_URL TEST_DB=numx_agent_employment_test_runtime_ui
python3 /opt/rebuild/clone_production_to_isolated_test.py
cd "$ROOT"
export NODE_PATH="$ROOT/node_modules" DATABASE_URL="$(node /opt/rebuild/rewrite_numx_test_url.cjs)"
export ECONOMY_MODE=test NODE_ENV=staging AGENT_EMPLOYMENT_TEST_DATABASE=1 AGENT_EMPLOYMENT_TEST_PREVIEW=1
export AGENT_EMPLOYMENT_SANDBOX_QUALIFICATION_OK=true AGENT_EMPLOYMENT_ALLOW_PRODUCTION_SANDBOX=true PAYMENT_SANDBOX_ENABLED=true
export WECHAT_PAYMENTS_ENABLED=0 AGENT_TRAINING_SWEEP=0
for migration in db/sync-agent-employment.mts db/sync-agent-plugins.mts db/sync-agent-plugin-payments.mts db/sync-agent-market-live.mts db/sync-runtime-outbox.mts db/sync-agent-runtime-container.mts; do node --import tsx "$migration"; done
node /opt/rebuild/seed_numx_integration_base.cjs
node --import tsx verifier/v3/seed-browser.mts
npm run build > "$E/staging-build.log" 2>&1
if [ -f "$E/staging.pid" ]; then old=$(cat "$E/staging.pid"); if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then kill "$old" || true; fi; fi
set -a; . /opt/rebuild/scnet-runtime.env; set +a
if [ ! -f "$E/ui-delegation.env" ]; then echo "AGENT_RUNTIME_DELEGATION_KEY=$(openssl rand -hex 32)" > "$E/ui-delegation.env"; chmod 600 "$E/ui-delegation.env"; fi
set -a; . "$E/ui-delegation.env"; set +a
export AGENT_RUNTIME_CONTAINER_WORKER=1 AGENT_RUNTIME_CONTAINER_WORKER_ID=runtime-ui
export BIND_HOST=127.0.0.1 PORT=3212
nohup node dist/boot.js > "$E/staging.log" 2>&1 & echo $! > "$E/staging.pid"
for i in $(seq 1 60); do if curl -fsS http://127.0.0.1:3212/api/healthz > "$E/staging-health.json" 2>/dev/null; then echo "STAGING_READY port=3102 pid=$(cat "$E/staging.pid")"; exit 0; fi; sleep 1; done
tail -80 "$E/staging.log"; exit 1
