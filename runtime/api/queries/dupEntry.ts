/* mysql2 的 errno 在 drizzle 包装下藏在 cause 链——逐层找（仓级唯一来源，OCR R29 抽取/R32 参数化）。
 *  本模块是所有「撞唯一键/撞列即拒」判定的唯一判定器，必须走 cause 链找 errno；
 *  任何「简化」成只判 code 的形态都会漏掉 drizzle 包装层，把拒重用变成双花。
 *  已收口：policy.ts / devices.ts / dshGovernance.ts / dshBridge.ts 均改用本模块（旧副本已全部删除）。
 *  R7-c121-⑥：文件头转普通块注释——双 JSDoc 堆叠=IDE 只挂末块（孤儿注释面封死，与 hasCauseChainMatch 同款收口对齐） */
/** 判别目标形状（R7-c60-③/R7-c71-⑧/R7-c78-⑧/R7-c95-⑥ 两轮裁断对齐）：在 hasCauseChainMatch 公开签名上——
 *  最新裁断（staffTrack StaffAttempt 案）：签名在场的型必须出口（declaration/isolatedDeclarations 一开私有名即破构建；调用方可具名） */
export type CauseChainTarget = { code?: string; errno?: number; message?: string };

/** cause 链逐跳上限单源（R7-c90-③/R7-c143-③）：matcher 与消息收集器同引——深度不再两处手抄；
 *  5 跳平顶系有意（判定/诊断道契约——mysql2/drizzle 实测链 ≤3 节点，硬顶=判定确定性上界）；
 *  诊断道（rawCauseChainMessages/missingTableName）同走本顶——超深链静默截断=有意取舍（与 rawRows.walkCauseChain 的任意深递归不同构——双 walker 口径声明见 walker 头注） */
const CAUSE_CHAIN_MAX_HOPS = 5;

/** cause 链 walker 单点（R7-c94-②/R7-c97-①/R7-c132-③）：matcher/收集器同引——走法+深度一处；
 *  守卫收窄到【cause 推进读】且【仅 tolerant 道不炸调用方】（Proxy/getter 断链静默止——诊断道日志纪律）；
 *  strict 道（判定道）cause 推进读照样传播上行（漏判=拒重用变双花——判定器不许 fail-open，勿误读本头为双道都守）；
 *  visit 内信号读取错误【上行】——日志道的节点容忍纪律不适用于判定道。
 *  R7-c123-④/R7-c128-⑤ 双 walker 并存口径声明（与 rawRows.walkCauseChain 的有意差异，非同源漂移——本 walker 已更名 walkCauseChainForMatch 结构性防混淆）：
 *  本 walker 系【判定道】——mysql2/drizzle 包裹链实测 ≤3 节点（wrapper→driver→底层），平直 5 跳硬顶=判定确定性上界，
 *  布尔 visit 契约（true 即止）服务「撞键与否」二元裁断；rawRows walker 系【诊断道】——递归逐层 sanitize 需穿任意深度
 *  （每层 MAX_CAUSE_HOPS），首中即返服务节流键/脱敏行提取。两道深度/守卫/容忍契约【不得互拉齐】——判定道收紧即漏判变双花，
 *  诊断道放宽即日志失真；真合并归挂账 P-WALKER-MERGE（须先证两道契约可统一，本批不收） */
function walkCauseChainForMatch(err: unknown, visit: (node: CauseChainTarget) => boolean | void, tolerant = false): void { // R7-c128-⑤：更名编码分歧契约——与 rawRows.walkCauseChain 同名撞名面封死（复制改/合并误把 strict/tolerant 语义对调即静默翻转 fail-open/fail-closed）
  // R7-c97-③/R7-c103-②⑥：形参形状单源同引+容忍度分流——判定道（hasCauseChainMatch）strict：cause 读取异常上行
  //  （不许 fail-open 漏判）；诊断道（rawCauseChainMessages）tolerant：cause 读失败断链不炸（日志道纪律 R83-13）
  let cur: unknown = err;
  for (let i = 0; i < CAUSE_CHAIN_MAX_HOPS && cur; i += 1) {
    const c = cur as CauseChainTarget & { cause?: unknown };
    if (visit(c) === true) return;
    if (tolerant) {
      try { cur = c.cause; } catch { return; }
    } else {
      cur = c.cause;
    }
  }
}

/** 中性原语（R7-c52-③/R7-c53-②/R7-c60-②/R7-c71-⑧ 正名：名随实——walker 匹配 code/errno/message 三类提示，不只 errno）：
 *  cause 链 walker 本体唯一出口——撞键语义在调用方（isDupEntry/isDupColumn 直调本函数，纯转发别名次级名已摘）；
 *  R7-c96-③：JSDoc 归位本体（双 JSDoc 堆叠=IDE 只挂末块——孤儿注释面封死） */
export function hasCauseChainMatch(
  err: unknown,
  target: CauseChainTarget, // R7-c62-①：形状单源同引（注释承诺兑现）
): boolean {
  // fail-closed 守卫（OCR R33 medium）：提示字段逐条非空才参与匹配——
  //   空串 message 会 includes("") 恒真、缺省 code/errno 会 undefined===undefined 恒真，
  //   三条全空 = 无有效提示 = 一律不判撞键（宁漏判不放过，判定器不许 fail-open）。
  if (!target.code && !target.errno && !target.message) return false;
  let hit = false;
  walkCauseChainForMatch(err, (c) => {
    if (target.code && c.code === target.code) { hit = true; return true; }
    if (target.errno && c.errno === target.errno) { hit = true; return true; }
    if (target.message && typeof c.message === "string" && c.message.includes(target.message)) { hit = true; return true; }
    return undefined;
  });
  return hit;
}

/** cause 链原始 message 收集（R7-c90-③/R7-c94-②/R7-c95-①/R7-c97-② security）：模块私有——原始串内嵌全 SQL+绑定参数，
 *  绝不直接进日志/响应；外部消费走下方目的性出口（抠取即弃的契约从注释升级为结构） */
function rawCauseChainMessages(err: unknown): string[] {
  const out: string[] = [];
  walkCauseChainForMatch(err, (c) => {
    try { if (typeof c.message === "string") out.push(c.message); } catch { /* 畸形节点弃本节点照走（R83-13 日志道纪律——R7-c103-⑥） */ }
  }, true); // 诊断道 tolerant
  return out;
}

/** 1146 缺表名抠取目的性出口（R7-c97-②）：pidSpaceLegacy 同引——就地抠表名返调用方，原始串不出本模块 */
export function missingTableName(err: unknown): string | null {
  for (const msg of rawCauseChainMessages(err)) {
    const hit = /Table '(?:[^'.]*\.)?(\w+)' doesn't exist/i.exec(msg); // R7-c100-② bug medium：库名前缀可选——裸表名报文（本仓测试夹具同形）也命中（良性席位表缺不再被误上行——假警报/回填中止面封死）
    if (hit) return hit[1];
  }
  return null;
}

/** 1062 ER_DUP_ENTRY（撞唯一键）——例外票据防重用等判定的唯一入口 */
export function isDupEntry(err: unknown): boolean {
  return hasCauseChainMatch(err, { code: "ER_DUP_ENTRY", errno: 1062, message: "Duplicate entry" }); // R7-c71-⑧：直调本体（转发别名摘除——双名同行为漂移面封死）
}

/** 1060 ER_DUP_FIELDNAME（并发补列撞列）——dshBridge DDL 兜底判定入口 */
export function isDupColumn(err: unknown): boolean {
  return hasCauseChainMatch(err, { code: "ER_DUP_FIELDNAME", errno: 1060, message: "Duplicate column name" });
}
