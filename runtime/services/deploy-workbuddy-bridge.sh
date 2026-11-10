#!/bin/bash
set -euo pipefail
EXPECTED_SHA=${1:?usage: deploy-workbuddy-bridge.sh <final-source-sha>}
SRC=${2:?usage: deploy-workbuddy-bridge.sh <final-source-sha> <repo-root>}
EXPECTED_FILE_SHA=$(sha256sum "$SRC/runtime/services/workbuddy-agent-bridge.mjs" | cut -d' ' -f1)
EXPECTED_UNIT_SHA=$(sha256sum "$SRC/runtime/services/workbuddy-agent-bridge.service" | cut -d' ' -f1)
test -s /opt/rebuild/workbuddy-agent-bridge.env
EVID=/opt/rebuild/verification-evidence/workbuddy-release
mkdir -p "$EVID"
cp "$SRC/runtime/services/workbuddy-agent-bridge.mjs" /opt/rebuild/workbuddy-agent-bridge.mjs
cp "$SRC/runtime/services/workbuddy-agent-bridge.service" /etc/systemd/system/workbuddy-agent-bridge.service
chmod 700 /opt/rebuild/workbuddy-agent-bridge.mjs
/opt/node22/bin/node --check /opt/rebuild/workbuddy-agent-bridge.mjs
ACTUAL_FILE_SHA=$(sha256sum /opt/rebuild/workbuddy-agent-bridge.mjs | cut -d' ' -f1)
ACTUAL_UNIT_SHA=$(sha256sum /etc/systemd/system/workbuddy-agent-bridge.service | cut -d' ' -f1)
test "$EXPECTED_FILE_SHA" = "$ACTUAL_FILE_SHA"
test "$EXPECTED_UNIT_SHA" = "$ACTUAL_UNIT_SHA"
printf 'sourceSha=%s\nbridgeSha256=%s\nunitSha256=%s\n' "$EXPECTED_SHA" "$ACTUAL_FILE_SHA" "$ACTUAL_UNIT_SHA" > "$EVID/release.env"
systemctl daemon-reload
systemctl restart workbuddy-agent-bridge
sleep 3
systemctl is-active workbuddy-agent-bridge
systemctl is-enabled workbuddy-agent-bridge
printf 'WORKBUDDY_RELEASE_OK sourceSha=%s\n' "$EXPECTED_SHA"
