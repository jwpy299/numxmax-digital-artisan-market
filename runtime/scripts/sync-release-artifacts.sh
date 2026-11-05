#!/usr/bin/env bash
# 仓外备份恢复：root 单飞、显式白名单、暂存验哈希、制品先行、清单最后、失败可回滚。
set -euo pipefail

SRC="${RELEASE_BACKUP_DIR:-${PWD}/release-backups/portal}"
DST="${PORTAL_PUBLIC_DIR:-${PWD}/public}"
DST_DIST="${PORTAL_DIST_PUBLIC_DIR:-${PWD}/dist/public}"
WORK_ROOT="${RELEASE_WORK_ROOT:-${PWD}/release-work/numx-artifacts}"
LOCK_FILE="${RELEASE_LOCK_FILE:-$WORK_ROOT/restore.lock}"
PUBLIC_BASE_URL="${PORTAL_DOWNLOAD_BASE_URL:-${PORTAL_PUBLIC_BASE_URL:-${RELEASE_PUBLIC_BASE_URL:-https://downloads.example.invalid}}}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL%/}"
DESKTOP_FILES=(
  "dl/numx-personal-setup.exe"
  "dl/numx-enterprise-setup.exe"
  "dl/numx-org-runtime-setup.exe"
)

fail() { echo "$1" >&2; exit 1; }
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
[ "$EUID" -eq 0 ] || fail "恢复脚本必须以 root 执行"
SRC_RAW="$SRC" DST_RAW="$DST" DST_DIST_RAW="$DST_DIST" WORK_ROOT_RAW="$WORK_ROOT" LOCK_FILE_RAW="$LOCK_FILE"
assert_no_symlink_tree() {
  local current="$1"
  [[ "$current" = /* ]] || fail "路径必须为绝对路径：$current"
  while [ "$current" != "/" ]; do
    [ -L "$current" ] && fail "目标路径含符号链接，拒绝执行：$current"
    current="$(dirname "$current")"
  done
}
for original in "$SRC_RAW" "$DST_RAW" "$DST_DIST_RAW" "$WORK_ROOT_RAW" "$LOCK_FILE_RAW"; do
  assert_no_symlink_tree "$original"
done
command -v realpath >/dev/null 2>&1 || fail "恢复脚本需要 GNU realpath"
for variable in SRC DST DST_DIST WORK_ROOT LOCK_FILE; do
  printf -v "$variable" '%s' "$(realpath -m -- "${!variable}")"
done
assert_test_injection_allowed() {
  [ "${RELEASE_TEST_MODE:-0}" = 1 ] || fail "故障注入只允许在显式 RELEASE_TEST_MODE=1 的临时夹具中启用"
  local directory
  for directory in "$SRC" "$DST" "$DST_DIST" "$WORK_ROOT" "$LOCK_FILE"; do
    case "$directory" in /tmp/*) ;; *) fail "故障注入只允许操作 /tmp 下的临时目录：$directory" ;; esac
  done
}
if [ "${RELEASE_TEST_FAIL_AFTER_PAYLOAD:-0}" = 1 ] || [ "${RELEASE_TEST_FAIL_AFTER_FIRST_MANIFEST:-0}" = 1 ]; then
  assert_test_injection_allowed
fi
json_field() { node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if (typeof m[process.argv[2]] === "string") process.stdout.write(m[process.argv[2]])' "$1" "$2"; }
version_of() { json_field "$1" version; }
min_version_of() { json_field "$1" minVersion; }
expected_hash() {
  node -e 'const fs=require("fs"); const wanted=process.argv[1]; for (const line of fs.readFileSync(process.argv[2],"utf8").split("\n")) { const hash=line.slice(0,64); let name=line.slice(64).trim().replace(/^\*/, "").replace(/^\.\//, ""); if (name===wanted && /^[0-9a-f]{64}$/.test(hash)) { console.log(hash); break } }' "$1" "$SRC/SHA256SUMS"
}
atomic_install() {
  local source="$1" target="$2" directory temporary
  directory="$(dirname "$target")"
  [ -L "$directory" ] && { echo "目标目录是符号链接，拒绝写入：$directory" >&2; return 1; }
  if [ ! -d "$directory" ]; then
    mkdir -p "$directory" || return 1
    chmod 755 "$directory" || return 1
  fi
  [ -L "$target" ] && { echo "目标文件是符号链接，拒绝写入：$target" >&2; return 1; }
  [ "$(stat -c %U "$directory")" = "root" ] || { echo "目标目录属主不是 root，拒绝写入：$directory" >&2; return 1; }
  if [ -f "$target" ] && cmp -s "$source" "$target"; then
    chmod 644 "$target"
    return 0
  fi
  temporary="$(mktemp "$directory/.$(basename "$target").tmp.XXXXXX")"
  TEMP_FILES+=("$temporary")
  install -m 644 "$source" "$temporary" || { rm -f "$temporary"; return 1; }
  sync "$temporary" || { rm -f "$temporary"; return 1; }
  mv -f "$temporary" "$target" || { rm -f "$temporary"; return 1; }
  sync "$target" || return 1
  sync -d "$directory"
}
copy_payload() {
  local source="$1" target="$2" file
  mkdir -p "$target"
  for file in "${PAYLOAD_FILES[@]}"; do
    if [ -f "$source/$file" ]; then atomic_install "$source/$file" "$target/$file" || return 1; fi
  done
  atomic_install "$source/SHA256SUMS" "$target/SHA256SUMS" || return 1
}
copy_manifest() {
  local source="$1" target="$2"
  mkdir -p "$target"
  if [ -f "$source/app-release.json" ]; then install -m 644 "$source/app-release.json" "$target/app-release.json"; fi
}
snapshot_target() {
  local source="$1" target="$2" file hash
  mkdir -p "$target"
  : > "$target/snapshot-hashes.tsv"
  for file in app-release.json SHA256SUMS "${PAYLOAD_FILES[@]}"; do
    if [ -f "$source/$file" ]; then
      mkdir -p "$target/$(dirname "$file")"
      hash="$(sha256sum "$source/$file" | cut -d' ' -f1)"
      printf '%s	%s
' "$file" "$hash" >> "$target/snapshot-hashes.tsv"
      if ! cp -al -- "$source/$file" "$target/$file" 2>/dev/null; then
        cp -a --reflink=auto -- "$source/$file" "$target/$file"
      fi
    fi
  done
}
snapshot_hash() { awk -v f="$1" '$1==f {print $2; exit}' "$2/snapshot-hashes.tsv"; }
restore_target() {
  local backup="$1" target="$2" file
  local rc=0
  for file in app-release.json SHA256SUMS "${PAYLOAD_FILES[@]}"; do
    # 未写清单前只回滚制品；清单发布后也只处理仍为本版的清单。
    if [ "$file" = app-release.json ] && [ "$MANIFEST_PUBLISHED" != 1 ]; then continue; fi
    if [ "$file" = app-release.json ] && [ "$(version_of "$target/app-release.json" 2>/dev/null)" != "$VER" ]; then continue; fi
    # 当前文件必须仍是本进程刚写入的哈希，避免覆盖其它发布通道的新制品。
    if [ ! -f "$STAGE/$file" ] || [ ! -f "$target/$file" ]; then continue; fi
    if [ "$(sha256sum "$target/$file" | cut -d' ' -f1)" != "$(sha256sum "$STAGE/$file" | cut -d' ' -f1)" ]; then continue; fi
    if [ -f "$backup/$file" ]; then
      expected="$(snapshot_hash "$file" "$backup")"
      actual="$(sha256sum "$backup/$file" | cut -d' ' -f1)"
      if [ -z "$expected" ] || [ "$actual" != "$expected" ]; then
        echo "回滚快照哈希不符，拒绝覆盖：$backup/$file" >&2
        rc=1
        continue
      fi
      if ! rm -f "$target/$file" || ! ln "$backup/$file" "$target/$file" 2>/dev/null; then
        atomic_install "$backup/$file" "$target/$file" || rc=1
      fi
    else
      rm -f "$target/$file" || rc=1
    fi
  done
  return "$rc"
}
verify_payload() {
  local target="$1" file expected actual
  for file in "${PAYLOAD_FILES[@]}"; do
    [ -s "$target/$file" ] || fail "制品缺失：$target/$file"
    expected="$(expected_hash "$file")"
    actual="$(sha256sum "$target/$file" | cut -d' ' -f1)"
    [ "$actual" = "$expected" ] || fail "制品哈希不符：$target/$file"
  done
  [ -s "$target/SHA256SUMS" ] || fail "SHA256SUMS 未恢复：$target"
  cmp -s "$SRC/SHA256SUMS" "$target/SHA256SUMS" || fail "SHA256SUMS 三处不一致：$target"
}
verify_manifest() {
  local target="$1"
  [ -s "$target/app-release.json" ] || fail "app-release.json 恢复失败：$target"
  [ "$(version_of "$target/app-release.json")" = "$VER" ] || fail "app-release.json 版本不符：$target"
}
verify_target() {
  verify_manifest "$1"
}
check_downgrade() {
  local target current current_lean current_lean_version backup_lean_version
  for target in "$DST" "$DST_DIST"; do
    if [ -s "$target/app-release.json" ]; then
      current="$(version_of "$target/app-release.json")"
      if [ -n "$current" ] && [ "$(printf '%s
%s
' "$current" "$VER" | sort -V | tail -1)" != "$VER" ]; then
        fail "拒绝用旧版本 v$VER 覆盖 $target 当前 v$current"
      fi
      current_lean="$(json_field "$target/app-release.json" leanUrl)"
      if [ -n "$current_lean" ]; then
        [ -n "$LEAN_URL" ] || fail "当前精简渠道存在，但备份未提供 leanUrl：$target"
        current_lean_version="${current_lean##*/}"
        current_lean_version="${current_lean_version#lingshu-spirit-lean-v}"
        current_lean_version="${current_lean_version%.apk}"
        backup_lean_version="${LEAN_APK##*/}"
        backup_lean_version="${backup_lean_version#lingshu-spirit-lean-v}"
        backup_lean_version="${backup_lean_version%.apk}"
        if [ "$(printf '%s
%s
' "$current_lean_version" "$backup_lean_version" | sort -V | tail -1)" != "$backup_lean_version" ]; then
          fail "拒绝用旧精简版本 v$backup_lean_version 覆盖 $target 当前 v$current_lean_version"
        fi
      fi
    fi
  done
}
manifest_fingerprint() {
  if [ -f "$1" ]; then printf '%s:%s' "$(stat -c %i "$1")" "$(sha256sum "$1" | cut -d' ' -f1)"; else printf 'missing'; fi
}
publish_manifest() {
  check_downgrade
  local target="$1" before after temporary
  before="$(manifest_fingerprint "$target/app-release.json")"
  [ "$(stat -c %U "$target")" = "root" ] || fail "清单目录属主不是 root：$target"
  temporary="$(mktemp "$target/.app-release.json.tmp.XXXXXX")"
  TEMP_FILES+=("$temporary")
  install -m 644 "$STAGE/app-release.json" "$temporary"
  sync "$temporary"
  after="$(manifest_fingerprint "$target/app-release.json")"
  [ "$before" = "$after" ] || { rm -f "$temporary"; fail "清单在发布前已被其他通道修改，拒绝覆盖：$target"; }
  MANIFEST_PUBLISHED=1
  mv -f "$temporary" "$target/app-release.json"
  sync "$target/app-release.json"
  sync -d "$target"
}

assert_disjoint() {
  case "$1" in "$2"|"$2"/*) fail "路径不得重合或嵌套：$1 / $2" ;; esac
  case "$2" in "$1"|"$1"/*) fail "路径不得重合或嵌套：$1 / $2" ;; esac
}
assert_disjoint "$DST" "$DST_DIST"
for protected in "$SRC" "$DST" "$DST_DIST"; do
  assert_disjoint "$WORK_ROOT" "$protected"
  assert_disjoint "$LOCK_FILE" "$protected"
done
[ "$(uname -s)" = "Linux" ] || fail "恢复脚本仅支持 Linux + GNU coreutils"
for tool in node flock cmp install mktemp sha256sum find sync sort tail cp stat realpath awk cut xargs grep; do
  command -v "$tool" >/dev/null 2>&1 || fail "恢复脚本缺少依赖命令：$tool"
done
sync --help | grep -- '-d' >/dev/null || fail "需要 GNU sync -d"
tail --help | grep -- '-z' >/dev/null || fail "需要 GNU tail -z"
sort --help | grep -- '-z' >/dev/null || fail "需要 GNU sort -z"
sort --help | grep -- '-V' >/dev/null || fail "需要 GNU sort -V"
cp --help | grep -- '--reflink' >/dev/null || fail "需要 GNU cp --reflink"
find --help | grep -- '-printf' >/dev/null || fail "需要 GNU find -printf"
stat --help | grep -- '-c' >/dev/null || fail "需要 GNU stat -c"
cut --help | grep -- '-z' >/dev/null || fail "需要 GNU cut -z"

[ -L "$LOCK_FILE" ] && fail "锁文件是符号链接，拒绝执行：$LOCK_FILE"
assert_no_symlink_tree "$WORK_ROOT"
assert_no_symlink_tree "$SRC"
assert_no_symlink_tree "$DST"
assert_no_symlink_tree "$DST_DIST"
[ -L "$SRC" ] && fail "备份目录是符号链接，拒绝执行：$SRC"
[ -L "$DST" ] && fail "公网目录是符号链接，拒绝执行：$DST"
[ -L "$DST_DIST" ] && fail "构建公网目录是符号链接，拒绝执行：$DST_DIST"
if [ -e "$WORK_ROOT" ]; then
  [ -d "$WORK_ROOT" ] && [ "$(stat -c '%U:%a' "$WORK_ROOT")" = "root:700" ] || fail "工作目录不是本脚本独占的 root 目录：$WORK_ROOT"
fi
mkdir -p "$DST" "$DST_DIST" "$WORK_ROOT" "$(dirname "$LOCK_FILE")"
chmod 700 "$WORK_ROOT"
if [ -e "$LOCK_FILE" ]; then
  [ -f "$LOCK_FILE" ] && [ "$(stat -c %h "$LOCK_FILE")" -eq 1 ] || fail "锁文件不是独占普通文件，拒绝执行：$LOCK_FILE"
  [ "$(stat -c %U "$LOCK_FILE")" = "root" ] || fail "锁文件属主不是 root：$LOCK_FILE"
  chmod 600 "$LOCK_FILE"
else
  ( umask 077; : > "$LOCK_FILE" )
fi
exec 9<>"$LOCK_FILE"
flock -n 9 || fail "已有发布恢复任务在运行：$LOCK_FILE"
[ -d "$SRC" ] || fail "发布备份目录不存在：$SRC"
[ "$(stat -c '%U:%a' "$SRC")" = "root:700" ] || fail "备份目录必须为 root 700：$SRC"
[ -s "$SRC/app-release.json" ] || fail "备份缺 app-release.json：$SRC"
[ -s "$SRC/SHA256SUMS" ] || fail "备份缺 SHA256SUMS：$SRC；先核验制品来源，再按 ops/RELEASE-ARTIFACTS.md 的清单生成契约补齐"
VER="$(version_of "$SRC/app-release.json")"
MINVER="$(min_version_of "$SRC/app-release.json")"
[[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "备份版本号无效：$VER"
[[ "$MINVER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "备份 minVersion 无效：$MINVER"
[ "$(printf '%s\n%s\n' "$MINVER" "$VER" | sort -V | head -1)" = "$MINVER" ] || fail "version 不得低于 minVersion"
grep -Eq '"notes"[[:space:]]*:[[:space:]]*"[^"]+"' "$SRC/app-release.json" || fail "app-release.json 缺有效 notes"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$SRC/app-release.json" >/dev/null || fail "app-release.json 不是合法 JSON"
node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); for (const key of ["version","minVersion","url","notes"]) { if (typeof m[key] !== "string" || !m[key].trim()) throw new Error(`manifest_${key}_invalid`) }' "$SRC/app-release.json" || fail "app-release.json 字段缺失或类型无效"
APK="numx-max-v$VER.apk"
HISTORICAL_APKS=()
LEAN_URL="$(json_field "$SRC/app-release.json" leanUrl)"
CURRENT_LEAN_VERSION=""
if [[ "${LEAN_URL##*/}" =~ ^lingshu-spirit-lean-v([0-9]+\.[0-9]+\.[0-9]+)\.apk$ ]]; then CURRENT_LEAN_VERSION="${BASH_REMATCH[1]}"; fi
while IFS= read -r -d '' historical; do
  base="$(basename "$historical")"
  [ "$base" = "$APK" ] && continue
  if [[ "$base" =~ ^numx-max-v([0-9]+\.[0-9]+\.[0-9]+)\.apk$ ]]; then
    historical_version="${BASH_REMATCH[1]}"
    if [ "$historical_version" != "$VER" ] && [ "$(printf '%s
%s
' "$VER" "$historical_version" | sort -V | tail -1)" = "$historical_version" ]; then
      echo "跳过高于当前恢复版本 v$VER 的未发布主包：$base" >&2
      continue
    fi
  elif [[ "$base" =~ ^lingshu-spirit-v[0-9]+\.[0-9]+\.[0-9]+\.apk$ ]]; then
    # 邀请页主包是独立渠道，不套用 lean 上限。
    :
  elif [[ "$base" =~ ^lingshu-spirit-lean-v([0-9]+\.[0-9]+\.[0-9]+)\.apk$ ]]; then
    historical_lean_version="${BASH_REMATCH[1]}"
    if [ -n "$CURRENT_LEAN_VERSION" ] && [ "$historical_lean_version" != "$CURRENT_LEAN_VERSION" ] && [ "$(printf '%s
%s
' "$CURRENT_LEAN_VERSION" "$historical_lean_version" | sort -V | tail -1)" = "$historical_lean_version" ]; then
      echo "跳过高于当前精简版本 v$CURRENT_LEAN_VERSION 的未发布包：$base" >&2
      continue
    fi
  else
    echo "跳过版本文件名无效的制品：$base" >&2
    continue
  fi
  HISTORICAL_APKS+=("$base")
done < <(find "$SRC" -maxdepth 1 -type f \( -name 'numx-max-v*.apk' -o -name 'lingshu-spirit-lean-v*.apk' -o -name 'lingshu-spirit-v*.apk' \) -print0)
PAYLOAD_FILES=("$APK" ${HISTORICAL_APKS[@]+"${HISTORICAL_APKS[@]}"} "${DESKTOP_FILES[@]}" "gh_icon.png")
URL="$(json_field "$SRC/app-release.json" url)"
[ "$URL" = "$PUBLIC_BASE_URL/$APK" ] || fail "app-release.json 的 URL 必须精确指向 $PUBLIC_BASE_URL/$APK"
if [ -n "$LEAN_URL" ]; then
  LEAN_APK="${LEAN_URL##*/}"
  [ "$LEAN_URL" = "$PUBLIC_BASE_URL/$LEAN_APK" ] || fail "app-release.json 的 leanUrl 必须精确指向 $PUBLIC_BASE_URL/$LEAN_APK"
  printf '%s\n' "${PAYLOAD_FILES[@]}" | grep -qxF "$LEAN_APK" || fail "leanUrl 指向的 $LEAN_APK 不在发布制品中"
fi
for file in "${PAYLOAD_FILES[@]}"; do
  [ -s "$SRC/$file" ] || fail "备份缺制品：$SRC/$file"
  [[ "$(expected_hash "$file")" =~ ^[0-9a-f]{64}$ ]] || fail "SHA256SUMS 缺少 $file 的有效哈希"
done
case "$DST" in
  "$SRC"|"$SRC"/*) fail "公网目录不得与备份目录重合：$DST" ;;
esac
case "$DST_DIST" in
  "$SRC"|"$SRC"/*) fail "构建公网目录不得与备份目录重合：$DST_DIST" ;;
esac
case "$SRC" in
  "$DST"|"$DST"/*|"$DST_DIST"|"$DST_DIST"/*) fail "备份目录不得位于公网目录内：$SRC" ;;
esac
check_downgrade

# 仅在整程锁内清理上次异常留下的工作目录；暂存和回滚不放在公网目录。
find "$WORK_ROOT" -mindepth 1 -maxdepth 1 -type d -name 'staging-*' -printf '%T@ %p\0' | sort -z -nr | tail -z -n +6 | cut -z -d' ' -f2- | xargs -0 -r rm -rf
find "$DST" "$DST_DIST" -maxdepth 3 -type f \( -name '.app-release.json.tmp.*' -o -name '.app-release.json.*.tmp.*' -o -name '.app-release.json.[0-9]*' -o -name '.*.tmp.*' -o -name 'app-release.json.tmp-*' -o -name 'app-release.json.recovery-*' \) -mmin +1440 -delete
# 失败快照可保留供人工恢复，但仅保留最近 5 份，避免无限堆积。
find "$WORK_ROOT" -mindepth 1 -maxdepth 1 -type d -name 'rollback-*' -printf '%T@ %p\0' | sort -z -nr | tail -z -n +6 | cut -z -d' ' -f2- | xargs -0 -r rm -rf
STAGE="$(mktemp -d "$WORK_ROOT/staging-$$-XXXXXX")"
ROLLBACK="$(mktemp -d "$WORK_ROOT/rollback-$$-XXXXXX")"
declare -a TEMP_FILES=()
PUBLISHING=0
MANIFEST_PUBLISHED=0
cleanup() {
  local code=$? failed=0
  trap - EXIT
  trap '' INT TERM HUP
  if [ "$PUBLISHING" = 1 ]; then
    restore_target "$ROLLBACK/public" "$DST" || failed=1
    restore_target "$ROLLBACK/dist" "$DST_DIST" || failed=1
  fi
  if [ "$failed" = 1 ]; then
    echo "回滚未完成，已保留快照：$ROLLBACK（暂存：$STAGE）" >&2
  else
    rm -rf "$STAGE" "$ROLLBACK" || true
  fi
  for temporary in ${TEMP_FILES[@]+"${TEMP_FILES[@]}"}; do rm -f -- "$temporary" 2>/dev/null || true; done
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
copy_payload "$SRC" "$STAGE"
copy_manifest "$SRC" "$STAGE"
verify_payload "$STAGE"
snapshot_target "$DST" "$ROLLBACK/public"
snapshot_target "$DST_DIST" "$ROLLBACK/dist"

PUBLISHING=1
copy_payload "$STAGE" "$DST"
copy_payload "$STAGE" "$DST_DIST"
verify_payload "$DST"
verify_payload "$DST_DIST"
if [ "${RELEASE_TEST_FAIL_AFTER_PAYLOAD:-0}" = 1 ]; then fail "测试注入：制品发布后失败"; fi
# 长耗时复制后再次检查，防止其它发布通道已更新版本。
check_downgrade
publish_manifest "$DST"
if [ "${RELEASE_TEST_FAIL_AFTER_FIRST_MANIFEST:-0}" = 1 ]; then fail "测试注入：首个清单发布后失败"; fi
check_downgrade
publish_manifest "$DST_DIST"
verify_target "$DST"
verify_target "$DST_DIST"
PUBLISHING=0
persist_manifest_snapshot() {
  local history="$WORK_ROOT/manifest-history/$VER" file
  if [ -d "$history" ]; then
    [ "$(stat -c '%U:%a' "$history")" = "root:700" ] || fail "历史快照目录权限不符：$history"
    cmp -s "$STAGE/app-release.json" "$history/app-release.json" || fail "历史 manifest 内容冲突，拒绝覆盖：$history"
    cmp -s "$STAGE/SHA256SUMS" "$history/SHA256SUMS" || fail "历史 SHA256SUMS 内容冲突，拒绝覆盖：$history"
    return 0
  fi
  mkdir -p "$history"
  chmod 700 "$history"
  atomic_install "$STAGE/app-release.json" "$history/app-release.json"
  atomic_install "$STAGE/SHA256SUMS" "$history/SHA256SUMS"
  : > "$history/snapshot-hashes.tsv"
  for file in app-release.json SHA256SUMS "${PAYLOAD_FILES[@]}"; do
    printf '%s\t%s\n' "$file" "$(sha256sum "$STAGE/$file" | cut -d' ' -f1)" >> "$history/snapshot-hashes.tsv"
  done
  sync "$history/snapshot-hashes.tsv"
  sync -d "$history"
}
persist_manifest_snapshot
printf 'RELEASE_ARTIFACTS_SYNC_OK version=%s\n' "$VER"
