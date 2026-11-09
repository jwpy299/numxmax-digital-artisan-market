#!/usr/bin/env bash
set -euo pipefail
ROOT=/opt/rebuild/workspaces/runtime-container
E=/opt/rebuild/verification-evidence/runtime-container
export PATH=/opt/node22/bin:$PATH
cd /opt/rebuild/portal; set -a; . /opt/rebuild/portal-run.env; set +a
cd "$ROOT"
export TEST_DB=numx_agent_employment_test_runtime_ui
export NODE_PATH="$ROOT/node_modules" DATABASE_URL="$(node /opt/rebuild/rewrite_numx_test_url.cjs)"
export ECONOMY_MODE=test NODE_ENV=staging AGENT_EMPLOYMENT_TEST_DATABASE=1 AGENT_EMPLOYMENT_TEST_PREVIEW=1
export AGENT_EMPLOYMENT_SANDBOX_QUALIFICATION_OK=true AGENT_EMPLOYMENT_ALLOW_PRODUCTION_SANDBOX=true PAYMENT_SANDBOX_ENABLED=true
export WECHAT_PAYMENTS_ENABLED=0 AGENT_TRAINING_SWEEP=0
set -a; . /opt/rebuild/scnet-runtime.env; set +a
export AGENT_RUNTIME_KIMI_BASE_URL="${IDOICTOS_BASE_URL}/v1" AGENT_RUNTIME_KIMI_MODEL=kimi-k3
export AGENT_RUNTIME_GLM_BASE_URL="${IDOICTOS_BASE_URL}/v1" AGENT_RUNTIME_GLM_MODEL=glm-5.2
export AGENT_RUNTIME_QWEN_BASE_URL="${IDOICTOS_BASE_URL}/v1" AGENT_RUNTIME_QWEN_MODEL=qwen3.5:cloud
set -a; . "$E/ui-delegation.env"; set +a
export AGENT_RUNTIME_CONTAINER_WORKER=1 AGENT_RUNTIME_CONTAINER_WORKER_ID=runtime-ui
export BIND_HOST=127.0.0.1 PORT=3212
nohup node dist/boot.js > "$E/staging.log" 2>&1 & echo $! > "$E/staging.pid"
for i in $(seq 1 60); do if curl -fsS http://127.0.0.1:3212/api/healthz > "$E/staging-health.json" 2>/dev/null; then echo "STAGING_READY port=3212 pid=$(cat "$E/staging.pid")"; exit 0; fi; sleep 1; done
tail -80 "$E/staging.log"; exit 1
