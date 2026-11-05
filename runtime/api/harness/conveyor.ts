/**
 * Nebula Harness · 闭环输送带执行层（M75）—— advanceLoop 判定 ↔ 数据库地面的装配器。
 *
 * 定位：M73 loop.ts 出「纯判定」，本模块出「地面真值装配」——把四类候选清单从库里
 * 查出来喂给 advanceLoop，动作输出给 S3 执行器服务（nebula-conveyor.timer，与
 * nebula-dispatch 同构的机械臂）。执行器只认本模块输出的动作清单，不自行决策。
 *
 * 四类候选口径（全部只用既有列，additive 零迁移）：
 * - approvedConstructible：approved 且可施工类型（optimize/new_skill 带 skill_key），
 *   排除已入施工队列的（st_release_audit action='construct:queued' detail 含 proposal:<id>，
 *   执行器入队时回写——审计即幂等锁，不新增状态列）；
 *   'investigate' 咨询型永不自动施工（人拍板后由人指派，红线）。
 * - draftsGreen：draft 且 verifier+report_ref 已附（构建测试证据在案）→ 可自动登记
 *   verified（证据是 M51「沙箱先跑通」纪律的数据化落点，无证据不绿）。
 * - verifiedTicketed：verified 且 publish 双签票据已 consumed（票据=人的拍板）。
 * - publishedUnhealthy：published 且最新探针审计为 probe:fail（probe:ok/rollback 在后则愈），
 *   探针审计由 S3 探针服务回写（action='probe:ok'/'probe:fail'，既有 audit 表承载）。
 *
 * 纪律：环身份（domain/scope/evoOptOut）由执行器配置显式传入，本模块不猜；
 * 失败静默（ok:false+error）；只读库 + 返回动作清单，绝不直接执行任何变更。
 */
import { sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { rawRows } from "../routers/terminal";
import { RELEASE_CHANNELS, type ReleaseChannel } from "../routers/releaseCenter";
import {
  advanceLoop, computeLoopRing, type LoopAction, type LoopRing,
  type OrgDomain, type ScopeLevel,
} from "./loop";
import { hqFactoryIdOf } from "./deptRing";

export interface ConveyorResult {
  ok: boolean;
  ring: LoopRing | null;
  actions: LoopAction[];
  candidates: {
    approvedConstructible: number;
    draftsGreen: number;
    verifiedTicketed: number;
    publishedUnhealthy: number;
  };
  domain: OrgDomain;
  scope: ScopeLevel;
  error?: string;
}

/** 单拍装配：查四类候选 → advanceLoop → 动作清单（环身份由调用方显式给定） */
export async function runConveyor(input: {
  domain: OrgDomain;
  scope: ScopeLevel;
  evoOptOut: boolean;
  /** M80：小环键（scope=dept 时过滤本部门定向提案）；大环缺省 null */
  deptKey?: string | null;
}): Promise<ConveyorResult> {
  const base: ConveyorResult = {
    ok: false, ring: null, actions: [],
    candidates: { approvedConstructible: 0, draftsGreen: 0, verifiedTicketed: 0, publishedUnhealthy: 0 },
    domain: input.domain, scope: input.scope,
  };
  try {
    const db = getDb();
    const [approved, drafts, verified, unhealthy] = await Promise.all([
      // 可施工提案：approved + 施工类型 + 有承载 skill_key + 未入队（审计锁）
      // M80 双闸：大环只消费本厂（HQ）提案（租户提案永不进平台施工链，跨厂红线）；
      //          小环（scope=dept + deptKey）再收本部定向（target_key 尾缀 @dept）。
      db.execute(
        sql`SELECT p.id FROM st_evo_proposals p
            WHERE p.status = 'approved'
              AND p.proposal_type IN ('optimize', 'new_skill')
              AND p.skill_key <> ''
              AND p.factory_id = ${hqFactoryIdOf() ?? -1}
              ${input.scope === "dept" && input.deptKey
                ? sql`AND p.target_key LIKE ${"%@" + input.deptKey}`
                : sql``}
              AND NOT EXISTS (
                SELECT 1 FROM st_release_audit a
                WHERE a.action = 'construct:queued'
                  AND a.detail LIKE CONCAT('%proposal:', p.id, '%')
              )
            ORDER BY p.id ASC LIMIT 20`,
      ).catch(() => null),
      // draft 全绿：证据双列齐备（verifier 闸编号 + 报告引用）
      db.execute(
        sql`SELECT id FROM st_releases
            WHERE status = 'draft' AND verifier IS NOT NULL AND report_ref IS NOT NULL
            ORDER BY id ASC LIMIT 20`,
      ).catch(() => null),
      // verified + publish 双签票据已消费
      db.execute(
        sql`SELECT r.id FROM st_releases r
            JOIN st_release_tickets t ON t.release_id = r.id
              AND t.action = 'publish' AND t.status = 'consumed'
            WHERE r.status = 'verified'
            ORDER BY r.id ASC LIMIT 20`,
      ).catch(() => null),
      // published 且最新探针为 fail（其后有 probe:ok/rollback 则愈，不重复止血）
      db.execute(
        sql`SELECT r.id FROM st_releases r
            WHERE r.status = 'published'
              AND EXISTS (
                SELECT 1 FROM st_release_audit f
                WHERE f.release_id = r.id AND f.action = 'probe:fail'
                  AND f.created_at >= COALESCE(r.published_at, r.created_at)
              )
              AND NOT EXISTS (
                SELECT 1 FROM st_release_audit h
                WHERE h.release_id = r.id AND h.action IN ('probe:ok', 'rollback')
                  AND h.created_at > (
                    SELECT MAX(f2.created_at) FROM st_release_audit f2
                    WHERE f2.release_id = r.id AND f2.action = 'probe:fail'
                  )
              )
            ORDER BY r.id ASC LIMIT 10`,
      ).catch(() => null),
    ]);
    // 四查询全灭 → 库抖动，如实报死；部分缺席 → 该类空集降级
    if ([approved, drafts, verified, unhealthy].every((v) => v === null)) {
      base.error = "全部查询失败（库抖动）";
      return base;
    }
    const ids = (res: unknown) =>
      (res ? rawRows(res) : []).map((r) => Number(r.id)).filter((n) => Number.isFinite(n));
    const approvedConstructible = ids(approved);
    const draftsGreen = ids(drafts);
    const verifiedTicketed = ids(verified);
    const publishedUnhealthy = ids(unhealthy);
    base.candidates = {
      approvedConstructible: approvedConstructible.length,
      draftsGreen: draftsGreen.length,
      verifiedTicketed: verifiedTicketed.length,
      publishedUnhealthy: publishedUnhealthy.length,
    };
    const ring = await computeLoopRing();
    base.ring = ring.ok ? ring : null;
    base.actions = advanceLoop({
      ring, domain: input.domain, scope: input.scope, evoOptOut: input.evoOptOut,
      approvedConstructible, draftsGreen, verifiedTicketed, publishedUnhealthy,
    });
    base.ok = true;
    return base;
  } catch (e) {
    base.error = String((e as Error)?.message ?? e).slice(0, 120);
    return base;
  }
}

// ─── 探针回写（M76 observe 段数据源）─────────────────────────────────────────

export interface ProbeReport {
  channel: ReleaseChannel;
  target: string; // 探针目标标识（如 s3-admin-3201），审计用
  ok: boolean;
  detail?: string; // 探针细节（截断 300，绝不含密钥——探针脚本只报状态码/时延）
}

export interface ProbeReportResult {
  ok: boolean;
  action: "probe:ok" | "probe:fail";
  releaseId: number | null; // 挂到的当前 live 发布（无 published 则 NULL，如实）
  error?: string;
}

/**
 * 探针结果落审计：挂该通道最新 published 发布（published_at 新→旧）。
 * 滞后/去抖在探针脚本侧（连续失败才报 fail、恢复才报 ok），本函数如实记录不裁决。
 * 失败静默（ok:false+error）——探针上报绝不反噬主链。
 */
export async function recordProbeReport(rep: ProbeReport): Promise<ProbeReportResult> {
  const action = rep.ok ? ("probe:ok" as const) : ("probe:fail" as const);
  try {
    const db = getDb();
    const live = rawRows(
      await db.execute(
        sql`SELECT id FROM st_releases WHERE channel = ${rep.channel} AND status = 'published'
            ORDER BY published_at DESC, id DESC LIMIT 1`,
      ),
    );
    const releaseId = live.length > 0 ? Number(live[0].id) : null;
    const detail = JSON.stringify({
      target: String(rep.target).slice(0, 64),
      detail: String(rep.detail ?? "").slice(0, 300),
    });
    await db.execute(
      sql`INSERT INTO st_release_audit (release_id, channel, actor, action, detail)
          VALUES (${releaseId}, ${rep.channel}, 'nebula-prober', ${action}, ${detail})`,
    );
    return { ok: true, action, releaseId };
  } catch (e) {
    return { ok: false, action, releaseId: null, error: String((e as Error)?.message ?? e).slice(0, 120) };
  }
}

export { RELEASE_CHANNELS };
