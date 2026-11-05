/**
 * Nebula Harness · 环路联邦（M74）—— 大小组织智能自进化运行时的互联互通层。
 *
 * 用户口径：「小的来说是部门内的组织智能自进化运行时框架，大的来说是组织智能
 * 自进化运行时框架……大小组织智能自进化运行时框架是互联互通的关系！」
 *
 * 互联互通两个方向（全确定性纯函数，执行权在点火器/输送带，本层只出判定）：
 *
 * 上行 escalate（部门环 → 企业环）：
 *   E1 共鸣升级：同 kind 信号在同厂 ≥2 个部门各自达部门阈 → 升企业环立项
 *      （跨部门共鸣 = 企业级问题，部门各自修是浪费）；
 *   E2 烈度升级：单部门 count ≥ 部门阈 × ESCALATE_FACTOR → 升企业环
 *      （超出部门处置烈度）；其余留部门环自治。
 *
 * 下行 propagate（企业环 → 部门环）：
 *   P1 企业环 applied 的全厂成果（skill 优化/新规）→ 分发到该厂每个部门环生效；
 *   P2 部门定向提案（带 deptKey）不扩散——定向修复不外溢。
 *
 * 红线：互联互通只在同 factory_id 内（企业数据强隔离永不动摇）；跨企业永不互通；
 * 平台环（factoryId=null）只收「已拍板 applied 的框架级成果」，不收企业原始信号。
 */

/** 部门环聚集（输入：M71 同形 + deptKey；dept 阈 = 企业阈的 1/2 向上取整，小环更灵敏） */
export interface DeptCluster {
  factoryId: number;
  deptKey: string;
  kind: string;
  count: number;
}

/** 烈度升级倍数：单部门超部门阈 3 倍 → 企业环接管 */
export const ESCALATE_FACTOR = 3;
/** 共鸣升级部门数：同 kind 达阈部门 ≥2 → 企业环立项 */
export const RESONANCE_DEPTS = 2;

export type Escalation =
  | { kind: "escalate_factory"; factoryId: number; signalKind: string; reason: "resonance" | "intensity"; depts: string[]; totalCount: number }
  | { kind: "stay_dept"; factoryId: number; deptKey: string; signalKind: string; count: number };

/**
 * 上行判定：部门环聚集 → 升级/留环。
 * 规则：先按 (factoryId, kind) 分组看达阈部门数（共鸣），再单部门烈度；两规则并集。
 * deptThreshold 由调用方按 M71 SIGNAL_RULES 的 1/2 向上取整传入（本函数不查表，纯判定）。
 */
export function escalateClusters(
  clusters: DeptCluster[],
  deptThresholdOf: (kind: string) => number,
): Escalation[] {
  const out: Escalation[] = [];
  const byGroup = new Map<string, DeptCluster[]>();
  for (const c of clusters) {
    const key = `${c.factoryId}|${c.kind}`;
    const arr = byGroup.get(key) ?? [];
    arr.push(c);
    byGroup.set(key, arr);
  }
  for (const group of byGroup.values()) {
    const { factoryId, kind } = group[0];
    const threshold = deptThresholdOf(kind);
    const qualified = group.filter((c) => c.count >= threshold);
    const handledDepts = new Set<string>();
    // E1 共鸣：≥2 部门达阈 → 一次升级（合并 depts）
    if (qualified.length >= RESONANCE_DEPTS) {
      for (const c of qualified) handledDepts.add(c.deptKey);
      out.push({
        kind: "escalate_factory", factoryId, signalKind: kind, reason: "resonance",
        depts: qualified.map((c) => c.deptKey).sort(),
        totalCount: qualified.reduce((s, c) => s + c.count, 0),
      });
    }
    // E2 烈度：单部门 ≥阈×3（共鸣已吸收的部门不重复升级）
    for (const c of group) {
      if (handledDepts.has(c.deptKey)) continue;
      if (c.count >= threshold * ESCALATE_FACTOR) {
        handledDepts.add(c.deptKey);
        out.push({
          kind: "escalate_factory", factoryId, signalKind: kind, reason: "intensity",
          depts: [c.deptKey], totalCount: c.count,
        });
      }
    }
    // 留环：未被任何升级吸收的部门聚集
    for (const c of group) {
      if (!handledDepts.has(c.deptKey) && c.count >= threshold) {
        out.push({ kind: "stay_dept", factoryId, deptKey: c.deptKey, signalKind: kind, count: c.count });
      }
    }
  }
  return out.sort((a, b) => (b.kind === "escalate_factory" ? b.totalCount : 0) - (a.kind === "escalate_factory" ? a.totalCount : 0));
}

export type Propagation =
  | { kind: "propagate"; factoryId: number; skillKey: string; targetDepts: string[] }
  | { kind: "targeted_only"; factoryId: number; skillKey: string; deptKey: string };

export interface AppliedOutcome {
  factoryId: number;
  skillKey: string;
  /** 非空 = 部门定向提案（不扩散）；空 = 全厂成果（下行分发） */
  deptKey: string | null;
}

/**
 * 下行判定：企业环 applied 成果 → 分发计划。
 * P1 全厂成果 → 该厂现存部门环全量分发；P2 部门定向 → targeted_only 不外溢。
 * deptsOfFactory 由调用方从 st_departments 读入（本函数不触库）。
 */
export function planPropagation(
  outcomes: AppliedOutcome[],
  deptsOfFactory: (factoryId: number) => string[],
): Propagation[] {
  const out: Propagation[] = [];
  for (const o of outcomes) {
    if (!o.skillKey) continue; // 无承载体的成果（纯调查结论）不产生分发动作
    if (o.deptKey) {
      out.push({ kind: "targeted_only", factoryId: o.factoryId, skillKey: o.skillKey, deptKey: o.deptKey });
    } else {
      out.push({
        kind: "propagate", factoryId: o.factoryId, skillKey: o.skillKey,
        targetDepts: deptsOfFactory(o.factoryId).slice().sort(),
      });
    }
  }
  return out;
}
