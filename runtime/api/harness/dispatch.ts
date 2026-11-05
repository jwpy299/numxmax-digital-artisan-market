/**
 * Nebula Harness · 事件驱动调度环（M71）—— 自进化回路的点火器。
 *
 * 断点实证：M45 信号总线（st_evo_signals 只进不出）与迭代33 提案引擎
 * （generateProposals 纯人工触发、从不读信号表）之间无连接——信号落地无人反应。
 * 本模块把「信号聚集」自动点燃成「待拍板提案」，闭环事件驱动第一段：
 *   信号落地 → 聚集检测 → 自动立项（pending）→ 人拍板（approve/reject 永在人手）
 *
 * 纪律：
 * - 提案一律 proposal_type='investigate'（咨询型立项）：approve 走迭代33 既有开关，
 *   对未知类型零自动变更（skills 不动、库不动），applied 仅留痕——拍板权完整在人；
 * - 幂等：同 factory_id + target_key(kind) + status='pending' 不重复立项；
 * - factory_id 可空（平台级信号）；企业数据强隔离（按 factory_id 各自立项）；
 * - source='auto-event' 如实标注，与人工/LLM 提案可区分；
 * - 只读信号表 + 写提案表，绝不回读提案正文给调用方之外的任何面；
 * - 全部 additive：不改既有路由/表结构，失败静默（表缺席降级空集）。
 */
import { sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { rawRows } from "../routers/terminal";
import { isoWeek } from "../routers/evo";
import { ESCALATE_FACTOR, escalateClusters, type DeptCluster } from "./federation";

/** M77 部门环阈值：企业阈的 1/2 向上取整（小环更灵敏；未知 kind 给超大阈=永不立案） */
export function deptThresholdOf(kind: string): number {
  const rule = SIGNAL_RULES.find((r) => r.kind === kind);
  return rule ? Math.ceil(rule.threshold / 2) : Number.MAX_SAFE_INTEGER;
}

/** 信号聚集规则：24h 同窗同厂同 kind 达阈即立案（boot 为心跳信息，不立案） */
export const SIGNAL_RULES: ReadonlyArray<{ kind: string; threshold: number; title: string }> = [
  { kind: "crash", threshold: 3, title: "崩溃聚集" },
  { kind: "dag_fail", threshold: 3, title: "任务图失败聚集" },
  { kind: "skill_fail", threshold: 5, title: "技能失败聚集" },
  { kind: "device_fail", threshold: 5, title: "设备链路失败聚集" },
  { kind: "mishear_diff", threshold: 8, title: "误听偏差聚集" },
  { kind: "voice_fail", threshold: 8, title: "语音链路失败聚集" },
  { kind: "tts_fail", threshold: 8, title: "TTS 失败聚集" },
  { kind: "asr_fail", threshold: 8, title: "ASR 失败聚集" },
  { kind: "api_error", threshold: 10, title: "API 异常聚集" },
];

export interface SignalBucket {
  factoryId: number | null;
  kind: string;
  count: number;
  /** M77：部门维度（NULL=企业环口径，老路径零感知） */
  deptKey?: string | null;
}

export interface SignalCluster extends SignalBucket {
  title: string;
  threshold: number;
}

/** 纯函数：信号桶 → 达阈聚集（四端可测，不触库） */
export function detectClusters(buckets: SignalBucket[]): SignalCluster[] {
  const out: SignalCluster[] = [];
  for (const b of buckets) {
    const rule = SIGNAL_RULES.find((r) => r.kind === b.kind);
    if (rule && b.count >= rule.threshold) {
      out.push({ ...b, title: rule.title, threshold: rule.threshold });
    }
  }
  return out.sort((a, b) => b.count - a.count);
}

export interface DispatchResult {
  ok: boolean;
  windowHours: number;
  buckets: number;
  clusters: number;
  created: number;
  skippedPending: number;
  proposals: Array<{ factoryId: number | null; kind: string; count: number }>;
  error?: string;
}

const WINDOW_HOURS = 24;

/**
 * 调度一次：聚集检测 → 幂等立项。返回元数据级结果（绝不回读正文）。
 * 任何一步表缺席/库抖动 → ok:false + error，绝不抛出阻塞调用链。
 */
export async function dispatchSignals(): Promise<DispatchResult> {
  const base: DispatchResult = {
    ok: false, windowHours: WINDOW_HOURS, buckets: 0, clusters: 0,
    created: 0, skippedPending: 0, proposals: [],
  };
  try {
    const db = getDb();
    // M77：优先按部门维度聚集；dept_key 列未补（sync-m73 未跑）时回退 legacy 二维聚集
    let bucketRows: Array<Record<string, unknown>>;
    try {
      bucketRows = rawRows(
        await db.execute(
          sql`SELECT factory_id, dept_key, kind, count(*) AS c FROM st_evo_signals
              WHERE created_at >= NOW() - INTERVAL ${WINDOW_HOURS} HOUR
              GROUP BY factory_id, kind, dept_key`,
        ),
      );
    } catch (e) {
      // 仅「列缺席」（sync-m73 未跑）回退 legacy 二维聚集；真库抖动原样上抛走 ok:false
      if (!/unknown column|er_bad_field/i.test(String((e as Error)?.message ?? e))) throw e;
      bucketRows = rawRows(
        await db.execute(
          sql`SELECT factory_id, kind, count(*) AS c FROM st_evo_signals
              WHERE created_at >= NOW() - INTERVAL ${WINDOW_HOURS} HOUR
              GROUP BY factory_id, kind`,
        ),
      );
    }
    const buckets: SignalBucket[] = bucketRows.map((r) => ({
      factoryId: r.factory_id === null || r.factory_id === undefined ? null : Number(r.factory_id),
      kind: String(r.kind ?? ""),
      count: Number(r.c ?? 0),
      deptKey: r.dept_key === null || r.dept_key === undefined || r.dept_key === "" ? null : String(r.dept_key),
    }));
    base.buckets = buckets.length;
    // 企业环桶（dept_key NULL）走 M71 原路径；部门环桶走 M74 联邦判定（共鸣/烈度/留环）
    const factoryBuckets = buckets.filter((b) => !b.deptKey);
    const deptBuckets = buckets.filter((b) => b.deptKey && b.factoryId !== null);
    const clusters = detectClusters(factoryBuckets);
    const deptClusters: DeptCluster[] = deptBuckets.map((b) => ({
      factoryId: b.factoryId as number, deptKey: b.deptKey as string, kind: b.kind, count: b.count,
    }));
    const escalations = escalateClusters(deptClusters, deptThresholdOf);
    base.clusters = clusters.length + escalations.length;

    const pendRows = rawRows(
      await db.execute(
        sql`SELECT factory_id, target_key FROM st_evo_proposals
            WHERE status = 'pending' AND target_type = 'signal'`,
      ),
    );
    const pending = new Set(
      pendRows.map((r) => `${r.factory_id === null ? "hq" : Number(r.factory_id)}:${String(r.target_key ?? "")}`),
    );

    const week = isoWeek();
    const insertProposal = async (input: {
      factoryId: number | null; targetKey: string; title: string; evidence: string;
      kind: string; count: number;
    }) => {
      const key = `${input.factoryId === null ? "hq" : input.factoryId}:${input.targetKey}`;
      if (pending.has(key)) {
        base.skippedPending += 1;
        return;
      }
      await db.execute(
        sql`INSERT INTO st_evo_proposals
            (week, target_type, target_key, title, content, evidence, status,
             factory_id, skill_key, proposal_type, rationale, diff_preview, \`source\`)
            VALUES (${week}, 'signal', ${input.targetKey}, ${input.title.slice(0, 128)},
              ${input.evidence}, ${input.evidence}, 'pending',
              ${input.factoryId}, '', 'investigate', ${input.evidence.slice(0, 3800)}, NULL, 'auto-event')`,
      );
      base.created += 1;
      base.proposals.push({ factoryId: input.factoryId, kind: input.kind, count: input.count });
    };

    // 企业环（M71 原路径，零行为变更）
    for (const cl of clusters) {
      const title = `【事件驱动】${cl.title}（${cl.kind} ×${cl.count}/24h）`;
      const evidence = `st_evo_signals 24h 聚集：kind=${cl.kind}，次数=${cl.count}（阈值 ${cl.threshold}），` +
        `factory_id=${cl.factoryId ?? "平台级"}。自动立项调查，拍板权在人。`;
      await insertProposal({ factoryId: cl.factoryId, targetKey: cl.kind, title, evidence, kind: cl.kind, count: cl.count });
    }

    // 部门环（M77 联邦判定：共鸣/烈度升企业环，留环部门自治定向立案）
    for (const esc of escalations) {
      if (esc.kind === "escalate_factory") {
        const targetKey = `${esc.signalKind}@${esc.reason}`;
        const title = esc.reason === "resonance"
          ? `【事件驱动·共鸣】${esc.signalKind} 跨部门共鸣（${esc.depts.join("/")} ×${esc.totalCount}/24h）`
          : `【事件驱动·烈度】${esc.signalKind} 单部门超烈度（${esc.depts[0]} ×${esc.totalCount}/24h）`;
        const evidence = esc.reason === "resonance"
          ? `st_evo_signals 24h 部门环聚集：kind=${esc.signalKind}，部门 ${esc.depts.join("、")} 各自达部门阈（${deptThresholdOf(esc.signalKind)}），` +
            `合计 ${esc.totalCount} 次。跨部门共鸣=企业级问题，升企业环立项（M74 E1，共鸣优先吸收），拍板权在人。`
          : `st_evo_signals 24h 部门环聚集：kind=${esc.signalKind}，部门 ${esc.depts[0]} 达 ${esc.totalCount} 次，` +
            `超部门烈度阈（${deptThresholdOf(esc.signalKind)}×${ESCALATE_FACTOR}）。升企业环立项（M74 E2），拍板权在人。`;
        await insertProposal({ factoryId: esc.factoryId, targetKey, title, evidence, kind: esc.signalKind, count: esc.totalCount });
      } else {
        const targetKey = `${esc.signalKind}@${esc.deptKey}`;
        const title = `【事件驱动·部门环】${esc.signalKind} 部门聚集（${esc.deptKey} ×${esc.count}/24h）`;
        const evidence = `st_evo_signals 24h 部门环聚集：kind=${esc.signalKind}，部门=${esc.deptKey}，次数=${esc.count}` +
          `（部门阈 ${deptThresholdOf(esc.signalKind)}）。留部门环自治定向立案（M74 P2 定向不外溢），拍板权在人。`;
        await insertProposal({ factoryId: esc.factoryId, targetKey, title, evidence, kind: esc.signalKind, count: esc.count });
      }
    }
    base.ok = true;
    return base;
  } catch (e) {
    base.error = String((e as Error)?.message ?? e).slice(0, 120);
    return base;
  }
}
