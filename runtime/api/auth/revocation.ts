/**
 * 四层四锁·吊销台账（批七-b）：签发吊销的单点与留痕。
 *
 * 口径：
 * - wb_users/staff_accounts 的 token 是「行内单点」——重颁覆盖即吊销（既有口径不动）；
 * - 本模块立【显式吊销】：管理员吊销他人 token / 批量吊销 / 留痕可审（st_token_revocations）。
 * - 吊销存 sha256 指纹不存明文（与 wbSession「库只存 sha256」同纪律）。
 * - 台账读写在出库层 throw——调用方（七-c 接线闸）自行 catch 走降级，本模块不吞错
 *   （吞错=「吊销了没记上」假吊销 / 「查不了当没吊销」假放行，两头都不静默）。
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { rawRows, logQueryErrorThrottled, scalarOfRows } from "../queries/rawRows"; // 行解包仓级单点+脱敏节流链+解包守卫单点同引（R7-c134-⑥⑨/R7-c157-⑧）
import { TRPCError } from "@trpc/server"; // R7-c134-⑥⑨：fail-closed 上行标准化（裸 Error 内文经 tRPC 格式化泄客户端面封死）

import { REVOKED_BY_MAX, REASON_MAX, REVOCATION_SCHEME_MARKER, REVOCATION_ROW_TAG, LEDGER_UNAVAILABLE_MESSAGE, SYNC_AUTH_LOCK_SCRIPT, normalizeCiText, FINGERPRINT_MAX } from "@contracts/authLock"; // R7-c154-⑥：行级口径标签同引（哨兵常量随全龄升维失消费——本文件摘除） // R7-c135-①/R7-c136-②：闸脚本路径+兜底哨兵常量同引

/** R7-c162-② security medium：标记确认进程级 memo（TTL 300s 免探针窗）整面摘除——TTL 窗内后写入异口径行/
 *  标记行被删对 isRevoked 不可见=假放行 fail-open 窗（「运维禁令禁删」是流程兜底不是结构封死）；
 *  实测探针 0.637ms/往返（R7-c135-② S4 钉）——免探针省的是亚毫秒、开的是五分钟洞：每未命中请求全量探针=fail-closed 逐请求全覆 */


/** token 指纹（sha256 hex）：台账不落明文。
 *  R7-c69-① security high：四表 authToken 列系 utf8mb4_ci（大小写不敏感）——指纹若对原文敏感，
 *  变体重放（nt_ABC→NT_abc）库内同号命中而指纹不同=吊销被穿透；故对【trim+小写归一】取哈希。
 *  生产者（recordRevocation）/消费者（isRevoked/resolveRevocation 绑定 fp）同走本点恒同步——绝不各站自哈希（发散=吊销整面静默失效） */
/** authToken 落库哈希单点（P3-6：不明文落库——新颁 token 只存指纹；与吊销台账同 tokenFingerprint 同点，
 *  归一化（大小写/口音/空白）纪律不双写——utf8mb4_ci 列等价类下指纹与库内命中同语义） */
export function authTokenHash(token: string): string {
  return tokenFingerprint(token);
}

/** 双轨明文腿的指纹形态排除（P3-6 门禁 high·pass-the-hash：库值已是 64hex 指纹时，明文等值兜底会把指纹当 bearer 放行——
 *  hash 支 miss → 明文支 `authToken = 指纹` 命中 → 惰性迁移把库值改写为 hash(指纹)，攻击者转正、真用户反被锁死，「不明文落库」目标被完全抵消。
 *  真存量 token 全带 nt_/st_/pk_ 前缀或 48hex（dev 族）——64hex 即指纹，排除不误伤；各双轨读点明文腿同引本件防九处自写漂移） */
export function authTokenPlaintextGuard(column = "authToken") {
  return sql`${sql.raw(column)} NOT REGEXP ${`^[0-9a-f]{${FINGERPRINT_MAX}}$`}`; // 指纹形宽单源 FINGERPRINT_MAX（@contracts/authLock——revocationWidths.test 钉 64；硬编码 64=算法/宽度演进时守卫静默失效面封死）
}

export function tokenFingerprint(token: string): string {
  // R7-c99-⑧ security low：归一化补齐口音维——utf8mb4_0900_ai_ci/general_ci 系【口音不敏感】列等价
  //  （nt_áb 与 nt_ab 库内同号命中）——NFD 分解+去组合符对齐之（变体穿透面与大小写同类同封）；
  //  残余显式登记：全角/兼容字符等价不在此面（在库 collation 也不等价全角——无需对齐）
  return createHash("sha256").update(normalizeCiText(token)).digest("hex"); // R7-c110-⑦：归一化走单点（口音/大小写/空白同值——不再手抄）
}

/** 吊销登记（显式）：写台账；返回指纹供调用方同步清行内 token（行内清理由调用方既有口径完成——wb_users/staff_accounts 不同表，不在本模块双抄） */
export async function recordRevocation(token: string, revokedBy: string, reason: string): Promise<{ fingerprint: string }> {
  const fp = tokenFingerprint(token);
  // R7-b-④ bug low：写前钳列宽（VARCHAR(64)/VARCHAR(256)）——超长文本会 ER_DATA_TOO_LONG 整句拒写，
  //  「吊销了没记上」的假吊销封死（仓规同 voiceSkills clip 口径）
  // R7-c10-④：按码点钳——slice 按 UTF-16 码元计，代理对（emoji 等）被切成孤半、入库转 U+FFFD，审计留痕反被钳污
  //  （与「截断不静默」相悖）；不引 terminal.clip——那是 display 省略号口径（钳后 +1 反而超宽），且 auth 不伸手路由层（R7-14-③）
  const byCps = [...revokedBy];
  const whyCps = [...reason];
  const by = byCps.slice(0, REVOKED_BY_MAX).join("");
  const why = whyCps.slice(0, REASON_MAX).join(""); // R7-c7-③：列宽同引单点常量
  // R7-c3-④：截断不静默——超长即留痕（台账审计不谎报；钳宽防 ER_DATA_TOO_LONG 假吊销与静默截断双杀）
  if (byCps.length > REVOKED_BY_MAX || whyCps.length > REASON_MAX) console.warn(`[auth/revocation] 吊销字段超列宽已截断（by ${byCps.length}cp/why ${whyCps.length}cp）`);
  // R7-b-② 幂等：uk_fingerprint 唯一键下重吊销不再 ER_DUP_ENTRY 假失败——重复吊销=无操作（id=id 空更新，与 st_weekly_digest 同例）；
  //  注意：二次吊销的 revoked_by/reason 不覆盖首记（首吊销即事实原点，后续重试不篡改留痕）
  // R7-c154-⑥：行级口径标签随写（scheme_tag=norm-v1——旧口径/带外写入行空标签=可逐行分辨，运行期+体检可检）
  await getDb().execute(
    sql`INSERT INTO st_token_revocations (fingerprint, scheme_tag, revoked_by, reason)
        VALUES (${fp}, ${REVOCATION_ROW_TAG}, ${by}, ${why})
        ON DUPLICATE KEY UPDATE id = id`,
  );
  // R7-c162-②：memo 已摘——写后无需失效动作（每次未命中照探=台账异动天然即刻可见）
  return { fingerprint: fp };
}

/** 异口径行谓词片段单源（R7-c160-⑦）：isRevoked 探针与 probeLedgerScheme 同引——双抄=未来加标签值/改谓词只改一处
 *  漏另一处=漂移盲区静默重开面封死；工厂产新鲜 sql 件（共享实例被 append 污染面不养） */
const legacyDriftCond = () => sql`fingerprint <> ${REVOCATION_SCHEME_MARKER} AND scheme_tag <> ${REVOCATION_ROW_TAG}`;

/** 台账归一化口径体检原语（R7-c136-② test low）：boot 生产启动块调用——probe 体自本模块出口（执行器可注入=可单测；
 *  fail-loud 解包内置——封套/别名漂移即抛不静默归零）；告警措辞归调用方（本原语只出事实）。
 *  语句=双判合一一次往返（标记在场 EXISTS 索引判——健康态零加价白跑面封死） */
export async function probeLedgerScheme(
  db: { execute(q: ReturnType<typeof sql>): Promise<unknown> } = getDb(),
): Promise<{ legacy: number; hasMarker: boolean; total: number }> { // R7-c154-⑥：total 增列（无标记态判定用）
  // R7-c154-⑥：legacyN 语义升维——行级标签在场后，异口径判定=无 norm-v1 标签行（全龄——不再限早于标记；
  //  行级标签可逐行分辨=c126 全龄假警报面（正常行不带前缀被误算）结构性解除——正常行带标签不计）
  // R7-c157-⑧：解包守卫走 scalarOfRows 单点（三副本合流销账——缺值/空白/NaN 一处判；本块不再内联守卫）
  // R7-c160-⑦：谓词片段单源同引（注释严禁写进 sql`` 模板内——JS 行注释在模板串里是文本，会拼进 SQL 触发 ER_PARSE_ERROR）
  const probeResult = await db.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM st_token_revocations WHERE ${legacyDriftCond()}) AS legacyN,
      EXISTS(SELECT 1 FROM st_token_revocations WHERE fingerprint = ${REVOCATION_SCHEME_MARKER}) AS markerHit,
      (SELECT COUNT(*) FROM st_token_revocations) AS totalN`); // R7-c154-⑥：无标记态判定归 total（标签化后 legacy 不再含新口径行——标记缺席×有行须独立可判）
  const legacy = scalarOfRows(probeResult, "legacyN");
  const markerHitN = scalarOfRows(probeResult, "markerHit");
  const total = scalarOfRows(probeResult, "totalN");
  return { legacy, hasMarker: markerHitN > 0, total };
}

/** 台账矛盾态判据单点（R7-c158-①⑦）：运行期 isRevoked 的 fail-closed 判据与 boot 启动闸同引——
 *  异口径行在场（legacy>0）或有行无标记（!hasMarker && total>0）即矛盾——两径不再各写谓词漂移 */
export function isLedgerContradictory(p: { legacy: number; hasMarker: boolean; total: number }): boolean {
  return p.legacy > 0 || (!p.hasMarker && p.total > 0);
}

/** 吊销判定：指纹命中台账即吊销（失败抛错上行——调用方口径决定降级方向，本函数绝不把「查不了」当「没吊销」放行） */
export async function isRevoked(token: string): Promise<boolean> {
  // R7-c76-④→R7-c77-⑦ security 收口：legacy 双读臂摘除——原串臂只能命中逐字节相同旧行，其大小写变体仍穿透
  //  （归一化臂≠sha256(原串)、legacy 臂≠sha256(变体)——双臂皆空而 CI 认证照中=穿透面在旧行上不可修）；
  //  台账系本批新建零存量（sync-auth-lock.mts 头注断言——部署前若有人工登记须清空重登），残留面彻底钉死胜过带病兼容
  // R7-c128-⑥ security medium 口径声明：口径切换系【一次性开关】——旧口径行（sha256 原文）永不复配=该吊销静默解除。
  //  运行期判别器结构性盲区诚实化：旧口径行与归一化行同为 64-hex——任何「指纹形状」运行期闸都无法分辨（勿再造盲闸）；
  //  可行控制面三道全在位：①sync-auth-lock.mts 零存量部署闸硬中止（REVOCATION_ALLOW_NONEMPTY=1 逃生门=显式担责留痕）；
  //  ②boot 启动体检炸眼警报（早于标记的异口径行/标记缺席两态都鸣）；③部署序声明（先闸后码——ops/P-ID-SPACE-LEGACY.md 门禁节）
  const fp = tokenFingerprint(token);
  // 命中快路（语句形态不变——每请求吊销查验主径零改动）
  const hits = rawRows(await getDb().execute(
    sql`SELECT id FROM st_token_revocations WHERE fingerprint = ${fp} LIMIT 1`,
  ));
  if (hits.length > 0) return true;
  // R7-c138-② security high 复审答复登记（口径重合分析——答复同步在 PR 评论）：真实凭证字母表=小写 hex
  //  （newCredential 产 nt_+hex）——normalizeCiText 对其为恒等映射，新口径指纹与旧口径（sha256 原文）【逐字节相同】：
  //  旧口径行对真实凭证仍然命中——「已吊销变有效」窗对真实凭证不存在；口径分叉只影响非规范串（大写/空白/口音变体——
  //  utf8mb4_ci 列等价类），而此类串发行端永不产、只能由带外写入产生——运维禁令（手工 INSERT 禁止）+零存量部署闸
  //  +逃生门显式担责+本探针（标记缺席×非空）四面合围。残余面=带外写入的非规范串旧行——运行期结构不可逐行分辨（双 64-hex），
  //  由 boot 体检（早于标记行炸眼）+部署序声明兜底。
  // R7-c132-⑥/R7-c133-⑥/R7-c134-⑤/R7-c140-③ security high：口径运行期可检——未命中支付探针（诚实化：未命中=主径常态）；
  //  R7-c140-③→R7-c162-②：进程级 memo 先立后摘——TTL 免探针窗=fail-open 面（门禁复审定级 security medium），
  //   亚毫秒实测加价买不回五分钟洞：未命中即探=标记被删/异口径行后写入逐请求可见；不折入命中快路=主查语句文本形态保持（钉/mock 面零扰动）；
  //  双 COUNT 已改 EXISTS——索引存在性判（totalN 全表扫描随台账增长面摘除——台账从不修剪）；
  //  R7-c135-② perf 实测钉（S4 沙箱库 2026-09-26）：EXPLAIN markerN=uk_fingerprint const 索引判 / totalN=覆盖索引首行即返（rows:1）；
  //  300 连跑均 0.637ms/往返——auth 热路径加价可忽略（实测非推测）：
  //  标记行缺席+台账非空=旧口径行留存（部署闸被跳/逃生门使用）→ 抛错上行（resolveRevocation 归 ledger_unavailable
  //  fail-closed 500——旧口径静默解除面在运行期钉死，不再纯靠部署序兜底）；空表无标记=闸未跑但无吊销可解=良性放行
  //  （boot 启动体检对标记缺席已炸眼告警——运行期不重复罚）；旧/新行同为 64-hex 不可逐行分辨——标记缺席×非空即结构信号
  // R7-c162-②：TTL 免探针窗摘除——未命中即探（fail-closed 逐请求全覆；亚毫秒实测加价换五分钟洞闭合）
  const probe = await getDb().execute(
    sql`SELECT
      EXISTS(SELECT 1 FROM st_token_revocations WHERE fingerprint = ${REVOCATION_SCHEME_MARKER}) AS markerN,
      EXISTS(SELECT 1 FROM st_token_revocations) AS totalN,
      EXISTS(SELECT 1 FROM st_token_revocations WHERE ${legacyDriftCond()}) AS legacyN`, // R7-c160-⑦：谓词片段单源同引
  );
  // R7-c134-⑨/R7-c157-⑧：解包守卫走 scalarOfRows 单点（封套/别名漂移即抛=守卫失效面封死；
  //  抛错经 resolveRevocation 归 ledger_unavailable 500=fail-closed）
  const markerN = scalarOfRows(probe, "markerN");
  const totalN = scalarOfRows(probe, "totalN");
  const legacyN = scalarOfRows(probe, "legacyN");
  // R7-c154-⑥ security medium 收口：行级口径标签运行期判——无 norm-v1 标签行（旧口径/带外写入/逃生门后遗留）
  //  不再靠「标记缺席×非空」独判（标记在场+异口径行共存=逃生门/旧码错峰面——此前 fail-open，现显形 fail-closed）
  if (isLedgerContradictory({ legacy: legacyN, hasMarker: markerN > 0, total: totalN })) { // R7-c158-①⑦：判据单点同引
    // 诊断细节走脱敏链留痕（内部部署措辞不上行）；抛 TRPCError 脱敏话术——
    //  未来直调方无 catch 也不泄内部态（resolveRevocation 现行 catch 全映 ledger_unavailable 不变）
    logQueryErrorThrottled(`[auth/revocation] 吊销台账异口径行在场（标记缺席=${markerN === 0 && totalN > 0}/无标签行=${legacyN}——部署闸被跳/逃生门后遗留/带外写入嫌疑；立即核查 ${SYNC_AUTH_LOCK_SCRIPT} 执行记录）`, new Error("revocation scheme drift")); // R7-c135-①：脚本路径常量同引
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: LEDGER_UNAVAILABLE_MESSAGE });
  }
  // R7-c155-⑰ bug medium：判后才记——旧序先记后抛=下次 TTL 内跳过判=漂移面冻结（memo 记时移判决通过后——
  //  标记在场+异口径行共存态不再被 memo 遮蔽）
  return false;
}
