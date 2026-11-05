#!/usr/bin/env node
/**
 * NumX Max · 空转检测（idle audit）· 零依赖（只用 Node 内置模块）
 * ---------------------------------------------------------------------------
 * 缘起：《空转检测·查询与判据》（NumX 判据 P1–P5）——把「代码对但永远不生效」
 *       这一整类问题从人工挖改成机器巡。
 *       ⚠️ 那份文档在 **NumX 侧工作区、不在本仓**（门禁 wb#52 R15 的 :5 指出引用了一个仓内不存在的路径）；
 *          因此本文件头部**自带 P1–P5 判据摘要**，判据口径以本文件为准。
 *
 * 用法：
 *   npm run audit:idle                                        # 打印（硬档命中 → 退出码 1）
 *   npm run audit:idle:report -- --report docs/idle-audit.md  # 另写 markdown 周报
 *   node scripts/idle-audit.mjs --db=off                      # 显式跳过 P2
 *
 * 分档（判据第六节）：
 *   硬档（退出码非 0，供 CI 阻断）：P1 命名空间未挂载 / P4 静默 404
 *   软档（退出码 0，进报告人工过）：P2 空表被读 / P3 幽灵值 / P5 自称不符
 *
 * 退出码语义（门禁 wb#52 的 high/medium 后落地，portal R5 的 :78 指出 help 漏了第 2 档）：
 *   0 = 干净 ／ 1 = 硬档命中 ／ 2 = **工具自身无法给出可信结论**（布局自检失败、argv/环境配错、运行异常）
 *
 * 与判据原文的偏离（逐条实测后调的，完整理由写在周报「阈值与过滤」节）：
 *   [1] P1 弃用「调用点上下文 40 字符」→ 改调用点锚定解析（只取实参里 depth 0 的
 *       字符串字面量）。40 字符窗口会把对象字面量里的点分名一起捞进来。
 *   [2] P1 补 trpc.X.Y.useQuery() 与 fetch('/api/trpc/X.Y') 两种形态——判据点名的
 *       两个已知实例（arenaBoard / agentsMatch）在仓内只以 raw fetch 形态出现。
 *   [3] 先剥注释（行号不变）再扫，否则注释掉的调用点会算成命中。
 *   [4] 一律排除 *.test.ts：测试夹具里的 SQL 会被误当成生产写方。
 *   [5] P3 改表作用域（同语句内表名+列名）为主判据，列全局差集降为对照指标。
 *   [6] P3 增加 DDL COMMENT 权威域交叉验证（判据第三节自己建议的依据）。
 *   [7] P2 的「空表」用真探针 SELECT 1 … LIMIT 1 判定，不用 TABLE_ROWS 估算。
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'

/**
 * 工具自检失败 ⇒ 以**专属退出码 2** 中止。
 * 退出码语义（门禁 wb#52 的 high/medium）：**0=干净 ／ 1=硬档命中 ／ 2=工具自身无法给出可信结论**。
 * 为什么要单开一档：本脚本是 CI 闸门，"没扫到东西"和"扫到了且干净"若都退 0，就是**假绿**；
 * "仓库结构变了导致全判未挂载"与"真有硬档命中"若都退 1，就是**假阻断**。两者都必须与结论区分开。
 */
function fail(msg, hint = '') {
  // 用 **`fs.writeSync(2, …)` 同步写 stderr**（门禁 portal R6 的 :42-45）：`process.stderr.write` 在 POSIX
  // 管道/socket 下同样是**异步**的，紧跟 `process.exit` 会**截断解释这条错误的那句话**。
  // 同步写之后，"能排空的走 exitCode、必须马上停的走 exit" 这条口径才真正自洽。
  fs.writeSync(
    2,
    `\n[空转检测·自检失败] ${msg}\n${hint ? `  ${hint}\n` : ''}  ⇒ 退出码 2（0=干净 / 1=硬档命中 / 2=工具自身无法给出可信结论）\n`,
  )
  process.exit(2)
}

/** `--x=<值>` 内联取值：**空值一律报错**（门禁 R10 的 :107）。
 *  原来 `--json=` 得到空串，而空串是 falsy ⇒ 后面 `if (ARGS.json)` 直接跳过写文件，
 *  **静默不干活**；`--root=` 空则解析成 cwd（也静默）。其它选项都是 fail-closed，这里补上同一口径。 */
function takeInlineValue(name, v) {
  if (!v) fail(`选项 ${name}= 后面是空的`, `用法：${name}=<值>（不写取值就别带这个选项）`)
  return v
}

/** 取一个必填的选项值；缺失、或后面紧跟另一个选项 ⇒ 自检失败（原来会静默回落默认值/抛 TypeError） */
function takeValue(name, argv, i) {
  const v = argv[i]
  // 空取值也必须失败（门禁 portal R18 的 :65-66）：`--json ""` 原来会静默接受空串，
  // 而**内联形式** `--json=` 是 fail-closed 的 —— 同一件事两种写法两种结果，属口径不一致。
  if (v === undefined || v.startsWith('--') || v === '') fail(`选项 ${name} 缺少取值`, `用法：${name}=<值> 或 ${name} <值>`)
  return v
}

/** 枚举取值校验（拼错不该静默回落成默认值——那会让"配错了"看起来像"跑通了"） */
function takeEnum(name, argv, i, allowed) {
  const v = takeValue(name, argv, i)
  if (!allowed.includes(v)) fail(`选项 ${name} 取值非法：${v}`, `只能是 ${allowed.join(' | ')}`)
  return v
}

// ─────────────────────────────── CLI ───────────────────────────────

function printHelp() {
  // 与 `fail()` 同理走**同步** stdout（门禁 portal R8 的 :112）：`process.stdout.write` 在管道下是异步的，
  // 紧跟 `process.exit(0)` 会截断帮助文本 —— 本文件别处已经论证过这件事，这里漏了。
  fs.writeSync(
    1,
    `空转检测（idle audit）· 零依赖

用法: node scripts/idle-audit.mjs [选项]

选项:
  --report <路径>    额外写 markdown 周报
  --json <路径>      额外写机器可读 JSON
  --root <目录>      仓库根（默认 cwd）
  --db=auto|on|off   P2 数据面开关（默认 auto：拿不到库就跳过并说明，绝不崩）
  --p5=core|wide     P5 词表（默认 core=跨件一致性断言；wide 追加通用全称量词）
  --max-console <n>  每项最多打印多少行（默认 200）
  --quiet            只打印汇总

退出码（三档）: 0=干净 ／ 1=硬档命中（P1 命名空间未挂载 / P4 静默 404） ／ 2=工具自身无法给出可信结论（布局自检失败、argv/env 配错、运行异常）
环境变量（P2，全部可选；脚本不读任何硬编码口令——AGENTS.md 第八节）:
  IDLE_AUDIT_DB_HOST / _PORT / _USER / _PASSWORD / _NAME / _TIMEOUT_MS
`,
  )
}

const DEFAULT_REPORT = 'docs/idle-audit.md' // 与文件头用法示例、生成报告里的「怎么跑」段保持一致（门禁 portal R5 的 :84：原来这里写的是 idle-audit-report.md，两处不一致）

function parseArgs(argv) {
  const out = { report: null, json: null, root: process.cwd(), db: 'auto', quiet: false, maxConsole: 200, p5: 'core' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    // --report 取值可选：不写路径（或后面紧跟另一个选项）就落默认路径，
    // 这样 `npm run audit:idle:report` 与 `npm run audit:idle:report -- --report docs/x.md` 都能用。
    if (a === '--report') { out.report = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : DEFAULT_REPORT }
    else if (a.startsWith('--report=')) out.report = takeInlineValue('--report', a.slice(9))
    else if (a === '--json') out.json = takeValue('--json', argv, ++i)
    else if (a.startsWith('--json=')) out.json = takeInlineValue('--json', a.slice(7))
    else if (a === '--root') out.root = takeValue('--root', argv, ++i)
    else if (a.startsWith('--root=')) out.root = takeInlineValue('--root', a.slice(7))
    else if (a === '--db') out.db = takeEnum('--db', argv, ++i, ['auto', 'on', 'off'])
    else if (a.startsWith('--db=')) out.db = takeEnum('--db', [a.slice(5)], 0, ['auto', 'on', 'off'])
    else if (a === '--quiet') out.quiet = true
    else if (a === '--p5') out.p5 = takeEnum('--p5', argv, ++i, ['core', 'wide'])
    else if (a.startsWith('--p5=')) out.p5 = takeEnum('--p5', [a.slice(5)], 0, ['core', 'wide'])
    else if (a === '--max-console') out.maxConsole = takePositiveInt('--max-console', argv, ++i)
    else if (a.startsWith('--max-console=')) out.maxConsole = takePositiveInt('--max-console', [a.slice(14)], 0)
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0) }
    // 拼错的选项不再被静默忽略（那是"配错了却看起来跑通了"的来源）
    else fail(`未知选项：${a}`, '用 --help 查看全部选项')
  }
  out.root = path.resolve(out.root)
  return out
}

/** 正整数取值（--max-console） */
function takePositiveInt(name, argv, i) {
  const raw = takeValue(name, argv, i)
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) fail(`选项 ${name} 需要正整数，收到：${raw}`)
  return n
}

const ARGS = parseArgs(process.argv.slice(2))

// ─────────────────────────── 通用工具 ───────────────────────────

const IGNORE_DIRS = new Set(['node_modules', 'dist', '.git', '.vite', 'coverage', '.dsh'])

// 读不到 ≠ 空（门禁 portal R6 的 :129）：`walk()` 原来把 `readdirSync` 的异常吞掉、`src()` 把
// `readFileSync` 的异常变成空串**并缓存** ⇒ 子树不可读时整轮会**静默给出不完整结论**。
// 这比"整棵树为空"更危险 —— 布局自检只挡得住后者（全空），挡不住"少读了一部分"。
const readFailures = []
/** **检测面目录**单源（门禁 portal#50 R5 的 :215 / Kimi 桥198④）：walk() 的逃逸分级与 inDir 的过滤
 *  原来各硬编码一份 src/api/db/contracts ⇒ 检测面一变就静默漂移。 */
const SCANNED_DIRS = ['src', 'api', 'db', 'contracts']
/** **模块级 notes 槽**（门禁 wb#54 R2 的 `critical` / portal#50 R4 的 `high` —— 同一个真 bug）：
 *  我在 `walk()` 的"逃逸降级"分支里写了 `notes.push(...)`，但 `notes` 当时只是 `detectP2()` 的**局部**变量
 *  ⇒ 那条路一走到就 `ReferenceError: notes is not defined`，**整次审计崩溃** —— 与"降级而不中止"的意图正好相反。
 *  ⚠️ 我上一轮的探针把它误读成"修好了"：我只看了退出码（1），没看输出文本 —— **那个 1 就是 node 崩溃的退出码**。
 *  教训：**验证要看输出，不能只看退出码**（这条今天已经是第三次同型）。
 *  这里与 `readFailures` 并列声明为模块级，并由报告与 `--json` 消费。 */
const notes = []
/** P5 症状里展示的 claim 截断长度（原为魔数 130）。 */
const CLAIM_SHOW_MAX = 130
const SUMMARY_HEADER = '── 汇总 ──'
/** **`--quiet` 视图的定窗单点**（cleanup-tail-r1 ⑤）。**主路径是确定性的**：取「── 汇总 ──」起的最后一段
 *  （不依赖行数窗口）—— 原来靠 `L.slice(-8)`，notes 行只因"恰好落在末 8 行内"才没丢/没重，汇总行一增减就双印或丢失。
 *  放在**模块级**是因为写 stdout 的语句在 `main()` **之外**（我第一版把 `quietBody` 声明在 main 内 ⇒ ReferenceError）。
 *  汇总头缺失时**落全量 `lines`**（门禁 2974④ 建议）：先前留 `slice(-8)` 兜底 + lint-allow，但"若该支可达就等于把定窗 bug 引回来"，故改全量。
 *  （门禁 2954 的 L4 据此判定该支**不可达**）；保留它是为了万一将来汇总段被改名/被跳过时，`--quiet` 不至于输出**空**
 *  （空输出在 CI 上会被读成"没跑"）。故显式白名单，不删。
 *  ⚠️ 这段 doc **曾经是两个叠放的 `/** … *​/` 块**（门禁 portal#51 指出：JSDoc 后面紧跟另一个 doc 块 ⇒ 前一块挂不到任何东西），
 *  现已合并为一块。 */
function quietView(lines) {
  const si = lines.lastIndexOf(SUMMARY_HEADER)
  // (2974-4) 按门禁建议：汇总头缺失时**落全量**，不再用 slice(-8) 定窗（那等于把已修的 bug 引回来）
  return si >= 0 ? lines.slice(si) : lines
}

/** **notes 摘要行单点**（门禁 portal#50 R6 的 :2299：同一消息曾在汇总与 quiet 尾行各写一份）：
 *  返回 null 表示没有非阻断记录。控制台汇总、`--quiet` 尾行、周报正文都从这里取文案。 */
function notesSummaryLine() {
  if (!notes.length) return null
  return `  注：${notes.length} 条非阻断记录（不中止）——例：${notes[0].err}`
}

/**
 * 读失败统一中止（门禁 R10 的 `:1499-1502` 指出两处守卫重复 —— 抽此单点）。
 * **两处都要调**：早闸只挡得住 `walk()` 阶段的失败，其余源码是**惰性读**的（`src()` 在检测器里才被调用），
 * 那些失败发生在早闸之后 —— 只在早闸查一次就等于放过"检测期少读了一部分"。
 */
function assertNoReadFailures(stageLabel, what) {
  if (!readFailures.length) return
  const f0 = readFailures[0]
  fail(
    `${stageLabel}有 ${readFailures.length} 处${what}读不到`,
    `例：${f0.path}（${f0.err}）；读不到**不等于**空，继续跑会给出不完整结论`,
  )
}

/** 「往下看多远就放弃」的统一上界（门禁 wb#54 R1 的 :825-826：原来 400/600 两个魔数各写一处）。 */
const LOOKAHEAD_LIMIT = 600
let rootRealCache = null
/** `--root` 的真实路径（**单点 + 缓存**）：软链包容校验要用它做前缀比较。
 *  walk() 每层目录都会调，故缓存一次；realpath 失败（权限/断链）退化为原字面值。
 *  ⚠️ 这段 doc **原来叠在 `LOOKAHEAD_LIMIT` 的 doc 之下** ⇒ 挂不到本函数（门禁"叠放 doc 块"同型；
 *  我新增的叠放自检把它一起抓出来了），已移到函数正上方。 */
function rootReal() {
  if (rootRealCache === null) {
    try { rootRealCache = fs.realpathSync(ARGS.root); } catch { rootRealCache = ARGS.root; }
  }
  return rootRealCache
}
/** 软链包容判定**单点**（门禁 portal#50 R1 的 :195-196）：目录/文件两处原来各手写一份、还是镜像取反的
 *  同一知识 ⇒ 任何一处改动都可能只改半边。收进一个谓词，两处共用。 */
function withinRoot(real) {
  const rr = rootReal()
  if (real === rr) return true
  // ⚠️ 前缀不能写 `rr + path.sep`（门禁 wb#54 R1 的 :181-184，bug·low）：当 `--root` 就是文件系统根
  //    （`/` 或 `C:\`）时 `realpathSync` 已带尾分隔符，再加一个就变成 `//`（或 `C:\\`）⇒ **所有真实路径都判不匹配**、
  //    整仓被判"逃逸"。故先判断根是否已以分隔符结尾，再拼。
  const prefix = rr.endsWith(path.sep) ? rr : rr + path.sep
  return real.startsWith(prefix)
}
/** 逃逸告警的去重集合：**只对逃逸**生效，键 = 目标 + 分类。
 *  ⚠️ 用**独立**集合、不用 `walk()` 的 `seen`（门禁 2978 的 `bug·med` / portal `security·medium`）：
 *  我上一版把去重塞进共享的 `seen` 且放在 `withinRoot` **之前**，两个后果都是错的：
 *   ① 两条**仓内**软链指同一目标（`src/a.ts`、`src/b.ts` -> `lib/x.ts`）时后者被整条跳过 ⇒ **被扫描文件静默消失**（P1 漏报）；
 *   ② 逃逸分级发生在去重**之后** ⇒ 分级结果取决于"哪条软链先被遍历到"：
 *      非检测面目录先命中则只记 note，随后**检测面目录**指向同一目标的软链被跳过 ⇒ **安全闸 fail-open**。
 *  改法：**先分级、再去重**，且键里含分类（目标 + 是否进检测面 + 是否代码）⇒ 既压掉重复告警，又**与遍历顺序无关**。 */
const seenEscapes = new Map()
function gradeEscape(inRepoPath, kind, realTarget) {
  const r = rel(inRepoPath)
  const scanned = SCANNED_DIRS.some((d) => r === d || r.startsWith(d + "/"))
  // (2976-1, security·medium) **有意耦合，并在此明写**：升级为 readFailures（= 阻断）的条件里含 `isCode(...)`，
  // 即"**安全闸与扫描白名单同源**" —— 当前唯一的读取方 `src()` 只消费 `filesIn()` 的 `isCode` 过滤结果，
  // 非代码文件根本不会被读、不会被扫，故 `src/x.json -> /etc/passwd` 只记 note 属**收窄**而非遗漏。
  // ⚠️ **这条耦合会腐化**：若将来任何探测器去读**非代码**文件、或改 ignore 清单，这类逃逸就会**静默失去阻断**。
  //    改那两处时必须回来同步本行。（门禁 2976① 要求显式标注，即此。）
  // ⚠️ **`risky` 也必须排除测试文件**（门禁 2987③，bug·low）：测试文件**从不被读**
  //    （`filesIn` 里带 `!isTest`），故 `src/foo.test.ts -> /etc/passwd` 不该升级成 readFailures 让整轮中止 ——
  //    否则与上面"会被读会被扫"的判据自相矛盾。
  // ⚠️ **谓词与 `filesIn()` 同源**（门禁 2998，maint·low）：`isCode && !isTest` 若留第二份抄本可各自漂移 ⇒
  //    统一走 `isScannable()` 单点（与 `filesIn` 共一个定义），安全闸与扫描白名单不再有两份真值。
  const risky = kind === 'dir' || isScannable(inRepoPath)
  // 分级**先于**去重（顺序无关性）；去重键 = 目标 + 分类。
  // ⚠️ 但**同一键下的多条软链不能只留第一条**（门禁 2994③ 的 maint·low）：把每条**仓内源路径**都攒进 `paths`，
  //    否则"哪几条链逃逸了"这个可行动信息会丢。
  const key = `${realTarget || r}|${scanned ? 1 : 0}|${risky ? 1 : 0}`
  const prev = seenEscapes.get(key)
  if (prev) { if (!prev.paths.includes(r)) prev.paths.push(r); return }
  // (2974-2) escaped:true 恒真且无人读 => 已删；kind 已表达同一事实
  const item = { kind: 'symlink-escape', path: inRepoPath, paths: [r], err: `符号链接逃逸 --root：${r}` }
  seenEscapes.set(key, item)
  if (scanned && risky) {
    // ⚠️ **失败消息要带上解析后的真实目标**（门禁 2994① 的 bug·med，**我改裁**）：先前我以"别把宿主路径带出去"为由
    //    把 `（${real}）` 拿掉了。门禁的论据更强：`readFailures` **不落盘**（不进 `--json` / 周报），只在
    //    stderr 上打一条，而"这条链到底能摸到宿主哪个路径"是**修复与评估影响范围的第一线索**。
    //    折中：目标**只出现在失败消息里**；note 与 `--json` 面仍只留仓内相对路径。
    readFailures.push({ ...item, err: item.err + `（真实目标：${realTarget || '?'}）` + ' —— 该处进检测面，已按读失败处置' })
    return
  }
  notes.push(item)
}

function walk(dir, out = [], seen = new Set()) {
  // ⚠️ **软链环守卫**（门禁 portal R25 的 :182-184，**bug/high**）：上一轮我给软链加了 `statSync` 跟随，
  //    但**没有环检测** —— `link -> .` 或"链指回祖先目录"会让递归无限下去（爆栈/挂死）。
  //    修法：按**真实路径**去重（`realpathSync`）—— 环回到已访问过的实体时直接返回。
  let real = dir
  try {
    real = fs.realpathSync(dir)
  } catch {
    /* realpath 失败（权限/断链）不阻断：退化成按字面路径去重 */
  }
  // ⚠️ **逃逸判定必须在 `seen` 短路之前**（门禁 portal#51 的 `security·medium`，我上两版都错在这里）：
  //    若先 `if (seen.has(real)) return out`，则当**非检测面目录**（如 `docs/`）里的软链先被遍历、
  //    已把该仓外目标登记进共享的 `seen` 时，随后**检测面目录**（`src/`）里指向**同一目标**的软链会被短路掉、
  //    **根本走不到分级** ⇒ 阻断消失（**fail-open**，且结果依赖遍历顺序）。
  //    现在：先判包容（逃逸一律登记/分级），`seen` 只服务于**仓内**遍历的环保护。
  //    重复告警由 `seenEscapes` 按"目标 + 分类"去重兜住 ⇒ 既无 fail-open、也不会重复刷屏。
  if (!withinRoot(real)) { gradeEscape(dir, 'dir', real); return out }
  if (seen.has(real)) return out
  seen.add(real)
  // ⚠️ **`--root` 包容校验**（门禁 portal#44 R24 的 :195，security·medium）：软链跟随只做去重是不够的 ——
  //    `src/`、`api/`、`db/` 下任何一条软链都能指向**仓外**任意宿主文件（`/etc`、`~/.aws`、`../node_modules`），
  //    于是工具会去读它、全检测器扫它，内容可进 findings / 报告证据 / `--json` dump ⇒
  //    **CI 门禁意外读宿主文件 + 信息泄漏**。逃逸按分级处置（检测面内 ⇒ 读失败；其余 ⇒ note）。
  //    ⚠️ **顺序（勿再写反）**：本行**先于** `if (seen.has(real))` 执行 —— 逃逸一律登记/分级，`seen` 只做仓内环保护；重复告警由 `seenEscapes`（目标+分类）兜住。旧注释曾写"seen 去重先于本校验"，与码相反、被门禁 2994② 的 :280 连抓两轮。
  //    （门禁 R2 的 :251；门禁 2963/2964 指出早先残留的一段旧注释把顺序写反，已删。）
  let ents
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) {
    readFailures.push({ path: dir, err: String((e && e.message) || e) })
    return out
  }
  for (const e of ents) {
    // ⚠️ **符号链接要跟随一次**（门禁 portal R24 的 :177-180）：`readdirSync({withFileTypes:true})` 对软链
    //    返回的 Dirent，`isDirectory()` 与 `isFile()` **都是 false**（它是 `isSymbolicLink()`）⇒ 直接走
    //    原来那两个分支会让**软链进来的源文件被静默漏掉**。用 `statSync`（跟随链接）判一次。
    let isDir = e.isDirectory()
    let isFile = e.isFile()
    if (e.isSymbolicLink()) {
      try {
        const st = fs.statSync(path.join(dir, e.name)) // 跟随链接；断链会抛 ⇒ 记 readFailures 而不是静默丢
        isDir = st.isDirectory()
        isFile = st.isFile()
      } catch (err) {
        readFailures.push({ path: path.join(dir, e.name), err: String((err && err.message) || err) })
        continue
      }
    }
    if (isDir) {
      if (IGNORE_DIRS.has(e.name)) continue
      walk(path.join(dir, e.name), out, seen)
    } else if (isFile) {
      // 软链**文件**同样要过包容校验（上面那道只覆盖目录）：否则 `src/x.ts -> /etc/passwd` 会被读进扫描面。
      const entry = path.join(dir, e.name)
      // ⚠️ 普通文件**不必**再 realpath（门禁 portal#50 R1 的 :226-227，perf·low）：它所在的 `dir` 已过包容校验，
      //    普通文件不可能"自己"逃逸出 --root ⇒ 每个文件一次 syscall 纯属浪费。只有**软链**才需要跟随判定。
      if (!e.isSymbolicLink()) { out.push(entry); continue }
      let freal = entry
      try { freal = fs.realpathSync(freal) } catch { /* 断链：按字面路径交下游按读失败处置 */ }
      // ⚠️ **仓内软链一律保留、绝不参与去重**（门禁 2978 的 `bug·med`）：`seen` 是整棵 DFS 共享的集合，
      //    两条**仓内**软链指同一目标（`src/a.ts`、`src/b.ts` -> `lib/x.ts`）时，后者会被整条跳过
      //    ⇒ **被扫描文件静默消失** ⇒ P1 硬档漏报。这里只判包容，不碰 `seen`。
      if (withinRoot(freal)) { out.push(entry); continue }
      // 逃逸：把**真实目标**交给 `gradeEscape` 参与"分类去重"（分级先于去重 ⇒ 与遍历顺序无关）。
      gradeEscape(entry, 'file', freal)
    }
  }
  return out
}

const isTest = (f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f)
const isCode = (f) => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(f)
// 会被读会被扫的**单源谓词**：检测面文件集（`filesIn`）与逃逸 `risky` 分级共用（门禁 2998）——
// 安全闸与扫描白名单只此一份真值，改这里即两边同步。
const isScannable = (f) => isCode(f) && !isTest(f)
const rel = (p) => path.relative(ARGS.root, p).split(path.sep).join('/')

const srcCache = new Map()
function src(file) {
  let hit = srcCache.get(file)
  if (hit) return hit
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch (e) {
    // 读不到就**记下来**，别把空串当成"文件是空的"缓存进 srcCache（门禁 portal R6 的 :129）
    readFailures.push({ path: file, err: String((e && e.message) || e) })
  }
  // `maskLines` 一并缓存（门禁 portal R10 的 :1304）：P2 在「每张空表 × 每个文件」的双层循环里
  // 需要**按行切分**的掩码，原来每次都 `mask.split('\n')` ⇒ 上百张表 × 上百文件 = 数万次整文件切分，
  // 是 P2（除 DB 探针外）的主要开销；`detectP5` 里也在重复切。一次算好放进 srcCache 即可。
  const mask = maskComments(text)
  // `text` **不进缓存**（门禁 portal R15 的 :198）：全脚本没有任何地方读它（格式化都用 `lines`/`maskLines`），
  // 留着等于为每个源文件多保一份完整拷贝。`lines` 只按住引用，不额外拷贝。
  hit = { mask, lines: text.split('\n'), maskLines: mask.split('\n') }
  srcCache.set(file, hit)
  return hit
}

/**
 * 注释内容替换成空格（保留换行 ⇒ 行号不变）。字符串/模板/正则原样保留。
 * 自己写扫描器而不是逐行正则：注释里带引号、正则里带引号在本仓都很常见，
 * 逐行正则会看错（把字符串里的 // 当注释、把正则里的 ' 当字符串头）。
 */
function maskComments(s) {
  const out = s.split('')
  const n = s.length
  let i = 0
  let st = null // line | block | sq | dq | tpl | re
  let tplDepth = 0 // 进入模板时归零：记录当前处在第几层 ${…}（模板里才是"文本"，${} 里是代码）
  let prevSig = ''
  let prevWord = ''
  while (i < n) {
    const c = s[i]
    const d = i + 1 < n ? s[i + 1] : ''
    if (st === null) {
      if (c === '/' && d === '/') { st = 'line'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue }
      if (c === '/' && d === '*') { st = 'block'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue }
      if (c === "'") { st = 'sq'; i++; prevSig = c; continue }
      if (c === '"') { st = 'dq'; i++; prevSig = c; continue }
      if (c === '`') { st = 'tpl'; tplDepth = 0; i++; prevSig = c; continue }
      if (c === '/' && regexAllowed(prevSig, prevWord)) { st = 're'; i++; continue }
      if (!/\s/.test(c)) {
        prevSig = c
        if (/[A-Za-z_$]/.test(c)) {
          // 只在**词的起点**取整词（门禁 R3 的 :141）：原来每个字符都重算、`s.slice(i)` 从当前字符起算，
          // 扫完 `return` 后 prevWord 停在 `"n"` ⇒ REGEX_WORDS 那半启发式**整个失效** ⇒
          // `return /[/*]/` 里的 `/*` 会开块注释且永不闭合，把此后整片真代码当注释吃掉（硬档漏报）。
          const prev = i > 0 ? s[i - 1] : ''
          if (!/[A-Za-z0-9_$]/.test(prev)) {
            const m = /^[A-Za-z_$][\w$]*/.exec(s.slice(i))
            prevWord = m ? m[0] : ''
          }
        } else prevWord = ''
      }
      i++
      continue
    }
    if (st === 'line') { if (c === '\n') { st = null; i++; continue } out[i] = ' '; i++; continue }
    if (st === 'block') {
      if (c === '*' && d === '/') { out[i] = ' '; out[i + 1] = ' '; st = null; i += 2; continue }
      if (c !== '\n') out[i] = ' '
      i++
      continue
    }
    if (st === 're') {
      // 行尾保险丝（门禁 R4 的 :191）：JS 正则字面量**同样不能跨行** —— sq/dq 有这条、re 原先漏了。
      // 一旦某个 `/` 被误判成正则起始，没有这条就会**跨行一路吞到下一个 `/`**，
      // 把中间的注释乃至整片代码都吞掉；有这条，误判的爆炸半径被压到一行。
      if (c === '\n') { st = null; i++; continue }
      if (c === '\\') { i += 2; continue }
      if (c === '[') {
        // 字符类**同样不能跨行**（门禁 portal R8 的 :226）：原来的子循环不认换行，
        // 会从行尾保险丝下面**绕过去** ⇒ 被误判的正则又能跨行乱吞（保险丝形同虚设）。
        i++
        let closed = false
        while (i < n && s[i] !== '\n') {
          if (s[i] === '\\') { i += 2; continue }
          if (s[i] === ']') { closed = true; i++; break }
          i++
        }
        if (!closed) { st = null; continue } // 未闭合或撞到换行 ⇒ 判为误判，作废 re 态
        continue
      }
      if (c === '/') { st = null; i++; prevSig = '/'; continue }
      i++
      continue
    }
    if (st === 'tpl') {
      // 模板里必须认 ${…} 深度（门禁 portal#44 的 high）。不认的后果是**状态反转**：
      //   嵌套模板的内层反引号会把外层模板「关掉」⇒ 内层文本被当**代码**扫 ⇒
      //   里面一个不成对的引号（如 `${`it's`}`）就让人卡进 sq/dq，
      //   而 sq/dq 又不换行终止 ⇒ **此后整个文件的注释都不再被掩掉**：
      //   注释掉的调用点会被 P1/P4 当**真代码**扫到（硬档误报），反之也可能把真代码当注释（硬档漏报）。
      //   深度记账口径与 literals() 一致。
      if (c === '\\') { i += 2; continue }
      if (c === '$' && d === '{') { tplDepth++; i += 2; continue }
      if (tplDepth > 0 && c === '}') { tplDepth--; i++; continue }
      if (tplDepth === 0 && c === '`') { st = null; i++; continue }
      i++
      continue
    }
    // 保险丝：JS 里 ' 与 " 本就不能跨行 ⇒ 行尾未闭合一律作废。
    // 没有这条，前面一旦判错一次，后面的注释会**整片**失去掩码（修复前实测即此症状）。
    if ((st === 'sq' || st === 'dq') && c === '\n') { st = null; i++; continue }
    if (c === '\\') { i += 2; continue }
    if ((st === 'sq' && c === "'") || (st === 'dq' && c === '"')) { st = null; i++; continue }
    i++
  }
  return out.join('')
}

const REGEX_PREV = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>'])
const REGEX_WORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'yield', 'await', 'case'])
const regexAllowed = (prevSig, prevWord) => REGEX_WORDS.has(prevWord) || REGEX_PREV.has(prevSig)

/**
 * 行号：**按文本缓存换行位置**后二分查找（门禁 portal R14 的 :300-305）。
 * 原来是从 0 扫到 `idx`，而它按**命中次数**调用（detectP1/P4、sqlStatements、ormValues 每处命中一次）
 * ⇒ 命中多的文件里是 O(命中数 × 文件大小)。文本来自 `src()` 缓存（同一文件同一字符串对象），
 * 所以按文本建一次换行表即可长期复用。
 */
const lineStartsCache = new Map()
const lineOf = (text, idx) => {
  let starts = lineStartsCache.get(text)
  if (!starts) {
    starts = [0]
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
    lineStartsCache.set(text, starts)
  }
  const end = Math.min(idx, text.length)
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= end) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/**
 * findings 的稳定排序键：**先文件、再行号（按数值）**。
 * 原来写的是 `(a.file + a.line).localeCompare(b.file + b.line, 'zh')` —— 字符串比较下
 * `'…:10' < '…:9'`，于是**行号 10 排在 9 前面**，报告里同一文件的命中次序是乱的（门禁 portal R9 的 :544）。
 */
const byFileLine = (a, b) => a.file.localeCompare(b.file, 'zh') || a.line - b.line

/** 布尔升序（false 在前）——显式写出来（门禁 R10 的 :1050）：原来靠 `a - b` 的隐式 bool→number 转换，
 *  能跑但看不出意图，而且这两个字段哪天变成非布尔就会**静默**排错。
 *  ⚠️ 我第一版写成 `(a === b ? 0 : a ? 1 : -1)`，那**本身就是嵌套三元**（门禁 portal R13 的 :316 抓到）——
 *  本文件里到处引用这条仓规，自己却犯了。改成 if 语句。 */
function byBoolAsc(a, b) {
  if (a === b) return 0
  return a ? 1 : -1
}

/** 把标识符安全地嵌进正则（门禁 portal R9 的 :1258）：表名/符号名来自 schema，但不该假定天然无元字符。 */
const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ─────────────────────── 字面量 / 语法小工具 ───────────────────────

function unescapeJs(s) {
  return s.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (m, g) => {
    if (g === 'n') return '\n'
    if (g === 't') return '\t'
    if (g === 'r') return '\r'
    if (g[0] === 'u' && g[1] === '{') return String.fromCodePoint(parseInt(g.slice(2, -1), 16))
    if (g[0] === 'u') return String.fromCharCode(parseInt(g.slice(1), 16))
    if (g[0] === 'x') return String.fromCharCode(parseInt(g.slice(1), 16))
    return g
  })
}

/** 抽字面量。返回 {kind:'sq'|'dq'|'tpl', value, raw, index, hasInterp}。 */
function literals(text, from = 0, to = text.length) {
  const res = []
  let i = from
  while (i < to) {
    const c = text[i]
    if (c === "'" || c === '"') {
      const q = c
      let j = i + 1
      let val = ''
      while (j < to) {
        if (text[j] === '\\') { val += text[j] + (text[j + 1] ?? ''); j += 2; continue }
        if (text[j] === q || text[j] === '\n') break
        val += text[j]
        j++
      }
      if (j < to && text[j] === q) {
        res.push({ kind: q === "'" ? 'sq' : 'dq', value: unescapeJs(val), raw: text.slice(i, j + 1), index: i, hasInterp: false })
        i = j + 1
        continue
      }
      i++
      continue
    }
    if (c === '`') {
      let j = i + 1
      let val = ''
      let depth = 0
      while (j < to) {
        if (text[j] === '\\') { val += text[j] + (text[j + 1] ?? ''); j += 2; continue }
        if (depth === 0 && text[j] === '`') break
        if (text[j] === '$' && text[j + 1] === '{') { depth++; val += '${'; j += 2; continue }
        if (depth > 0 && text[j] === '}') { depth--; val += '}'; j++; continue }
        val += text[j]
        j++
      }
      if (j < to && text[j] === '`') {
        res.push({ kind: 'tpl', value: unescapeJs(val), raw: text.slice(i, j + 1), index: i, hasInterp: val.includes('${') })
        i = j + 1
        continue
      }
      i++
      continue
    }
    i++
  }
  return res
}

/**
 * 跳过从 `text[i]`（必须是引号/反引号）开始的字符串字面量，返回**闭合引号之后**的下标。
 * **所有"数括号 / 找顶层键"的扫描都必须用它**（门禁 portal R15 的 :419 / :610-611 / :726-731）：
 * 这些扫描跑在**掩码后**的文本上，而掩码**保留字符串字面量原样** ⇒ 字符串里的 `{` `}` 或 `method:`
 * 会被当成代码参与判定 —— 轻则方法判错（硬档假阳性），重则整个对象解析不出任何键。
 *
 * ⚠️ **`'` / `"` 必须有行尾保险**（门禁 wb#52 R20 的 :419-428）：JS 里这两者**不能跨行**，
 * 掩码函数 `maskComments()` 也是这个口径（行尾未闭合就作废该状态）。没有它，源码里一个未闭合的单引号
 * （例如中文注释里误打的 `'`，或我扫到的一半字符串）会让 `skipQuoted` 一路吞到**文件末尾** ⇒
 * 调用方拿到的 span 全错。反引号可以跨行，故不设这道闸。
 */
function skipQuoted(text, i) {
  const q = text[i]
  const multiline = q === '`'
  i++
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue }
    if (!multiline && text[i] === '\n') return i // 行尾保险：未闭合 ⇒ 停在换行处（不回卷，交给调用方继续扫）
    if (text[i] === q) return i + 1
    i++
  }
  return text.length
}

/** 从 `{` 取到**配对的** `}`（跳过引号内内容）——取完整的 init 对象用（门禁 portal R12 的 high）。
 *  必须是配对扫描：惰性正则会在第一个 `}` 停住，而 init 对象里常有嵌套（`headers`/`body`）。 */
function sliceBraces(text, openIdx) {
  let depth = 0
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i]
    if (c === "'" || c === '"' || c === '`') { i = skipQuoted(text, i) - 1; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return text.slice(openIdx, i + 1) }
  }
  return null
}

/** 对象字面量文本里**顶层** `method` 的形态，返回值三选一：
 *  - 小写方法名字符串（如 `'post'`）—— 顶层 `method: 'X'` 字面量；
 *  - `'unknown'` —— 顶层有 `method` 但不是字符串字面量（简写 `{ method }` / 变量 `{ method: m }`）；
 *  - `null` —— **没有**顶层 `method`。
 *  「顶层」很关键：`{ headers: { method: 'X' } }` 里的 method 是嵌套的，不代表本次请求的方法。
 *  ⚠️ 我第一版 JSDoc 写的是返回 `'literal:<m>'`，而实现早就改成直接返回方法名了（门禁 portal R14 的 :406 抓到）——
 *  文档与实现不一致比没有文档更坏，这里据实写。 */
function topLevelMethodKind(objText) {
  let depth = 0
  for (let i = 0; i < objText.length; i++) {
    const c = objText[i]
    // 字符串/模板字面量整段跳过（门禁 portal R15 的 :419）：`{ body: 'method: "POST"' }` 里那个
    // `method:` 在字符串里，不是请求方法；字符串里若有 `{`/`}` 还会让 depth 记账错位、漏掉真的 method 键。
    if (c === "'" || c === '"' || c === '`') { i = skipQuoted(objText, i) - 1; continue }
    if (c === '{' || c === '[' || c === '(') { depth++; continue }
    if (c === '}' || c === ']' || c === ')') { depth--; continue }
    if (depth !== 1 || c !== 'm') continue
    // ⚠️ 必须确认**前一个字符不是标识符字符/`.`**（门禁 portal R20 的 :459-461）：`/^method\b/` 只保证
    //    后面有边界，`{ amethod: 'x', headers: … }` 里 `amethod` 的尾巴 `method` 会被当成真方法键。
    if (i > 0 && /[\w$.]/.test(objText[i - 1])) continue
    const rest = objText.slice(i)
    if (!/^method\b/.test(rest)) continue
    const lit = /^method\s*:\s*['"]([A-Za-z]+)['"]/.exec(rest)
    if (lit) return lit[1].toLowerCase()
    return 'unknown' // `method: someVar` / 简写 `{ method }` ⇒ 判不了
  }
  return null
}

/** 从 '(' 找配对 ')'，返回 [start, endExclusive]；找不到 → null。
 *  ⚠️ 引号处理**必须走 `skipQuoted` 单点**（门禁 wb#52 R20 的 :479-487）：原来这里内联复制了同一段
 *  跳引号循环 —— 于是"给 `skipQuoted` 加行尾保险"这类修正**管不到它**（同一处知识两套实现，正是我这几轮
 *  反复被门禁抓到的那个型）。收成单点后，行尾保险（`'`/`"` 不能跨行）自动生效。 */
function matchParen(text, openIdx) {
  let depth = 0
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i]
    if (c === '(') depth++
    else if (c === ')') { depth--; if (depth === 0) return [openIdx, i + 1] }
    else if (c === "'" || c === '"' || c === '`') i = skipQuoted(text, i) - 1
  }
  return null
}

/**
 * 从 '<' 找配对的 '>'（用于跨过类型实参），返回 [start, endExclusive]；找不到 → null。
 * 必须支持**嵌套泛型**（`Array<{ a: number }>`、`Record<string, () => void>`）—— 这正是门禁 R4 的 :413
 * 指出的缺口：原来用 `(?:<[^<>()]*>)?` 一条正则，跨不过嵌套，导致这类调用点被静默跳过。
 * `=>`（函数类型里的箭头）不算泛型闭合。
 */
function matchAngle(text, openIdx) {
  let depth = 0
  // ⚠️ 原来"遇连续空行即 return null"的保守退出**代价太大**（门禁 portal R8 的 :369）：
  //    调用点 `if (!ang) continue` 会把**整个调用点**跳过 ⇒ P1 漏报（P1 是**硬档**）。
  //    类型实参本来就可能被 prettier 折到空行两侧，为"防误吞"而制造假阴性不划算。
  //    改用**长度上界**兜底：类型实参不可能长到这个量级，超界才判"这不是类型实参"。
  const LIMIT = LOOKAHEAD_LIMIT // 收编到共用上界（门禁 portal#50 R5 的 :173-841 / Kimi 桥198③：原来两处各写 600）
  const end = Math.min(text.length, openIdx + LIMIT)
  for (let i = openIdx; i < end; i++) {
    const c = text[i]
    if (c === '<') depth++
    else if (c === '>') {
      if (text[i - 1] === '=') continue // `=>` 箭头，不是闭合
      depth--
      if (depth === 0) return [openIdx, i + 1]
    }
  }
  return null
}

/**
 * 按**顶层逗号**切分：跳引号内内容，且**三种括号**（`()` `{}` `[]`）都要计入深度
 *（门禁 wb#52 R9 的 high：INSERT 值列表必须按位置取 token，不能拿"所有引号字面量"当数组；
 * 门禁 portal R20 的 :535-537：原来只数圆括号，`{…}`/`[…]` 里的逗号会被当顶层 —— 与上面那句注释不符）。
 */
function splitTopCommas(s) {
  const out = []
  let depth = 0
  let cur = ''
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === "'" || c === '"' || c === '`') {
      const end = skipQuoted(s, i)
      cur += s.slice(i, end)
      i = end
      continue
    }
    if (c === '(' || c === '{' || c === '[') depth++
    else if (c === ')' || c === '}' || c === ']') depth--
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; i++; continue }
    cur += c
    i++
  }
  out.push(cur)
  return out
}

/**
 * 按**顶层分号**切分 SQL 文本（跳过引号内内容），返回 `{ text, at }[]`（`at` = 该段在原文中的起点）。
 * 门禁 wb#52 R15 的 :1001：原来用 `body.split(';')`，字符串里的分号（如 `'a;b'`）会把**一条语句劈成两半**，
 * 两半都解析错。`at` 直接给出偏移，省掉调用方再 `indexOf` 定位（那个写法在重复片段上会指错）。
 */
function splitStatements(body) {
  const out = []
  let start = 0
  let i = 0
  while (i < body.length) {
    const c = body[i]
    if (c === "'" || c === '"' || c === '`') { i = skipQuoted(body, i); continue }
    if (c === ';') { out.push({ text: body.slice(start, i), at: start }); i++; start = i; continue }
    i++
  }
  out.push({ text: body.slice(start), at: start })
  return out
}

/**
 * 把字符串/模板字面量**替换成等长空格**，其余原样 —— 让"按位置扫关键字/列名"的正则不会把**值**当结构。
 * 门禁 wb#52 R15 的 :1070：`WHERE note = 'status'` 里的 `'status'` 会被 `wordRe` 当成**列名**。
 * 等长替换是关键：下标与原文一一对应，所以取值仍可从原文 `sql` 切（值不会被抹掉）。
 */
function blankStrings(s) {
  let out = ''
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === "'" || c === '"' || c === '`') {
      const end = skipQuoted(s, i)
      out += ' '.repeat(end - i)
      i = end
      continue
    }
    out += c
    i++
  }
  return out
}

function topLevelStrings(argText) {
  // 单趟前置扫描（门禁 portal R9 的 :397）：原来在**每一个引号处**调 `literals(argText, i)`，
  // 而 `literals` 会从 `i` 一路扫到串尾、却只取"正好落在 i 的那一条" ⇒ 整体近似 O(n²)。
  // 改成**先一次扫完、按 index 建表**，再单趟判 depth —— 行为不变，复杂度降到 O(n)。
  const byIndex = new Map()
  for (const l of literals(argText)) byIndex.set(l.index, l)
  const out = []
  let depth = 0
  let i = 0
  while (i < argText.length) {
    const c = argText[i]
    if (c === '(' || c === '[' || c === '{') { depth++; i++; continue }
    if (c === ')' || c === ']' || c === '}') { depth--; i++; continue }
    const cand = byIndex.get(i)
    if (cand) {
      if (depth === 0) out.push(cand)
      i = cand.index + cand.raw.length
      continue
    }
    i++
  }
  return out
}

const DOTTED = /^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/

// ─────────────────────────── 扫描面 ───────────────────────────

const allFiles = walk(ARGS.root)
const inDir = (f, d) => rel(f).startsWith(`${d}/`) // 按**相对路径**锚定（门禁 portal R25 的 :633）：
// 原来在**绝对路径**里找 `/src/` 段 —— 仓库若 checkout 在含 `/src/` 或 `/api/` 的目录下，`api/` 下的文件
// 会被同时算进 `srcFiles`、`src/` 下的也会进 `apiFiles`（检测面/计数/`--root` 语义一起错）。
// 也与下面 `dbFiles` 的 `rel(f).startsWith('db/')` 口径统一。
// ⚠️ **文件集从 `SCANNED_DIRS` 单源派生**（门禁 portal#50 R5 的 :215 ④ / Kimi 桥198④）：原来这里
// 硬编码 `'src'`/`'api'`/`'db'`/`'contracts'`，与逃逸分级那份是**两份真值** ⇒ 检测面一变就静默漂移。
// 现在：目录名只出现在 `SCANNED_DIRS` 一处。
const filesIn = (dirs) => allFiles.filter((f) => dirs.some((d) => inDir(f, d)) && isScannable(f))
// 目录名仍以 SCANNED_DIRS 为**单源**，但**不再按位置解构**（门禁 R1 的 :740：位置解构会把"数组顺序/长度"变成隐式契约，
// 插一个名字就静默错位）。改成按名字取 + **显式校验**：名字不在 SCANNED_DIRS 里就 fail-loud（退 2），
// 与"检测面变更必须显式处理"同一口径。
// ⚠️ **不在模块顶层 throw**（门禁 R2 的 :744，bug·low）：`const srcFiles = filesIn([dirOf("src")])` 在模块求值期就跑，
// 而文件底部只对 `main()` 包了 `.catch` ⇒ 这里 throw 会**绕过错误处理**、以裸栈崩溃结束（退 1，
// 与"1 = 硬档命中"语义冲突）。改：记进 `configErrors`，由**模块级早闸**（下方 `if (configErrors.length)`，
// 它在 `main()` 被调用**之前**就跑 —— 门禁 2963/2964 指出原注释误写为"main() 开头的早闸"）按标准失败路径报出（说明 + 退 2）。
const configErrors = []
/** `dirOf()` 实际**被调用过**的目录名（门禁 2978 的 `bug·med`）：反向断言必须**从真实调用派生**。
 *  我上一版写成 `new Set(['src','api','db','contracts'])` 第三个硬编码副本 ⇒ 它只验"这 4 个名字在不在集合里"，
 *  **既不检删除漂移**（拿掉某行 `dirOf('db')` 也照样通过），与注释宣称的语义不符。现在由 `dirOf()` 自己登记。 */
const consumedDirs = new Set()
const dirOf = (name) => {
  consumedDirs.add(name)
  if (!SCANNED_DIRS.includes(name)) {
    configErrors.push(`检测面目录 "${name}" 不在 SCANNED_DIRS（${SCANNED_DIRS.join("/")}）—— 改检测面时请同步这里`)
  }
  return name
}
const srcFiles = filesIn([dirOf('src')])
const apiFiles = filesIn([dirOf('api')])
const dbFiles = filesIn([dirOf('db'), dirOf('contracts')])
// 反向断言：`SCANNED_DIRS` 里每个名字都必须**真的被 `dirOf()` 调用过**（派生自实际调用，而非另一份字面量）。
// 只做单向校验时，往 SCANNED_DIRS 新增目录却忘了接上 ⇒ 检测面"看起来变宽、实则没扫"（静默漂移）。
for (const d of SCANNED_DIRS) {
  if (!consumedDirs.has(d)) configErrors.push(`SCANNED_DIRS 里的 ${d} 没有被 filesIn 消费 —— 新增检测面目录时必须在这里接上`)
}
const testCount = allFiles.filter((f) => isCode(f) && isTest(f)).length

// `mountedNamespaces()` 的记忆化缓存（门禁 portal R8 的 :435）。**必须声明在下面这段模块级守卫之前**：
// 守卫在模块加载时就会调用它，而 `let` 的初始化晚于守卫 ⇒ 放在函数旁边就是 TDZ（我第一版正是这么写错的）。
let mountCache = null

// ─────────── 布局自检（门禁 wb#52 的 high）：CI 闸门绝不能在"看错了仓库"时给出结论 ───────────
// 实测存在两种**沉默失败**，都直接破坏结论可信度：
//   ① root 指错/不可读 ⇒ walk() 吞掉 readdirSync 异常返回 [] ⇒ 0 命中 + 退出码 0（**假绿**）；
//   ② api/router.ts 改名/搬走 ⇒ mountedNamespaces() 返回空 ⇒ **每个调用点都被判"未挂载"**（满屏假阻断）。
// 故这两种情况一律以**专属退出码 2**中止：不出"干净"，也不出"命中"。
if (allFiles.length === 0) {
  fail('扫不到任何文件', `--root 指向的目录不存在、不可读或为空：${ARGS.root}`)
}
// 配置自洽早闸（门禁 R2 的 :744；M1/L1 两条修在这里）：
// · **前移到布局守卫之前**（门禁 2954 的 L1）：`SCANNED_DIRS` 与 `dirOf()` 的名字对不上时，若先跑布局守卫，
//   报出的是"仓库布局不符合预期"⇒ **具体诊断（是哪条目录名错）被遮蔽**。
// · **走 `fail()`**（门禁 2954 的 M1）：`console.error + process.exit(2)` 在 stderr 是管道时（CI）是**异步写**，
//   而 `exit` 不等待排空 ⇒ 解释句可能丢。本文件 `fail()` / `printHelp()` 两处注释早已写明同型 hazard。
if (configErrors.length) {
  fail('检测面目录配置不自洽', `${configErrors.length} 项：\n  · ${configErrors.join('\n  · ')}`)
}
if (srcFiles.length === 0 || apiFiles.length === 0) {
  fail(
    '仓库布局不符合预期',
    `src/ 下 ${srcFiles.length} 个源码文件、api/ 下 ${apiFiles.length} 个（root=${ARGS.root}）——本脚本只对 NumX Max 的 wb / portal 仓有效`,
  )
}
{
  // 读失败必须拦在**跑检测器之前**（门禁 portal R6 的 :129）：少读一部分目录/文件所得的"干净"
  // 与真干净无法区分 —— 这正是本脚本用退出码 2 表达的那件事。
  assertNoReadFailures('', '目录/源码')
  // ⚠️ `mountCache` 的声明必须在这句**之前**（守卫是**模块级**代码，模块加载时就跑，
  //    早于下面 `let mountCache = null` 的初始化 ⇒ 声明晚于调用就是 TDZ，
  //    与 team-progress.html 那条 `retryCount` 同型错 —— 我第一版正是这么写错的）。
  const mountCheck = mountedNamespaces()
  if (mountCheck.keys.length === 0) {
    fail(
      'api/router.ts 未解析出任何挂载命名空间',
      `文件${mountCheck.file ? `（${rel(mountCheck.file)}）` : '**不存在**'}；此时 P1 会把**所有**调用点判成"未挂载"，属满屏假阻断`,
    )
  }
  // 展开挂载（`...otherRouters`）静态列不出来（门禁 R10 的 :511-512）：静默忽略 = 挂载集合不完整
  // ⇒ P1 可能把**已挂载**的命名空间判成未挂载（硬档假阳性）。宁可响铃。
  if (mountCheck.spreads?.length) {
    fail(
      'api/router.ts 里存在"展开挂载"，挂载集合无法静态确定',
      `发现：${mountCheck.spreads.join('、')}；P1 依赖完整挂载表，此时结论不可信`,
    )
  }
}

// ───────────────────── P1 · 命名空间未挂载（硬档）─────────────────────

/** 解析 api/router.ts 里 `appRouter = createRouter({ … })` 的**顶层键**，并**记忆化**（门禁 portal R8 的 :435）：
 *  本函数在**布局自检**与 **detectP1** 里各调一次，每次都要读并扫描 `api/router.ts` —— 一轮运行内结果恒定，不该算两遍。
 *  ⚠️ `mountCache` **声明在守卫那一段**（模块加载即会调用本函数，声明晚于调用就是 TDZ）。
 *  ⚠️ 这里**原来也是两个叠放的 doc 块**（上一行 `/** 解析… *​/` 挂不到任何东西），已按新叠放自检合并。 */
function mountedNamespaces() {
  if (!mountCache) mountCache = computeMountedNamespaces()
  return mountCache
}

function computeMountedNamespaces() {
  const file = [path.join(ARGS.root, 'api', 'router.ts'), path.join(ARGS.root, 'api', 'router.tsx')].find((f) => fs.existsSync(f))
  // ⚠️ 早返回也要带 `spreads`（门禁 wb#52 R20 的 :683）：调用方读的是 `mountCheck.spreads?.length`，
  //   今天靠"`keys.length === 0` 那道闸会先 fail 退出"才没炸 —— 那是**顺序巧合**，不是契约。
  //   三个返回点的形状必须一致（少一个字段 = 埋在调用方的一颗雷）。
  if (!file) return { keys: [], file: null, spreads: [] }
  const text = src(file).mask
  const m = /export\s+const\s+appRouter\s*=\s*createRouter\s*\(\s*\{/.exec(text)
  if (!m) return { keys: [], file, spreads: [] }
  const keys = []
  const spreads = [] // `...otherRouters`：静态列不出来 ⇒ 交给调用方响铃
  let depth = 0
  let expectKey = true
  for (let i = m.index + m[0].length - 1; i < text.length; i++) {
    const c = text[i]
    // 字符串/模板字面量整段跳过（门禁 portal R15 的 :610-611）：路由表里到处是字符串值，
    // 值里若含未配对的 `{`/`}` 会让 depth 记账错位 ⇒ 后面的键全被跳过或提前 break。
    if (c === "'" || c === '"' || c === '`') { i = skipQuoted(text, i) - 1; continue }
    if (c === '{' || c === '[' || c === '(') { depth++; if (depth === 1) expectKey = true; continue }
    if (c === '}' || c === ']' || c === ')') { depth--; if (depth === 0) break; continue }
    if (depth !== 1) continue
    if (c === ',') { expectKey = true; continue }
    if (expectKey) {
      const km = /^([A-Za-z_$][\w$]*)\s*:/.exec(text.slice(i))
      if (km) { keys.push(km[1]); expectKey = false; i += km[0].length - 1; continue }
      // 简写挂载 `foo,`（门禁 R10 的 :511-512）：原来只认 `key: value` ⇒ 简写项被**静默丢掉**，
      // 于是 P1 会把它判成"未挂载"（**硬档假阳性**）。简写这里也收进来。
      const sm = /^([A-Za-z_$][\w$]*)\s*(?=[,}\]])/.exec(text.slice(i))
      if (sm) { keys.push(sm[1]); expectKey = false; i += sm[0].length - 1; continue }
      // 展开 `...other`：**列不出来**。静默忽略 = 挂载集合不完整 = P1 可能满屏假阳性，
      // 所以记下来由调用方以退出码 2 中止（宁可响铃，不给不可信结论）。
      if (text.startsWith('...', i)) {
        const sm2 = /^\.\.\.\s*([A-Za-z_$][\w$]*)?/.exec(text.slice(i))
        spreads.push(sm2 && sm2[1] ? sm2[1] : '(匿名展开)')
        expectKey = false
        i += (sm2 ? sm2[0].length : 3) - 1
        continue
      }
      if (!/\s/.test(c)) expectKey = false
    }
  }
  return { keys, file, spreads }
}

function detectP1() {
  const { keys: mounted, file: routerFile } = mountedNamespaces()
  const mountedSet = new Set(mounted)
  const called = []

  // 辅助调用形态：**只匹配名字**，类型实参由下面手工跨过 —— 原来的 `(?:<[^<>()]*>)?`
  // 跨不过嵌套泛型（`Array<…>`/`Record<…>`/函数类型）⇒ 这类调用点被**静默跳过**，
  // 是硬档的覆盖缺口（门禁 R4 的 :413）。
  const HELPER = /\b(wbQuery|wbMutation|useWbQuery|useWbMutation|callWb|wbFetchQuery)\b/g
  // 别名客户端也要认（门禁 portal R12 的 :580）：原正则 `\btrpc[A-Za-z]*` 只匹配**以 trpc 开头**的标识符，
  // 而本仓确实存在别名客户端并同样以三段式调用 —— 实测：`voiceBuddyTrpc.voiceBuddy.chat.useMutation(…)`、
  // `syncTrpc.dshBridge.history.useQuery(…)`、`mastersTrpc.masters.dashboard.useQuery(…)`。
  // 漏掉它们 = **P1 漏调用点**（P1 是硬档，漏报比误报更危险）。改为"标识符里含 trpc/Trpc 即可"。
  const TRPC_HOOK = /\b(?:[A-Za-z_$][\w$]*)?[Tt]rpc[A-Za-z]*\s*\.\s*([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\.\s*(useQuery|useMutation|useSuspenseQuery|useInfiniteQuery|useQueries)\b/g
  // 允许过程名后跟**查询串**（门禁 portal R18 的 :689）：原来要求引号**紧贴**过程名，
  // 于是 `/api/trpc/ns.proc?batch=1` 这种标准 raw-fetch 形态被**静默跳过** ⇒ P1 漏调用点（硬档漏报）。
  const TRPC_RAW = /\bfetch\s*\(\s*['"`]([^'"`]*\/api\/trpc\/([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*))(?:\?[^'"`]*)?['"`]/g

  /** `usePolledQuery({ path: 'ns.proc' })`（门禁 wb#52 R21 的 :732；portal#44 R26 的 :814 要求与三个兄弟常量同置）。
   *  与 `HELPER`/`TRPC_HOOK`/`TRPC_RAW` 一样**在循环外声明一次**（原来在 `for (const f of srcFiles)` 里每轮重建）。
   *  它们都带 `g` 旗标、由各自的 `while` 管 `lastIndex`：`exec` 匹配失败时会自动归零，故跨文件复用安全。
   *  ⚠️ **必须跨过泛型实参**（Kimi 巡检的 `:785` high，门禁 R27 漏掉、他抓到的）：本仓 9 处调用**全是**
   *  `usePolledQuery<T>({…})` 形态（`Codespace.tsx:38` / `Training.tsx:81` 是生产调用），
   *  而原正则写死 `\s*\(\s*\{` ⇒ **一个都认不到**、我那道锚点对真实仓库等于死代码。
   *  故改成与 `HELPER` 同款的三步：跳空白 → `matchAngle` 跨（可嵌套的）泛型 → `matchParen` 取实参。 */
  const POLLED_NAME = /\busePolledQuery\b/g
  /** 抽出 `usePolledQuery[<T>]({ path: 'ns.proc', … })` 的 ns.proc —— 返回 null 表示不是这个形态。 */
  function polledPathAt(mask, from) {
    let j = from
    while (j < mask.length && /\s/.test(mask[j])) j++
    if (mask[j] === '<') {
      const ang = matchAngle(mask, j)
      if (ang) {
        j = ang[1]
        while (j < mask.length && /\s/.test(mask[j])) j++
      } else {
        // ⚠️ **真的实现"跨不过就不跳"**（门禁 portal#50 R2 的 :812-814）：我上一版只写了这句注释、
        //    代码没动 —— `j` 停在 `<`，随后 `mask[j] !== '('` 照样 return null，行为与改前一模一样（门禁对质成立）。
        //    现在：在**有限窗口**内找那个 `(`（泛型实参列表不会很长；限窗是防止外扩到下一个调用点）。
        const p = mask.indexOf('(', j)
        if (p === -1 || p - j > LOOKAHEAD_LIMIT) return null // 与 matchAngle 同族的具名上界（门禁 wb#54 R1 的 :825-826）
        j = p
      }
    }
    if (mask[j] !== '(') return null
    const span = matchParen(mask, j)
    if (!span) return null
    const pm = /\bpath\s*:\s*['"]([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)['"]/.exec(mask.slice(span[0] + 1, span[1] - 1))
    return pm ? { ns: pm[1], proc: `${pm[1]}.${pm[2]}` } : null // 不再返回 at（门禁 portal#50 R1 的 :817：唯一调用方用 m.index 算行号，at 从未被消费 = 死数据）
  }

  for (const f of srcFiles) {
    const { mask } = src(f)
    let m
    HELPER.lastIndex = 0
    while ((m = HELPER.exec(mask))) {
      let j = m.index + m[0].length
      while (j < mask.length && /\s/.test(mask[j])) j++
      if (mask[j] === '<') {
        const ang = matchAngle(mask, j)
        if (ang) {
          j = ang[1]
          while (j < mask.length && /\s/.test(mask[j])) j++
        } else {
          // `matchAngle` 失败（超长度上界 / 类型实参里有未配平的 `>`）时**不再整条调用点跳过**
          //（门禁 portal R10 的 :521）：P1 是**硬档**，漏一条的代价远大于多一条噪音，而"静默跳过"
          // 在这里就等于"这条调用点不存在"。退回到"名字之后第一个 `(`"：若那个 `(` 落在泛型内部，
          // 后面取不到 dotted 字面量、自然无命中 —— **最坏情况与跳过相同，最好情况把漏掉的捞回来**。
          const open = mask.indexOf('(', j)
          if (open === -1) continue
          j = open
        }
      }
      if (mask[j] !== '(') continue
      const span = matchParen(mask, j)
      if (!span) continue
      const args = mask.slice(span[0] + 1, span[1] - 1)
      const strs = topLevelStrings(args)
      const hit = strs.find((s) => !s.hasInterp && DOTTED.test(s.value))
      if (hit) {
        called.push({ ns: hit.value.split('.')[0], proc: hit.value, file: f, line: lineOf(mask, span[0] + 1 + hit.index), via: m[1] })
      }
    }
    TRPC_HOOK.lastIndex = 0
    while ((m = TRPC_HOOK.exec(mask))) {
      called.push({ ns: m[1], proc: `${m[1]}.${m[2]}`, file: f, line: lineOf(mask, m.index), via: `trpc.${m[3]}` })
    }
    TRPC_RAW.lastIndex = 0
    while ((m = TRPC_RAW.exec(mask))) {
      called.push({ ns: m[2], proc: `${m[2]}.${m[3]}`, file: f, line: lineOf(mask, m.index), via: 'fetch(/api/trpc/…)' })
    }
    // `usePolledQuery[<T>]({ path: 'ns.proc', … })`（门禁 wb#52 R21 的 :732；泛型形态见 `:785`）：
    // 该 hook 内部用 `wbQuery(path, …)` 转发，而转发点的 `path` 是**变量** ⇒ 工具在定义处看不到命名空间；
    // 调用点把 `'ns.proc'` 写成字面量，不认这一形态就等于整类**轮询调用**不进 P1 判定（硬档漏报）。
    // ⚠️ 用 `polledPathAt` 而不是正则：本仓调用**全是泛型形态**，正则写不出可嵌套的泛型跳过。
    POLLED_NAME.lastIndex = 0
    while ((m = POLLED_NAME.exec(mask))) {
      // 定义处（`export function usePolledQuery<T>(opts…)`）没有字面量 path ⇒ 自然不命中，无需特判。
      const p = polledPathAt(mask, m.index + m[0].length)
      if (!p) continue
      called.push({ ns: p.ns, proc: p.proc, file: f, line: lineOf(mask, m.index), via: 'usePolledQuery({ path })' })
    }
  }

  const findings = []
  const seen = new Set()
  for (const c of called) {
    if (!c.ns || mountedSet.has(c.ns)) continue
    const key = `${c.ns}|${rel(c.file)}|${c.line}`
    if (seen.has(key)) continue
    seen.add(key)
    findings.push({
      rule: 'P1',
      severity: 'hard',
      file: rel(c.file),
      line: c.line,
      symptom: `调用 tRPC 过程 ${c.proc}（形态：${c.via}），但 api/router.ts 未挂载命名空间「${c.ns}」⇒ 该调用必然失败（NO_PROCEDURE_FOUND），前端兜底一吞即静默空转`,
      evidence: `${mountedSet.size} namespaces mounted`,
    })
  }
  findings.sort((a, b) => byFileLine(a, b))
  const calledNs = new Set(called.map((c) => c.ns))
  return { findings, mounted, uncalled: mounted.filter((k) => !calledNs.has(k)), called, routerFile }
}

// ─────────────────────── P4 · 静默 404（硬档）───────────────────────

/** 抽 `const X = { k: "v" }` 映射，用于解析 `Paths.oauthCallback` 这类路由路径。 */
function constStringMaps() {
  const map = new Map()
  for (const f of [...dbFiles, ...apiFiles, ...srcFiles]) {
    const { mask } = src(f)
    const re = /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*\{/g
    let m
    while ((m = re.exec(mask))) {
      const open = mask.indexOf('{', m.index + m[0].length - 1)
      let depth = 0
      let end = open
      for (let i = open; i < mask.length; i++) {
        // 跳过字符串/模板字面量（门禁 portal R15 的 :726-731）：这些常量对象**满是字符串值**，
        // 值里只要有一个未配对的 `{`/`}`，depth 就回不到 0 ⇒ `end` 停在 open ⇒ body 为空 ⇒
        // 整个对象**一个键值都解不出来**（本仓 `Paths` 就是这种密集字面量对象）。
        if (mask[i] === "'" || mask[i] === '"' || mask[i] === '`') { i = skipQuoted(mask, i) - 1; continue }
        if (mask[i] === '{') depth++
        else if (mask[i] === '}') { depth--; if (depth === 0) { end = i; break } }
      }
      const body = mask.slice(open + 1, end)
      const kre = /([A-Za-z_$][\w$]*)\s*:\s*(['"])([^'"]*)\2/g
      let k
      while ((k = kre.exec(body))) map.set(`${m[1]}.${k[1]}`, k[3])
    }
  }
  return map
}

function routeToRe(pat) {
  // 尾部通配必须在**分段转义之后**再展开（门禁 portal#44 的 high）：
  //   若先把 `/*` 换成 `(?:/.*)?`，它会被 split('/') 切成 `reports(?:` / `.*)?` 两段
  //   并逐段转义成字面量 ⇒ 正则只能匹配那串字面量本身 ⇒ **任何"通配路由背后的前端
  //   fetch"都被误判成硬档 P4 静默 404**（硬档 = CI 退出码非 0，属确定性假阻断）。
  //   ⚠️ 本函数修对之后，`api/boot.ts` 的 404 兜底 `app.all("/api/*")` 会匹配一切 ——
  //   它必须继续被 detectP4 里那条「404 兜底 catch-all 不算挂载」的过滤挡在路由表外，
  //   否则 P4 会从「6 条真命中」变成「0 条」= 整条规则静默失效。
  const trailingWild = pat.endsWith('/*')
  const p = trailingWild ? pat.slice(0, -2) : pat
  // 分段 → 正则片段。**不用嵌套三元**（仓规禁止；门禁 portal R8 的 :575 指出本文件别处
  // 已在改掉嵌套三元、这里还是）—— 而且显式分支正好把"哪一段按什么规则展开"写明白：
  const segRe = (seg) => {
    if (seg === '*') return '.*' // 中段通配
    if (seg.startsWith(':')) return '[^/]+' // 路径参数
    return reEsc(seg) // 字面量段：转义 —— 复用模块级 `reEsc`（门禁 portal R25 的 :872：原来把同一个字符类又抄了一遍，改一处会漏另一处）
  }
  const esc = p
    .split('/')
    .map(segRe)
    .join('/')
  return new RegExp(`^${esc}${trailingWild ? '(?:/.*)?$' : '$'}`)
}

function detectP4(constMaps) {
  /**
   * 路由是否接受该调用方法（门禁 portal R10 的 :674）。
   * 原来 P4 **只按路径匹配**，`routes` 里记的 `method` 从未被消费 ⇒ 只注册了 `POST` 的路径，
   * 前端一个默认 GET 的 `fetch()` 也会被判"已挂载" ⇒ **漏报**（P4 少一条真命中）。
   * `all`/`use` 视为接受一切；调用方法**判不出来**（`null`）时按"接受"处理 —— 宁可漏报也不制造假阳性。
   */
  const routeAccepts = (routeMethod, callMethod) =>
    !callMethod || routeMethod === 'all' || routeMethod === 'use' || routeMethod === callMethod

  const front = []
  for (const f of srcFiles) {
    const { mask } = src(f)
    const re = /\b(fetch|EventSource)\s*\(\s*(['"`])([^'"`]*)\2/g
    let m
    while ((m = re.exec(mask))) {
      const raw = m[3]
      if (!raw.startsWith('/api/')) continue
      const p = raw.split('?')[0].split('#')[0]
      if (p.startsWith('/api/trpc/')) continue // tRPC 面归 P1
      // 动态判定只看**路径部分**：`/api/personal-uploads?token=${…}` 的路径是静态的，
      // 只有 query 带插值——整串含 ${ 就跳过，会把这类真 404 漏掉。
      // 方法（门禁 portal R10 的 :674）：`fetch(url)` 不带 init 就是 **GET**；显式 `{ method: 'X' }` 取那个值；
      // 第二实参是变量/表达式时**静态判不了** ⇒ 记 `null`（按"任意方法"匹配，保持既有行为、不制造假阳性）。
      let method = 'get' // EventSource 恒 GET；fetch 无第二实参也是 GET
      const after = mask.slice(m.index + m[0].length)
      if (m[1] === 'fetch') {
        if (/^\s*,/.test(after)) {
          const rest = after.replace(/^\s*,\s*/, '')
          if (!rest.startsWith('{')) method = null // 第二实参不是对象字面量（变量/表达式）⇒ 判不了
          else {
            // ⚠️ init 对象必须用**花括号配对**取全（门禁 portal R12 的 high）：
            //    原来用惰性 `[\s\S]{0,200}?}`，在**第一个 `}`** 就截断 ——
            //    `fetch('/api/x', { headers: { … }, method: 'POST' })`（headers 在前）里那个 `}`
            //    是 headers 的内层闭合 ⇒ 看不到 method ⇒ 落到默认 `'get'` ⇒ 若该路径只注册了 POST，
            //    `routeAccepts('post','get')` 为 false ⇒ **P4 误报硬档命中（确定性假阻断）**。
            const objText = sliceBraces(rest, 0)
            const top = objText ? topLevelMethodKind(objText) : null
            if (top === null) method = 'get' // 没有**顶层** method ⇒ 默认 GET
            else if (top === 'unknown') method = null // method 不是字符串字面量（简写/变量）⇒ 判不了
            else method = top
          }
        }
      }
      // **字符串拼接也算动态**（门禁 portal R15 的 :809 high）：`fetch('/api/agents/' + id)` 的正则同样只
      // 捕获到字面量前缀 `/api/agents/`，若把它当**完整路径**，路由 `/api/agents/:id` 的 `^/api/agents/[^/]+$`
      // 就匹配不上 ⇒ **P4 硬档假阳性（CI 退出码 1，确定性假阻断）**。`.concat(` / `.replace(` 同理。
      const concat = /^\s*\+/.test(after) || /^\s*\.\s*(?:concat|replace|trim|slice)\s*\(/.test(after)
      front.push({ full: p, raw, file: f, line: lineOf(mask, m.index), dynamic: p.includes('${') || concat, via: m[1], method })
    }
  }

  const routes = []
  const unresolved = []
  // 接收者白名单只是**粗筛**（挡掉 `map.get(…)` 这类噪声）。但只认白名单会漏掉**换了名字的实例**
  //（门禁 portal R14 的 :815）：`subApp.post('/api/y', …)` 完全合法却进不了路由表 ⇒ 前端 fetch 到它
  // 会被判"无对应路由" ⇒ **P4 假阳性**。故对非白名单接收者追加一条更可靠的判据（见下面的 `pathish` + 双实参）。
  const RECEIVER_OK = /^(app|router|api|r|server|hono)$/
  /** 非白名单接收者的**形状判据**：名字以 app/router/server/hono 结尾（`subApp` / `apiServer` / `mainRouter`）。
   *  只在"首参不是 `/…` 字面量"这条兜底路径上用 —— 没有它，`Promise.all(…)` 这类会被当成路由注册。 */
  const RECEIVER_LIKE = /(?:app|router|server|hono)$/i
  for (const f of apiFiles) {
    const { mask } = src(f)
    const re = /\b([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|delete|all|use|options|patch)\s*\(/g
    let m
    while ((m = re.exec(mask))) {
      const open = mask.indexOf('(', m.index + m[0].length - 1)
      const span = matchParen(mask, open)
      if (!span) continue
      const args = mask.slice(span[0] + 1, span[1] - 1)
      const first = topLevelStrings(args).find((s) => args.slice(0, s.index).trim() === '')
      const line = lineOf(mask, span[0])
      // 粗筛：接收者不在白名单时，要求**同时**满足「首参是 `/…` 字面量」+「至少两个实参（路径 + handler）」
      // —— 路由注册总是带 handler。只放宽到"首参是 /…"会把 `map.get('/api/x')` 也当成挂载路由
      //（我第一版就是这么写的，探针当场抓到：那样会**掩盖**真 404，方向相反但同样是硬档错结论）。
      if (!RECEIVER_OK.test(m[1])) {
        const pathish = first && first.value.startsWith('/')
        const twoArgs = splitTopCommas(args).length >= 2
        if (!pathish || !twoArgs) {
          // ⚠️ 但"首参不是字面量"**不等于**"不是路由"（门禁 wb#52 R18 的 :925）：`subApp.get(routeVar, h)` /
          //    `subApp.get(Paths.someRoute, h)` 正是这种形态 —— 我上一版在这里直接 `continue`，等于把
          //    **换名字实例 + 动态路径**的路由整条丢掉 ⇒ 前端 fetch 到它会误报 404（硬档假阳性）。
          //    故：看起来像路由注册（双实参、方法是路由方法、且**首参形如路径**）就记进 unresolved，由守卫响铃。
          //    ⚠️ "形如路径"这一条不能省：`Promise.all([a, b, c])` 也能被上面那个宽松正则匹到
          //    （接收者 `Promise`、方法 `all`），我第一版就是这么误伤的 —— 探针当场打回退出码 2。
          const firstArg = (splitTopCommas(args)[0] ?? '').trim()
          // 两道收窄缺一不可（我连着两版都误伤了真代码，探针每次都立刻打回退出码 2）：
          //   ① 首参**形如路径**（标识符/点分常量/调用/字符串），排除 `[`/`{`/`(` 开头；
          //   ② 接收者名**形如 app/router/server/hono** —— 否则 `Promise.all(PROVIDERS.map(…), …)`
          //      这类"接收者 Promise + 方法 all + 首参是调用表达式"会被当成路由注册。
          const pathLike = /^(?:[A-Za-z_$][\w$]*(\s*\.\s*[A-Za-z_$][\w$]*)*\s*(?:\(|,|$)|`|['"])/.test(firstArg)
          if (twoArgs && m[2] !== 'use' && pathLike && RECEIVER_LIKE.test(m[1])) {
            unresolved.push({ file: rel(f), line, expr: firstArg.slice(0, 40) })
          }
          continue
        }
      }
      let pat = null
      if (first) {
        // ⚠️ **带插值的模板路径**（`` app.get(`/api/${x}`) ``）静态判不出来（门禁 portal R18 的 :884-885）：
        // 把它当字面量只会得到 `/api/` 这种前缀 ⇒ 匹配不上真路径 ⇒ **P4 硬档假阳性**（而且它会**绕过**
        // 下面那道 unresolved 守卫，因为 `first` 是存在的）。故记进 unresolved，由守卫响铃。
        if (first.kind === 'tpl' && first.raw.includes('${')) {
          unresolved.push({ file: rel(f), line, expr: `模板路径 ${first.raw.slice(0, 32)}` })
          continue
        }
        // ⚠️ **字符串拼接的路径**（门禁 wb#52 R20 的 :956-960）：`app.get('/api/' + x, h)` 只取到字面量前缀
        // `/api/`，若当完整路径就会注册成一条**假路由** `/api/`；而且它**绕过**守卫（`first` 存在）。
        // 前端侧（`fetch('/api/x' + id)`）我早已按动态处理 —— **两侧口径必须对称**，否则就是"一边堵一边漏"。
        const afterLit = args.slice(first.index + first.raw.length)
        if (/^\s*\+/.test(afterLit) || /^\s*\.\s*(?:concat|replace)\s*\(/.test(afterLit)) {
          unresolved.push({ file: rel(f), line, expr: `拼接路径 ${first.raw.slice(0, 30)}` })
          continue
        }
        pat = first.value
      }
      // `app.use(fn)` 是**中间件**、不是路由路径 —— 首参非字面量属常态，静默跳过不算缺口。
      //（我第一版没区分，于是 `app.use(bodyLimit({…}))` 也被记成"解析不出的路由路径"⇒ 守卫误响。）
      else if (m[2] === 'use') continue
      else {
        // ⚠️ 守卫必须覆盖**所有**解析不出的形态（门禁 portal R13 的 :775-776）：原来只记 `X.Y` 点分常量，
        //   而 `app.get(routePath, handler)`（裸标识符）与 `app.get(buildPath(), handler)`（函数调用）
        //   既不匹配 `idm` 也不进 unresolved ⇒ **静默跳过** ⇒ 前端 fetch 到它会误报 404。
        //   （接收者白名单在上一行已把 `map.get(...)` 这类噪声挡掉，所以这里可以放心记。）
        const idm = /^\s*([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)/.exec(args)
        const resolved = idm ? constMaps.get(`${idm[1]}.${idm[2]}`) : undefined
        if (typeof resolved === 'string') pat = resolved
        else unresolved.push({ file: rel(f), line, expr: idm ? `${idm[1]}.${idm[2]}` : (splitTopCommas(args)[0] ?? '').trim().slice(0, 40) || '(空实参)' })
      }
      if (!pat || !pat.startsWith('/')) continue
      const head = args.slice(0, 400)
      if (pat.includes('*') && /404|Not\s*Found/i.test(head)) continue // 404 兜底 catch-all 不算挂载
      routes.push({ pat, file: rel(f), line, method: m[2] })
    }
  }

  // 无法静态解析的路由路径（门禁 R10 的 :696-700）：这些路由**不会进 matchers** ⇒
  // 前端 fetch 到它们会被判"无对应路由" ⇒ **硬档假阳性**。静默跳过等于让 P4 在不知情时撒谎。
  // 本仓当前为 **0 处**（唯一一处 `app.get(Paths.oauthCallback, …)` 能被 `constStringMaps` 解析 ——
  // `contracts/` 也在它的扫描面内），故加这道守卫**不花钱**；一旦将来有人写成解析不出的形式就会响铃。
  if (unresolved.length) {
    fail(
      `有 ${unresolved.length} 处路由路径无法静态解析`,
      `例：${unresolved[0].file}:${unresolved[0].line}（${unresolved[0].expr}）；` +
        `它们不进路由表 ⇒ 前端调用会被误报"无对应路由"（硬档 P4）。把路径写成字面量、或补进常量表`,
    )
  }

  const matchers = routes.map((r) => ({ ...r, re: routeToRe(r.pat) }))

  // ── P4 的**结构性自检**（门禁 portal 的 `:596` 与 `:642` 两次提这条）────────────────────
  // 上面那句「404 兜底 catch-all 不算挂载」是**文本启发式**（在实参前 400 字符里找 `404` / `Not Found`）。
  // 它一旦因**改写 / 搬移 / 拆分 handler** 而没命中，兜底路由就会被算成"已挂载"：
  //   `app.all("/api/*")` ⇒ `^/api(?:/.*)?$` ⇒ 匹配**一切** `/api/...` ⇒ **P4 从 6 条静默变成 0 条**。
  // 那正是判据最怕的"整条规则失效"。所以：与其在这种情况下给出一个"P4 干净"的结论，不如**响铃** ——
  // 路由表里只要还留着一条「前缀为 `/api` 或空 + 以 `/*` 结尾」的兜底式通配，就退出码 2。
  const catchAll = matchers.find((mt) => mt.pat.endsWith('/*') && ['', '/api'].includes(mt.pat.slice(0, -2)))
  if (catchAll) {
    fail(
      'P4 无法给出可信结论：路由表里存在兜底式通配',
      `${catchAll.file}:${catchAll.line} 注册了 \`${catchAll.pat}\`（${catchAll.method}）—— 它能匹配一切 /api/... ⇒ ` +
        `前端任何路径都会被判"已挂载"，P4 会静默归零。若它确实是 404 兜底，请让上面那条识别条件命中它`,
    )
  }
  const findings = []
  const dynamic = []
  const seen = new Set()
  for (const c of front) {
    if (c.dynamic) { dynamic.push(c); continue }
    const key = `${c.full}|${rel(c.file)}|${c.line}`
    if (seen.has(key)) continue
    seen.add(key)
    if (matchers.some((mt) => mt.re.test(c.full) && routeAccepts(mt.method, c.method))) continue
    findings.push({
      rule: 'P4',
      severity: 'hard',
      file: rel(c.file),
      line: c.line,
      symptom: `${c.via}('${c.full}') 在 api/ 全树无对应 raw 路由 ⇒ 该请求必然 404（通常被 .catch 吞掉，界面静默降级）`,
      evidence: `${routes.length} raw routes registered`,
    })
  }
  findings.sort((a, b) => byFileLine(a, b))
  return { findings, routes, dynamic }
}

// ──────────────────── SQL 抽取（P2 / P3 共用）────────────────────

/**
 * 把模板串里的 ${...} 插值替换成 `?`（**花括号配对感知**）。
 * 必须配对感知：本仓 SQL 模板里嵌着 ${`a=${x}; b=${y}`} 这种嵌套模板，
 * 用 /\$\{[^}]*\}/ 会在第一个 } 处截断，剩下的 `; b=${y}` 被当成语句分隔——
 * 真出过一次：INSERT … SELECT … FROM DUAL 被从中间切开，表名误判成 dual。
 */
function stripInterp(s) {
  let out = ''
  let i = 0
  while (i < s.length) {
    if (s[i] === '$' && s[i + 1] === '{') {
      const start = i
      let depth = 1
      i += 2
      while (i < s.length && depth > 0) {
        if (s[i] === '{') depth++
        else if (s[i] === '}') depth--
        i++
      }
      out += '?'
      // 插值内部的换行必须**原样带出**（门禁 portal R5 的 :636-646）：`sqlStatements` 靠处理后
      // body 里的换行数推算语句行号，吞掉换行会让此后所有 P3 命中的行号偏小、指向错误位置
      //（判据明确要求"输出要带 file:line，否则修的人要重新找一遍"）。
      for (let k = start; k < i; k++) if (s[k] === '\n') out += '\n'
      continue
    }
    out += s[i]
    i++
  }
  return out
}

/** 抽「像 SQL」的字面量并切成语句 → [{sql, file, line}]。 */
function sqlStatements(files) {
  const out = []
  for (const f of files) {
    const { mask } = src(f)
    for (const lit of literals(mask)) {
      if (!/\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(lit.value)) continue
      if (!/\b(FROM|INTO|SET|JOIN)\b/i.test(lit.value)) continue
      const body = lit.kind === 'tpl' ? stripInterp(lit.value) : lit.value
      const litLine = lineOf(mask, lit.index)
      for (const { text: part, at } of splitStatements(body)) {
        if (!/\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(part)) continue
        const nl = (body.slice(0, Math.max(0, at)).match(/\n/g) || []).length
        out.push({ sql: part, file: f, line: litLine + nl })
      }
    }
  }
  return out
}

const TRACKED = 'status|state|audience|kind|type'
const TRACKED_SET = new Set(TRACKED.split('|'))
/** 不是表的词：SQL 自己的关键字（FROM DUAL 是 MySQL 的哑表，曾误判成一张真表）。 */
const NOT_A_TABLE = new Set(['dual', 'select', 'values', 'set', 'where', 'as', 'on', 'using', 'information_schema'])

/** 一条 SQL 语句 → 表 / 列 / 值，分读写侧。
 *  表归属优先级：① 列的限定符（`l.type` 的 l）② 最近的前导表名。
 *  限定符必须解析：本仓大量 JOIN 查询写作 `FROM wb_listings l JOIN wb_factories f
 *  WHERE l.type='agent'`——只按「最近前导表名」会把 l.type 记到 wb_factories 头上（实测假阳性）。 */
function parseSqlValues(stmt, symToTable) {
  const sql = stmt.sql.replace(/`/g, '')
  const res = { writes: [], reads: [], paramCols: new Set() }
  const tokens = []
  const alias = new Map() // 别名/表名/符号 → 真表名
  // `UPDATE` 前面若是 `KEY `（即 `ON DUPLICATE KEY UPDATE <col>`），那是**列名**不是表名 ——
  // 本仓约 40 条语句这么写，原来会把 `status`/`org_role` 这类列当成一张表收进 tokens，
  // 于是 qualifierAt 把该列上的写**记到那张假表头上**（门禁 portal R6 的 :690）。
  // 别名组**不能吃掉 SQL 关键字**（门禁 wb#52 R8 的 :725）：`FROM a JOIN b ON …` 里，
  // `(?:\s+(?:AS\s+)?([A-Za-z_][\w]*))?` 会把 `JOIN` 当别名吞掉 ⇒ 下一次 exec 从它之后开始，
  // `b` **永远成不了 token**（表归属直接丢一张表）。用负向前瞻把这些关键字挡在别名位之外。
  const SQL_KW = 'JOIN|WHERE|ON|SET|GROUP|ORDER|HAVING|LIMIT|UNION|LEFT|RIGHT|INNER|OUTER|CROSS|USING|VALUES|SELECT|AND|OR|AS'
  const tre = new RegExp(
    `\\b(?:FROM|INTO|UPDATE|JOIN)\\s+([A-Za-z_][\\w]*)(?:\\s+(?:AS\\s+)?((?!(?:${SQL_KW})\\b)[A-Za-z_][\\w]*))?`,
    'gi',
  )
  const NOT_ALIAS = new Set(['where', 'on', 'set', 'join', 'left', 'right', 'inner', 'outer', 'cross', 'group', 'order', 'having', 'limit', 'union', 'select', 'and', 'or', 'using', 'as', 'values', 'duplicate'])
  let t
  while ((t = tre.exec(sql))) {
    // `ON DUPLICATE KEY UPDATE <col>` 里的 `UPDATE` 是**列名不是表名**。⚠️ 不能靠定宽负向后顾
    // `(?<!KEY\s)` —— 它只挡得住**恰好一个**空白，SQL 折行成 `ON DUPLICATE KEY\n  UPDATE …` 时就会漏
    //（门禁 portal R9 的 :748；这正是 R4 那条 `:1114` 修复留下的洞）。改成**看前文**：
    // 关键字前若以 `KEY` + 任意空白结尾，就跳过这一处。
    if (/^UPDATE/i.test(t[0]) && /KEY\s*$/i.test(sql.slice(0, t.index))) continue
    const name = t[1].toLowerCase()
    if (NOT_A_TABLE.has(name)) continue
    tokens.push({ at: t.index, table: name })
    alias.set(name, name)
    if (t[2] && !NOT_ALIAS.has(t[2].toLowerCase())) alias.set(t[2].toLowerCase(), name)
  }
  if (!tokens.length) return res
  // `res.table` 是死赋值（门禁 portal R7/R8/R9 三次提；调用方只解构 `{ writes, reads }`）—— 去掉，
  // 免得读者以为"首个表"这个信息在别处被消费。
  for (const [sym, tbl] of symToTable) alias.set(sym.toLowerCase(), tbl) // drizzle 符号限定符

  const qualifierAt = (idx) => {
    const back = sql.slice(0, idx)
    const qm = /([A-Za-z_][\w]*)\s*\.\s*$/.exec(back)
    if (qm && alias.has(qm[1].toLowerCase())) return alias.get(qm[1].toLowerCase())
    let cur = tokens[0].table
    for (const tk of tokens) { if (tk.at <= idx) cur = tk.table; else break }
    return cur
  }

  const isUpdate = /^\s*UPDATE\b/i.test(sql)
  const isInsert = /^\s*INSERT\b/i.test(sql)
  const whereIdx = isUpdate ? sql.search(/\bWHERE\b/i) : -1
  // `INSERT … SELECT …` 的**读写边界**（门禁 portal R20 的 :1151）：内层 `SELECT` 之后的字面量是
  // **源查询的过滤条件**（读方），不是写入值；但 `ON DUPLICATE KEY UPDATE` 之后的又回到**写**方。
  // 我早前按"内层 FROM 划界"试过一版，实测 P3 从 25 跳到 48 且漏了 dup-key 那半边，故当时没推；
  // 这次把 dup-key 一并算进去（见下面的 `inSource`）。
  const selIdx = isInsert ? sql.search(/\bSELECT\b/i) : -1
  const dupIdx = isInsert ? sql.search(/ON\s+DUPLICATE\s+KEY\s+UPDATE/i) : -1

  // ⚠️ 结构扫描跑在**抹掉字面量**的副本上（门禁 wb#52 R15 的 :1070）：否则 `WHERE note = 'status'` 里的
  //    `'status'` 会被当成**列名**收进 reads/writes（凭空多出读写方）。等长替换 ⇒ 下标与 `sql` 一致，
  //    所以下面的取值仍从**原文** `sql` 切，不会被抹掉。
  const scan = blankStrings(sql)
  const wordRe = new RegExp(`\\b(${TRACKED})\\b\\s*(=|IN\\b|LIKE\\b)?`, 'gi')
  let m
  while ((m = wordRe.exec(scan))) {
    const col = m[1].toLowerCase()
    const op = (m[2] || '').toUpperCase()
    if (op === 'LIKE') continue // LIKE 的右侧是模式串（'%\_miss'），不是枚举值
    const after = sql.slice(m.index + m[0].length)
    const vals = []
    if (op === 'IN') {
      const pm = /^\s*\(([^)]*)\)/.exec(after)
      if (pm) for (const v of pm[1].matchAll(/'([^']*)'/g)) vals.push(v[1])
    } else {
      const sm = /^\s*'([^']*)'/.exec(after)
      if (sm) vals.push(sm[1])
    }
    // 嵌套三元违仓规（门禁 portal R6 的 :733）：改成显式分支，顺带把"为什么"写清楚
    // ⚠️ 门禁 portal R7 的 :746 与 R20 的 :1151 两次指出：`INSERT … SELECT …` 里**源查询**的字面量
    // （`… FROM b WHERE status='x'`）也被告成 write，凭空给写侧添值。
    // 我早前按"内层 FROM 划界"试过一版：**实测 P3 25→48（+22/-0）**，且漏了 dup-key 那半边 ⇒ 当时未推。
    // 这次把 `ON DUPLICATE KEY UPDATE` 一并算进去（那条之后仍是**真写**）。
    let side
    if (isInsert) {
      const inSource = selIdx !== -1 && m.index > selIdx && !(dupIdx !== -1 && m.index > dupIdx)
      side = inSource ? 'read' : 'write'
    } else if (!isUpdate) side = 'read'
    else side = whereIdx === -1 || m.index < whereIdx ? 'write' : 'read'
    if (!vals.length) {
      // ⚠️ 值**不是字面量**（`= ?` / `= ${x}` / 子查询）⇒ 静态判不出写了什么值。
      //    必须与 INSERT 位置对齐分支**同口径**记进 `paramCols`（门禁 wb#52 R21 的 :1181：
      //    我上一版只在那一条路径上记了 ⇒ P3 仍会对这里写过的列断言"全仓无写方写入该值"——
      //    又是"半途而归一"，因此这道豁免没有生效在同一条判据的另一半输入上）。
      //    ⚠️ **只在写侧记**：这条路径同时覆盖读，`WHERE status = ${x}` 是**参数化读**，
      //      把它也算成"参数化写方"会让标注泛滥（我实测过：11 → 31/32，标注就没意义了）。
      //    ⚠️ **还必须是带算子的形态**（门禁 portal R24 的 :1206-1209）：`$1` 之外，正则的算子组
      //      `(=|IN|LIKE)` 是**可选**的 ⇒ **裸列名**（`INSERT INTO t (status, …)` 的列名清单、
      //      `ORDER BY status`）也会走到这里。裸列名不存在"值写不写得出来"这回事，不该进豁免表。
      if (side === 'write' && op) {
        const qt = qualifierAt(m.index)
        if (qt) res.paramCols.add(`${qt}.${col}`)
      }
      continue
    }
    const ref = { file: stmt.file, line: stmt.line, table: qualifierAt(m.index), col, values: vals, sql: sql.trim().slice(0, 160) }
    if (side === 'write') res.writes.push(ref)
    else res.reads.push(ref)
  }

  // 跨行 INSERT 位置对齐：INSERT [IGNORE] INTO t (a,b,c) VALUES ('x','y','z')；`REPLACE INTO` 同形
  //（门禁 R4 的 :1114：本仓生产在用 INSERT IGNORE，漏认会让 P3 的写侧归属也一起变窄）
  // ⚠️ 值列表用 `([^)]*)` 会被**列表内部的第一个 `)`** 截断（门禁 portal R12 的 :955-956）：
  //    `NOW()` / `CAST(? AS JSON)` / `DATE_ADD(NOW(), INTERVAL 30 DAY)` 都会让值列表提前结束 ⇒
  //    位置对齐再次错位 —— 我刚修的 R9 high（按 token 取第 i 个值）会因此复发。
  //    故改成：正则只定位到 `VALUES (`，**值列表本体用括号配对取全**（`matchParen` 会跳引号与嵌套）。
  const im = /(?:INSERT\s+(?:IGNORE\s+)?|REPLACE\s+)INTO\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)\s*VALUES\s*\(/is.exec(sql)
  if (im && !NOT_A_TABLE.has(im[1].toLowerCase())) {
    const cols = im[2].split(',').map((s) => s.trim().replace(/[`"']/g, '').toLowerCase())
    // ⚠️ 位置对齐必须取**值列表里第 i 个 token**（门禁 wb#52 R9 的 high）：原实现把 `vals` 建成
    // "所有引号字面量"的数组再按**列位置**索引 —— 只要前面有一列不是字面量（`?` / `NOW()` / 数字 /
    // 表达式），后面所有值就**整体错位**：真实写入的值被记到别的列上 ⇒ P3 假阳性与漏报同时发生。
    const valsOpen0 = im.index + im[0].length - 1
    // ⚠️ **多行 INSERT 要遍历全部元组**（门禁 portal#44 R24 的 :1267-1269，bug·med）：原来只 `matchParen` 一次、
    //    只消费**首个** `VALUES` 元组 ⇒ `VALUES ('a'),('b')` 的**第二元组起被整段丢掉**，那些值没有任何归属
    //    ⇒ 后续 `WHERE status='b'` 被报 P3 **幽灵值（假阳性）** —— 恰恰是本块要防的失效模式。
    //    仓内真实例：`db/sync-m55.mts:51`。
    // ⚠️ **null ⇒ 保留一个空元组**（门禁 wb#54 R1 的 :1336-1337，bug·low，**我引入的回归**）：
    //    改前 `valToks` 在 matchParen 失败时回落成 `[]`，**每列循环照样跑** ⇒ 每个 tracked 列都落进
    //    `!lit` 分支、被记进 `paramCols`（"该列有参数化写方"）。我改成元组循环后，tuples 为空 ⇒ 循环
    //    **一次都不跑** ⇒ 这些列不再被标记 ⇒ P3 会重新对它们断言"全仓无写方写入该值" = **假阳性回归**。
    //    故：解析不出值时补一个空元组，把旧行为原样保住。
    const tuples = ['']
    let vs = matchParen(sql, valsOpen0)
    if (vs) tuples.length = 0
    while (vs) {
      tuples.push(sql.slice(vs[0] + 1, vs[1] - 1))
      const nxt = /^\s*,\s*\(/.exec(sql.slice(vs[1])) // 紧随 `)` 的 `, (`
      if (!nxt) break
      vs = matchParen(sql, vs[1] + nxt[0].length - 1)
    }
    for (const tuple of tuples) {
      const valToks = splitTopCommas(tuple)
      for (let i = 0; i < cols.length; i++) {
        if (!TRACKED_SET.has(cols[i])) continue
        // 只认"整段就是一个单引号字面量"的 token；`?`/函数/拼接一律不猜（宁可漏报不编值）
        const lit = /^\s*'((?:[^\\']|\\.)*)'\s*$/.exec(valToks[i] ?? '')
        if (!lit) {
          // ⚠️ **参数化写方**：`VALUES (${x})` / `?` 这种"写了但静态看不出写了什么"的列，
          //    记进 `paramCols` ⇒ P3 不能对它断言"全仓无写方写入该值"（那是假阳性）。
          //    实测来源：`reportBus.ts:69` 读 `st_report_events.audience='factory'`，而该列唯一的 INSERT
          //    写的是 `${e.audience}`（参数），调用方 `appSync.ts:248` 等**确实**传 `"factory"` ⇒ 行是真的存在。
          res.paramCols.add(`${im[1].toLowerCase()}.${cols[i]}`)
          continue
        }
        res.writes.push({ file: stmt.file, line: stmt.line, table: im[1].toLowerCase(), col: cols[i], values: [lit[1]], sql: sql.trim().slice(0, 160), via: 'INSERT 位置对齐' })
      }
    } // ← 多行 INSERT：元组循环收口（门禁 portal#44 R24 的 :1267-1269）
  }
  return res
}

/** 查询构造器（drizzle）里的读写字面量——无表归属，只作全局兜底。 */
function ormValues(files) {
  const writes = []
  const reads = []
  for (const f of files) {
    const { mask } = src(f)
    let m
    // ⚠️ 写侧改成**括号配对 + 逐行找 `col: 'val'`**（门禁 portal R19 的 :1179）：原来的
    // `\.(?:set|values)\s*\(\s*\{[^}]*?…` 有两种真实形态**静默漏掉** ——
    //   ① 数组形态 `.values([ { … } ])`（前导 `[` 不满足 `\{`）；
    //   ② tracked 键之前有嵌套对象（`.set({ opts: { … }, status: 'x' })`，`[^}]*?` 在第一个 `}` 就停）。
    // 漏掉的写会让 `ormColVals` 豁免表不完整 ⇒ 一条**活的写路径**被报成"幽灵值"（假阳性）。
    // 换句话说：这里漏认，错在我这边。
    // ⚠️ 接收者形状要收（门禁 portal R23 的 :1263）：`/\.(?:set|values)\s*\(/` 也会匹到
    // `map.set(k, { status: 'active' })` / `cache.set('k', …)` 这类**非 drizzle**调用 ⇒ 凭空多出 ORM 写。
    // drizzle 的两种形态是 `.set({…})`（**实参就是对象字面量**）与 `.values([{…}])` / `.values({…})`，
    // 故按"左括号后紧跟 `{` 或 `[`"收窄 —— 这既不漏那两种真形态（R19 的 :1179 修的就是它们），也不再误吞 `map.set(k, …)`。
    const w0 = /\.(?:set|values)\s*\(\s*(?=[{[])/gis
    while ((m = w0.exec(mask))) {
      // ⚠️ 左括号位置必须**从匹配串自身**取（门禁 portal R24 的 :1267-1269）：这个正则以 `\(\s*` 结尾，
      //    会把 `(` 之后的空白也吃进匹配 ⇒ 原来从"匹配串末尾"起 `indexOf('(')` 会**越过**真正的左括号
      //    （`.set( { … }`、`.values( [ … ])` 这种带空格的写法首当其冲，`open` 落到 `{` 上 ⇒ matchParen 数错）。
      //    这是我上一版收窄接收者形状时引入的回归。另两处 `indexOf('(', m.index + m[0].length - 1)`
      //    的正则以 `\(` 结尾（无尾随空白），不受影响，故不动。
      const open = m.index + m[0].lastIndexOf('(')
      const span = matchParen(mask, open)
      if (!span) continue
      const body = mask.slice(span[0] + 1, span[1] - 1)
      const kvs = new RegExp(`\\b(${TRACKED})\\b\\s*:\\s*'([^']*)'`, 'g')
      let k
      while ((k = kvs.exec(body))) {
        writes.push({ file: f, line: lineOf(mask, span[0]), col: k[1].toLowerCase(), values: [k[2]], via: 'drizzle .set/.values' })
      }
    }
    const r1 = new RegExp(`\\beq\\s*\\(\\s*[A-Za-z_$][\\w$]*\\s*\\.\\s*(${TRACKED})\\b\\s*,\\s*'([^']*)'`, 'gis')
    while ((m = r1.exec(mask))) reads.push({ file: f, line: lineOf(mask, m.index), col: m[1].toLowerCase(), values: [m[2]], via: 'drizzle eq()' })
  }
  return { writes, reads }
}

/**
 * 遍历 `dbFiles` 里所有 `CREATE TABLE … ( … )`，产出 `{ table, body }`。
 * **两个 DDL 解析器共用这一处**（门禁 portal R17 的 :1202-1203 与 wb#52 R15 的 :1203 指出重复），
 * 且**必须跳过字符串字面量**（同轮 :1156-1159）：DDL 正文里到处是 `'…'`（COMMENT、DEFAULT、ENUM 取值），
 * 里面若有未配对的 `(`/`)`，深度记账就会错位 ⇒ body 截错位置 ⇒ 整个表的域/默认值全丢。
 * —— 这与我这几轮修的那批"扫描不跳字面量"是同一根因，当时漏了这两处。
 */
function* createTableBodies() {
  for (const f of dbFiles) {
    const { mask } = src(f)
    const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?([A-Za-z_][\w]*)[`"']?\s*\(/gi
    let m
    while ((m = re.exec(mask))) {
      const table = m[1].toLowerCase()
      const open = mask.indexOf('(', m.index + m[0].length - 1)
      let depth = 0
      let end = open
      for (let i = open; i < mask.length; i++) {
        const c = mask[i]
        if (c === "'" || c === '"' || c === '`') { i = skipQuoted(mask, i) - 1; continue }
        if (c === '(') depth++
        else if (c === ')') { depth--; if (depth === 0) { end = i; break } }
      }
      yield { table, body: mask.slice(open + 1, end) }
    }
  }
}

/**
 * 逐列定义迭代：**列名 + 该行原文**。`ddlDomains()` 找 `COMMENT`、`ddlDefaults()` 找 `DEFAULT`，
 * 两者共用这一处锚定（门禁 portal R19 的 :1257-1259 指出重复）——
 * 这两处**历史上就因为各写各的而分叉过**（ENUM 逗号那次只修了一处），所以按"一个迭代器、两个消费者"收口。
 */
function* columnDefs(body) {
  for (const line of body.split('\n')) {
    const cm = /^\s*[`"']?([A-Za-z_][\w]*)[`"']?\s+/.exec(line)
    if (!cm) continue
    yield { col: cm[1].toLowerCase(), line }
  }
}

/** DDL 列的 COMMENT → 权威合法域。 */
function ddlDomains() {
  const map = new Map()
  for (const { table, body } of createTableBodies()) {
    for (const { col, line } of columnDefs(body)) {
      const dm = /COMMENT\s+'([^']*)'/i.exec(line)
      if (!dm) continue
      const vals = new Set()
      for (const tok of dm[1].matchAll(/[A-Za-z_][\w]*/g)) {
        const v = tok[0].toLowerCase()
        if (v.length >= 2 && v !== 'null' && v !== 'default') vals.add(v)
      }
      if (!vals.size) continue
      const k = `${table}.${col}`
      const prev = map.get(k) || new Set()
      for (const v of vals) prev.add(v)
      map.set(k, prev)
    }
  }
  return map
}

/**
 * DDL 里各列的 **DEFAULT 值**（`Map<"table.col", Set<小写值>>`）。
 * 为什么必须有这一张表：`status VARCHAR(20) NOT NULL DEFAULT 'open'` 意味着「不写该列」的行天然就是 `'open'`
 * ⇒ 读 `WHERE status='open'` 是**活的**，不是幽灵值。这与 `COMMENT` 域**语义不同**：
 * 域只是声明"合法取值有哪些"，不保证真有人写；而 DEFAULT 是**本表的确定性来源**，因此进豁免。
 * （我按 R14 的 `:1147-1148` 去掉"跨表同名"豁免后，实测立刻出现 21 条新增，抽验第一条
 *  `st_auto_signals.status='open'` 就撞上 `DEFAULT 'open'` —— 说明这一半不补上，那个"修复"会变成假阳性制造机。）
 */
function ddlDefaults() {
  const map = new Map()
  for (const { table, body } of createTableBodies()) {
    // 列定义的锚定与 `ddlDomains()` **共用** `columnDefs()`（两处历史分叉过一次，见该函数的说明）。
    for (const { col, line } of columnDefs(body)) {
      const dm = /\bDEFAULT\s+'([^']*)'/i.exec(line)
      if (!dm) continue
      const k = `${table}.${col}`
      if (!map.has(k)) map.set(k, new Set())
      map.get(k).add(dm[1].toLowerCase())
    }
  }
  return map
}

// ─────────────────────── P3 · 幽灵值（软档）───────────────────────

function detectP3() {
  const stmts = sqlStatements([...apiFiles, ...dbFiles])
  const symMap = tableSymbolMap()
  const symToTable = new Map()
  for (const [tbl, sym] of symMap) symToTable.set(sym, tbl)
  const tableWrites = new Map()
  const tableReads = new Map()
  const globalWrites = new Map()
  const globalReads = new Map()
  const push = (map, key, v, ref) => {
    if (!map.has(key)) map.set(key, new Map())
    const mm = map.get(key)
    if (!mm.has(v)) mm.set(v, ref)
  }

  const paramCols = new Set()
  for (const s of stmts) {
    const { writes, reads, paramCols: pc } = parseSqlValues(s, symToTable)
    for (const k of pc) paramCols.add(k)
    for (const w of writes) for (const v of w.values) { push(tableWrites, `${w.table}.${w.col}`, v, w); push(globalWrites, w.col, v, w) }
    for (const r of reads) for (const v of r.values) { push(tableReads, `${r.table}.${r.col}`, v, r); push(globalReads, r.col, v, r) }
  }
  const orm = ormValues([...apiFiles, ...dbFiles])
  // ORM 的写**没有表信息**（`ormValues()` 只给 `{ file, line, col, values, via }`），进不了表作用域。
  // 但它们是真写方 —— 不能因为"没表名"就把该值判成幽灵（这正是我上轮收紧表作用域判据带来的假阳性风险，
  // 门禁 portal R17 的 :1260-1261 指出）。这里按 `col|val` 建一张豁免表：**判不出表的时候宁可保守**。
  const ormColVals = new Set()
  for (const w of orm.writes) for (const v of w.values) { push(globalWrites, w.col, v, w); ormColVals.add(`${w.col}|${v}`) }
  for (const r of orm.reads) for (const v of r.values) push(globalReads, r.col, v, r)

  const domains = ddlDomains()
  const defaults = ddlDefaults()
  const findings = []

  // 主判据：表作用域
  for (const [key, reads] of tableReads) {
    const [table, col] = key.split('.')
    const tw = tableWrites.get(key)
    const gw = globalWrites.get(col)
    for (const [val, ref] of reads) {
      const here = tw && tw.get(val)
      if (here) continue // **真·表作用域**豁免：本表本列确有写方（唯一该豁的情形）
      // ⚠️ 同名列在**别的表**有写方，**不再豁免**（门禁 portal R14 的 :1147-1148）：
      //    原来这里是 `if (gw && gw.has(val)) continue`，而 `globalWrites` 是 `tableWrites` 按列投影的
      //    **超集**（两者在同一个循环里填、且 `ormValues` 的写只进 globalWrites）⇒ 上一句永远被这一句吃掉，
      //    **表作用域判据从未生效**：任何别的表往同名 status 列写过一个值，本表的真幽灵值就被掩盖。
      //    现在把"跨表同名"降级成**标注**而非豁免（证据强度低一档，但不再掩盖）。
      const elsewhere = gw && gw.get(val)
      const cross = elsewhere && elsewhere.table && elsewhere.table !== table ? `${elsewhere.table}.${elsewhere.col}` : null
      // ⚠️ DDL **默认值**是确定性来源，必须豁免（见 `ddlDefaults()` 的说明）：
      //    `status ... DEFAULT 'open'` + INSERT 不写该列 ⇒ 行天然就是 'open'，读它是活的。
      //    **我自己在验证 R14 那条修复时抽验第一条就撞上了这个**（把 21 条新增里的假阳性挡住）。
      if (defaults.get(key)?.has(val.toLowerCase())) continue
      // ORM 写方（无表信息）按 `col|val` 豁免 —— 见 `ormColVals` 的说明。
      if (ormColVals.has(`${col}|${val}`)) continue
      // ⚠️ 域查询也要**大小写归一**（门禁 portal R17 的 :1266）：`ddlDomains()` 存的是小写 token，
      //    这里原来拿 `val` 原样查 ⇒ `'Active'` 这类大小写不同的真值会被判成"域外/双重证据"。
      //    紧邻的 `defaults` 查询早就用了 `toLowerCase()`，两处口径要一致。
      const inDomain = domains.get(key)?.has(val.toLowerCase()) || false
      // 注意：**不因 DDL 域内而降级**。判据自己把 st_ent_agents.status='hired' 列为 🔴 已知实例，
      // 而该值正是在 DDL COMMENT 声明的域内——若「域内即豁免」，判据自己的实例会被自己的依据否掉。
      // 故 DDL 域只作**归因标注**（域外=双重证据；域内=多半写路径没扫到），两条都留在 findings 里。
      // 文案用 if/else 算（门禁 wb#52 R14 的 :1246-1258）：原来写成
      // `cross ? … : inDomain ? … : …` 是**三重嵌套三元** —— 本文件到处引用"禁止嵌套三元"这条仓规，
      // 我自己却又犯了一次（上一轮的 `byBoolAsc` 也是同一个型）。写成分支，顺带让三段文案更好读。
      // 参数化写方（`VALUES (${x})`）：该列写过什么值**静态判不出来** ⇒ 不能断言"全仓无写方写入该值"。
      const paramWrite = paramCols.has(key)
      let symptom
      if (paramWrite) {
        symptom = `表 ${table} 的 ${col} 查 '${val}'：本仓**字面量**写方里没有该值，但该列存在**参数化写方**（\`VALUES (${'${…}'})\`）⇒ 静态判不出调用方传了什么（实测：\`st_report_events.audience\` 由 \`appSync.ts:248\` 等传 \`"factory"\`，查它是**活的**）。**先查调用方再当幽灵值**`
      } else if (cross) {
        symptom = `表 ${table} 的 ${col} 查 '${val}'：**本表本列无写方**，只有别的表（${cross}）的同名列写过它 ⇒ 本表该查询在本仓写路径下恒空（跨表同名不构成证据；请确认是否有仓外写方）`
      } else if (inDomain) {
        symptom = `表 ${table} 的 ${col} 查 '${val}'：全仓无写方写入该值，但 DDL COMMENT 声明的合法域含它 ⇒ 读面恒空无误，只是「域内声明 vs 无写方」——多半是写路径未被本次扫描覆盖，需人工确认（不要直接当 bug 修）`
      } else {
        symptom = `表 ${table} 的 ${col} 查 '${val}'：全仓无任何写方写入该值，且 DDL COMMENT 声明的合法域也不含它 ⇒ 双重证据，该查询恒空、功能永不触发（幽灵值）`
      }
      findings.push({
        rule: 'P3',
        severity: 'soft',
        file: rel(ref.file),
        line: ref.line,
        symptom,
        evidence: ref.sql,
        extra: { table, col, value: val, inDomain, crossTable: cross, paramWrite },
      })
    }
  }
  // 域外（双重证据）排前，域内次之——纯粹是 triage 顺序，两条都保留
  findings.sort((a, b) => byBoolAsc(a.extra.inDomain, b.extra.inDomain) || byFileLine(a, b))

  // 对照：判据原文的列全局差集（跨表池化）
  const globalOnly = []
  for (const [col, reads] of globalReads) {
    const gw = globalWrites.get(col)
    for (const [val, ref] of reads) if (!gw || !gw.has(val)) globalOnly.push({ col, val, file: rel(ref.file), line: ref.line })
  }

  let writeOnly = 0
  for (const [col, writes] of globalWrites) {
    const gr = globalReads.get(col)
    for (const [val] of writes) if (!gr || !gr.has(val)) writeOnly++
  }

  return { findings, stmtCount: stmts.length, globalOnly, writeOnly, domainCols: domains.size }
}

// ─────────────────────── P5 · 自称不符（软档）───────────────────────

/**
 * P5 词表分两层（判据原文只有一个词表，实测在产仓命中 868 行 = 不可用）：
 *   core —— 「跨件一致性」断言（自称与**另一件东西**同款/已同步/全真/真件）。
 *           这正是判据第五节点名的全部已知实例的形态（「全真库数据」「仓内 streamBus 同款纪律」），
 *           实测 75 行 ≈ 判据自己预期的「几十行」。
 *   wide —— 判据说辞里的通用全称量词（一律/全部/永不/绝不/保证/如实/必然/必有）。
 *           实测 793 行，其中前四个词占 722 行——本仓把它们当 fail-closed 论证的惯用语，
 *           不是对世界的断言 ⇒ 默认不进 findings，只计数（--p5=wide 可展开）。
 */
const P5_CORE = ['同款', '已同步', '已接通', '全真', '真件']
const P5_WIDE = ['一律', '全部', '永不', '绝不', '保证', '如实', '必然', '必有']
/** 合并词表**提到模块级**（门禁 R10 的 :1101）：原来在每一条被扫到的注释行上重建一次 `[...CORE, ...WIDE]`。 */
const P5_ALL = [...P5_CORE, ...P5_WIDE]
const P5_STRONGEST = new Set(['同款', '已同步', '已接通', '全真', '真件', '永不', '绝不', '保证', '必有'])
/** 取词顺序按**强度**而非词表书写顺序（门禁 portal R23 的 :1519）：core 优先 > `P5_STRONGEST` 里的强 wide
 *  词 > 其余 wide 词 —— 否则一行同时含 `全部`（弱）与 `保证`（强）时会先命中弱的，
 *  走不到"强全称量词 + 有技术标识"那条更严的档。
 *  ⚠️ 这份顺序表也**提到模块级**（门禁 portal R24 的 :1527）：我上一版在每一条注释行上重建它，
 *    与本文件既有的"词表提升"口径（见上一行 `P5_ALL`）自相矛盾。 */
const P5_BY_STRENGTH = [
  ...P5_CORE,
  // ⚠️ 中段必须**排除 core**：`P5_STRONGEST` 里已经含全部 core 词（同款/已同步/已接通/全真/真件），
  // 不排除就是把同一批词再放一遍 —— `.find()` 永远先命中前一段，这些是**不可达的重复项**
  //（门禁 portal R25 的 :1524）。
  ...P5_ALL.filter((w) => P5_STRONGEST.has(w) && !P5_CORE.includes(w)),
  ...P5_ALL.filter((w) => !P5_CORE.includes(w) && !P5_STRONGEST.has(w)),
]
const P5_TECH = /`[^`]+`|\/api\/|\.tsx?\b|表\s*[a-z_]{3,}|端点|路由|字段\s*[a-z_]{3,}/

function detectP5() {
  const findings = []
  const wideHits = []
  // 计数口径（门禁 R10 的 :1498/:1535）：`findings` 里**同时**含 core 与"够格的 wide"
  //（`strongWide` 会进 findings），所以 `findings.length` **不是** core 数。
  // 这里单独记 core 数，报告直接用 `coreN` + `wideCount`，避免"打印的数字与产出它的代码不是一回事"。
  let coreN = 0
  let labelN = 0
  /** 强 wide 词的命中数（门禁 portal R25 的 :2101）：在循环里按**词表**数，不再由 `findings.length - coreN` 推 ——
   *  后者在 `--p5=wide` 下会等于"全部 wide"，把「一律/全部/如实/必然」也算成"强全称量词"。 */
  let strongN = 0
  let commentLines = 0
  for (const f of [...srcFiles, ...apiFiles]) {
    // 用 `src()` 已缓存的切分（门禁 R10 的 :1052/:1089）：这两行原来每次重新 `split('\n')`，
    // 而我上一轮加 `maskLines` 缓存时**漏了 detectP5** —— 缓存加了却没用上，等于白加。
    const { lines, maskLines: ml } = src(f)
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]
      const masked = ml[i] ?? ''
      // ⚠️ 自称词必须在**注释部分**里找（门禁 wb#52 R11/R12 的 :1168）：原来在**整行** `raw` 里搜，
      // 于是 `const label = '同款' // 普通注释` 这种"代码里有词、注释里没有"的行也被算成注释自称 ⇒ **假候选**。
      let commentAt = -1
      for (let k = 0; k < Math.min(raw.length, masked.length); k++) {
        if (masked[k] === ' ' && raw[k] !== ' ' && raw[k] !== '\t') { commentAt = k; break }
      }
      if (commentAt < 0) continue
      commentLines++
      const commentText = raw.slice(commentAt)
      // 取词顺序（门禁 portal R23 的 :1519）：原来用 `P5_ALL.find(...)` —— 那是**数组书写顺序**，
      // core 词排在前没问题，但**wide 词之间**会先命中"弱"的（`全部` 在 `保证` 之前）⇒ 该行走不到
      // "强全称量词 + 有技术标识"那条更严的档，可能把强断言漏成低档。故按**强度**排序：
      // 核心词优先 > `P5_STRONGEST` 里的强词 > 其余 wide 词。
      const word = P5_BY_STRENGTH.find((w) => commentText.includes(w))
      if (!word) continue
      // 展示用的 claim：去掉注释定界符。⚠️ **长度门槛必须量 `commentText`，不能量 claim** ——
      // 我第一版拿 claim 去比 8，而 JSX 注释 `{/* 三真件 */}` 的 claim 只剩 `三真件 */}`（7 字符）
      // ⇒ 把一条**合法候选**判掉了（实测：P5 94→93 少的那条正是它）。阈值本身是"注释得有足够内容
      // 才算自称"，量注释段才是它原本的语义（原来量整行，所以恰好放过了 JSX 注释）。
      if (commentText.trim().length < 8) continue
      const claim = commentText.replace(/^\s*(\/\/|\/\*|\*)\s?/, '').trim()
      const isCore = P5_CORE.includes(word)
      // 「真件：<数据源>」「真件（工作域）：…」是本仓的**资料标签**（列出哪个过程供真数据），
      // 不是可被反证的断言 ⇒ 降级计数，不进 findings（实测 51 条 真件 里大半是这种形态）。
      const isLabel = /^\s*(?:\/\/|\/\*|\*|\{\/\*)?\s*真件\s*[：:（(]/.test(raw)
      // ⚠️ **同时含更强的 core 断言时不降级**（门禁 wb#52 R21 的 :1511）：`// 真件：… 同款 …` 这种
      //    "既打了资料标签、又含跨件一致性断言（同款/已同步/已接通/全真）"的注释，原来被整条丢掉
      //    （`labelN++` 且不进 findings）⇒ 软档误漏。只有当注释里**除「真件：」外没有别的 core 词**时，
      //    才算纯资料标签。
      if (isLabel && !P5_CORE.some((w) => w !== '真件' && commentText.includes(w))) { labelN++; continue }
      // core 直接收；wide 要求行内有可核对的技术标识，否则纯修辞
      // `--p5=wide` 必须真的**展开**这个词表（门禁 portal R5 的 :920、R3 的 :810）：原实现即使在 wide
      // 模式下仍额外要求 `P5_STRONGEST.has(word)`，于是「一律/全部/如实/必然」**任何模式下**都进不了
      // findings —— 与 `--help` 的「wide 追加通用全称量词」不符 = 自称与实现不符。
      const wideMode = ARGS.p5 === 'wide'
      // 「强 wide 词 + 行内有可核对的技术标识」在**默认模式**下也够格进 findings。
      // ⚠️ 这条门槛原来是**死代码**（门禁 portal R7 的 :947-948）：过了门槛的 rec 紧接着又被末尾
      // `if (isCore || wideMode)` 丢掉 ⇒ 白算一遍，行为与"直接 continue"完全一样。现在让它真正生效。
      const strongWide = !isCore && P5_STRONGEST.has(word) && P5_TECH.test(raw)
      if (!isCore && !wideMode && !strongWide) { wideHits.push(word); continue }
      // ⚠️ **强 wide 计数单独数**（门禁 portal R25 的 :2101）：原来 `strongN = findings.length - coreN`，
      //    而 `--p5=wide` 模式下**每个** wide 词都会被 push 进 findings ⇒ 那个差等于"全部 wide"、
      //    把「一律/全部/如实/必然」也算成"强全称量词"，报告里的分解与实际口径不符。这里按词表实数。
      if (!isCore && P5_STRONGEST.has(word)) strongN++
      const rec = {
        rule: 'P5',
        severity: 'soft',
        file: rel(f),
        line: i + 1,
        symptom: `注释自称「${word}」（${isCore ? '跨件一致性断言' : '全称断言'}）：${claim.slice(0, CLAIM_SHOW_MAX)}${claim.length > CLAIM_SHOW_MAX ? '…' : ''} ⇒ 人工核对实现是否可反证（改文案或改实现，二者必居其一）`,
        evidence: word,
        extra: { word, tier: isCore ? 'core' : 'wide' },
      }
      if (isCore) { findings.push(rec); coreN++ }
      else {
        // wide 档：**既进 findings、也计入 wide 统计** —— 否则报告里「wide 另 N 条」会把
        // strongWide 那些漏算（门禁 portal R9 的 :1014）。原来这里是 `else wideHits.push(word)`，
        // 在 strongWide 生效之后已经**不可达**（同轮 :1009 指出的死分支）。
        findings.push(rec)
        wideHits.push(word)
      }
    }
  }
  findings.sort((a, b) => byFileLine(a, b))
  // `strongN` 由这里**一次算好**（门禁 portal R20 的 :1886）：原来在 3 处各算一遍
  //（汇总行 / 报告表 / 明细行），哪天口径改了就会有一处忘了跟。
  // ⚠️ 口径（门禁 portal R25 的 :2101）：**强 wide 词的命中数**，在循环里按词表实数，
  //    不再用 `findings.length - coreN`（那在 `--p5=wide` 下会等于"全部 wide"）。
  return { findings, commentLines, coreN, labelN, strongN, wideCount: wideHits.length }
}

// ───────────────── P2 · 空表被活代码读（软档 · 数据面）─────────────────

function dbConfig() {
  // ⚠️ **优先读仓内单源** `DATABASE_URL`（门禁 portal R19 的 :1467 / 长期挂着的 :1277）：
  // 本仓其它脚本（`db/*.mts`）统一从它取连接串；只有本脚本自己写死了 `wb_rebuild / 127.0.0.1 / 3307 / root`，
  // 在非开发环境会**静默指向错误的库**。优先级：显式 `IDLE_AUDIT_DB_*` > `DATABASE_URL` > 内置默认（并打印来源）。
  const fromUrl = parseDatabaseUrl(process.env.DATABASE_URL)
  // ⚠️ **设了但解析不出 ⇒ fail-closed**（门禁 portal R23 的 :1625）：静默回落到内置开发默认会让
  // "连错库"与"连对库"看起来一样可信 —— 而本脚本的退出码 2 正是为这种情形设的。
  if (ARGS.db !== 'off' && process.env.DATABASE_URL && !fromUrl) {
    fail(
      'DATABASE_URL 已设置但解析不出连接信息',
      '值形如 `mysql://user:pass@host:port/db`；本脚本拒绝静默回落到内置开发默认（127.0.0.1:3307/wb_rebuild）',
    )
  }
  const name = process.env.IDLE_AUDIT_DB_NAME || fromUrl?.database || 'wb_rebuild'
  const host = process.env.IDLE_AUDIT_DB_HOST || fromUrl?.host || '127.0.0.1'
  // 非法库名**不许静默回落**（门禁 R5 的 :912）：那会让审计跑到**另一个 schema** 上，
  // 而结论看起来一样可信 —— 与 --root / --db=on 的自检同一口径（配错 ⇒ 退出码 2）。
  // `--db=off` 用不到库名，故不校验。
  if (ARGS.db !== 'off' && !/^[A-Za-z_][\w$]*$/.test(name)) {
    fail(`IDLE_AUDIT_DB_NAME 非法：${name}`, '库名只能由字母/数字/下划线组成；本脚本拒绝"静默换库"')
  }
  // ⚠️ **非回环主机 fail-closed**（门禁 portal R22 的 :1725，security/medium）：
  //    本客户端是裸 `net` 明文 TCP（**没有 TLS**）；`caching_sha2_password` 的**全量认证**分支还要用
  //    **服务端下发的 RSA 公钥**加密口令，而公钥既不校验指纹也不校验证书 ⇒ 链路中间人可替换公钥解出口令，
  //    而脚本照旧给出"可信"结论（0/1）。回环不出主机，故不受影响；非回环一律拒绝，除非显式承担风险。
  const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
  // ⚠️ 只对 **`--db=on`**（显式要求远端）拒绝；`auto` 走下面的 `autoAllowed` 分支**优雅跳过**并说明 ——
  //    两者都要"不静默打到远端库"，但 `on` 是拒绝、`auto` 是降级，语义不同（我第一版一律 fail，把 auto 也拦成了退出码 2）。
  if (ARGS.db === 'on' && !LOOPBACK_HOSTS.has(host) && process.env.IDLE_AUDIT_ALLOW_PLAINTEXT_DB !== '1') {
    fail(
      `数据库主机 ${host} 不是回环地址，而本脚本走明文 TCP（无 TLS）`,
      'caching_sha2 全量认证会用**未验证的服务端公钥**加密口令 ⇒ 可被中间人解出；确要连它请显式设 IDLE_AUDIT_ALLOW_PLAINTEXT_DB=1',
    )
  }
  return {
    host,
    port: takeEnvInt('IDLE_AUDIT_DB_PORT', process.env.IDLE_AUDIT_DB_PORT, fromUrl?.port ?? 3307, 1, 65535, ARGS.db !== 'off'),
    user: process.env.IDLE_AUDIT_DB_USER || fromUrl?.user || 'root',
    password: process.env.IDLE_AUDIT_DB_PASSWORD ?? fromUrl?.password ?? '',
    // 空口令 ≠ 没给口令（门禁 portal R6 的 :1213）：本机 root@127.0.0.1 的开发库就是**故意空口令**，
    // 用 `|| ''` 再判 `!password` 会把"给了但为空"当成"没给" ⇒ P2 永远被跳过。
    // ⚠️ `Boolean(fromUrl?.password)` 对**空串**求值为 false ⇒ `mysql://root:@host/db`（本仓 smoke 脚本
    //    就是这么写的）会被判成"没给口令"（门禁 portal R22 的 :1573）。故这里判的是 **`!== undefined`**。
    pwProvided: process.env.IDLE_AUDIT_DB_PASSWORD !== undefined || fromUrl?.password !== undefined,
    // `--db=auto` 只对**回环**自动开数据面（门禁 portal R22 的 :111）：CI/部署普遍设 `DATABASE_URL`，
    // 若 auto 一律自动探测，一次普通 `npm run audit:idle` 就会对远端库开数百条 TCP 并跑 SELECT。
    autoAllowed: ARGS.db !== 'auto' || LOOPBACK_HOSTS.has(host),
    database: name,
    timeoutMs: takeEnvInt('IDLE_AUDIT_DB_TIMEOUT_MS', process.env.IDLE_AUDIT_DB_TIMEOUT_MS, 8000, 100, 600000, ARGS.db !== 'off'),
    // 取值来源（`--db=on` 时打印）：不打印来源，"连错库"和"连对库"在输出上长得一样。
    // ⚠️ 拆成显式分支（门禁 wb#52 R26 的 :1690）：本文件**明令禁止嵌套三元**（`byBoolAsc` 那处就是为此改的），
    //    我这里又写了一个 `a ? b : c ? d : e` —— 自己违反自己的仓规。
    source: dbSourceLabel(process.env.IDLE_AUDIT_DB_HOST || process.env.IDLE_AUDIT_DB_NAME, fromUrl),
  }
}

/**
 * 取值来源标签（门禁 wb#52 R26 的 :1690：原来写成嵌套三元，违反本文件"禁止嵌套三元"的仓规）。
 * 返回给 `--db=on` 的打印用 —— 不打印来源时，"连错库"与"连对库"在输出上长得一样。
 */
function dbSourceLabel(fromEnv, fromUrl) {
  if (fromEnv) return 'IDLE_AUDIT_DB_* 环境变量'
  if (fromUrl) return 'DATABASE_URL'
  return '内置默认（仅适用于本机开发：127.0.0.1:3307/wb_rebuild）'
}

/**
 * 解析 `DATABASE_URL`（`mysql://user:pass@host:port/db`）—— 取不出就返回 `null`。
 * ⚠️ **"设了但解析不出"与"没设"必须分开**（门禁 portal R23 的 :1625）：原来两者都返回 `null` ⇒
 * 部署设了 `DATABASE_URL` 却因格式未被接受（scheme 字符类原来不收数字等）时，脚本会**静默回落到内置开发默认**
 * （`127.0.0.1:3307/wb_rebuild/root`）⇒ 连错库而结论看起来一样可信。调用方据此 fail-closed。
 */
function parseDatabaseUrl(raw) {
  if (!raw) return null
  // ⚠️ host 组要容**方括号 IPv6**（门禁 wb#52 R26 的 :1702）：`([^:/?]+)` 遇 `[::1]` 会在第一个 `:` 处断掉，
  //    端口组与 `/db` 就都匹配不上 ⇒ 整条 URL 解析失败（而 `[::1]` 又恰在回环白名单里，等于白名单形同虚设）。
  const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:([^:@/]*)(?::([^@/]*))?@)?(\[[^\]]+\]|[^:/?]+)(?::(\d+))?\/([^?]*)/.exec(raw)
  if (!m) return null
  return {
    user: m[1] ? decodeURIComponent(m[1]) : undefined,
    password: m[2] !== undefined ? decodeURIComponent(m[2]) : undefined,
    host: m[3],
    port: m[4] ? Number(m[4]) : undefined,
    database: m[5] ? decodeURIComponent(m[5]) : undefined,
  }
}

/**
 * 环境变量里的整数取值：**非法即自检失败**（门禁 portal R6 的 :944）。
 * 原来 `Number(...)` 会把拼错的值变成 `NaN`，最后表现为一次**语焉不详的连接超时** ——
 * 人得从网络层倒推才发现是 env 写错了。口径与 `--max-console` 的 `takePositiveInt` 对齐。
 */
function takeEnvInt(name, raw, dflt, lo, hi, active = true) {
  // `active=false`（如 `--db=off`）时**不校验**：那条路根本用不到这个值。
  // 为用不上的环境变量报错属于"校验了不该校验的东西"（门禁 portal R8 的 :1281）——
  // 与库名那条同口径（那条早就带了 `ARGS.db !== 'off'`，这两条当时漏了）。
  if (!active || raw === undefined || raw === '') return dflt
  const n = Number(raw)
  if (!Number.isInteger(n) || n < lo || n > hi) {
    fail(`${name} 非法：${raw}`, `需要 ${lo}..${hi} 之间的整数（不写则默认 ${dflt}）`)
  }
  return n
}

/** 极简 MySQL 客户端（零依赖）：连上 → 跑一条只读 SELECT → 返回行数组。 */
function mysqlQuery(cfg, sql, timeoutMs = cfg.timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: cfg.host, port: cfg.port })
    let buf = Buffer.alloc(0)
    let stage = 'handshake'
    let hs = null
    let done = false
    let colCount = 0
    let colDefs = 0
    let phase = 'count'
    let seq = 0
    const rows = []
    const timer = setTimeout(() => finish(new Error(`MySQL 超时（${timeoutMs}ms）`)), timeoutMs)

    function finish(err, val) {
      if (done) return
      done = true
      clearTimeout(timer)
      try { sock.destroy() } catch { /* noop */ }
      err ? reject(err) : resolve(val)
    }
    function send(payload) {
      const h = Buffer.alloc(4)
      h.writeUIntLE(payload.length, 0, 3)
      h[3] = seq & 0xff
      seq = (seq + 1) & 0xff
      sock.write(Buffer.concat([h, payload]))
    }
    const readLenEnc = (p, o) => {
      const f = p[o]
      if (f < 0xfb) return [f, o + 1]
      if (f === 0xfc) return [p.readUInt16LE(o + 1), o + 3]
      if (f === 0xfd) return [p.readUIntLE(o + 1, 3), o + 4]
      if (f === 0xfe) return [Number(p.readBigUInt64LE(o + 1)), o + 9]
      return [null, o + 1]
    }
    function tokenFor(plugin, scramble) {
      const pw = cfg.password
      // ⚠️ `mysql_clear_password` **直接拒绝**（门禁 portal R23 的 :1703，security/medium）：该插件要求客户端
      //    把口令**明文**放进认证响应，而本客户端全程裸 TCP（从不设 `CLIENT_SSL`、不协商 TLS）——
      //    唯一的兜底是"host 必须回环"，但逃生开关 `IDLE_AUDIT_ALLOW_PLAINTEXT_DB=1` 会把它打开。
      //    明文的代价与"用一个本地只读探针"的收益完全不成比例，故**不提供**这条路：让服务端改插件或用回环。
      if (plugin === 'mysql_clear_password') {
        throw new Error('服务端要求 mysql_clear_password（明文口令），而本脚本走明文 TCP —— 拒绝发送口令明文；请改用回环连接或换认证插件')
      }
      // 空口令 ⇒ **空认证响应**（门禁 R10 的 :1183-1185）：MySQL 协议里"没有口令"就是 0 字节，
      // 而不是"用空字符串算出来的 token" —— 后者会被服务端判成鉴权失败。
      // 我上一轮让"空口令"算作"已提供口令"（`pwProvided`），于是终于走到这里：
      // **必须同时把响应也改对**，否则那条修复只是把"优雅跳过"换成了"连不上"。
      if (pw === '') return Buffer.alloc(0)
      if (plugin === 'caching_sha2_password') {
        const s1 = crypto.createHash('sha256').update(pw).digest()
        const s2 = crypto.createHash('sha256').update(s1).digest()
        const s3 = crypto.createHash('sha256').update(Buffer.concat([s2, scramble])).digest()
        return Buffer.from(s1.map((b, i) => b ^ s3[i]))
      }
      // （`mysql_clear_password` 那条 `return Buffer.from(pw + '\0')` 已随上面的"直接拒绝"删掉 —— 不可达分支不留。）
      const s1 = crypto.createHash('sha1').update(pw).digest()
      const s2 = crypto.createHash('sha1').update(s1).digest()
      const s3 = crypto.createHash('sha1').update(Buffer.concat([scramble, s2])).digest()
      return Buffer.from(s1.map((b, i) => b ^ s3[i]))
    }
    function readHandshake(p) {
      let o = 1
      o = p.indexOf(0, o) + 1
      o += 4
      const seed1 = p.subarray(o, o + 8); o += 8
      o += 1
      o += 2 // 服务端 capabilities 低位、+1+2 后是高位：**本客户端不消费**（回复用固定 CAPS），
      o += 1 + 2 // 故只按协议步长走偏移、不取值 —— 免得读者以为能力协商真的发生（门禁 R4 的 :970）
      o += 2
      const authLen = p[o]; o += 1
      o += 10
      const part2Len = Math.max(13, authLen - 8)
      const seed2 = p.subarray(o, o + part2Len - 1); o += part2Len
      const z2 = p.indexOf(0, o)
      const plugin = z2 >= 0 ? p.toString('utf8', o, z2) : p.toString('utf8', o)
      return { seed1, seed2, plugin }
    }
    function handle(p) {
      const tag = p[0]
      if (stage === 'handshake') {
        hs = readHandshake(p)
        const scramble = Buffer.concat([hs.seed1, hs.seed2])
        const CAPS = (0x00000001 | 0x00000200 | 0x00002000 | 0x00008000 | 0x00080000 | 0x00200000 | 0x00020000) >>> 0
        const head = Buffer.alloc(4 + 4 + 1 + 23)
        head.writeUInt32LE(CAPS, 0)
        head.writeUInt32LE(0x1000000, 4)
        head[8] = 0x21
        const tk = tokenFor(hs.plugin, scramble)
        send(Buffer.concat([head, Buffer.from(cfg.user + '\0', 'utf8'), Buffer.from([tk.length]), tk, Buffer.from(hs.plugin + '\0', 'utf8')]))
        stage = 'auth'
        return
      }
      if (stage === 'auth' || stage === 'auth2') {
        // 鉴权完成：MySQL 规定每条新命令从 seq=0 重新开始（不重置 → ER_NET_PACKETS_OUT_OF_ORDER）
        if (tag === 0x00) { stage = 'query'; seq = 0; send(Buffer.concat([Buffer.from([0x03]), Buffer.from(sql, 'utf8')])); return }
        if (tag === 0xff) { finish(new Error(`MySQL 鉴权失败: ${p.toString('utf8', 3)}`)); return }
        if (tag === 0xfe) {
          const rest = p.subarray(1)
          const z = rest.indexOf(0)
          const plugin = rest.toString('utf8', 0, z)
          let sc = rest.subarray(z + 1)
          if (sc.length && sc[sc.length - 1] === 0) sc = sc.subarray(0, sc.length - 1)
          send(tokenFor(plugin, sc))
          return
        }
        if (tag === 0x01 && p[1] === 0x04) { send(Buffer.from([0x02])); stage = 'rsa'; return }
        return
      }
      if (stage === 'rsa') {
        const pem = p.subarray(1).toString('utf8')
        const scramble = Buffer.concat([hs.seed1, hs.seed2])
        const plain = Buffer.from(cfg.password + '\0', 'utf8')
        const xored = Buffer.alloc(plain.length)
        for (let i = 0; i < plain.length; i++) xored[i] = plain[i] ^ scramble[i % scramble.length]
        send(crypto.publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, xored))
        stage = 'auth2'
        return
      }
      if (stage === 'query') {
        if (tag === 0xff) { finish(new Error(`MySQL 查询失败: ${p.toString('utf8', 3)}`)); return }
        if (phase === 'count') {
          colCount = p[0]
          if (colCount === 0) { finish(null, []); return } // OK 包 = 非结果集
          colDefs = 0
          phase = 'cols'
          return
        }
        if (phase === 'cols') {
          colDefs++
          if (colDefs >= colCount) phase = 'eof'
          return
        }
        if (phase === 'eof') { phase = 'rows'; return }
        if (phase === 'rows') {
          if (tag === 0xfe && p.length < 9) { finish(null, rows); return }
          const vals = []
          let o = 0
          while (o < p.length) {
            if (p[o] === 0xfb) { vals.push(null); o++; continue }
            const [len, adv] = readLenEnc(p, o)
            if (len === null) { vals.push(null); o = adv; continue }
            vals.push(p.toString('utf8', adv, adv + len))
            o = adv + len
          }
          rows.push(vals)
          return
        }
      }
    }
    sock.on('error', (e) => finish(e))
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      while (buf.length >= 4) {
        const len = buf.readUIntLE(0, 3)
        if (buf.length < 4 + len) break
        const sid = buf[3]
        const payload = buf.subarray(4, 4 + len)
        buf = buf.subarray(4 + len)
        seq = (sid + 1) & 0xff
        try { handle(payload) } catch (e) { finish(e) }
      }
    })
  })
}

/**
 * 表名 → drizzle 符号名（`export const agentHireRecords = mysqlTable("agent_hire_records"`）。
 * 必须有这张映射：写方多用**符号**（`db.insert(agentHireRecords)`）而不是表名，
 * 只按表名找写方会把一大堆有写方的表误判成「结构性零写方」——实测踩过：
 * 初版 14 张「零写方」里有 12 张其实是符号形态写的。
 */
let symMapCache = null
function tableSymbolMap() {
  // 记忆化（门禁 portal R8 的 :435）：本函数在 detectP3 与 detectP2 里各被调用一次，
  // 每次都要把 db/+api/+src/ 全扫一遍 —— 结果在**一轮运行内是常量**，没必要算两遍。
  if (symMapCache) return symMapCache
  const map = new Map()
  for (const f of [...dbFiles, ...apiFiles, ...srcFiles]) {
    const { mask } = src(f)
    const re = /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:mysqlTable|pgTable|sqliteTable)\s*\(\s*['"]([^'"]+)['"]/g
    let m
    while ((m = re.exec(mask))) map.set(m[2].toLowerCase(), m[1])
  }
  symMapCache = map
  return map
}

async function detectP2(cfg) {
  const notes = []
  // ⚠️ 此处曾被插入一份**嵌套的 `notesSummaryLine` 副本**（门禁 portal#50 R7 的 :2064-2071 / Kimi 桥214：
  //    它遮蔽模块级单点、在本作用域内是死码）。根因：我用 `String.Replace(anchor, fn)` 改代码时，
  //    `const notes = []` 这个锚点在文件里**有两处**（模块级 + 本函数局部）⇒ **两处都被替换**。
  //    教训：**用"替换全部"改代码前，先数锚点出现次数**。
  // 标识符**白名单校验**（门禁 R10 的 :1381）：库名只在 `--db !== 'off'` 时才被校验过一次，
  // 表名则来自 `information_schema`（MySQL 标识符可含反引号、点号、甚至引号）。
  // 下面两处 SQL 都是**拼接**进去的 ⇒ 拼之前统一挡一道，别把"库/表名"当成天然安全。
  const IDENT = /^[A-Za-z_][\w$]*$/
  const badTable = (names) => names.find((n) => !IDENT.test(n))
  if (!IDENT.test(cfg.database)) fail(`库名含非法字符，拒绝拼进 SQL：${cfg.database}`, '库名只能由字母/数字/下划线组成')
  const tables = await mysqlQuery(cfg, `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${cfg.database}' AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`)
  const names = tables.map((r) => r[0]).filter(Boolean)
  const bad = badTable(names)
  if (bad) fail(`表名含非法字符，拒绝拼进 SQL：${bad}`, `库 ${cfg.database} 下取到 ${names.length} 张表；表名只能由字母/数字/下划线组成`)
  notes.push(`库 \`${cfg.database}\` 底座表 ${names.length} 张（information_schema 只用来取表名；空/非空一律真探针判定）`)
  // 打印**取值来源**（门禁 portal R19 的 :1467）：不打印来源时，"连错库"与"连对库"在输出上长得一样。
  notes.push(`连接取值来源：${cfg.source}（${cfg.host}:${cfg.port}/${cfg.database}，用户 ${cfg.user}）`)

  const empty = []
  const probeErrors = []
  // 表探针**有界并发**（门禁 portal R6/R7/R8 连提、R4 起第四次）：每次探针都要新开一条 TCP 并做
  // 完整 MySQL 握手，串行在几百张表时是**线性等待**；而这些探针彼此独立。用 6 路并发把墙钟压下来，
  // 同时**保持结果按表名原序**（下游按 names/empty 顺序产报告，顺序变了 diff 会抖）。
  const CONC = 6
  const probes = new Array(names.length)
  let nextIdx = 0
  const worker = async () => {
    for (;;) {
      const idx = nextIdx++
      if (idx >= names.length) return
      const t = names[idx]
      try {
        const r = await mysqlQuery(cfg, `SELECT 1 FROM \`${cfg.database}\`.\`${t}\` LIMIT 1`)
        probes[idx] = { t, isEmpty: !r.length }
      } catch (e) {
        probes[idx] = { t, err: e.message.slice(0, 60) }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(CONC, names.length)) }, worker))
  for (const p of probes) {
    if (!p) continue
    if (p.err) probeErrors.push(`${p.t}(${p.err})`)
    else if (p.isEmpty) empty.push(p.t)
  }
  notes.push(`真探针（SELECT 1 … LIMIT 1）判定：空表 **${empty.length}** 张；探针失败 ${probeErrors.length} 张`)

  const findings = []
  const deadTables = []
  // 读/写方判定必须同时扫 api/ **和 db/**：只扫 api/ 会把 sync-*/seed 脚本写的表
  // 误判成「全仓零写方」——实测踩过：st_agents 被 db/sync-iter89.mts 写了 6 处。
  const writerFiles = [...apiFiles, ...dbFiles]
  const symMap = tableSymbolMap()
  for (const t of empty) {
    const refs = []
    const sym = symMap.get(t)
    // 表名/符号名来自 schema —— 但**不该假定它们天然无正则元字符**（门禁 portal R9 的 :1258）：
    // 直接拼进 RegExp 会让匹配错位甚至抛错，而这里的结论是"零写方"这种强信号，不能靠运气。
    const marker = new RegExp(`\\b${reEsc(t)}\\b${sym ? `|\\b${reEsc(sym)}\\b` : ''}`)
    const nameAlt = sym ? `(?:${reEsc(t)}|${reEsc(sym)})` : reEsc(t)
    // 这两个正则**只依赖 `nameAlt`**（整表迭代内是常量），原来在**每一行**都重建一次
    //（门禁 R10 的 :1386/:1415）—— P2 的最内层循环，表 × 文件 × 行三重，重建开销很实在。
    // ⚠️ 必须带 `i` 标志（门禁 portal R14 的 :1547-1548）：P3 那条同族正则是 `/i` 的
    //（`\b(SELECT|INSERT|UPDATE|DELETE)\b/i`），这两条原来没有 ⇒ 小写 `from` / `insert into` 漏认，
    // 读/写方归属直接变窄 —— 而 P2 最强的信号正是「零写方」。同一套关键字，两处口径必须一致。
    const readRe = new RegExp(`\\bFROM\\s+\`?${nameAlt}\\b\`?|\\bJOIN\\s+\`?${nameAlt}\\b\`?|\\bfrom\\s*\\(\\s*${nameAlt}\\b\\s*\\)|\\.\\s*(?:inner|left|right|full)Join\\s*\\(\\s*${nameAlt}\\b`, 'i')
    const writeRe = new RegExp(
      `\\bINSERT\\s+(?:IGNORE\\s+)?INTO\\s+\`?${nameAlt}\\b\`?` +
        `|\\bREPLACE\\s+INTO\\s+\`?${nameAlt}\\b\`?` +
        `|\\bUPDATE\\s+\`?${nameAlt}\\b\`?` +
        `|\\bDELETE\\s+FROM\\s+\`?${nameAlt}\\b\`?` +
        `|\\.\\s*(?:insert|update|delete)\\s*\\(\\s*${nameAlt}\\b`,
      'i',
    )
    for (const f of writerFiles) {
      const { lines: rawLines, maskLines } = src(f)
      // 判定必须走**掩码后**的行（门禁 R5 的 :1123）：原实现读的是原始源码 ⇒ 被注释掉的
      // `INSERT INTO t` / `FROM t` 也会被算成真读写方，直接污染 P2 **最强**的那层信号
      //（「零写方」= 结构性恒空）。展示用的原文仍取 rawLines，便于人按行号去定位。
      const lines = maskLines // 已随 src() 缓存（门禁 portal R10 的 :1304），不再每次 split
      for (let i = 0; i < lines.length; i++) {
        if (!marker.test(lines[i])) continue
        const win = lines.slice(Math.max(0, i - 4), i + 5).join('\n')
        // 读方：raw SQL 的 FROM/JOIN，或 drizzle 的 .from(sym)
        // ⚠️ `${nameAlt}` 之后**必须带词边界**（门禁 portal R10 的 :1309）：本仓存在**前缀同名**的表
        //（`st_corps` 与 `st_corps_training`，见 `db/sync-iter91.mts`）—— 没有 `\b` 时，
        // 对 `st_corps` 的判定会把 `st_corps_training` 的读写**也算到它头上**（写归属串表）。
        // 同一函数里 drizzle 那一支本来就带了 `\b`，补上才对称。
        const read = readRe.test(win)
        // 写方：raw SQL 的 INSERT/UPDATE/DELETE，或 drizzle 的 .insert(sym)/.update(sym)/.delete(sym)
        // 写方识别：补 `INSERT IGNORE INTO` 与 `REPLACE INTO` —— 本仓生产在用
        // （`api/routers/billing.ts:131` 的 INSERT IGNORE），漏认会把有写方的表判成「零写方」，
        // 而「零写方」正是 P2 最强的那层信号（门禁 R4 的 :1114）。
        const write = writeRe.test(win)
        if (read || write) refs.push({ file: rel(f), line: i + 1, read, write, text: (rawLines[i] ?? lines[i]).trim().slice(0, 140) })
      }
    }
    const readers = refs.filter((r) => r.read)
    const writers = refs.filter((r) => r.write)
    if (!readers.length) { deadTables.push({ table: t, refs: refs.length }); continue }
    // 分档（都在软档内，只影响排序与措辞——P2 不决定退出码）：
    //   零写方 = 结构性恒空（不是「还没数据」）；有写方 = 可能只是没数据，按读方数排序供抽查
    findings.push({
      rule: 'P2',
      severity: 'soft',
      file: readers[0].file,
      line: readers[0].line,
      symptom: writers.length
        ? `表 ${t} 真探针判定 0 行，api/+db/ 有 ${readers.length} 处读方、${writers.length} 处写方 ⇒ 读面恒空（可能只是尚未产生数据，也可能写路径从不触发——需人工判）`
        : `【强信号】表 ${t} 真探针判定 0 行，api/+db/ 有 ${readers.length} 处读方但**本仓无任何写方**（raw SQL 与 drizzle 符号两种形态都查过）⇒ 读面恒空。注意：仓外进程/运维脚本仍可能是写方（如 ops_health_checks 系服务器指标采集），需人工确认后再判`,
      evidence: readers[0].text,
      extra: { table: t, readers: readers.length, writers: writers.length, structural: writers.length === 0 },
    })
  }
  // 降序：先按"结构性恒空"（true 在前），再按读方数。
  // `structural` 是**布尔**，原来靠 `true - false` 的隐式转换（门禁 portal R13 的 :1539）——
  // 与本文件新加的 `byBoolAsc` 同一条道理（那里就是为了替掉这种写法），这里也改掉。
  findings.sort((a, b) => byBoolAsc(b.extra.structural, a.extra.structural) || b.extra.readers - a.extra.readers)
  return { findings, empty, deadTables, notes, probeErrors }
}

// ─────────────────────── 汇总 / 渲染 / 入口 ───────────────────────

const HARD_RULES = new Set(['P1', 'P4'])
// 嵌套三元违仓规（门禁 portal R6 的 :1199 / :733）：换成查表 + 显式分支
const ICON = { hard: '🔴', soft: '🟠' }
const icon = (f) => ICON[f.severity] ?? '🟡'

async function main() {
  const started = Date.now()
  const constMaps = constStringMaps()
  const p1 = detectP1()
  const p4 = detectP4(constMaps)
  const p3 = detectP3()
  const p5 = detectP5()

  const cfg = dbConfig()
  let p2 = null
  let p2Skip = null
  if (ARGS.db === 'off') p2Skip = '显式 --db=off'
  else if (!cfg.autoAllowed) {
    // 门禁 portal R22 的 :111：`auto` 只对回环自动开数据面 —— 远端库要**显式** `--db=on`
    // （否则 CI 里一次普通 `npm run audit:idle` 就会打到 `DATABASE_URL` 指向的远端库）。
    p2Skip = `--db=auto 且库主机 ${cfg.host} 非回环：自动探测只对回环开（要跑请显式 --db=on）`
  } else if (!cfg.pwProvided) {
    // `--db=on` 是**显式要求**跑数据面：要不到口令就不能"悄悄跳过、退出码还不改"（门禁 R4 的 :1155）——
    // 那会让"数据面没跑"看起来跟"跑了且干净"一样。auto 才允许优雅降级。
    if (ARGS.db === 'on') fail('--db=on 但未提供数据库口令', '设 IDLE_AUDIT_DB_PASSWORD，或改用 --db=auto 允许跳过并说明')
    p2Skip = '未提供 IDLE_AUDIT_DB_PASSWORD（本脚本不读任何硬编码口令）'
  } else {
    try {
      p2 = await detectP2(cfg)
    } catch (e) {
      p2 = null
      const why = `连库失败：${String(e && e.message).slice(0, 160)}`
      if (ARGS.db === 'on') fail(`--db=on 但${why}`, '数据面是显式要求的：不能降级成"跳过"却仍给出结论')
      p2Skip = `${why}，已降级跳过（不阻断）`
    }
  }

  // ⚠️ **第二次**读失败检查（门禁 wb#52 R8 的 high）：早闸（`mountedNamespaces()` 之前那次）只能挡住
  // `walk()` 阶段的失败 —— 其余源码是**惰性读**的，`src()` 要等 `detectP1/P3/P4/P5`（以及
  // `constStringMaps` / `tableSymbolMap` / `ddlDomains`）跑到才被调用，那些失败发生在早闸**之后**。
  // 只在早闸查一次 ⇒ "检测期少读了一部分"仍会退 0 = **假绿**，正是退出码 2 要防的那件事。
  // 我自己上一轮就犯了这个错：加了单点却没让**所有**路径都流经它（同 `markOffline` 那次）。
  assertNoReadFailures('检测期', '源码')

  const all = [...p1.findings, ...p4.findings, ...p3.findings, ...p5.findings, ...(p2 ? p2.findings : [])]
  const hard = all.filter((f) => HARD_RULES.has(f.rule))
  const soft = all.filter((f) => !HARD_RULES.has(f.rule))

  const L = []
  L.push(`空转检测 · idle audit · ${rel(ARGS.root) || '.'}`)
  L.push(`扫描：src ${srcFiles.length} / api ${apiFiles.length} / db+contracts ${dbFiles.length} 文件（已排除 ${testCount} 个测试文件）`)
  L.push('')
  const sections = [
    ['P1 · 命名空间未挂载（硬档）', p1.findings],
    ['P4 · 静默 404（硬档）', p4.findings],
    ['P2 · 空表被读（软档）', p2 ? p2.findings : []],
    ['P3 · 幽灵值（软档）', p3.findings],
    ['P5 · 自称不符（软档）', p5.findings],
  ]
  for (const [title, list] of sections) {
    L.push(`── ${title} ── ${p2 === null && title.startsWith('P2') ? `跳过（${p2Skip}）` : list.length + ' 条'}`)
    for (const f of list.slice(0, ARGS.maxConsole)) L.push(`  ${icon(f)} ${f.rule} · ${f.file}:${f.line} · ${f.symptom}`)
    if (list.length > ARGS.maxConsole) L.push(`  … 其余 ${list.length - ARGS.maxConsole} 条见报告`)
    L.push('')
  }
  L.push(SUMMARY_HEADER)
  // 非阻断记录**必须露出来**（门禁 wb#54 R2 / portal#50 R4）：降级而不中止是对的，但"降级了什么"不写出来
  // 就等于把逃逸静默吞掉。文案与 `--quiet` 尾行**共用同一句**（避免同一消息两份真值 —— 门禁 portal#50 R6 的 :2299），
  // 故由模块级 `notesSummaryLine()` 单点产出。
  {
    const nl = notesSummaryLine()
    if (nl) L.push(nl)
  }
  L.push(`  硬档命中 ${hard.length} 条（P1 ${p1.findings.length} / P4 ${p4.findings.length}）→ 退出码 ${hard.length ? 1 : 0}`)
  // P5 的口径写全（门禁 wb#52 R16 的 :1815 / portal R18 的 :1815）：`findings.length` = core + **强**wide，
  // 而 `wideCount` 是**所有** wide 命中（含只计数的）—— 写成 `core + wide + 资料标签` 会被读成"加得起来"，
  // 其实加不起来（资料标签**不进** findings）。
  {
    const strongN = p5.strongN
    // 参数化写方那部分单独透出（口径与 P5 的 core/wide 同思路）：不写出来的话，"P3 32 条"会被读成
    // 32 条同强度证据，而其中约三分之一是"静态判不出写方传了什么"的弱证据。
    const paramN = p3.findings.filter((f) => f.extra.paramWrite).length
    // ⚠️ 这两行只在**默认（core）模式**下成立（门禁 wb#52/portal#44 R26 的 :2127）：`--p5=wide` 下
    //    每个 wide 词都进 findings ⇒ `findings = core + 强` 这个恒等式不成立（findings 还含"仅计数"那批）。
    //    故按模式分别打印，别让人拿一个在 wide 下不成立的等式去对账。
    const wideMode = ARGS.p5 === 'wide'
    if (wideMode) {
      L.push(`  软档命中 ${soft.length} 条（P2 ${p2 ? p2.findings.length : '-'} / P3 ${p3.findings.length}${paramN ? `（其中 ${paramN} 条**该列有参数化写方**，证据弱一档）` : ''} / P5 ${p5.findings.length}（**--p5=wide 全展开**）= core ${p5.coreN} + 强全称量词 ${strongN} + 仅计数档 ${p5.findings.length - p5.coreN - strongN}）`)
      L.push(`        P5 另有：wide 命中总计 ${p5.wideCount} 条、资料标签 ${p5.labelN} 条（后者不进 findings）`)
    } else {
      L.push(`  软档命中 ${soft.length} 条（P2 ${p2 ? p2.findings.length : '-'} / P3 ${p3.findings.length}${paramN ? `（其中 ${paramN} 条**该列有参数化写方**，证据弱一档：静态判不出调用方传了什么）` : ''} / P5 ${p5.findings.length} = core ${p5.coreN} + 强全称量词 ${strongN}）`)
      L.push(`        P5 另有：仅计数的 wide ${p5.wideCount - strongN} 条、资料标签 ${p5.labelN} 条（两者都不进 findings）`)
    }
  }
  L.push(`  P1 已挂载命名空间 ${p1.mounted.length} 个；其中全仓零调用 ${p1.uncalled.length} 个（登记项，非缺陷）`)
  L.push(`  P4 已挂载 raw 路由 ${p4.routes.length} 条；动态路径（模板插值，静态判不了）${p4.dynamic.length} 条`)
  L.push(`  P3 扫描 SQL 语句 ${p3.stmtCount} 条；DDL COMMENT 权威域 ${p3.domainCols} 列；判据原文列全局差集对照 ${p3.globalOnly.length} 条`)
  // 这一行的数字**必须自洽**（门禁 portal R15 的 :1681）：`findings` = core + 强全称量词，
  // 而 `wideCount` 数的是**所有** wide 命中的行（含默认模式下只计数、不进 findings 的那些）。
  // 原来把 `wideCount` 写成"wide 另 N 条"，看起来像是 findings 之外另有 N 条 —— 与实际不符。
  {
    const strongN = p5.strongN
    L.push(`  P5 词表：findings **${p5.findings.length}** = core（跨件一致性）**${p5.coreN}** + 强全称量词 **${strongN}**；wide 命中总计 **${p5.wideCount}**（其中仅计数 **${p5.wideCount - strongN}**）；资料标签（「真件：…」，降级不计）**${p5.labelN}** 条（--p5=wide 全展开）`)
  }
  L.push(`  用时 ${((Date.now() - started) / 1000).toFixed(1)}s`)

  // ⚠️ **先落文件、再打印**（本次实测踩到）：文件写入原来排在 `process.stdout.write` **之后**，
  // 而 stdout 是管道且被提前关掉时（`| head`、`| Select-Object -First 1`）写会抛 EPIPE ⇒
  // main() 直接进 `.catch`，**JSON/周报一个字都没写**（实测：带 `-First 1` 时 JSON 未落盘，
  // 不截断时正常落盘）。CI 里 `audit:idle:report | head` 正好是这个形态 —— 报告会静默消失。
  // 落盘与打印互不依赖，顺序换过来即可：打印失败不该毁掉产物。
  if (ARGS.json) {
    const jp = path.resolve(ARGS.json)
    fs.mkdirSync(path.dirname(jp), { recursive: true })
    fs.writeFileSync(jp, JSON.stringify({ p1, p2, p3, p4, p5, notes, meta: { root: ARGS.root, at: new Date().toISOString() } }, null, 2))
  }
  if (ARGS.report) {
    const rp = path.resolve(ARGS.report)
    fs.mkdirSync(path.dirname(rp), { recursive: true })
    fs.writeFileSync(rp, renderReport({ p1, p2, p3, p4, p5, p2Skip, hard, cfg, notes }), 'utf8')
  }

  // `--quiet` 的输出由 `quietView(L)` 决定：取「── 汇总 ──」起的**最后一段**（cleanup-tail-r1 ⑤）。
  // （上面那两行旧注释描述的是**已删除的实现** —— "把 notes 行补回末尾 / 仍只留末 8 行"；
  //   门禁 R2 的 :2336 与 R3 指出它与本行代码矛盾，已更正。）
  process.stdout.write((ARGS.quiet ? quietView(L) : L).join('\n') + '\n')
  if (ARGS.report) process.stdout.write(`周报已写：${path.resolve(ARGS.report)}\n`)
  // 门禁 R3 的 :1147 与 R4 的 :1209 两次提到同一件事：`process.exit()` **不等待 stdout 排空**，
  // 而上面那些 `process.stdout.write` 在 stdout 是管道时（CI）是**异步**的 ⇒ 命中几百条时输出
  // 可能被截断 —— 恰好在最需要它的时候（退出码照给，命中列表却缺了）。
  // 改为置 `exitCode` 让事件循环自然排空后退出：本脚本没有长驻句柄（DB 是逐条开的短连接）。
  process.exitCode = hard.length ? 1 : 0
}

function renderReport({ p1, p2, p3, p4, p5, p2Skip, hard, cfg, notes = [] }) {
  /** 非阻断记录进**周报正文**（门禁 portal#50 R5 的 :160 / wb#54 R3 ①）：只进控制台 = 机读/留档面静默丢失。 */
  const notesBlock = () => { if (!notes.length) return; R.push(''); R.push('## 非阻断记录（不中止）'); for (const nt of notes) R.push('- ' + (nt && nt.err ? nt.err : JSON.stringify(nt))) }
  const R = []
  const at = new Date().toISOString().replace('T', ' ').slice(0, 16)
  R.push('# 空转检测周报 · idle audit')
  R.push('')
  R.push(`> 生成：${at} ｜ 仓库根：\`${ARGS.root}\` ｜ 判据：P1–P5（**本脚本头部自带判据摘要，口径以本文件为准**；外部文档《空转检测·查询与判据》在 NumX 侧工作区，**不在本仓**）`)
  R.push('> 硬档（P1 命名空间未挂载 / P4 静默 404）有命中即真 bug，退出码非 0；软档（P2/P3/P5）写入本报告，退出码 0，需人工过。')
  R.push('')
  R.push('## 一、汇总')
  R.push('')
  R.push('| 档 | 项 | 命中 | 说明 |')
  R.push('|---|---|---:|---|')
  R.push(`| 硬 🔴 | P1 命名空间未挂载 | ${p1.findings.length} | 前端调了但 api/router.ts 没挂 ⇒ 100% 失效 |`)
  R.push(`| 硬 🔴 | P4 静默 404 | ${p4.findings.length} | 前端 fetch 的 /api 路径后端无 raw 路由 |`)
  R.push(`| 软 🟠 | P2 空表被读 | ${p2 ? p2.findings.length : '—'} | ${p2 ? '真探针判定' : '本次跳过：' + (p2Skip || '未执行')} |`)
  R.push(`| 软 🟠 | P3 幽灵值 | ${p3.findings.length} | 表作用域「查了但没人写」 |`)
  // 口径必须与上一处自洽（门禁 wb#52 R15 的 :1855）：`findings.length` 是 core + **强**wide，
  // 而 `wideCount` 数的是所有 wide 命中行 —— 原来这里把它写成 `core + wide`，读者按这个式子是加不出来的。
  {
    const strongN = p5.strongN
    R.push(`| 软 🟠 | P5 自称不符 | ${p5.findings.length} | = core ${p5.coreN} + 强全称量词 ${strongN}（wide 命中总计 ${p5.wideCount}，其中仅计数 ${p5.wideCount - strongN}；资料标签 ${p5.labelN} 不计），需人工核对 |`)
  }
  R.push('')
  R.push(`**退出码：${hard.length ? 1 : 0}**（硬档命中 ${hard.length} 条）`)
  R.push('')
  R.push(`扫描面：src ${srcFiles.length} / api ${apiFiles.length} / db+contracts ${dbFiles.length} 文件；已排除 ${testCount} 个测试文件。`)
  R.push('')

  const sec = (title, list, note) => {
    R.push(`## ${title}`)
    R.push('')
    if (note) { R.push(note); R.push('') }
    if (!list.length) { R.push('（0 条命中）'); R.push(''); return }
    R.push('| # | 类别 | 位置 | 一句话症状 |')
    R.push('|---:|---|---|---|')
    list.forEach((f, i) => {
      R.push(`| ${i + 1} | ${icon(f)} ${f.rule} | \`${f.file}:${f.line}\` | ${String(f.symptom).replace(/\|/g, '\\|')} |`)
    })
    R.push('')
  }

  sec('二、P1 · 前端调了、后端没注册的过程名（硬档）', p1.findings)
  R.push(`- 已挂载命名空间 **${p1.mounted.length}** 个（源：\`${p1.routerFile ? rel(p1.routerFile) : '未找到 api/router.ts'}\`）`)
  R.push(`- 前端实际调用到的命名空间 **${new Set(p1.called.map((c) => c.ns)).size}** 个`)
  R.push(`- 🟡 挂了但全仓零调用 **${p1.uncalled.length}** 个（判据判为「登记」，可能给 APP/外部用，**非缺陷**）`)
  if (p1.uncalled.length) {
    R.push('')
    R.push(`<details><summary>展开登记项 ${p1.uncalled.length} 个</summary>`)
    R.push('')
    R.push(p1.uncalled.map((k) => `\`${k}\``).join('、'))
    R.push('')
    R.push('</details>')
  }
  R.push('')

  sec('三、P4 · 静默 404（硬档）', p4.findings)
  R.push(`- 后端已挂载 raw 路由 **${p4.routes.length}** 条`)
  R.push(`- 🟡 前端动态路径（模板插值，静态判不了）**${p4.dynamic.length}** 条`)
  if (p4.dynamic.length) {
    R.push('')
    for (const d of p4.dynamic.slice(0, 20)) R.push(`  - ${rel(d.file)}:${d.line} · \`${d.raw}\``)
  }
  // 门禁 portal R19 的 :1972（第三次提）：`detectP4()` 在 `unresolved.length > 0` 时已 `fail()`，
  // 所以它**永远不会**带着非空 `unresolved` 返回 ⇒ 报告里那段分支是死代码。这轮直接把字段从返回值里去掉，
  // 不再留 `void p4.unresolved` 这种"为了安抚读者"的占位语句（它自己也是一种噪音）。
  R.push('')

  sec('四、P3 · 写入值 vs 查询值不对称 · 幽灵值（软档）', p3.findings,
    `扫描 SQL 语句 **${p3.stmtCount}** 条；DDL COMMENT 权威域覆盖 **${p3.domainCols}** 个列。\n` +
    `排序：**DDL 域外**（双重证据）在前，**DDL 域内**（多半是写路径没扫到）在后。**两条都保留**——` +
    `判据自己把 \`st_ent_agents.status='hired'\` 列为 🔴 已确认例，而该值正在 DDL 域内；若「域内即豁免」，判据的实例会被判据自己的依据否掉。\n` +
    `判据原文的**列全局差集**对照结果 **${p3.globalOnly.length}** 条 —— 与表作用域结果之差即跨表污染量。\n` +
    `「写了没人查」（判据 🟠）本次计数 **${p3.writeOnly}** 次（噪音大，只计数不给行）。`)
  if (p3.globalOnly.length) {
    R.push(`<details><summary>对照：判据原文列全局差集 ${p3.globalOnly.length} 条（展开）</summary>`)
    R.push('')
    for (const g of p3.globalOnly.slice(0, 300)) R.push(`  - ${g.col} = '${g.val}' 读于 \`${g.file}:${g.line}\``)
    R.push('')
    R.push('</details>')
    R.push('')
  }

  sec('五、P5 · 自称与实现不符（软档）', p5.findings,
    `本项**不做判定，只收敛候选**（判据自述「无法全自动」）。已扫注释行 ${p5.commentLines} 行。\n\n` +
    `判据原文给的是**一个**词表；落地实测：该词表在本仓命中 **${p5.coreN + p5.wideCount + p5.labelN}** 行（判据预期「几十行」）——**不可用**。\n` +
    `本脚本按证据把它劈成两层：\n\n` +
    `- **core（默认，本节所列）**=${P5_CORE.map((w) => `\`${w}\``).join('/')} —— 「跨件一致性」断言，判据第五节点名的已知实例全是这个形态；本仓实测 ${p5.coreN} 行，落在「几十行」量级。\n` +
    `- **wide（另计 ${p5.wideCount} 行；其中够格的已进本节）**=${P5_WIDE.map((w) => `\`${w}\``).join('/')} —— 通用全称量词。` +
    `本仓把「一律/绝不/永不/全部」当 fail-closed 论证的**惯用语**（\`未登记的组合一律 none\` 这类实现自述），不是对世界的断言；` +
    `要看得加 \`--p5=wide\`。\n`)

  R.push('## 六、P2 · 有表 0 行却被活代码读取（软档）')
  R.push('')
  if (p2) {
    for (const n of p2.notes) R.push(`- ${n}`)
    R.push('')
    const strong = p2.findings.filter((f) => f.extra.structural)
    R.push(`**P2 命中的分档（本脚本加的，判据原文没有）**：判据说「叠加『有读方』才有信号，否则 208 行噪音」——` +
      `实测叠加后仍有 **${p2.findings.length}** 行，仍是平铺清单。本脚本再叠一层「**本仓零写方**」：` +
      `**${strong.length}** 行（强信号：没有任何本仓代码会写它 ⇒ 读面恒空不是「还没数据」），其余 ${p2.findings.length - strong.length} 行按读方数降序排在后面供抽查。`)
    R.push('')
    R.push(`> ⚠️ **「零写方」只保证本仓（api/+db/）没有写方**——仓外进程/运维脚本仍可能写（例：\`ops_health_checks\` 的注释自述是「服务器指标采集」，采集器不在本仓）。故强信号行**仍需人工确认**，不要直接当 bug 修。`)
    R.push('')
    sec('P2 明细（强信号在前，按读方数降序）', p2.findings)
    if (p2.deadTables.length) {
      R.push(`<details><summary>空表但 api/ 无读方（死表候选）${p2.deadTables.length} 张</summary>`)
      R.push('')
      R.push(p2.deadTables.map((d) => `\`${d.table}\``).join('、'))
      R.push('')
      R.push('</details>')
      R.push('')
    }
    if (p2.probeErrors.length) {
      R.push(`> ⚠️ 探针失败 ${p2.probeErrors.length} 张（锁/权限），已跳过：${p2.probeErrors.slice(0, 10).join('；')}`)
      R.push('')
    }
  } else {
    R.push(`**本次跳过。** 原因：${p2Skip || '未执行'}。`)
    R.push('')
    R.push(`P2 需连生产库（\`${cfg.host}:${cfg.port}/${cfg.database}\`，只读 SELECT）才能判定「哪张表是空的」。`)
    R.push('本脚本**不读任何硬编码口令**（仓纪律 AGENTS.md 第八节），口令一律从环境变量取：')
    R.push('')
    R.push('```bash')
    R.push('IDLE_AUDIT_DB_HOST=127.0.0.1 IDLE_AUDIT_DB_PORT=3307 IDLE_AUDIT_DB_USER=root \\')
    R.push('IDLE_AUDIT_DB_NAME=wb_rebuild IDLE_AUDIT_DB_PASSWORD=*** \\')
    R.push('  npm run audit:idle:report -- --report docs/idle-audit.md')
    R.push('```')
    R.push('')
    R.push('拿不到库时**降级为跳过并说明**（判据授权），不影响 P1/P3/P4/P5 与退出码。')
    R.push('')
  }

  R.push('## 七、阈值与过滤（落地实测后改了什么，为什么）')
  R.push('')
  R.push('判据第七节自述：文中 SQL/grep **未在脚本里跑过**、阈值（40 字符等）**未复核**。以下为落地实测后的逐条调整：')
  R.push('')
  R.push('| # | 判据原文 | 落地改成 | 为什么 |')
  R.push('|---|---|---|---|')
  R.push('| 1 | P1：只留调用点**上下文 40 字符内**的点分名 | 改**调用点锚定**：解析 `wbQuery/useWbQuery/wbMutation/callWb` 的实参，只取 **depth 0** 的字符串字面量 | 40 字符窗口会把实参里的对象字面量、链式调用尾巴一起捞进来；锚定后同文件同行的假阳性归零 |')
  R.push('| 2 | P1：只覆盖 `call(`/`useWbQuery(`/`callWb(` | 补 `trpc.X.Y.useQuery()` 与 `fetch(\'/api/trpc/X.Y\')` | 判据点名的两个已知实例（`arenaBoard`/`agentsMatch`）在仓内**只**以 raw fetch 形态出现——只按原文三种锚点扫会**全部漏掉**，即判据的「已知实例」自己扫不出来 |')
  R.push('| 3 | P1：未提注释 | 先剥注释（行号不变）再扫 | 注释掉的调用点会被算成命中 |')
  R.push('| 4 | P3：`api/ src/` 全域 grep | 一律排除 `*.test.ts` | 测试夹具里全是 SQL 字面量（`UPDATE st_x SET status=\'…\'`），会把「没人写」判成「有人写」——即判据自述的假阳性来源「跨行 INSERT 漏采」同类 |')
  R.push('| 5 | P3：列全局差集 | 主判据改**表作用域**（同语句内表名+列名），列全局差集降为对照指标 | 原文把全库的 `status` 池成一个域：A 表写 `active` 会「救活」B 表读 `active`，跨表污染是噪音主因 |')
  // ⚠️ 这一行原来写"命中即降级为观察项"，与实现不符（门禁 portal R20 的 :2071）：`detectP3()` 明确
  // **不因域内而降级**（判据自己把 `st_ent_agents.status='hired'` 列为已知实例，而那个值就在域内 ——
  // 若"域内即豁免"，判据自己的例子会被自己的依据否掉）。域只作**归因标注**，两条都留在 findings 里。
  R.push('| 6 | P3：建议用 DDL COMMENT 作权威域 | 已实现：`db/*.mts` 的 `COMMENT \'pending=…/active/revoked\'` 解析成域；域内命中**不降级、不丢弃**，只作**归因标注**（域外=双重证据；域内=多半写路径没扫到，两条都在 findings 里） | 判据自己把 `st_ent_agents.status=\'hired\'` 列为已知实例，而该值正在域内 —— 域内即豁免会否掉判据自己的例子 |')
  R.push('| 7 | P2：`TABLE_ROWS = 0` 当空表 | 改**真探针** `SELECT 1 FROM t LIMIT 1`，逐表判定 | 判据同一段写着「真 COUNT，不用 information_schema 估算」，但给的 SQL 正是估算值——两者矛盾，取真探针 |')
  R.push('| 8 | P5：强断言词逐行 grep | 只收**注释行** + 要求「最强断言词」或「行内有技术标识」 | 原文关键词在本仓命中量远超「几十行」，需收窄 |')
  R.push('')
  R.push('## 八、已知覆盖边界（别拿这份报告当全覆盖）')
  R.push('')
  R.push('- **P1 只判到命名空间一级**：命名空间挂上了、过程名不存在，本脚本**不报**（判据原文只要求到命名空间一级）。')
  R.push('- **P4 只覆盖 raw handler**：`/api/trpc/*` 归 P1；模板插值拼出的路径静态判不了，已单列。')
  R.push('- **P3 只覆盖「字面量出现在 SQL / 查询构造器里」的值**：列名/表名由变量拼接、值来自运行时（前端传入、配置、枚举常量）的读写看不见。故 P3 命中**必须人工过一遍再改**（判据第三节同款要求）。')
  R.push('- **P5 天然无法全自动**（判据自述）：只做候选收敛，**不做判定**。')
  R.push('- 扫描排除 `node_modules` / `dist` / `*.test.ts`。')
  R.push('')
  R.push('## 九、怎么跑')
  R.push('')
  R.push('```bash')
  R.push('npm run audit:idle                                       # 打印；硬档命中 → 退出码 1')
  R.push('npm run audit:idle:report -- --report docs/idle-audit.md  # 另写周报（退出码同上）')
  R.push('```')
  R.push('')
  R.push('**CI 建议**：`npm run audit:idle` 作必过步骤，**只让硬档决定退出码**（本脚本已如此）——软档进周报，不阻断。')
  R.push('')
  notesBlock() // 非阻断记录进正文
    return R.join('\n')
}

main().catch((e) => {
  // 工具自身炸了 ⇒ 退出码 2。绝不能与"硬档命中=1"混为一谈：
  // 命中是**结论**，异常是**工具坏了**；原来靠 Node 默认的未捕获拒绝退 1，CI 上分不出是哪种。
  // 与 `fail()` 同理：走**同步** stderr（门禁 portal R6 的 :42-45），免得截断这段解释。
  fs.writeSync(
    2,
    `\n[空转检测·运行异常] ${e && e.stack ? e.stack : String(e)}\n  ⇒ 退出码 2（0=干净 / 1=硬档命中 / 2=工具自身无法给出可信结论）\n`,
  )
  process.exit(2)
})
