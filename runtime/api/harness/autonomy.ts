/**
 * Nebula Harness · 自治四口（2026-08-26 彭总令，组织自治治理层）。
 *
 * G1 授权分级：L0 只读报告自动 / L1 低风险执行自动+报备 / L2 中风险双签 / L3（钱/数据/对外）永远人工；
 * G2 沙盘预演：C 级以上施工必须有沙箱干跑记录（st_release_audit action='sandbox:dryrun'）才进双签队列；
 * G3 记忆代谢：召回注入只信高置信（score 阈值），低置信进隔离区不计入给养；
 * G4 合规牙齿：涉资金/数据导出/对外文案的提案，不过合规检查进不了输送带。
 *
 * 纪律：全部纯规则可测；闸门失败=诚实拒绝（写明理由），绝不静默放行。
 */

// ─── G1 授权分级 ─────────────────────────────────────────────────────────────
export type AutonomyLevel = "L0" | "L1" | "L2" | "L3";

/** 动作→授权级别（一张表定边界；未列入的动作一律按最严 L3 处理——宁严勿宽） */
export const ACTION_TIERS: Record<string, AutonomyLevel> = {
  "probe:read": "L0",           // 探针读环相位
  "report:emit": "L1",          // 汇报总线发报
  "memory:capture": "L1",       // 记忆回写
  "queue_construct": "L2",      // 输送带立项（双签已有，此处钉级）
  "auto_verify": "L2",
  "eligible_deploy": "L3",      // 发布=永远人工
  "auto_rollback": "L3",        // 回滚=永远人工拍板后执行
  "controlled_repair": "L3",    // v177 受控自修：低风险补丁部署（双签+沙箱979双证缺一不收）
  "patch:draft": "L1",          // 补丁草案生成（L2 报备制，只写审计不动刀）
  "billing:*": "L3",            // 资金类
  "data:export": "L3",          // 数据导出类
  "comms:external": "L3",       // 对外发声类
} as const;

export function tierOfAction(action: string): AutonomyLevel {
  if (ACTION_TIERS[action]) return ACTION_TIERS[action];
  const prefix = Object.keys(ACTION_TIERS).find((k) => k.endsWith("*") && action.startsWith(k.slice(0, -1)));
  return prefix ? ACTION_TIERS[prefix] : "L3"; // 未登记动作按最严
}

/** 该动作可否全自动执行（L2 及以上必须有人工闸介入） */
export function canAutoExecute(action: string): boolean {
  const t = tierOfAction(action);
  return t === "L0" || t === "L1";
}

// ─── G2 沙盘预演闸 ────────────────────────────────────────────────────────────
/** C 级提案入施工队列前必须有的沙箱干跑审计动作 */
export const SANDBOX_DRYRUN_ACTION = "sandbox:dryrun";

// ─── G3 记忆代谢（置信度阈值；低置信隔离） ────────────────────────────────────
export const MEMORY_MIN_SCORE = 0.5;
/** #11 遗忘曲线（彭总令 2026-09-02，技术债治理）：30 天半衰期，越老的记忆分越低；
 *  衰减后低于 0.3 直接进「陈旧隔离区」（陈旧数单列上报，不与低置信混计）；
 *  同主题（同标题键）冲突时只留最新一条（新记忆天然压旧记忆）。 */
export const MEMORY_HALF_LIFE_DAYS = 30;
export const MEMORY_STALE_SCORE = 0.3;

interface MemoryBlock { raw: string; title: string; score: number; date: string | null; decayed: number }

function parseBlock(b: string, now: number): MemoryBlock {
  const sm = b.match(/\(score:\s*([\d.]+)\)/);
  const rawScore = sm ? Number(sm[1]) : 0;
  // recall 死面修（哨兵复证实录）：FTS 策略（embedding=none 部署面）网关不回评分（score 恒 0.000）——
  //  恒 0 被置信阈全压=recall 链死面；score=0 且有 priority 时按 priority/100 折算（65→0.65 过阈——有真评分面零影响）
  const pm = b.match(/\(priority:\s*(\d+)\)/);
  const score = rawScore === 0 && pm ? Number(pm[1]) / 100 : rawScore;
  const tm = b.match(/\*\*([^*]+)\*\*/);
  const title = (tm ? tm[1] : b.slice(0, 40)).trim();
  const dm = b.match(/(20\d{2}[-/]\d{1,2}[-/]\d{1,2})/);
  const date = dm ? dm[1].replace(/\//g, "-") : null;
  let decayed = score;
  if (date) {
    const ageDays = Math.max(0, (now - new Date(date).getTime()) / 86_400_000);
    decayed = score * Math.pow(0.5, ageDays / MEMORY_HALF_LIFE_DAYS);
  }
  return { raw: b.trim(), title, score, date, decayed };
}

/** 解析 /search/memories 返回文本，置信阈值+遗忘曲线+同主题留新（#11） */
export function filterConfidentMemories(resultsText: string, minScore = MEMORY_MIN_SCORE): { text: string | null; suppressed: number; stale: number } {
  const blocks = resultsText.split(/\n(?=- \*\*)/).filter((b) => b.trim().startsWith("- **"));
  if (blocks.length === 0) return { text: null, suppressed: 0, stale: 0 };
  const now = Date.now();
  const kept: MemoryBlock[] = [];
  let suppressed = 0;
  let stale = 0;
  for (const b of blocks) {
    const m = parseBlock(b, now);
    if (m.score < minScore) { suppressed++; continue; }
    if (m.date && m.decayed < MEMORY_STALE_SCORE) { stale++; continue; } // 陈旧隔离区
    kept.push(m);
  }
  // 冲突裁决：同标题键只留最新（日期新优先，其次衰减分高优先）
  const byTitle = new Map<string, MemoryBlock>();
  for (const m of kept) {
    const prev = byTitle.get(m.title);
    if (!prev) { byTitle.set(m.title, m); continue; }
    const mNewer = (m.date ?? "") > (prev.date ?? "") || (m.date === prev.date && m.decayed > prev.decayed);
    if (mNewer) byTitle.set(m.title, m);
  }
  const final = [...byTitle.values()].sort((a, b) => b.decayed - a.decayed);
  if (final.length === 0) return { text: null, suppressed, stale };
  const text = `Found ${final.length} confident memories:\n\n${final.map((m) => m.raw).join("\n\n")}`;
  return { text, suppressed, stale };
}

// ─── G4 合规牙齿（规则 v1：资金/数据/对外文案关键词风险类） ──────────────────
export const COMPLIANCE_RISK_RULES: { cls: string; pattern: RegExp; reason: string }[] = [
  { cls: "billing", pattern: /退款|结算|提现|佣金|价格|收费|token.*充值|钱包/i, reason: "涉资金动作" },
  { cls: "data", pattern: /导出用户|批量导出|明文|身份证|手机号.*批量|隐私/i, reason: "涉用户数据" },
  { cls: "comms", pattern: /对外发布|公告|推送全员|营销文案|广告/i, reason: "涉对外发声" },
];

export interface ComplianceVerdict {
  pass: boolean;
  hits: { cls: string; reason: string }[];
}

/** 合规检查：提案文本命中风险类 → 不通过（必须人工走 L3 通道，输送带不收） */
export function complianceCheck(text: string): ComplianceVerdict {
  const hits = COMPLIANCE_RISK_RULES.filter((r) => r.pattern.test(text)).map((r) => ({ cls: r.cls, reason: r.reason }));
  return { pass: hits.length === 0, hits };
}
