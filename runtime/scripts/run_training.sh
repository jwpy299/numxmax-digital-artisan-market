#!/bin/bash
# Per-package isolated sandbox: real samples -> scp/ssh -> DCU LoRA -> held-out eval -> S4 local inference.
set -e
PKG="$1"
VER="$2"
[ -z "$PKG" ] && { echo "usage: run_training.sh <pkg> <version>"; exit 1; }
[ -z "$VER" ] && { echo "usage: run_training.sh <pkg> <version>"; exit 1; }
[[ "$PKG" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ ]] || { echo "PKG 形态非法——只允许字母数字/下划线/连字符"; exit 1; }
[[ "$VER" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ ]] || { echo "VER 形态非法——只允许字母数字/下划线/连字符"; exit 1; }
[ "${#TRAINING_RUNNER_SECRET}" -ge 32 ] || { echo "TRAINING_RUNNER_SECRET 未配或过短——训练前停链"; exit 1; }
export TRAINING_ADMIN_URL="${TRAINING_ADMIN_URL:-http://127.0.0.1:3472}"
KNOWN_HOSTS="${SCNET_KNOWN_HOSTS:-/etc/ssh/ssh_known_hosts}"
[ -r "$KNOWN_HOSTS" ] && [ -s "$KNOWN_HOSTS" ] || { echo "SCNET known_hosts 缺失/为空（$KNOWN_HOSTS）——拒绝关闭 host-key 校验"; exit 1; }
TIMEOUT=(timeout --signal=TERM --kill-after=10s)
command -v timeout >/dev/null || { echo "timeout 命令缺失——停链"; exit 1; }
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$KNOWN_HOSTS")
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
WORK_ROOT="${TRAINING_WORK_ROOT:-/tmp/numxmax-training-sandbox}/$VER"
mkdir -p "$WORK_ROOT"
chmod 700 "$WORK_ROOT"
DB_CNF=$(mktemp /tmp/numx-training-db.XXXXXX.cnf)
chmod 600 "$DB_CNF"
python3 "$SCRIPT_DIR/training_mysql_config.py" ${TRAINING_DB_ENV:-/tmp/numxmax-training.env} "$DB_CNF"
export TRAINING_DB_CNF="$DB_CNF"
MYSQL=(mysql --defaults-extra-file="$DB_CNF" ${TRAINING_DB_NAME:-numx_training})
MAIN_PID=$$
SAMPLE_OUT="$WORK_ROOT/samples.jsonl"
export TRAINING_SAMPLE_OUT="$SAMPLE_OUT"

fail_job() {
  local note="$1"
  ${TIMEOUT[@]} 15 "${MYSQL[@]}" -e "UPDATE st_training_jobs SET status='ready', note='$note' WHERE pkg='$PKG' AND lora_version='$VER' AND status='training'" || true
  echo "$note" >&2
}
heartbeat_loop() {
  for _ in $(seq 1 240); do
    sleep 60
    [ -d "/proc/$MAIN_PID" ] || break
    ${TIMEOUT[@]} 15 "${MYSQL[@]}" -e "UPDATE st_training_jobs SET heartbeat_at=NOW() WHERE pkg='$PKG' AND lora_version='$VER' AND status='training'" || true
  done
}
heartbeat_loop &
HEARTBEAT_PID=$!
trap 'kill "$HEARTBEAT_PID" 2>/dev/null || true; wait "$HEARTBEAT_PID" 2>/dev/null || true; rm -f "$DB_CNF"' EXIT

printf '== ① 独立沙箱拉样本（%s）==\n' "$WORK_ROOT"
${TIMEOUT[@]} 300 python3 "$SCRIPT_DIR/train_by_package.py" "$PKG" > "$WORK_ROOT/train.log" 2>&1 || { fail_job '拉样本失败'; tail -3 "$WORK_ROOT/train.log"; exit 1; }
tail -2 "$WORK_ROOT/train.log"

printf '== ② 独立远端目录与训练/评测/脚本上传 ==\n'
${TIMEOUT[@]} 60 ssh "${SSH_OPTS[@]}" root@compute.example.invalid "mkdir -p ${SCNET_REMOTE_WORK_ROOT:-/opt/train/sandboxes}/$VER" || { fail_job '远端沙箱目录创建失败'; exit 1; }
${TIMEOUT[@]} 60 scp "${SSH_OPTS[@]}" "$SAMPLE_OUT" "$SAMPLE_OUT.eval.jsonl" "$SCRIPT_DIR/train_lora.py" "$SCRIPT_DIR/eval_reviewer.py" "$SCRIPT_DIR/generation_utils.py" "root@compute.example.invalid:${SCNET_REMOTE_WORK_ROOT:-/opt/train/sandboxes}/$VER/" || { fail_job '训练集或执行脚本上传失败'; exit 1; }

printf '== ③ 海光 DCU LoRA（%s）==\n' "$VER"
${TIMEOUT[@]} 7200 ssh "${SSH_OPTS[@]}" root@compute.example.invalid "mkdir -p ${SCNET_MODEL_ROOT:-/tmp/numxmax-models}/$VER/final && LD_LIBRARY_PATH=${SCNET_DTK_LIB:-/tmp/numxmax-dtk/lib} ${SCNET_PYTHON:-python3} ${SCNET_REMOTE_WORK_ROOT:-/opt/train/sandboxes}/$VER/train_lora.py --data ${SCNET_REMOTE_WORK_ROOT:-/opt/train/sandboxes}/$VER/samples.jsonl --base ${SCNET_BASE_MODEL:-/tmp/numxmax-models/Qwen2.5-1.5B-Instruct} --out ${SCNET_MODEL_ROOT:-/tmp/numxmax-models}/$VER/final --epochs 2" > "$WORK_ROOT/train_run.log" 2>&1 || { fail_job '训练失败'; tail -5 "$WORK_ROOT/train_run.log"; exit 1; }
tail -3 "$WORK_ROOT/train_run.log"

printf '== ④ 对拉评测（独立基座 vs LoRA）==\n'
${TIMEOUT[@]} 1800 ssh "${SSH_OPTS[@]}" root@compute.example.invalid "LD_LIBRARY_PATH=${SCNET_DTK_LIB:-/tmp/numxmax-dtk/lib} ${SCNET_PYTHON:-python3} ${SCNET_REMOTE_WORK_ROOT:-/opt/train/sandboxes}/$VER/eval_reviewer.py --base ${SCNET_BASE_MODEL:-/tmp/numxmax-models/Qwen2.5-1.5B-Instruct} --lora ${SCNET_MODEL_ROOT:-/tmp/numxmax-models}/$VER/final --eval ${SCNET_REMOTE_WORK_ROOT:-/opt/train/sandboxes}/$VER/samples.jsonl.eval.jsonl" > "$WORK_ROOT/eval.log" 2>&1 || { fail_job '对拉评测失败'; tail -5 "$WORK_ROOT/eval.log"; exit 1; }
tail -10 "$WORK_ROOT/eval.log"
SCORE=$(grep -oP '对拉得分：\K[0-9]+' "$WORK_ROOT/eval.log" | tail -1)
[[ "$SCORE" =~ ^([0-9]|[1-9][0-9]|100)$ ]] || { fail_job '评测得分缺失或越界'; exit 1; }
${TIMEOUT[@]} 45 python3 "$SCRIPT_DIR/report_training_eval.py" "$PKG" "$VER" "$SCORE" || { fail_job '评测审计回写失败'; exit 1; }
echo "EVAL_SCORE=$SCORE"
if [ "$SCORE" -lt 70 ]; then
  echo "EVAL_BELOW_THRESHOLD=$SCORE——不发布、不启动 S4 推理"
  exit 0
fi

printf '== ⑤ 回流 S4 基座与 LoRA 并启动本地推理 ==\n'
if [ ! -f "$WORK_ROOT/base/config.json" ]; then
  rm -rf "$WORK_ROOT/base"
  ${TIMEOUT[@]} 300 scp -r "${SSH_OPTS[@]}" "root@compute.example.invalid:${SCNET_BASE_MODEL:-/tmp/numxmax-models/Qwen2.5-1.5B-Instruct}" "$WORK_ROOT/base" || { fail_job '基座回流失败'; exit 1; }
fi
if [ ! -f "$WORK_ROOT/final/adapter_config.json" ]; then
  rm -rf "$WORK_ROOT/final"
  ${TIMEOUT[@]} 300 scp -r "${SSH_OPTS[@]}" "root@compute.example.invalid:${SCNET_MODEL_ROOT:-/tmp/numxmax-models}/$VER/final" "$WORK_ROOT/final" || { fail_job 'LoRA 回流失败'; exit 1; }
fi
bash "$SCRIPT_DIR/start_inference.sh" "$VER" "$WORK_ROOT"
