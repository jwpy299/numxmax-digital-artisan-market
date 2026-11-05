/**
 * Nebula Harness · 自进化闭环输送带（M73）—— 框架自动更新升级迭代的决策核。
 *
 * 用户口径：「整个组织智能自进化运行时框架是自动更新升级迭代……在企业、政府、科研、
 * 教育、金融等领域都适配；小的来说是部门内、大的来说是组织级；整体要形成闭环系统。」
 *
 * 闭环七段（M69 四段灯的完整态）：
 *   sense 感知 → propose 立项 → decide 拍板 → construct 施工
 *   → verify 验证 → release 发布 → observe 观测回流（→ 回到 sense）
 *
 * 本模块职责（纯函数为骨，薄 DB 壳为肤）：
 * - resolveDomain：企业行业文本 → 五域归一（enterprise/gov/research/education/finance）；
 * - DOMAIN_POLICIES：每域自治天花板——红线恒真：所有域发布闸 requireDoubleSign=true
 *   （C 级双签永不动摇）；域间差异在施工/验证自动化深度与附加闸；
 * - SCOPE_CEILING：尺度天花板——dept 环不施工（只立项/调参），factory 环可施工，
 *   platform 环恒双签；
 * - advanceLoop：闭环状态 × 域 × 尺度 → 本拍可自动执行的动作（advisory，由点火器/
 *   部署服务机械执行；任何动作都可被域/尺度天花板 veto，宁严勿宽）；
 * - computeLoopRing：七段状态读取（薄 DB 壳，表缺席降级空集，绝不炸链）。
 *
 * 纪律：additive；token 仅在请求体；域推导只用行业文本（不读隐私字段）；
 * evo_opt_out 企业硬退出（环路对该厂恒 noop）。
 */
import { AUDIT_ACTION } from "../releaseActions";
import { sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { rawRows } from "../routers/terminal";

// ─── 域适配层 ────────────────────────────────────────────────────────────────

export type OrgDomain = "enterprise" | "gov" | "research" | "education" | "finance";

/** 五域关键词（命中即归一；顺序即优先级——gov/finance 从严在前） */
const DOMAIN_KEYWORDS: ReadonlyArray<{ domain: OrgDomain; words: readonly string[] }> = [
  { domain: "gov", words: ["政府", "政务", "机关", "公共事业", "事业编制", "街道", "委员会"] },
  { domain: "finance", words: ["金融", "银行", "证券", "保险", "基金", "支付", "期货", "信托"] },
  { domain: "education", words: ["教育", "学校", "校园", "培训", "高校", "中学", "小学", "幼儿园"] },
  { domain: "research", words: ["科研", "研究院", "研究所", "实验室", "研发中心", "科学院"] },
];

/** 行业文本 → 五域归一（默认 enterprise；纯关键词，宁严勿宽：gov/finance 优先命中） */
export function resolveDomain(industryText: string | null | undefined): OrgDomain {
  const t = String(industryText ?? "");
  if (!t) return "enterprise";
  for (const { domain, words } of DOMAIN_KEYWORDS) {
    if (words.some((w) => t.includes(w))) return domain;
  }
  return "enterprise";
}

/** 域自治天花板：施工/验证/部署三段自动化深度 + 附加闸（双签恒 true，红线） */
export interface DomainPolicy {
  /** 允许施工臂自动接续（approved 提案 → codex 臂沙箱施工） */
  autoConstruct: boolean;
  /** 允许构建+测试全绿后自动登记 verified（附 verifier 证据引用） */
  autoVerify: boolean;
  /** 允许双签票据消费后部署服务自动执行蓝绿切换（票据本身就是人的拍板） */
  autoDeploy: boolean;
  /** 发布闸恒双签（C 级红线，全域 true，字段存在是为防未来有人偷偷放开） */
  requireDoubleSign: true;
  /** 域附加闸（如教育内容审查） */
  extraGates: readonly string[];
}

export const DOMAIN_POLICIES: Readonly<Record<OrgDomain, DomainPolicy>> = {
  // 政府：全人审——政务变更每一步都要留痕到人，自动化只到立项为止
  gov: { autoConstruct: false, autoVerify: false, autoDeploy: false, requireDoubleSign: true, extraGates: ["audit_trail_strict"] },
  // 金融：可沙箱施工（不动产线），验证与部署全人审（双录/风控口径）
  finance: { autoConstruct: true, autoVerify: false, autoDeploy: false, requireDoubleSign: true, extraGates: ["audit_trail_strict"] },
  // 教育：施工+验证可自动，发布人审；内容审查附加闸
  education: { autoConstruct: true, autoVerify: true, autoDeploy: false, requireDoubleSign: true, extraGates: ["content_screen"] },
  // 科研/企业：三段自动化全开（部署仍以双签票据为前提——票据=人的拍板，服务只是机械臂）
  research: { autoConstruct: true, autoVerify: true, autoDeploy: true, requireDoubleSign: true, extraGates: [] },
  enterprise: { autoConstruct: true, autoVerify: true, autoDeploy: true, requireDoubleSign: true, extraGates: [] },
} as const;

// ─── 尺度适配层 ──────────────────────────────────────────────────────────────

export type ScopeLevel = "dept" | "factory" | "platform";

/**
 * 尺度天花板（与域天花板取交集，宁严勿宽）：
 * - dept：部门内环——只许立项/调查型提案，施工必须上升到 factory 环（部门不伤主干）；
 * - factory：企业环——可施工可验证，部署按域政策；
 * - platform：平台环（跨厂/框架自身）——部署恒需双签且 autoDeploy 恒 false（框架自我
 *   更新是最重动作，机械臂不碰，运维通道执行）。
 */
export const SCOPE_CEILING: Readonly<Record<ScopeLevel, { autoConstruct: boolean; autoVerify: boolean; autoDeploy: boolean }>> = {
  dept: { autoConstruct: false, autoVerify: false, autoDeploy: false },
  factory: { autoConstruct: true, autoVerify: true, autoDeploy: true },
  platform: { autoConstruct: false, autoVerify: false, autoDeploy: false },
} as const;

/** 域 × 尺度 交集后的有效自治（三者全 true 才 true） */
export function effectiveAutonomy(domain: OrgDomain, scope: ScopeLevel) {
  const d = DOMAIN_POLICIES[domain];
  const s = SCOPE_CEILING[scope];
  return {
    autoConstruct: d.autoConstruct && s.autoConstruct,
    autoVerify: d.autoVerify && s.autoVerify,
    autoDeploy: d.autoDeploy && s.autoDeploy,
    requireDoubleSign: true as const,
    extraGates: d.extraGates,
  };
}

// ─── 闭环状态与推进 ──────────────────────────────────────────────────────────

export interface LoopRing {
  ok: boolean;
  signals24h: number;
  proposals: Record<string, number>; // status → count
  releases: Record<string, number>; // status → count
  pendingTickets: number;
  /** 最近 24h 内有 published 后又 rolled_back → 观测段判不健康 */
  rollbackAfterPublish24h: boolean;
  lastArmRunAt: string | null;
  stages: {
    sense: boolean; propose: boolean; decide: boolean; construct: boolean;
    verify: boolean; release: boolean; observe: boolean;
  };
  error?: string;
}

export type LoopAction =
  | { kind: "dispatch_signals" } // 点火：信号聚集→立项（M71 已常驻，此处为完整性枚举）
  | { kind: "queue_construct"; proposalId: number }
  | { kind: "auto_verify"; releaseId: number }
  | { kind: "eligible_deploy"; releaseId: number }
  | { kind: "auto_rollback"; releaseId: number; reason: string }
  | { kind: "noop"; reason: string };

export interface AdvanceInput {
  ring: LoopRing;
  domain: OrgDomain;
  scope: ScopeLevel;
  evoOptOut: boolean;
  /** approved 且可施工的提案 id 列表（调用方从提案表筛好传入，本函数不触库） */
  approvedConstructible: number[];
  /** draft 且构建测试全绿的 release id 列表 */
  draftsGreen: number[];
  /** verified 且双签票据已消费的 release id 列表 */
  verifiedTicketed: number[];
  /** published 24h 内且探针红的 release id 列表 */
  publishedUnhealthy: number[];
}

/** 闭环推进判定（纯函数）：本拍可自动执行的动作序列；天花板 veto 优先，宁严勿宽 */
export function advanceLoop(input: AdvanceInput): LoopAction[] {
  if (input.evoOptOut) return [{ kind: "noop", reason: "企业已退出自进化（evo_opt_out）" }];
  const cap = effectiveAutonomy(input.domain, input.scope);
  const out: LoopAction[] = [];

  // observe → 回滚永远第一优先（坏发布先止血，域/尺度无 veto 权——止血不设闸）
  for (const releaseId of input.publishedUnhealthy) {
    out.push({ kind: "auto_rollback", releaseId, reason: "published 24h 内探针红" });
  }
  // construct：approved 可施工提案 → 施工队列（域×尺度许可）
  if (cap.autoConstruct) {
    for (const proposalId of input.approvedConstructible) {
      out.push({ kind: "queue_construct", proposalId });
    }
  }
  // verify：draft 全绿 → 自动登记 verified
  if (cap.autoVerify) {
    for (const releaseId of input.draftsGreen) {
      out.push({ kind: "auto_verify", releaseId });
    }
  }
  // release：verified + 双签票据已消费 → 部署资格（票据=人拍板，机械臂执行）
  if (cap.autoDeploy) {
    for (const releaseId of input.verifiedTicketed) {
      out.push({ kind: "eligible_deploy", releaseId });
    }
  }
  if (out.length === 0) {
    return [{ kind: "noop", reason: "闭环本拍无可推进项（各段均未达自动条件）" }];
  }
  return out;
}

// ─── 薄 DB 壳：七段状态读取 ──────────────────────────────────────────────────

/** 七段闭环状态（表缺席/库抖动 → 降级空集 + ok:false，绝不炸调用链） */
export async function computeLoopRing(): Promise<LoopRing> {
  const base: LoopRing = {
    ok: false, signals24h: 0, proposals: {}, releases: {}, pendingTickets: 0,
    rollbackAfterPublish24h: false, lastArmRunAt: null,
    stages: { sense: false, propose: false, decide: false, construct: false, verify: false, release: false, observe: false },
  };
  try {
    const db = getDb();
    const [sig, prop, rel, tick, arm, rb] = await Promise.all([
      db.execute(sql`SELECT count(*) AS c FROM st_evo_signals
        WHERE created_at >= NOW() - INTERVAL 24 HOUR`).catch(() => null),
      db.execute(sql`SELECT status, count(*) AS c FROM st_evo_proposals GROUP BY status`).catch(() => null),
      db.execute(sql`SELECT status, count(*) AS c FROM st_releases GROUP BY status`).catch(() => null),
      db.execute(sql`SELECT count(*) AS c FROM st_release_tickets WHERE status = 'pending'`).catch(() => null),
      db.execute(sql`SELECT created_at FROM st_release_audit
        WHERE action = 'arm:run' ORDER BY id DESC LIMIT 1`).catch(() => null),
      // 观测段：24h 内是否存在「双签发布（confirm:publish）后又回滚（自动止血 rollback / 人工 confirm:rollback）」——
      //  两侧全走词表（OCR R15：裸 'publish' 无写侧，旧 join 永不命中、该段死环）
      db.execute(sql`SELECT count(*) AS c FROM st_release_audit a
        JOIN st_release_audit b ON a.release_id = b.release_id
        WHERE a.action = ${AUDIT_ACTION.confirmPublish} AND b.action IN (${AUDIT_ACTION.rollback}, ${AUDIT_ACTION.confirmRollback}) AND b.id > a.id
          AND b.created_at >= NOW() - INTERVAL 24 HOUR`).catch(() => null),
    ]);
    // 降级语义：单表缺席（个别 null）→ 该段空集、ok 仍 true（诚实报已有段）；
    // 六查询全灭（库抖动级）→ ok:false，调用方得以区分「空闭环」与「无数据」。
    const allNull = [sig, prop, rel, tick, arm, rb].every((v) => v === null);
    if (allNull) {
      base.error = "全部查询失败（库抖动）";
      return base;
    }
    const toMap = (rows: Array<Record<string, unknown>>) =>
      Object.fromEntries(rows.map((r) => [String(r.status), Number(r.c)]));
    const sigRows = sig ? rawRows(sig) : [];
    const propRows = prop ? rawRows(prop) : [];
    const relRows = rel ? rawRows(rel) : [];
    const tickRows = tick ? rawRows(tick) : [];
    const armRows = arm ? rawRows(arm) : [];
    const rbRows = rb ? rawRows(rb) : [];
    base.signals24h = Number(sigRows[0]?.c ?? 0);
    base.proposals = toMap(propRows);
    base.releases = toMap(relRows);
    base.pendingTickets = Number(tickRows[0]?.c ?? 0);
    base.lastArmRunAt = armRows[0] ? String(armRows[0].created_at ?? "") : null;
    base.rollbackAfterPublish24h = Number(rbRows[0]?.c ?? 0) > 0;
    base.stages = {
      sense: base.signals24h > 0,
      propose: propRows.length > 0,
      decide: Number(base.proposals.approved ?? 0) + Number(base.proposals.applied ?? 0)
        + Number(base.proposals.rejected ?? 0) > 0,
      construct: relRows.length > 0 || armRows.length > 0,
      verify: Number(base.releases.verified ?? 0) > 0,
      release: Number(base.releases.published ?? 0) > 0,
      observe: armRows.length > 0 || Number(base.releases.published ?? 0) > 0,
    };
    base.ok = true;
    return base;
  } catch (e) {
    base.error = String((e as Error)?.message ?? e).slice(0, 120);
    return base;
  }
}
