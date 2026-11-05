#!/bin/bash
# Start only a real local S4 inference process; every failure kills this attempt's PID.
set -e
VER="$1"
WORK_ROOT="$2"
[ -n "$VER" ] && [ -n "$WORK_ROOT" ] || { echo "usage: start_inference.sh <version> <work_root>"; exit 1; }
[[ "$VER" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ ]] || { echo "VER 形态非法"; exit 1; }
[[ "$WORK_ROOT" == /tmp/numxmax/training-sandbox/* ]] || { echo "WORK_ROOT 不在独立沙箱目录"; exit 1; }
BASE_DIR="${INFERENCE_BASE_DIR:-$WORK_ROOT/base}"
ADAPTER_DIR="${INFERENCE_ADAPTER_DIR:-$WORK_ROOT/final}"
[ -f "$BASE_DIR/config.json" ] || { echo "INFERENCE_BASE_MISSING=$BASE_DIR"; exit 1; }
[ -f "$ADAPTER_DIR/adapter_config.json" ] || { echo "INFERENCE_ADAPTER_MISSING=$ADAPTER_DIR"; exit 1; }
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
command -v ss >/dev/null || { echo "INFERENCE_TOOL_MISSING=ss"; exit 1; }
command -v curl >/dev/null || { echo "INFERENCE_TOOL_MISSING=curl"; exit 1; }
python3 -c 'import torch, transformers, peft' 2>/dev/null || { echo "INFERENCE_RUNTIME_MISSING=torch/transformers/peft"; exit 1; }
PID=""
trap 'if [ -n "${PID:-}" ]; then kill "$PID" 2>/dev/null || true; fi' EXIT

PID_FILE="$WORK_ROOT/inference.pid"
if [ -f "$PID_FILE" ]; then
  old=$(cat "$PID_FILE" || true)
  if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then
    echo "INFERENCE_ALREADY_RUNNING=$old"
    exit 1
  fi
  rm -f "$PID_FILE"
fi

port_in_use() {
  ss -ltn | awk -v port=":$1" '$4 ~ (port "$") { found=1 } END { exit found ? 0 : 1 }'
}
PORT=""
if [ -n "${INFERENCE_PORT:-}" ]; then
  [[ "$INFERENCE_PORT" =~ ^[0-9]+$ ]] || { echo "INFERENCE_PORT_INVALID"; exit 1; }
  [ "$INFERENCE_PORT" -ge 1024 ] && [ "$INFERENCE_PORT" -le 65535 ] || { echo "INFERENCE_PORT_INVALID"; exit 1; }
  if port_in_use "$INFERENCE_PORT"; then echo "INFERENCE_PORT_IN_USE=$INFERENCE_PORT"; exit 1; fi
  PORT="$INFERENCE_PORT"
else
  start=$((18890 + $(printf '%s' "$VER" | cksum | awk '{print $1 % 97}')))
  for i in $(seq 0 96); do
    candidate=$((18890 + (start - 18890 + i) % 97))
    if ! port_in_use "$candidate"; then PORT="$candidate"; break; fi
  done
fi
[ -n "$PORT" ] || { echo "INFERENCE_NO_FREE_PORT"; exit 1; }

nohup python3 "$SCRIPT_DIR/inference_server.py" --base "$BASE_DIR" --adapter "$ADAPTER_DIR" --port "$PORT" --version "$VER" > "$WORK_ROOT/inference.log" 2>&1 &
PID=$!
echo "$PID" > "$PID_FILE"
chmod 600 "$PID_FILE"
for _ in $(seq 1 30); do
  if python3 "$SCRIPT_DIR/verify_inference.py" "$PORT" "$PID" "$VER" --health-only >/dev/null 2>&1; then break; fi
  if ! kill -0 "$PID" 2>/dev/null; then break; fi
  sleep 1
done
python3 "$SCRIPT_DIR/verify_inference.py" "$PORT" "$PID" "$VER" --health-only
python3 "$SCRIPT_DIR/verify_inference.py" "$PORT" "$PID" "$VER"
READY_PID="$PID"
PID=""
echo "INFERENCE_READY port=$PORT pid=$READY_PID version=$VER"
