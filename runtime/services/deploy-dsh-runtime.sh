#!/bin/bash
set -euo pipefail
EXPECTED_SHA=${1:?usage: deploy-dsh-runtime.sh <final-source-sha>
SRC=${2:?usage: deploy-dsh-runtime.sh <final-source-sha> <repo-root>}
EXPECTED_SERVER_SHA=$(sha256sum "$SRC/runtime/services/dsh-runtime-server.mjs" | cut -d' ' -f1)
EXPECTED_SETTINGS_SHA=$(sha256sum "$SRC/runtime/services/dsh-runtime-settings.yaml" | cut -d' ' -f1)
test -s /opt/numx-signing/moonshot-api.env
EVID=/opt/rebuild/verification-evidence/dsh-runtime-release
mkdir -p "$EVID"
cp /opt/dsh-sandbox/server.mjs "$EVID/server.before.mjs"
cp /root/.dsh/settings.yaml "$EVID/settings.before.yaml"
cp "$SRC/runtime/services/dsh-runtime-server.mjs" /opt/dsh-sandbox/server.mjs
cp "$SRC/runtime/services/dsh-runtime-settings.yaml" /root/.dsh/settings.yaml
chmod 600 /opt/dsh-sandbox/server.mjs /root/.dsh/settings.yaml
/opt/node22/bin/node --check /opt/dsh-sandbox/server.mjs
ACTUAL_SERVER_SHA=$(sha256sum /opt/dsh-sandbox/server.mjs | cut -d' ' -f1)
ACTUAL_SETTINGS_SHA=$(sha256sum /root/.dsh/settings.yaml | cut -d' ' -f1)
test "$EXPECTED_SERVER_SHA" = "$ACTUAL_SERVER_SHA"
test "$EXPECTED_SETTINGS_SHA" = "$ACTUAL_SETTINGS_SHA"
printf 'sourceSha=%s\nserverSha256=%s\nsettingsSha256=%s\n' "$EXPECTED_SHA" "$ACTUAL_SERVER_SHA" "$ACTUAL_SETTINGS_SHA" > "$EVID/release.env"
systemctl restart dsh-sandbox-runtime
sleep 4
systemctl is-active dsh-sandbox-runtime
printf 'DSH_RUNTIME_RELEASE_OK sourceSha=%s\n' "$EXPECTED_SHA"
