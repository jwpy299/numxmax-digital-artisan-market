/** raw SQL 结果集行提取（drizzle mysql2 execute 返回 [rows, fields]）——仓级规范实现（canonical，OCR 批五 R8 + 批六 R4 合并并集，彭总统一双签 2026-09-20）。
 *  terminal.ts 从此处再导出保持向后兼容；新模块直接引这里，不背 terminal 依赖图。
 *  middleware/deptCustom/deviceMcp/entAgent/identityBinding/internDispatch/internJobs/personalAgent/reportBus 等 9 处历史本地副本已登记在案，
 *  随后续批次分批迁移收口（口径先诚实，不冒充「唯一」；名册经 OCR 合并复审 R51⑦ 核验——admin 系直引 canonical 不在列，防后续批次照名册找不存在的副本）。
 *
 *  契约（含写入回包，有意透传；OCR 批五 R18 回归教训登记）：写入语句 drizzle/mysql2 返 [ResultSetHeader, undefined]，
 *  本函数把首元素 ResultSetHeader 原样放行——仓内 60+ 消费方（devices rename/disable/原子认领、devicePlugins、
 *  internalOps 等）经 stQuery/terminal 再导出读 [0].affectedRows/insertId 判写入 ack，此处不得返空集
 *  （R18 护栏曾截断该路径致 devices×4 回归飙红，回退并立此存照）。读方消费写入回包属既有口径。 */
import { createHash } from "node:crypto"; // R7-c138-①：窗键 hash 后缀消歧用（截断前缀碰撞面封死）
import { DrizzleQueryError, type SQLWrapper } from "drizzle-orm"; // 合一单 import（OCR R34④）；instanceof 判别（OCR R9：打包构建不赋 name，靠 name 判别会漏）
import { getDb } from "./connection"; // R112-9 登记：本 import 使本模块（含 rawRows 行提取叶）传递初始化 ./connection（dotenv+drizzle）——
//  节流态/脱敏/行提取同居一文件系批六收口史成；拆分纯叶（rawRows 出）与壳（tryQueryRows/留痕入）归批七评估，台账挂账 P-RAWROWS-SPLIT

export function rawRows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result) && Array.isArray(result[0])) {
    return result[0] as Array<Record<string, unknown>>;
  }
  // 非空非数组原样透传（OCR 批五 R21：与 admin/terminal 旧副本 `(result ?? [])` 口径一致——
  //  若驱动路径给出裸 ResultSetHeader，收窄成 [] 会重演 R18 写入 ack 丢失事故）；
  //  契约假设：drizzle mysql2 execute 恒返 [rows, fields] 元组，本分支仅是历史口径兜底
  return (result ?? []) as Array<Record<string, unknown>>;
}

/** 留痕节流（OCR 批六 R8/R17）：预期态「表未建」每请求 6 条 console.error 是噪音洪水——
 *  同 tag+同错误签名 60s 内只记一条，保信号不刷屏；窗口内新错误类不被旧洪水吞掉 */
const LOG_THROTTLE_MS = 60_000;
/** 顺扫启动阈值（OCR R23）：小图不扫，超过才清；写入后收严共用同一清扫实现（R36③） */
const LOG_PRUNE_MIN_KEYS = 256;
const SWEEP_INTERVAL_MS = 10_000; // 清扫摊还间隔（OCR R38③）
const HARD_LOG_KEYS = LOG_PRUNE_MIN_KEYS * 8; // 全活洪水硬顶（R38③/R95-9：直锚软顶 8 倍自证关系，LOG_KEY_BASE 间接层摘除——旧注「4 倍软顶」错口径一并绝根）：超过即单趟淘汰回收，软顶不杀活窗的承诺只到本线
const SIG_KEY_MAX = 200; // 节流键内签名限长（OCR R47③+R52③ 提名：HARD_LOG_KEYS 只顶数量不顶字节；200 已足够区分错误类，R19 不截断的判别意图不受损）
const FLAT_TEXT_MAX = 300; // 自由文本压平限长（OCR R48③+R52③ 提名：裸换行伪造日志行通道关闭、原文长度有界）
const SCRUB_INPUT_MAX = 4_000; // 脱敏链入料封顶（OCR R67② performance）：near '[\s\S]*' 每命中点重启贪婪扫=O(n²)，
//  原文无界在降级风暴同周期（多路 tryQueryRows 全灭）放大；终文本本就限 FLAT_TEXT_MAX，4K 前置封顶足留 code/表名/出错片段语境
const QUERY_FAILED_FALLBACK = "query failed"; // 兜底话术单源（OCR R60⑥）：测试/triage 认这串=契约，不再内联多处
const QUERY_FAILED_QUOTE_FRAGMENT = `${QUERY_FAILED_FALLBACK}（含不可配对引号片段）`; // 同前缀派生（OCR R61⑧）：契约前缀一改全改
const DRIZZLE_FALLBACK = "DrizzleQueryError"; // 固定字面量单源（R18：打包改名防护，同串多处提名）
const UNTAGGED_SINK_TAG = "rawQuery.untagged"; // 无汇兜底 tag 单源（R59⑧/R60⑥）
const DEFAULT_DEGRADED_LABEL = "raw query degraded"; // 默认类别标签单源（R43⑤/R60⑥）
const SCRUB_PAIR_ROUNDS_MAX = 4; // 成对抹除循环轮上限单源（OCR R92-5）：唯一防病态 de-quote 死循环的闸，提名入列不再裸字面值
const QUOTE_SPAN_MAX = 120; // 尾刀/补刀跨度界单源（OCR R92-5 同单）：tail/patch 两式同引，跨度漂移改一处
/** 引号 scrub 规则预编译（OCR R74-7）：' ` " 三族 × 尾刀/补刀两式，模块加载编译一次 */
const QUOTE_SCRUB_RULES = (["'", "`", '"'] as const).map((q) => { // R76-3：双引号用字面量，fromCharCode 晦涩且与同行兄弟不一致
  const ph = `${q}…${q}`;
  return {
    ph,
    tail: new RegExp(`${ph}[^${q}\\n]{0,${QUOTE_SPAN_MAX}}${q}(?![A-Za-z…])`, "g"),
    patch: new RegExp(`${ph}[^\\s${q}\\n]{1,${QUOTE_SPAN_MAX}}${ph}`, "g"),
  };
});

const MAX_CAUSE_HOPS = 5; // cause 链走查深度单源（OCR R60⑤/R111-13 符号迁移）：sanitize/collectThrottleFacts（原 throttleTableOf，R103-3 收口）同界，键/行深度不再分叉
const MYSQL_ERR_QUERY_TIMEOUT = 3024; // MAX_EXECUTION_TIME 服务端杀语句=ER_QUERY_TIMEOUT（R65⑨ 立/R66⑤ 拆吞痕短路，R67③ 复立作分类映射）
export const DB_TIMEOUT_LABEL = "db 超时"; // 超时类别词单源（OCR R67③）：rawRows 服务端 3024 映射与 withTimeout 壳 JS 定时器支同词，导出单源不养第二份字面值
const TAG_LABEL_MAX = 80; // tag/label 压平限长单源（OCR R61④）：两处 .slice(0,80) 内联收口
const TABLE_KEY_MAX = 120; // 节流键表名片段限长（OCR R58⑨ 提名）：与 SIG_KEY_MAX/CODE_KEY_MAX 同列，键长三兜底齐
const CODE_KEY_MAX = 100; // 白名单 code 限长（OCR R58⑧ bug low 提名）：字符集白名单只管字符不管长度，纯 [A-Za-z0-9_] 长串会原样
//  穿透让日志行/sig 挣脱 FLAT_TEXT_MAX（此前仅 SIG_KEY_MAX 间接兜底、console.error 行完全无顶）；100 足够 ER_* 码/SQLSTATE 判别
/** code 出口白名单（OCR R52⑤ + R54③ security）：压平限长管得住伪造行/行宽，管不住 code 里内联绑定值
 *  （code="near 'SECRET' at line 1" 形态会原文落日志）——mysql2/SQLSTATE 错误码恒为 [A-Za-z0-9_]，
 *  非白名单形态一律不落原文（判别力靠白名单内的 ER_ 系与 SQLSTATE 码，异常形态丢码保密） */
function flattenCode(code: string): string {
  return /^[A-Za-z0-9_]+$/.test(code) ? code.slice(0, CODE_KEY_MAX) : ""; // 白名单+截断（OCR R94-6 注释诚实化）：非白名单字符（含空白/换行）整码丢 ""——与 flatTag/flatLabel 的 \s+ 压平不同义，伪造行防线由白名单达成而非压平
}

/** code-only 降级单点（OCR R60④）：顶层/cause/最深鸭式三处同一形态不再三抄——白名单+限长口径一改全改，
 *  本文件头注登记的历史回归源就是这类相邻单点化漏网后的三抄漂移 */
function codeOnlyFallback(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const fc = flattenCode(v);
  return fc !== "" ? fc : null;
}

/** 「code 在场即返回、否则落兜底」续形单点（OCR R95-10）：topCode/causeCode/duckCode 三分支曾各抄
 *  { const fc = codeOnlyFallback(x); if (fc !== null) return fc; }——值规则与续形同点，漂移不再三面 */
function codeOnlyOr(v: unknown, fallback: string): string {
  return codeOnlyFallback(v) ?? fallback;
}
const lastLogAt = new Map<string, number>();
let lastSweepAt = 0;

/** 过期键清扫单点（OCR R18/R20/R23 + 合并复审 R36②③）：顺扫与写入后收严同一规则同一实现——
 *  size 超 threshold 才扫，只删过期键；签名键来自半结构化错误文本，长驻进程防 Map 无界增长。
 *  不逐活键（OCR R35⑥）：逐活键=作废其 60s 节流窗，异质错误洪水期防洪闸反失效；
 *  全活允许短暂超限（增长上界=洪水速率×60s，下一窗口自然回收）。过期判定一律看时间戳
 *  （Map.set 原位更新不刷新插入序，按 keys() 序逐会误杀刚刷新窗口的键） */
function sweepExpiredThrottleKeys(now: number, threshold: number): void { // R111-3：force 死参摘除（两调用点均不传，摊还闸恒生效）
  if (lastLogAt.size <= threshold) return;
  // 摊还（OCR R38③）：洪水期每次调用全图 O(n) 清扫=二次方 CPU 放大负载，10s 一扫足够；
  if (now - lastSweepAt < SWEEP_INTERVAL_MS && lastLogAt.size <= HARD_LOG_KEYS) return; // R111-3：摊还闸恒生效（force 支随死参摘除——R39① 的收严短路顾虑已由 R110-13 去 force 一并消解）
  lastSweepAt = now;
  for (const [k, t] of lastLogAt) if (now - t >= LOG_THROTTLE_MS) lastLogAt.delete(k);
  // 硬兜底（R38③，与 R35⑥ 平衡；R69-14 对齐常量）：清扫后仍超 HARD_LOG_KEYS（=LOG_PRUNE_MIN_KEYS*8=8 倍软顶——R96-8：LOG_KEY_BASE 已摘除，公式指向活常量）=全活洪水（本身已是事故）——
  //  回收到硬顶，丢几个活窗换进程内存不垮；常态路径（有过期键可清）永不触及。
  //  单趟淘汰（OCR 合并复审 R50⑧）：逐最老 while 每轮全图重扫是 O(n²)，错误风暴期在已降级系统上再叠二次方 CPU——
  //  单趟从 Map 头部取最老 overflow 个（R90-16 取代 R50⑧ 排序版：Map 序=新鲜度序——R94-15 同块互矛注释清账，不再找不存在的排序逻辑），洪水路径不放大淘汰开销
  if (lastLogAt.size > HARD_LOG_KEYS) {
    // 单趟淘汰（OCR R90-16 perf medium）：Map 序=新鲜度序（写入处 delete+set 沉尾），从头部取 overflow 个即最旧——
    //  不再全图排序 O(n log n)，洪水期每新键入列只付 O(overflow)
    let overflow = lastLogAt.size - HARD_LOG_KEYS;
    for (const k of lastLogAt.keys()) { if (overflow <= 0) break; lastLogAt.delete(k); overflow -= 1; }
  }
}

/** 测试复位钩子（仓级惯例同 snapshots.ts __resetXxxForTest）：节流表为模块全局态，不断言顺序（OCR R17） */
export function __resetQueryLogThrottleForTest(): void {
  lastLogAt.clear();
  lastSweepAt = 0; // 墙钟闸也复位（OCR R39②）：否则清扫行为跨用例顺序依赖
  benignWarnAt.clear(); // R7-c87-⑥：良性道窗态同复位（跨用例泄漏=顺序依赖面封死——warnThrottled 可测性钉）
}

/** Drizzle 原文指纹单源（R7-c121-③ maintainability）：isDrizzleLike 判别与 warnThrottled 入口守卫同引——
 *  双字面量各持一份=漂移即守卫静默失效（原始 SQL+绑定参数经 benign 道落 console=泄密面 reopen） */
const DRIZZLE_FAILED_QUERY_PREFIX = "Failed query:";
/** 入口守卫用预编译正则（R7-c121-③/R7-c122-⑤/R7-c124-①/R7-c134-③）：指纹段转义插值（常量未来引入元字符不炸不变）；
 *  有意语义差声明：本守卫大小写不敏感（sink 纵深防御——大小写变体亦拦），isDrizzleLike 判别大小写敏感（精确形态判别）——非锁步承诺，系分工；
 *  R7-c124-①/R7-c134-③：mysql2 驱动层语法回显指纹收紧专属形态（near '…' at line N 成对——散文含 " near '" 的良性文本不误吞；
 *  驱动层裸错内嵌 SQL 片段照样拦）；本守卫系纵深兜底——边界诚实化：启发式非全量证明——【静态/预脱敏文本】前置契约不变
 *  （原始错误对象恒走 logQueryErrorThrottled 脱敏链；命中即整文拒——triage 线索让位泄密面） */
const DRIZZLE_RAW_TEXT_RE = new RegExp(`${DRIZZLE_FAILED_QUERY_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|params: \\[|\\bnear\\s'[^']{0,120}'\\s+at line`, "i");

/** Drizzle 包装形态判别单点（OCR 合并复审 R34④）：instanceof + 指纹文本特征双通道——
 *  sanitize 入口与 cause 链逐层判定共用同一谓词，不再两处各抄一份致口径漂移 */
function isDrizzleLike(e: unknown): boolean {
  return e instanceof DrizzleQueryError || (e instanceof Error && e.message.includes(DRIZZLE_FAILED_QUERY_PREFIX)); // R7-c121-③：指纹常量同引
}

/** error-like 朴素对象归一化单点（OCR 合并复审 R54⑦）：{message} 鸭式对象 → Error（键过滤拷贝保 code 等附加字段，R65⑧），
 *  顶层入口/drizzle cause/deepest cause 三处同引——三抄必漂移（R37④/R35⑧/R38②/R39⑦ 同口径的承载点） */
function asErrorLike(obj: unknown): Error | null {
  const msg = (obj as { message?: unknown }).message;
  if (typeof msg !== "string") return null;
  // 键过滤拷贝（OCR R65⑧）：Object.assign 全量搬不可信自有键——`__proto__` 经 [[Set]] 触发原型 setter
  //  会污染新 Error 的原型链，stack/name 可被伪造出处——诊断字段（code/errno 等 driver 附加键）照保，
  //  原型三键与 message/stack/name 不搬（message 已由构造器落位，与构造入参同源不丢信息）
  const err = new Error(msg);
  for (const k of Object.keys(obj as Record<string, unknown>)) {
    if (k === "message" || k === "stack" || k === "name" || k === "__proto__" || k === "constructor" || k === "prototype") continue;
    // R115-3 bug low：逐键读入 try——不可信对象的 accessor/Proxy 键抛错不再整链塌缩成 query failed（ER_* 码/表名照保）
    try { (err as unknown as Record<string, unknown>)[k] = (obj as Record<string, unknown>)[k]; } catch { /* 跳过肇事键 */ }
  }
  // cause 显式携带（OCR R84-19 bug low）：Error 的 cause 是非枚举自有键，Object.keys 循环搬不到——
  //  递归入口拿到的 err 若丢 cause，深层 driver 错（ER_* 码/表名）被截停在 hop5，与 collectThrottleFacts（原 throttleTableOf）走链深度分叉
  if ("cause" in (obj as object)) (err as { cause?: unknown }).cause = (obj as { cause?: unknown }).cause;
  return err;
}

// 3024 语义存照（OCR R66⑤/R69-5）：MAX_EXECUTION_TIME 杀语句=ER_QUERY_TIMEOUT；
//  判别器未摘除——MYSQL_ERR_QUERY_TIMEOUT 常量现役消费端=collectThrottleFacts 的 facts.serverKill 支（R103-3 单趟走查，原 isServerTimeoutKill 已收口）；R79-3：行号随文件生长即腐，只锚符号名；R104-11：符号迁移同步点名
//  此处注释此前误称「随之摘除」，按 R69-5 修正以免误导后续维护者误删活逻辑

/** SQL/参数脱敏单点（OCR R11/R12/R14，全链唯一出口）：
 *  - 顶层或 cause 任意深度出现 DrizzleQueryError（含双打包/缩容构建致 instanceof 漏判的
 *    "Failed query:" 文本特征兜底）→ 只拆到 driver cause 递归处理，message 绝不原样下传；
 *  - driver/普通 Error：引号片段（可能内联绑定值：Duplicate entry '<v>' / near '<frag>'）一律抹除，
 *    mysql2 错误码（ER_*）前置保「表未建 vs 库抖动」判别力；
 *  - 无法归类的形态只落 "query failed"（不带任何原文），绝不赌"message 应该干净"。
 *  残余例外如实登记（OCR R45①）：绑定值「未加引号」裸拼进 message 的包装层（如 `token ${x} invalid`）
 *  不在抹除范围——MySQL/driver 错误文本一律给片段加引号（本链抹除面的前提），裸拼属封装层违规；
 *  纪律：上层封装不得把秘密/绑定值裸拼进 Error.message，要拼就加引号（进抹除面）。
 *  （JSDoc 归位 OCR R51③：本块此前叠在 isDrizzleLike 上方被吞挂，sanitizeQueryError 反而裸奔无文档） */
function sanitizeQueryError(e: unknown, depth = 0): string {
  try {
    if (e === null || typeof e !== "object") return QUERY_FAILED_FALLBACK;
    if (depth > MAX_CAUSE_HOPS) return `${QUERY_FAILED_FALLBACK}（包装层级过深）`; // 深度与 MAX_CAUSE_HOPS 同源（OCR R61③）：守卫不再钉死 4 与走链界分叉
    // 顶层 error-like 朴素对象归一化（OCR R39⑦，与 cause 分支 R35⑧/R38② 同口径）：
    //  driver/worker 直抛 {code,message} 非 Error 时原路径只落 "query failed"，ER_* 码/表名全丢、键行不一致
    if (!(e instanceof Error)) {
      const topNorm = asErrorLike(e); // 归一化单点（OCR 合并复审 R54⑦：顶层/cause/deepest 三处同一形态同一出口，不再各抄漂移）
      if (topNorm) return sanitizeQueryError(topNorm, depth + 1);
      const topCode = (e as { code?: unknown }).code; // code-only error-like（OCR R47④）：{code,errno} 无 message 也保 ER_* 判别信号
      const topFc = codeOnlyFallback(topCode); if (topFc !== null) return topFc; // R95-10 值规则同引；R96-7：本支三支（码→链→兜底）续形不适用 codeOnlyOr
      const topCause = (e as { cause?: unknown }).cause;
      // R96-7 bug medium：顶层 error-like 无自有 message/code 时续走 cause 链再兜底——throttle 系 walkCauseChain 本就走链，
      //  本支提前 bail 会让日志行落「query failed」而节流键仍带表名/错误码（键/行分叉，正是周边注释宣称已闭合的形态）
      if (topCause !== undefined && topCause !== null) return sanitizeQueryError(topCause, depth + 1);
      return QUERY_FAILED_FALLBACK;
    }
    const msg = e.message; // 非 Error 已在入口归一化/退出（R39⑦），此处 e 恒为 Error（OCR R41③拆死分支）
    if (isDrizzleLike(e)) { // R17：前缀包装（pool: ${inner.message}）也拆包，marker 不限行首；判别走单点（R34④）
      const cause = (e as { cause?: unknown }).cause;
      if (cause instanceof Error) return sanitizeQueryError(cause, depth + 1);
      // 非 Error 的 error-like cause（OCR 合并复审 R35⑧：driver/worker 透传的 {code,message} 朴素对象）——
      //  同样走脱敏链，保住 ER_* 错误码「表未建 vs 库抖动」判别力；与 collectThrottleFacts（原 throttleTableOf）/dupEntry.hasCauseChainMatch 鸭式口径一致
      const causeNorm = cause !== null && typeof cause === "object" ? asErrorLike(cause) : null; // 归一化单点（R54⑦）
      if (causeNorm) return sanitizeQueryError(causeNorm, depth + 1);
      const causeCode = (cause as { code?: unknown } | undefined)?.code; // 与 R47④/R35⑧ 同口径（OCR R48⑥）：code-only cause 也保 ER_* 判别信号
      return codeOnlyOr(causeCode, DRIZZLE_FALLBACK); // R95-10：同折（DRIZZLE_FALLBACK 固定字面量 OCR R18：esbuild 打包会把类表达式改名 _DrizzleQueryError，测试/生产两套文案）
    }
    { // 块保留仅为作用域（OCR R41③：e 恒为 Error，恒真 if 守卫已拆，不再伪装成分支；R90-17 登记：拆块动控制流的风险大于收益，保留作用域块+注释，最深层信号缺失时落外层脱敏为有意行为）
      // 普通包装层（池/重试 new Error(msg, {cause})）：cause 链逐层找 DrizzleQueryError 拆包
      //  （OCR R12/R14 + 合并复审 R32，与 dupEntry.hasCauseChainMatch 同口径逐层走链）——多级普通包装
      //  （Error→Error→DrizzleQueryError）停在浅层会把 driver 错误码（ER_*）截胡，只剩外层通用文案
      let cause = (e as { cause?: unknown }).cause;
      let deepest: unknown; // 最深 cause 跟踪（OCR R37③）：非 drizzle 包装的 driver 错（ER_*）藏在普通包装下时
      for (let hops = 0; hops < MAX_CAUSE_HOPS && cause !== undefined && cause !== null; hops += 1) { // 与 collectThrottleFacts 同界（OCR R60⑤/R111-13）：sanitize 提得到表名的深度 facts 也够得着，键/行不再不一致
        if (isDrizzleLike(cause)) {
          return sanitizeQueryError(cause, depth + 1);
        }
        deepest = cause;
        cause = (cause as { cause?: unknown }).cause;
      }
      // 链上有隐藏 cause 但不是 drizzle 形态 → 递归最深对象节点（R37③）：
      //  停在外层包装只剩 "connector failed" 通用文案，ER_* 码与表名全丢（collectThrottleFacts 却取得到，键/行不一致）
      if (deepest !== undefined && typeof deepest === "object") {
        // error-like 朴素对象归一化（OCR R38②，与 isDrizzleLike 分支 R35⑧ 对称）：
        //  非 Error 对象直接递归会在「非 object Error」判上掉进 "query failed"，ER_* 码/表名全丢
        const duckNorm = asErrorLike(deepest); // 归一化单点（R54⑦）
        if (duckNorm) return sanitizeQueryError(duckNorm, depth + 1);
        const duckCode = (deepest as { code?: unknown }).code; // code-only error-like（R47④）：最深节点只有 code 也保信号
        { const fc = codeOnlyFallback(duckCode); if (fc !== null) return fc; } // R95-10 值规则同引；R106-12：codeOnlyOr 空串代理判是误用（本支无固定兜底字面值，空信号须落回外层脱敏路径 R47④ 不短路）——回直引
        // 最深节点无可读信号 → 落回外层包装自身脱敏路径（R47④：不短路外层的 code/message）
      }
      let code: unknown; // R115-14 bug low：主路 code 读入 try——抛错 getter/Proxy 不再把整句塌缩成 query failed（同 collectThrottleFacts R112-10 口径）
      try { code = (e as { code?: unknown }).code; } catch { code = undefined; }
      // drizzle 形态（<sql>\nparams: <未加引号绑定值>）若文本前缀判别漏判，params 段无引号可抹——
      // 先整段截断再抹引号片段（OCR R14/R15：Duplicate entry '<v>' / near '<frag>' 同理）
      const inputTruncated = msg.length > SCRUB_INPUT_MAX; // R84-16 security low：截断可能切断引号对——下游补网只认成对/占位形态
      let scrubbed = msg.slice(0, SCRUB_INPUT_MAX) // 入链先封顶（OCR R67②）
        .replace(/\nparams:[\s\S]*$/, "\nparams: …")
        // MySQL 解析错把出错片段整体再包一层引号（near '...= 'SECRET'' at line N）：成对匹配会漏出中间绑定值——
        //  该形态 fail-closed 整段占位，再做成对抹除（OCR R17）
        .replace(/near '[\s\S]*' at line/g, "near '…' at line");
      // 成对抹除循环至稳定（OCR R21：孤立撇号如 Can't 抢配开头会致 'db.st_x' 右半漏抹）——
      //  每轮把已抹占位固定、残余片段重新配对；轮上限单源 SCRUB_PAIR_ROUNDS_MAX 防病态输入死循环（OCR R92-5）
      for (let i = 0; i < SCRUB_PAIR_ROUNDS_MAX; i++) {
        const next = scrubbed
          .replace(/'[^']*'/g, "'…'")
          .replace(/`[^`]*`/g, "`…`")
          .replace(/"[^"]*"/g, '"…"');
        if (next === scrubbed) break;
        scrubbed = next;
      }
      // 防御尾刀（OCR R21）：抢配后残留在占位符之后的标识符+落单引号（'…'db.st_x'）整段抹除；
      //  不匹配空格开头，收缩词（Can't/doesn't）不受影响
      // 尾刀/补刀三引号同模板参数化（OCR 合并复审 R35⑤）：' ` " 三族同一套规则，quote 字符驱动生成——
      //  {0,120} 界、负向前瞻、夹层空白判只维护一份，不再三份抄录漂移（本文件反复登记的回归源）
      //  尾刀（OCR R23）：含空格绑定值也抹（\n 除外不碰 params 段）；闭引号后随字母=收缩词撇号不算右界（负向前瞻），
      //  前瞻同排除省略号（否则吞下一占位符开引号，'…' for key '…' 塌成 '…'…'，R25）
      //  补刀（OCR R26）：值内转义引号致配对错位，残留夹在两占位符间且不含空白时并入（保结构词，R25）
      // 模块级预编译（OCR R74-7 perf low）：固定引号集派生规则只编译一次——失败风暴路径不再每次 6 趟
      //  new RegExp 编译+分配（且消除 ${q} 插值进 pattern 的元字符隐忧，引号集无正则元字符方安全）
      for (const { ph, tail, patch } of QUOTE_SCRUB_RULES) {
        scrubbed = scrubbed.replace(tail, ph).replace(patch, ph);
      }
      // 补网（OCR R27）：占位符紧邻单词字符 = 配对已错位（值内引号+空格形态 '…'Brien Smith'…'：
      //  夹层含空白不被上行补刀并入，尾刀又把残余引号拼回占位符），终网看不到裸引号 → 片段会漏进日志；
      //  fail-closed 整句降级，三条引号线同判；只命中 \w（字母/数字/_）——占位符后跟 . , ) 等标点属合法
      //  结构（`db`.`child` 点分隔标识符、'…' for key '…' 结构词），不误伤
      if (/'…'\w|`…`\w|"…"\w/.test(scrubbed)) {
        scrubbed = QUERY_FAILED_QUOTE_FRAGMENT; // 派生常量（OCR R61⑧）
      }
      // 截断缺口补网（OCR R84-16 security low）：截断切在引号值中段且首字符不落边界集时，成对/尾刀/终网全不接——
      //  残余 ~300 字符绑定值会进日志行+节流键；截断发生后若仍残奇数引号（任一族）即 fail-closed 整句占位
      if (inputTruncated && scrubbed !== QUERY_FAILED_QUOTE_FRAGMENT) {
        const odd = (q: string) => (scrubbed.split(q).length - 1) % 2 === 1;
        if (odd("'") || odd("`") || odd('"')) scrubbed = QUERY_FAILED_QUOTE_FRAGMENT;
      }
      // 终网（OCR R23）：摘掉占位符后仍有「裸引号+标识符」残留（落单尾引号 'SECRET 等形态）→ 整句不可信，只保错误码；
      //  收缩词 doesn't/Can't 两侧皆字母，不命中边界形态，不误伤
      const stripped = scrubbed.replace(/'…'|`…`|"…"/g, "");
      // 只命中前缀形态（OCR R26：尾部「字母+引号+空白/行尾」是 Can't/doesn't 收缩词或尾刀残留，
      //  吞掉会把 errno/错误码外的诊断全灭）；x='secret（引号邻 = 后接字母）也在此列
      if (/(^|[^A-Za-z])['"`][A-Za-z0-9_.$-]/.test(stripped)) { // R114-12 security medium：前置字符集枚举改「前置非字母」——冒号直贴（R44④）与 -/+/)/@/! 等任意前置同兜（收缩词 doesn't/Can't 前置为字母不受影响）；边界枚举漏一即漏一类
        scrubbed = QUERY_FAILED_QUOTE_FRAGMENT; // 派生常量（OCR R61⑧）
      }
      // 自由文本一律压平+限长（OCR R48③ security）：裸换行会伪造日志行（假 [tag] 行），原文长度无界——
      //  判别力靠 code 前缀，文本只留单行 300 字符
      const flat = flattenText(scrubbed).slice(0, FLAT_TEXT_MAX); // R7-c155-⑯：归一走单点（控制字符剥离同纪律——事故道不弱于良性道；限长提名 OCR R52③）
      // code 与 flat 同口径（OCR R52⑤）：同为外部文本，压平+限长后再拼接——拼接发生在压平之前的旧形态会让
      //  含换行的 code 伪造日志行、且整行挣脱 FLAT_TEXT_MAX 约束
      const safeCode = typeof code === "string" ? flattenCode(code) : "";
      if (safeCode) return `${safeCode}: ${flat}`;
      return flat || QUERY_FAILED_FALLBACK; // 空签名兜底（OCR R69-6 bug low）：空串会落空白日志行并塌成同一节流键 tag||
    }
  } catch {
    return QUERY_FAILED_FALLBACK; // 脱敏环节自身抛错不得破坏 fail-closed 契约
  }
}

export interface TryQueryOptions {
  /** 低噪留痕 tag：内置 console.error（60s 内 tag+表名+脱敏签名相同才只记一条，见 logQueryErrorThrottled R33/R43④）——预期态降级（表未建）不刷屏的唯一可靠路径（OCR R9） */
  tag?: string;
  /** 自定义留痕回调（抛错被隔离，不破坏 fail-closed）——每次失败都调用（OCR R21：
   *  回调可能是指标/告警/审计汇，节流会静默丢失败；落日志的节流责任在调用方汇）。
   *  只有内置 console.error 走 tag 的 60s 节流 */
  onError?: (message: string) => void; // 收到的是脱敏后字符串（非 Error 对象），勿读 .stack（OCR R15）
}

/** 带 fail-closed 降级的 raw 查询共享单点（OCR 批六 R4/R5/R7/R8）：
 *  表未建/库抖动/列漂移 → 返回 null（降级话术由各调用方按表名自定义，不落第二处口径）；
 *  adminAnalytics/opsTickets/training 三路共用，"查询失败即降级"契约不再分叉。
 *  留痕安全契约（本函数强制兑现，调用方无需自卫）：
 *  - drizzle 的 DrizzleQueryError.message 内含完整 SQL + 绑定参数（token/factoryId），
 *    绝不原样下传——只给 driver cause message（如 ER_NO_SUCH_TABLE）（OCR R5）；
 *  - 非 DrizzleQueryError 的普通 Error（getDb 构造失败/驱动层错）下传 e.message 保判别力（OCR R8）；
 *  - String(e) 可能抛（null 原型对象/暴走 toString）——脱敏环节自身也隔离（OCR R7）；
 *  - onError/内置日志任何抛错都被隔离，留痕失败永不破坏"降级返回 null"契约。 */
export async function tryQueryRows(
  query: SQLWrapper,
  opts?: TryQueryOptions,
): Promise<Array<Record<string, unknown>> | null> {
  const { tag, onError } = opts ?? {};
  try {
    return rawRows(await getDb().execute(query));
  } catch (e) {
    // 脱敏惰性化（OCR 合并复审 R49④ performance）：生产调用方全走 tag 节流（logQueryErrorThrottled 内部重算同一脱敏链），
    //  无条件预跑会让每条失败查询在降级风暴路径（缺表时 ~50 路 tryRows 全灭）白付两遍正则管道——仅 onError 需要时才算
    const safe = onError ? sanitizeQueryError(e) : ""; // 全形态 SQL/参数脱敏单点（OCR R11/R12/R14）
    // onError 恒调（OCR R21：回调可能是指标/告警/审计汇，不只日志——静默丢失败比洪水更危险，节流责任在调用方汇）；
    // 只有内置 console.error 走 tag 节流。签名已被上游脱敏（引号片段=占位符），脱敏后文本相同的错误在窗口内塌缩；
    // 逐表信号由 collectThrottleFacts（原 throttleTableOf，R103-3 收口）提取的表名进 key 保留（见 logQueryErrorThrottled R33）——新错误类（码/文本不同）永远放行（OCR R41⑨注释对齐实现）
    try {
      onError?.(safe);
    } catch {
      // 留痕失败不得破坏 fail-closed 契约
    }
    // 内置 console.error 走 tag 节流（OCR 合并复审 R32/R33：与 withTimeout 超时留痕同一出口；脱敏在节流器内重算，R49④ 后不再预跑两遍）
    if (tag) { // 双汇免二遍（OCR R50⑦）+ 边界自执行（R52④）：onError 已算 safe 则走模块内直调（恒为脱敏输出）；无 onError 走公开入口（壳内自算，R49④ 惰性化不白跑）
      // 3024 不再短路（OCR R66⑤ bug medium，推翻 R65⑨ 前提）：R65⑨ 假设挂死语句（MAX_EXECUTION_TIME 服务端收尾，
      //  errno 3024）必已被 withTimeoutOrNull 按「db 超时」留痕——但该壳只在 JS 定时器先到时才进 catch；查询在 p() 内
      //  先于 withTimeout 派发（实参先求值），MySQL 死线武装更早、常态先杀——本函数吞 3024 resolves null，壳永不进 catch，
      //  组合壳调用方（adminAnalytics/dbSection）、裸调方（opsTickets tryQueryRowsWithTag）、无 hint 的服务器级 kill
      //  全部零留痕。改回不短路：JS 定时器先赢的罕见序下会双痕——两路签名不同（WB_DB_TIMEOUT vs ER_QUERY_TIMEOUT），
      //  节流键不同不会被塌缩，同一事故出两条近似行（仅类别同归「db 超时」标签）——已登记接受的已知重复（OCR R75-12 诚实化），onError 指标汇照调不变
      if (onError) logThrottledWithSig(tag, e, safe);
      else logQueryErrorThrottled(tag, e);
    } else if (!onError) {
      // 无汇不落静默（OCR R59⑧）：tag/onError 皆缺的调用方此前失败零留痕——故障在日志与指标里完全不可见；
      //  塌到通用 tag 进同一脱敏+节流链。收窄（OCR R61②）：有 onError 无 tag 的调用方（指标/审计汇）不再被
      //  额外 console.error 双报，也省一遍脱敏管道（safe 已为其算过，节流器内会重算）
      logQueryErrorThrottled(UNTAGGED_SINK_TAG, e);
    }
    return null;
  }
}

/** cause 链同程走查骨架单源（OCR R95-13 maintainability）：throttleTableOf/throttleCodeOf/isServerTimeoutKill 三处
 *  曾各自实现「每级 MAX_CAUSE_HOPS 跳循环 + 最深节点续递归」——R72-9/R93-14/R75-15 三轮注释锁步即漂移税
 *  （throttleTableOf 漏 typeof 守卫与另两处分叉已实证）；骨架单源后节点判别各自传入，深度语义一改全改。
 *  （R103-3 续：三个节流函数已收口为 collectThrottleFacts 单趟走查，本骨架现役唯一消费端即 facts）
 *  visit 返非 null 即命中上抛；容错同纪律（R83-13：getter 抛错不得炸穿留痕链） */
function walkCauseChain(e: unknown, depth: number, visit: (node: object) => string | null): string | null {
  if (e === null || typeof e !== "object" || depth > MAX_CAUSE_HOPS) return null;
  let cur: unknown = e;
  for (let hops = 0; hops < MAX_CAUSE_HOPS && cur !== undefined && cur !== null; hops += 1) { // 与 sanitize 同界（OCR R60⑤）
    if (typeof cur !== "object") return null; // 原始型节点无信号（R95-13：三处同守不再分叉）
    const hit = visit(cur);
    if (hit !== null) return hit;
    // R115-2 bug low：cause 读同入节点级容错——抛错 getter/Proxy 的 cause 访问不再炸穿整链（visit 已被各调用点节点级 try 护，walker 自身进度读亦护）
    try { cur = (cur as { cause?: unknown }).cause; } catch { return null; }
  }
  if (cur === undefined || cur === null) return null; // 链已终结不再递归空转（OCR R75-15）
  return walkCauseChain(cur, depth + 1, visit); // 递归同程（OCR R72-9）：深包装链信号必达键
}


/** 节流键信号一次走查（OCR R103-3 perf low）：此前 throttleTableOf/throttleCodeOf/isServerTimeoutKill 三趟独立走链，
 *  且全在 60s 节流查表之前付——降级风暴期每条失败查询为至多一行日志付全链遍历×3+正则×N。单趟收齐 table/code/3024，
 *  三齐即早退；键成分与 R78-8/R93-20 口径逐项不变 */
interface ThrottleFacts { table: string; code: string; serverKill: boolean }
function collectThrottleFacts(e: unknown): ThrottleFacts {
  const facts: ThrottleFacts = { table: "", code: "", serverKill: false };
  try { // 容错同 R34⑤/R83-13 口径：提取失败=无附加信号，塌回纯签名键
    walkCauseChain(e, 0, (node) => {
      if (!facts.table) {
        // 鸭式读 message（OCR R37④，与 dupEntry.hasCauseChainMatch 同口径）；R107-11 bug low：String(node) 急切求值——
        //  null 原型/抛错 toString 的畸形节点会炸穿整链（外层 try 一吞全链信号尽失），转换收节点级 try 单点跳过
        let msg: string | null = null;
        try {
          const duck = node as { message?: unknown };
          const duckMsg = typeof duck.message === "string" ? duck.message : String(node); // 拆序不嵌套三元（仓规 R72-4，R104-6）
          msg = node instanceof Error ? node.message : duckMsg;
        } catch { msg = null; } // 畸形节点：表名信号放弃本节点，链余节点照走
        if (msg !== null) {
          const m = /Table '([^']+)'/.exec(msg.slice(0, SCRUB_INPUT_MAX)); // R70-6 同帽
          if (m) facts.table = (m[1] ?? "").slice(0, TABLE_KEY_MAX); // R58⑨ 同限长
        }
      }
      // R112-10 bug low：errno/code 属性读同收节点级 try——getter/Proxy 抛错逃逸即 abort 整链且被外层吞（全链信号尽失），
      //  本节点任何信号读失败只丢本节点（R83-13 口径从 message 扩到 errno/code）
      let errno: unknown;
      let codeV: unknown;
      try {
        errno = (node as { errno?: unknown }).errno;
        codeV = (node as { code?: unknown }).code;
      } catch { return null; } // 畸形节点：本节点信号全弃，链余节点照走
      if (!facts.code) {
        if (typeof errno === "number" || (typeof errno === "string" && /^\d{1,32}$/.test(errno))) facts.code = String(errno); // R85-9 同纪律
        else if (typeof codeV === "string" && /^[A-Z0-9_]{2,40}$/.test(codeV)) facts.code = codeV; // 白名单形（ER_* 大写码）
      }
      if (!facts.serverKill && Number(errno) === MYSQL_ERR_QUERY_TIMEOUT) facts.serverKill = true; // R70-7 同归一
      return facts.table !== "" && facts.code !== "" && facts.serverKill ? "done" : null; // 三齐早退（walkCauseChain 命中语义复用）
    });
  } catch { /* 同上 */ }
  return facts;
}

/** 节流留痕内部实现（签名已脱敏）：仅供模块内双汇路径（tryQueryRows 已算 safe）直调，不导出——
 *  导出参数接预脱敏值=边界靠调用方自律（OCR R52④ security medium：未来调用方传原文即日志行+节流键双泄），
 *  戒律从注释升级为结构：公开入口根本够不着「传原文直通」的形态 */
function logThrottledWithSig(tag: string, e: unknown, sig: string, label?: string): void {
  try {
    // tag 同为外部文本（OCR 合并复审 R53④ security）：dbSection 壳的 tag 由调用方 reason 拼出——
    //  裸换行可伪造 [tag] 日志行；压平后键与日志行同源同步（sig/code 已同口径，tag 不例外）
    const flatTag = flattenText(tag).slice(0, TAG_LABEL_MAX); // R7-c155-⑯：同上——tag 系外部文本（裸换行可伪造 [tag] 行——ESC/NUL 注入面同封）
    const now = Date.now();
    sweepExpiredThrottleKeys(now, LOG_PRUNE_MIN_KEYS); // 顺扫（R36③同一实现）
    const sigKey = sig.length > SIG_KEY_MAX ? `${sig.slice(0, SIG_KEY_MAX)}…` : sig; // 键内签名限长（OCR R47③，常量提名 R52③）
    // R93-20 bug low：label 提位先入键——label 同为行塑形成分（3024 分类/调用方显式 label 如 board-degraded），
    //  不入键会让同 (tag,表,码,签名) 四元组在第二类别下被静默吞 60s，R43⑤ 的分类行永不到日志；声明单趟复用下行日志行
    const facts = collectThrottleFacts(e); // R103-3：table/code/3024 单趟收齐（原三趟走链收口，节流查表前成本三分之一）
    const effLabel = label !== undefined && label.trim() !== "" ? label : undefined; // R94-7 bug low：空白 label 视同缺省——「[tag] : msg」畸形行与空 label 键段不出，默认分类不被 "" 旁路
    const flatLabel = flattenText(effLabel ?? (facts.serverKill ? DB_TIMEOUT_LABEL : DEFAULT_DEGRADED_LABEL)).slice(0, TAG_LABEL_MAX); // R7-c155-⑯：归一单点（同纪律）；3024 服务端收尾同归超时类（OCR R67③）；R103-3 换 facts
    const key = `${flatTag}|${flatLabel}|${facts.table}|${facts.code}|${sigKey}`; // R103-3：键成分逐项同口径 // 长度增长由 HARD_LOG_KEYS + 签名限长双兜底；tag 压平后入键（R53④：键行同源）；R78-8 bug medium：脱敏 fail-closed 把异因错误塌成同一兜底字面值（QUOTE_FRAGMENT/FALLBACK 无码）——并入 errno/code 分键，两条不同 ER_PARSE_ERROR 不再互吞 60s 窗
    if (throttleWindowOpen(lastLogAt, key, now, LOG_THROTTLE_MS)) { // R7-c90-④：开窗判走共享单点（显式 undefined 判内聚——语义恒等 R33 口径）
      // 先落日志再计窗（OCR R48⑦）：console.error 抛错被外层 catch 吞掉时，先 set 会让该错误类白吞 60s 窗口
      // label 同为外部文本（OCR R60⑪ security）：当前唯一供方是 DB_TIMEOUT_LABEL 常量（R85-10 指正；MARKER 仅为文案片段），但公开签名
      //  logQueryErrorThrottled(tag, e, label?) 对未来调用方不设防——与 flatTag 同口径压平+限长，边界自执行
      //  （flatLabel 已提位入键——R93-20：声明单趟，键行同源）
      console.error(`[${flatTag}] ${flatLabel}:`, sig); // 类别标签可选（OCR R43⑤）：纯超时不是「查询退化」，triage 不再靠猜正文；tag/label 压平防伪造行（R53④/R60⑪）
      lastLogAt.delete(key); lastLogAt.set(key, now); // 重记沉尾（R90-16）：Map 序=新鲜度序，硬顶淘汰从头取最旧不再排序
      sweepExpiredThrottleKeys(now, LOG_PRUNE_MIN_KEYS); // R110-13 perf medium：去 force 走 10s 摊还闸——降级风暴期不再每入列全图 O(n) 扫；
      //  硬顶溢出最多顺延一个摊还窗（入列已被 60s/tag 节流限频，上有界不破；R39① 的 force 理由随 R90-16 单趟淘汰失效）。实耗口径登记（R47②）：摊还窗外才全图扫，上有 HARD_LOG_KEYS 封顶
    }
  } catch {
    // 日志失败不得破坏 fail-closed 契约
  }
}

/** 节流留痕共享出口（OCR 合并复审 R32/R52④）：边界自执行——只接原始错误，脱敏恒在壳内发生；
 *  模块内已持脱敏签名的双汇路径走 logThrottledWithSig（不导出） */
export function logQueryErrorThrottled(tag: string, e: unknown, label?: string): void {
  // R90-15 廉价预键已回滚（OCR R91-18 复审推翻）：粗键逃 TAG_LABEL_MAX 限长、Map 原位 set 不沉尾破新鲜度序、
  //  且粗键比真键宽——首 64 字符相同但表/errno 不同的异类错误会被互吞 60s，破「逐表各自计窗」契约。
  //  脱敏先于节流查表的实耗登记为已评估接受：SCRUB_INPUT_MAX 封顶单次入料，风暴期吞吐让位正确性
  logThrottledWithSig(tag, e, sanitizeQueryError(e), label);
}

/** 键控时限窗「开」判单点（R7-c90-④）：显式 undefined 判（「未见」与「时刻 0」不混同）——良性/事故两通道同引（簿记不再双抄漂移） */
function throttleWindowOpen(map: Map<string, number>, key: string, now: number, ttlMs: number): boolean {
  const lastAt = map.get(key);
  return lastAt === undefined || now - lastAt >= ttlMs;
}

/** 键控时限窗「记账」单点（R7-c90-④）：delete+set 沉尾（Map 序=新鲜度序）+硬顶逐最老——良性道用；
 *  事故道记账走 sweepExpiredThrottleKeys 摊还清扫（纪律差异显式登记：摊还 vs 即逐——各自不动对方） */
function throttleWindowBook(map: Map<string, number>, key: string, now: number, hardKeys: number): void {
  if (map.size >= hardKeys && !map.has(key)) {
    const oldest = map.keys().next().value; // 插入序=新鲜度序（沉尾维护）
    if (oldest !== undefined) map.delete(oldest);
  }
  map.delete(key);
  map.set(key, now);
}

/** 良性/配置态告警节流单点（R7-c84-③）：键控时限窗——同一 key 窗内仅一条；
 *  ⚠️ 前置契约（R7-c114-③ security）：仅接【静态/预脱敏】文本——本 sink 只压平限长不做 SQL/参数脱敏；
 *  原始错误对象一律走 logQueryErrorThrottled（脱敏链），违者=泄密面（边界自执行纪律同 logThrottledWithSig 模块私有先例）；
 *  与 logQueryErrorThrottled 频道分立（incident 口径不混）；adminGate/authLock/adminAuth/staffTrack/boot 等模块同引（R7-c96-⑦/R7-c109-①/R7-c115-⑥/R7-c130-③/R7-c146-③/R7-c157-③：清单即契约——模块名单失真即修（逐处计数系脆面已退役））——
 *  手写时限节流副本三处漂移面封死（log 量/triage 行为单源演进） */
const benignWarnAt = new Map<string, number>(); // R7-c87-①/R7-c118-⑥：键系调用方文本（含插值先例 delegate-grant.${username}）——sink 内压平限长（键伪造面封死）+硬顶兜底（无界增长面封死）
const BENIGN_WARN_HARD_KEYS = 128; // 与 lastLogAt 的 HARD_LOG_KEYS 同纪律（硬顶仅病态键洪触及——逐最老一格换进程内存不垮）
const BENIGN_WARN_TTL_MS = 3600_000; // R7-c89-④：窗长具名单源（魔数内联面封死——与 LOG_THROTTLE_MS 同纪律）
/** 日志文本归一化单点（R7-c135-⑤/R7-c136-①）：C0/C1 控制字符剥离（ESC/NUL/DEL——终端转义注入面）+空白压平+trim——
 *  warnThrottled 的 msg 与 key 同引，boot 启动报告（flatBoot）同引（检测口径==输出口径全仓锁死；本地副本=纪律双份漂移面封死） */
const flattenText = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim(); // R7-c155-⑧：零外部消费实证摘出口（boot 只引 renderLogValue——幻影出口不养；注释口径同改）

/** 标量解包 fail-loud 守卫单点（R7-c155-⑩）：缺值/空白/非数值即抛——pidSpaceLegacy.scalarOf/txInsertId/probeLedgerScheme
 *  三副本合流（「漂移成可信 0/NaN 假通过」面一处封死）；opts.positive=必须正整数（id 族） */
export function scalarOfRows(r: unknown, key: string, opts?: { positive?: boolean }): number {
  // r3-⑤：委托 scalarOfRow 行级单点（校验逻辑不再双抄——结果集级=rawRows 解封套后行级判；
  //  label 保原消息口径「封套/别名漂移」可辨）
  // r4-①：label 不嵌 key（scalarOfRow 模板已拼——双 key 重复面封死）
  return scalarOfRow(rawRows(r)[0], key, { ...opts, label: "标量（封套/别名漂移判）" });
}

/** 日志值渲显式标记单点（R7-c152-①）：空/缺/非串漂移/Date 归一+压平限长——adminGate 委派告警/boot 委派报告同引
 *  （两套词汇表各自渲=静默分歧面封死）；空值先标（不渲 "null"/"undefined"/"[object Object]" 误导串） */
export function renderLogValue(v: unknown, max: number): string {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "（无效日期）" : v.toISOString();
  if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return "（空/缺）";
  if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return `（非串漂移:${typeof v}）`;
  return flattenText(String(v)).slice(0, max);
}
/** 行级标量解包 fail-loud（门禁 PR#15-r2-⑥：scalarOfRows 是结果集级（rows[0] 取键）——行级消费方此前用
 *  `[r, []] as never` 伪元组凑形（rawRows 契约收紧即破+as never 无保护面）；本件=行级单点——同纪律不静默归零） */
export function scalarOfRow(row: Record<string, unknown> | undefined, key: string, opts?: { positive?: boolean; label?: string }): number {
  const at = typeof opts?.label === "string" && opts.label.trim() !== "" ? opts.label : "行级"; // r3-⑤+r3c-②：label 空白视同缺省（logThrottledWithSig 的 effLabel 归一同纪律——空串 label=类别缺失双空格面封死）
  const raw = row?.[key];
  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
    throw new Error(`[queries/rawRows] ${at} ${key} 解包失败（缺值/空白）——不静默归零`);
  }
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`[queries/rawRows] ${at} ${key} 解包失败——非数值`);
  if (opts?.positive && (!Number.isInteger(v) || v <= 0)) throw new Error(`[queries/rawRows] ${at} ${key} 解包失败——非正整数`);
  return v;
}

/** 违例哨兵保留键（R7-c128-④ bug low）：内含换行——调用方键经 sink 压平（\s+→空格）后永不可达本键，
 *  哨兵窗态与调用方窗态结构性不互撞（键伪造面封死；模块私有——内部专用常量声明即契约） */
const BENIGN_VIOLATION_KEY = "warnThrottled.\nviolation";
/** 违例拒绝处置单点（R7-c132-②）：节流开窗+哨兵文案+记账一处——类型闸与指纹闸两支同引（双份复抄=单侧改键/改文漂移面封死） */
function reportBenignViolation(ttlMs: number): void { // R7-c154-②：违例告警窗长随调用方（恒窗=违例/正常两支行为分裂面封死——ttlMs=0 强制复报钉生效）
  const violationNow = Date.now();
  if (throttleWindowOpen(benignWarnAt, BENIGN_VIOLATION_KEY, violationNow, ttlMs)) {
    console.warn("[rawRows] warnThrottled 拒绝违例入参（非 string key/msg 或疑似 Drizzle 原文——原始错误一律走 logQueryErrorThrottled 脱敏链）");
    throttleWindowBook(benignWarnAt, BENIGN_VIOLATION_KEY, violationNow, BENIGN_WARN_HARD_KEYS);
  }
}
export function warnThrottled(key: string, msg: string, ttlMs = BENIGN_WARN_TTL_MS): void { // R7-c89-④：窗长具名常量默认（零调用方传参——形参保留供未来显式窗）
  // R7-c85-①⑥：纪律对齐 logThrottledWithSig——先报后记窗（console.warn 抛错不吞整窗）+全壳 try/catch（告警失败不破
  //  fail-closed 调用链——authLock 拒收支在调本点）+显式 undefined 判（?? 0 把「未见」与「时刻 0」混同=假时钟吞首条面封死）
  try {
    // R7-c119-③/R7-c120-②③ security：入口校验合一——非 string key/msg 或 drizzle 原文指纹（共享常量同引）一律拒
    //  （典型误用正是字符串模板内嵌 Error=完整 SQL+绑定参数原样落 console.warn=泄密面——结构性拦截）；
    //  R7-c131-③ bug low：检测口径==输出口径——先归一（\s+→空格）后检测（换行/制表变体 params:\n[…] 不再绕过守卫
    //  又以归一形态落日志=守卫空转面封死）；违例告警不带原文片段（命中即含 SQL 嫌疑——triage 线索让位泄密面）；
    //  R7-c121-⑦ perf：违例告警走本 sink 同一节流（保留键）——热路径持续违例不再每调一条 console.warn 洪灌
    //  （为压日志量而生的 sink 自身不产洪；窗内可见+先报后记窗纪律同下）
    if (typeof key !== "string" || typeof msg !== "string") {
      reportBenignViolation(ttlMs); // R7-c132-②/R7-c154-②：处置单点同引（窗长透传）
      return;
    }
    const flatMsg = flattenText(msg); // R7-c134-④/R7-c135-⑤：归一化走 flattenText 单点（控制字符剥离+空白压平一处——检测/输出同文本，双抄漂移面封死）
    if (DRIZZLE_RAW_TEXT_RE.test(flatMsg)) {
      reportBenignViolation(ttlMs); // R7-c132-②/R7-c154-②：处置单点同引（窗长透传）
      return;
    }
    // R7-c138-① bug low：窗键=截断前缀+全长 hash 后缀消歧——共享 80 字符前缀的异类键不再并窗互吞
    //  （如 delegate-grant.${username} 长前缀共享面）；硬顶 BENIGN_WARN_HARD_KEYS 已兜内存——截断只为日志可读不为省内存
    const flatKey = flattenText(key);
    const k = flatKey.length <= TAG_LABEL_MAX ? flatKey : `${flatKey.slice(0, TAG_LABEL_MAX)}#${createHash("sha256").update(flatKey).digest("hex").slice(0, 8)}`;
    const now = Date.now();
    if (!throttleWindowOpen(benignWarnAt, k, now, ttlMs)) return; // R7-c90-④：开窗判走共享单点
    console.warn(flatMsg.slice(0, FLAT_TEXT_MAX)); // R7-c89-⑤/R7-c131-③ security：sink 内压平+限长（归一单源复用——双份压平漂移面封死）
    throttleWindowBook(benignWarnAt, k, now, BENIGN_WARN_HARD_KEYS); // R7-c90-④/R7-c118-⑥：记账走共享单点（键=压平后——窗/行同源）
  } catch { /* 告警失败不破坏调用方 */ }
}

/** tag 绑定工厂（OCR R14）：adminAnalytics/opsTickets 等路由不再各写一行重复包装，
 *  tag 值与节流语义收口在本模块——新路由只挑 tag，不造分叉。
 *  ⚠️ 配对契约（OCR 合并复审 R50⑥）：本工厂只覆盖「抛错路径」降级（throwing statement → null+留痕）；
 *  「挂起语句」（hung statement/打满的连接池）不在此列——它会 indefinite 阻塞请求而非降级。
 *  面板区轮询查询必须走 ../queries/dbSection 的 queryDbSection 三件套壳（JS 超时+DB_EXEC_HINT+本工厂配对），
 *  或至少自行配 withDbTimeout；只有「一次性、非轮询、调用方自担挂起风险」的查询才许裸用本工厂 */
export function tryQueryRowsWithTag(
  tag: string,
  opts?: Omit<TryQueryOptions, "tag">,
): (query: SQLWrapper) => Promise<Array<Record<string, unknown>> | null> { // 显式返回类型（OCR R59⑦）：公开契约钉死，本体重构不外泄推断型
  // 透传其余选项（OCR 合并复审 R33）：onError 是审计/指标/告警汇的唯一恒调路径，工厂caller 不得够不着
  return (query: SQLWrapper) => tryQueryRows(query, { ...opts, tag }); // tag 收尾在后（OCR R39⑧）：运行时展开不得盖掉工厂 tag，「只挑 tag 不造分叉」契约成立
}
