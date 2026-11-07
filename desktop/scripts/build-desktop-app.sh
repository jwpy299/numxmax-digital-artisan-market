#!/bin/bash
# build_desktop_app.sh——桌面端应用打包链（Win10/11 x64）
# 按需构建仓内前端 → 每壳独立渲染 shell/apiBase preload → 分壳 NSIS → asar 读回 → dl/ 稳定名。
set -e
export PATH=/opt/node22/bin:$PATH
WB=${WB:-/opt/numxmax/wb} # 正式包仅用 master；候选验收显式传入独立工作树，不混用产物
DT=${DT:-/opt/numxmax/desktop} # 桌面源目录：正式包用 master；候选验收显式传入独立工作树，禁止混壳
PA=/opt/numxmax/portal-admin
OPS_WEB_CUSTOM=${OPS_WEB:+x}
OPS_WEB=${OPS_WEB:-$PA/dist/public/ops}
BUILD_STARTED=$(( $(date +%s) - 2 ))
PUBLISH_KEYS="personal enterprise org ops"
SHELL_KEYS="personal enterprise admin org ops"
SHELL_LIST=${SHELL_LIST:-${*:-$PUBLISH_KEYS}} # admin 仅显式指定时构建（远程过渡，不对外发布）

# 先验壳键与依赖面：未知键在任何长构建前停链；ops 不白跑 WB，admin 远程壳不白跑两套前端。
[ -n "${SHELL_LIST//[[:space:]]/}" ] || { echo '  SHELL_LIST 为空——停链'; exit 1; }
SHELL_LIST=$(printf '%s' "$SHELL_LIST" | xargs -n1 | sort -u | xargs)
NEED_WB=0
NEED_OPS=0
for SHELL_KEY in $SHELL_LIST; do
  case " $SHELL_KEYS " in
    *" $SHELL_KEY "*)
      case "$SHELL_KEY" in
        personal|enterprise|org) NEED_WB=1 ;;
        ops) NEED_OPS=1 ;;
        admin) ;;
      esac
      ;;
    *) echo "  未知壳键: $SHELL_KEY——停链"; exit 1 ;;
  esac
done
command -v flock >/dev/null || { echo "  flock 缺失——不能并发安全打包"; exit 1; }
command -v timeout >/dev/null || { echo "  GNU timeout 缺失——不能为测试设置硬超时"; exit 1; }
LOCK_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/numx-desktop"
mkdir -p "$LOCK_DIR"
chmod 700 "$LOCK_DIR"
exec 9>"$LOCK_DIR/build.lock"
flock -n 9 || { echo "  另一桌面构建正在执行——请完成后再跑，禁止共享 shellKey/preload/dist-out 竞争"; exit 1; }
find "${TMPDIR:-/tmp}" -maxdepth 1 -type d -name "numx-desktop-build.*" -mtime +1 -exec rm -rf {} +
DT_RESOLVED=$(cd "$DT" 2>/dev/null && pwd -P) || { echo "  桌面源目录不存在：$DT——在任何长构建前停链"; exit 1; }
DT="$DT_RESOLVED"
[ -s "$DT/package.json" ] && [ -s "$DT/src/main.cjs" ] && [ -s "$DT/electron-builder.yml" ] && [ -s "$DT/electron-builder.shared.yml" ] || { echo "  DT 不是完整桌面仓：$DT——在任何清理/长构建前停链"; exit 1; }
[ -s "$DT/scripts/run-tests.cjs" ] && [ -d "$DT/test" ] || { echo "  DT 缺测试入口或测试目录：$DT——在任何清理/长构建前停链"; exit 1; }
if [[ " $SHELL_LIST " == *" org "* ]]; then
  [ -s "$DT/electron-builder.org.yml" ] || { echo "  缺少 org 专用 electron-builder 配置——在任何清理/长构建前停链"; exit 1; }
fi
ORG_FILE_MANIFEST="$DT/scripts/org-plugin-files.cjs"
[ -s "$ORG_FILE_MANIFEST" ] || { echo "  org 插件文件清单缺失：$ORG_FILE_MANIFEST——在任何清理/长构建前停链"; exit 1; }
ORG_ONLY_PATHS=$(node "$ORG_FILE_MANIFEST" org-only-paths) || { echo '  非 org 排除清单为空或非法——停链'; exit 1; }
ORG_RUNTIME_PATHS=$(node "$ORG_FILE_MANIFEST" runtime-package-paths) || { echo '  org 运行依赖路径闭包为空或含非法路径——停链'; exit 1; }
if [[ " $SHELL_LIST " == *" org "* ]]; then
  DEPT_FINANCE_REQUIRED=$(node -e "const p=require(process.argv[1]);process.stdout.write((p.dependencies?.['dept-finance'] || p.optionalDependencies?.['dept-finance']) ? '1' : '0')" "$DT/package.json") || { echo '  无法解析桌面 package.json 部门依赖——停链'; exit 1; }
  if [[ "$DEPT_FINANCE_REQUIRED" == 1 && ! -s "$DT/src/plugins/dept-finance/package.json" ]]; then
    echo '  package.json 已强制依赖 dept-finance，但部门源包缺失——在任何清理/长构建前停链'; exit 1
  fi
  if [[ -d "$DT/src/plugins/dept-finance" && "$DEPT_FINANCE_REQUIRED" != 1 ]]; then
    echo '  src/plugins/dept-finance 源包存在但 package.json 未声明 dept-finance 依赖——请先声明 file:src/plugins/dept-finance 并 npm install'; exit 1
  fi
  set -f
  for REL in $ORG_RUNTIME_PATHS; do
    [ -s "$DT/$REL" ] || { echo "  org 运行依赖未安装：$REL（请在 $DT 执行 npm install，org 壳不得省略可选依赖）——在任何清理/长构建前停链"; exit 1; }
  done
  ORG_PLUGIN_FILES=$(node "$ORG_FILE_MANIFEST" files) || { echo '  org 插件文件清单非法——停链'; exit 1; }
  ORG_ASAR_FILES=""
  for REL in $ORG_PLUGIN_FILES; do
    case "$REL" in
      src/*) ORG_ASAR_FILES="${ORG_ASAR_FILES:+$ORG_ASAR_FILES }$REL" ;;
      scripts/*) ;;
      *) echo "  org 插件清单含未审命名空间：$REL——停链"; exit 1 ;;
    esac
  done
  [ -n "$ORG_ASAR_FILES" ] || { echo '  org asar 依赖清单为空——停链'; exit 1; }
  for REL in $ORG_PLUGIN_FILES; do
    [ -f "$DT/$REL" ] && [ -s "$DT/$REL" ] || { echo "  org 插件源件缺失：$DT/$REL——在任何清理/长构建前停链"; exit 1; }
  done
  set +f
fi
if [[ "$NEED_WB" == 1 ]]; then
  WB_RESOLVED=$(cd "$WB" 2>/dev/null && pwd -P) || { echo "  WB 源目录不存在：$WB——在任何长构建前停链"; exit 1; }
  WB="$WB_RESOLVED"
  [ -s "$WB/package.json" ] && [ -s "$WB/api/boot.ts" ] && [ -s "$WB/index.html" ] || { echo "  WB 源目录不是完整运行仓：$WB——在任何长构建前停链"; exit 1; }
fi
cd "$DT"
node scripts/check-org-plugin-contract.cjs || { echo '  组织插件契约不一致——停止打包'; exit 1; }
( exec 9>&-; timeout -k 30s 600 npm test ) || { echo '  桌面插件测试失败或超时——停止打包'; exit 1; }
RUN_TMP=$(mktemp -d "${TMPDIR:-/tmp}/numx-desktop-build.XXXXXX")
if ! grep -Pq 'numx' <<< 'numx'; then
  echo '  当前 grep 不支持 -P（PCRE）——在任何长构建前停链'; exit 1;
fi

if [[ "$NEED_OPS" == 1 && "$OPS_WEB_CUSTOM" != "x" ]]; then
  [ -d "$PA" ] && [ -s "$PA/package.json" ] || { echo "  portal-admin 仓或 package.json 缺失: $PA——在任何长构建前停链"; exit 1; }
fi

  rm -f "$DT/src/shellKey.cjs" "$DT/src/preload.cjs"

if [[ "$NEED_WB" == 1 ]]; then
  echo '== ① wb 前端桌面变体构建（VITE_DESKTOP=1）=='
  cd "$WB"
  WB_API_BASE=$(node -p "require('$DT/src/apiAllowlist.cjs').SHELL_API_BASE.personal")
  VITE_DESKTOP=1 VITE_API_BASE="$WB_API_BASE" npm run build > "$RUN_TMP/desk_fe_build.log" 2>&1
  echo '  前端 build OK'
fi

if [[ "$NEED_OPS" == 1 ]]; then
  if [[ "$OPS_WEB_CUSTOM" == "x" ]]; then
    echo '== ② OPS_WEB 外部预构件（不跑 portal-admin build）=='
    [ -s "$OPS_WEB/index.html" ] || { echo "  外部 OPS_WEB 入口缺失：$OPS_WEB/index.html——停链"; exit 1; }
  else
    echo '== ② portal-admin 仓内构建（ops 源件，不取产线散件）=='
    rm -rf "$OPS_WEB"
    cd "$PA"
    npm run build > "$RUN_TMP/desk_ops_fe_build.log" 2>&1
    [ -s "$OPS_WEB/index.html" ] || { echo "  第5壳入口缺失（源=$OPS_WEB）——先完成 portal-admin build"; exit 1; }
    [ -n "$(find "$OPS_WEB/index.html" -newermt "@$BUILD_STARTED" -print -quit)" ] || { echo "  第5壳入口为旧产物（源=$OPS_WEB）——新鲜度停链"; exit 1; }
  fi
fi

echo '== ③ 前端件入壳（按需取件，逐壳恢复后裁剪）=='
rm -rf "$DT/frontend-src"
mkdir -p "$DT/frontend-src"
if [[ "$NEED_WB" == 1 ]]; then
  cp -r "$WB"/dist/public/* "$DT/frontend-src/"
  grep -q 'src="./assets/' "$DT/frontend-src/index.html" || { echo '  wb 前端相对 assets 引用缺失——停链'; exit 1; }
  grep -l "${WB_API_BASE}/api/trpc" "$DT"/frontend-src/assets/index-*.js >/dev/null || { echo '  wb API 基址字面缺失——停链'; exit 1; }
  if [[ " $SHELL_LIST " == *" org "* ]]; then
    [ -s "$DT/frontend-src/org/index.html" ] || { echo "  org 入口缺失：$DT/frontend-src/org/index.html——打包前停链"; exit 1; }
  fi
  echo '  wb 相对引用+API 基址字面 OK'
fi
if [[ "$NEED_OPS" == 1 ]]; then
  mkdir -p "$DT/frontend-src/ops"
  cp -r "$OPS_WEB"/. "$DT/frontend-src/ops/"
  [ -s "$DT/frontend-src/ops/index.html" ] || { echo '  第5壳入口缺失——停链'; exit 1; }
  assert_no_match() {
    local label="$1" pattern="$2"
    shift 2
    local out rc
    out=$(grep -Prn --include='*.js' --include='*.mjs' --include='*.html' --include='*.css' --include='*.json' --include='*.svg' "$pattern" "$@" 2>&1) && { printf '%s\n' "$out"; return 1; }
    rc=$?
    if [ "$rc" -eq 1 ]; then return 0; fi
    printf '%s：%s\n' "$label" "$out" >&2
    return "$rc"
  }
  OPS_API_OK=0
  while IFS= read -r -d '' file; do
    if node -e 'const fs=require("fs");const direct=/numxShell(?:\s*\?\.\s*apiBase|\.apiBase)/;const destruct=/(?:const|let|var)\s*(?:\{[^}]*\bapiBase\b[^}]*\}|\bapiBase\b)\s*=\s*window\.numxShell/;const f=process.argv[1];const t=fs.readFileSync(f,"utf8");process.exit(direct.test(t)||destruct.test(t)?0:1)' "$file"; then
      OPS_API_OK=1
      break
    fi
  done < <(find "$DT/frontend-src/ops" -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.html' -o -name '*.css' -o -name '*.json' -o -name '*.svg' \) -print0)
  [ "$OPS_API_OK" -eq 1 ] || { echo '  第5壳未消费 preload apiBase——停链'; exit 1; }
  assert_no_match '第5壳含生产域硬编码回退' 'https://(admin|wb)\.lingshu-nebulaai\.com' "$DT/frontend-src/ops" || { echo '  域扫描失败/命中——停链'; exit 1; }
  assert_no_match '第5壳含 ?api= 可篡改基址' '\?api=' "$DT/frontend-src/ops" || { echo '  query 扫描失败/命中——停链'; exit 1; }
  echo '  第5壳入口+preload 基址（全 chunk 扫描，无生产域回退）OK'
fi

echo '== ④ 分壳打包（nsis x64）=='
cd "$DT"
GENERATED_BACKUP=$(mktemp -d)
HAD_GENERATED=0
if [[ -d "$DT/src/generated" ]]; then cp -a "$DT/src/generated" "$GENERATED_BACKUP/generated"; HAD_GENERATED=1; fi
cleanup(){
  local rc=$?
  if [[ "$HAD_GENERATED" == 1 ]]; then rm -rf "$DT/src/generated"; cp -a "$GENERATED_BACKUP/generated" "$DT/src/generated"; else rm -rf "$DT/src/generated"; fi
  rm -rf "$GENERATED_BACKUP"
  rm -rf "$DT/frontend" "$DT/frontend-src"
  echo "BUILD_ARTIFACTS=$RUN_TMP"
}
trap cleanup EXIT
for SHELL_KEY in $SHELL_LIST; do
  # 每壳重建母本并渲染独立 preload：shell 与 API allowlist 都是构建期常量，不读用户机环境变量。
  rm -rf "$DT/frontend"
  cp -r "$DT/frontend-src" "$DT/frontend"
  case "$SHELL_KEY" in
    admin) rm -rf "$DT/frontend" ;;
    ops) find "$DT/frontend" -mindepth 1 -maxdepth 1 ! -name ops -exec rm -rf {} + ;;
    personal|enterprise) rm -rf "$DT/frontend/ops" "$DT/frontend/org" ;;
    org) rm -rf "$DT/frontend/ops"; rm -f "$DT/frontend/index.html" ;;
  esac
  node scripts/render-preload.cjs --locked "$SHELL_KEY"
  case "$SHELL_KEY" in
    personal|enterprise) EXPECT_ENTRY='frontend/index.html' ;;
    org) EXPECT_ENTRY='frontend/org/index.html' ;;
    ops) EXPECT_ENTRY='frontend/ops/index.html' ;;
    admin) EXPECT_ENTRY='' ;;
  esac
  if [ -n "$EXPECT_ENTRY" ]; then
        [ -s "$DT/$EXPECT_ENTRY" ] || { echo "  打包前源入口缺失 $SHELL_KEY：$DT/$EXPECT_ENTRY——停链"; exit 1; }
    fi
  # 每壳清理独立临时输出，防止上一壳入口残留到下一壳；dl/ 旧安装包不删除。
  rm -rf "$DT/dist-out/win-unpacked"
  BUILDER_CONFIG="$DT/electron-builder.yml"
  if [[ "$SHELL_KEY" == "org" ]]; then BUILDER_CONFIG="$DT/electron-builder.org.yml"; fi
  # NUMX_SHELL 仅供 artifactName 展开；安装后运行不依赖它。
  NUMX_SHELL=$SHELL_KEY npx electron-builder --config "$BUILDER_CONFIG" --win nsis --x64 > "$RUN_TMP/desk_pack_$SHELL_KEY.log" 2>&1
  rm -rf "$RUN_TMP/asar"
  mkdir -p "$RUN_TMP/asar"
  npx asar extract dist-out/win-unpacked/resources/app.asar "$RUN_TMP/asar" >/dev/null 2>&1 || { echo "  asar 解包失败——停链"; exit 1; }
  [ -s "$RUN_TMP/asar/src/generated/preload.cjs" ] || { echo "  asar 缺 generated/preload.cjs——停链"; exit 1; }
  ACTUAL=$(grep -oE 'personal|enterprise|admin|org|ops' $RUN_TMP/asar/src/generated/shellKey.cjs | head -1)
  [ "$ACTUAL" = "$SHELL_KEY" ] || { echo "  串味：包名 $SHELL_KEY vs asar 内 $ACTUAL——停链"; exit 1; }
  RUN_TMP_ASAR="$RUN_TMP/asar" node -e 'const fs=require("fs");const shell=process.argv[1];const cfg=require(process.env.RUN_TMP_ASAR + "/src/apiAllowlist.cjs");const allowed=cfg.SHELL_API_BASE[shell];const p=fs.readFileSync(process.env.RUN_TMP_ASAR + "/src/generated/preload.cjs","utf8");if(!new RegExp(`const\\s+SHELL_KEY\\s*=\\s*["\x27]${shell}["\x27]`).test(p)||!/shell\s*:\s*SHELL_KEY/.test(p))throw new Error("preload 壳键不符");const m=p.match(/const\s+API_BASE_ALLOWLIST\s*=\s*new Set\((\[[^\]]+\])\)/);if(!m)throw new Error("preload 白名单结构缺失");const bases=JSON.parse(m[1]);if(bases.length!==1||bases[0]!==allowed)throw new Error("preload API 白名单不符");if(p.includes("process.env.NUMX_SHELL")||p.includes("__NUMX_SHELL__"))throw new Error("preload 仍依赖运行时 env/占位符");' "$SHELL_KEY"
  if [ -n "$EXPECT_ENTRY" ]; then
    [ -s "$RUN_TMP/asar/$EXPECT_ENTRY" ] || { echo "  asar 缺 $SHELL_KEY 实际入口 $EXPECT_ENTRY——停链"; exit 1; }
  fi
  if [[ "$SHELL_KEY" != "org" ]]; then
    set -f
    for REL in $ORG_ONLY_PATHS; do
      [ ! -L "$RUN_TMP/asar/$REL" ] && [ ! -e "$RUN_TMP/asar/$REL" ] || { echo "  $SHELL_KEY 包内混入 org 运行源件 $REL——停链"; exit 1; }
    done
    for REL in $ORG_RUNTIME_PATHS; do
      [ ! -L "$RUN_TMP/asar/$REL" ] && [ ! -e "$RUN_TMP/asar/$REL" ] || { echo "  $SHELL_KEY 包内混入 org 运行依赖 $REL——停链"; exit 1; }
    done
    set +f
  fi
  if [[ "$SHELL_KEY" != "ops" && "$SHELL_KEY" != "admin" ]]; then
    [ ! -d $RUN_TMP/asar/frontend/ops ] || { echo "  $SHELL_KEY 包内混入 ops 管理台——停链"; exit 1; }
    if [[ "$SHELL_KEY" == "org" ]]; then
      [ ! -e $RUN_TMP/asar/frontend/index.html ] || { echo '  org 包内混入个人首页——停链'; exit 1; }
      set -f
      for REL in $ORG_ASAR_FILES; do
        [ -f "$RUN_TMP/asar/$REL" ] && [ -s "$RUN_TMP/asar/$REL" ] || { echo "  org asar 缺运行依赖 $REL——停链"; exit 1; }
      done
      set +f
      for REL in $ORG_RUNTIME_PATHS; do
        [ -s "$RUN_TMP/asar/$REL" ] || { echo "  org asar 缺运行依赖 $REL——停链"; exit 1; }
      done
      RUN_TMP_ASAR="$RUN_TMP/asar" node -e 'const p=require(process.env.RUN_TMP_ASAR + "/src/org-transport/index.cjs");if(typeof p.normalizeJson!=="function")throw new Error("org transport 不可加载")' || { echo '  org asar 内 org-transport 不可加载——停链'; exit 1; }
      mkdir -p "$RUN_TMP/asar/scripts"
      cp "$DT/scripts/verify-org-esm.mjs" "$RUN_TMP/asar/scripts/verify-org-esm.mjs"
      RUN_TMP_ASAR="$RUN_TMP/asar" node "$RUN_TMP/asar/scripts/verify-org-esm.mjs" || { echo '  org asar 内插件 ESM 入口或依赖不可加载——停链'; exit 1; }
    else
      [ ! -e $RUN_TMP/asar/frontend/org/index.html ] || { echo "  $SHELL_KEY 包内混入 org 入口——停链"; exit 1; }
    fi
  fi
  [ -s $RUN_TMP/asar/src/preload.template.cjs ] || { echo '  asar 缺 preload 源模板——停链'; exit 1; }
  [ -s $RUN_TMP/asar/src/apiAllowlist.cjs ] || { echo '  asar 缺 apiAllowlist.cjs——停链'; exit 1; }
  echo "  $SHELL_KEY 打包 OK（asar 壳键+入口+独立 preload/API 白名单实证）"
done

echo '== ⑤ 落 dl/ 稳定名 =='
VER=$(node -p "require('./package.json').version")
mkdir -p dl
for SHELL_KEY in $SHELL_LIST; do
  case "$SHELL_KEY" in
    personal) cp "dist-out/numx-desktop-shell-setup-${VER}-personal.exe" dl/numx-personal-setup.exe ;;
    enterprise) cp "dist-out/numx-desktop-shell-setup-${VER}-enterprise.exe" dl/numx-enterprise-setup.exe ;;
    admin) echo '  admin 壳暂不落 dl/（远程过渡壳，不对外发布）' ;;
    org) cp "dist-out/numx-desktop-shell-setup-${VER}-org.exe" dl/numx-org-runtime-setup.exe ;;
    ops) cp "dist-out/numx-desktop-shell-setup-${VER}-ops.exe" dl/numx-ops-console-setup.exe ;;
  esac
done
for STABLE in $PUBLISH_KEYS; do
  if [[ " $SHELL_LIST " != *" $STABLE "* ]]; then
    case "$STABLE" in
      personal) OLD_FILE="$DT/dl/numx-personal-setup.exe" ;;
      enterprise) OLD_FILE="$DT/dl/numx-enterprise-setup.exe" ;;
      org) OLD_FILE="$DT/dl/numx-org-runtime-setup.exe" ;;
      ops) OLD_FILE="$DT/dl/numx-ops-console-setup.exe" ;;
    esac
    [ ! -f "$OLD_FILE" ] || echo "  WARNING: $STABLE 本次未重建，dl 中仍是旧包——禁止把整目录当同批发布"
  fi
done
ls -la dl/
SHELL_SET=$(printf '%s' "$SHELL_LIST" | xargs -n1 | sort -u | xargs)
PUBLISH_SET=$(printf '%s' "$PUBLISH_KEYS" | xargs -n1 | sort | xargs)
if [[ "$SHELL_SET" == "$PUBLISH_SET" ]]; then
  echo "BUILD_APP_ALL_OK"
else
  echo "BUILD_PARTIAL_OK_SHELLS=$SHELL_LIST"
fi
