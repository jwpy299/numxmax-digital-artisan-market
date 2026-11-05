/**
 * Nebula Harness · 输送带真执行层（M78b，彭总双签开闸 2026-08-23）。
 *
 * 定位：conveyor.ts 出动作清单（纯判定），本模块把动作落成地面真值。
 * 闸门（fail-closed，缺省 REPORT-ONLY 行为零变化）：
 * - EVO_CONVEYOR_EXECUTE=1 才真执行，且调用方必须持内部令牌（router 层已校验）；
 * - 逐动作 try/catch，单动作失败不拖垮整拍，结果逐项如实回报；
 * - investigate 咨询型永不在清单内（conveyor SQL 已钉死），双签票据是 deploy 的前置（人拍板在先）。
 *
 * 真执行口径（v1 诚实边界）：
 * - queue_construct：approved 提案 → 建 server 通道 draft 发布（版本 auto-p<id>-<date>，唯一即幂等）
 *   + construct:queued 审计（审计即幂等锁，与候选查询互斥闭环）；
 * - auto_verify：draft 且证据双列齐备 → verified（执行时复查证据，防空翻）；
 * - eligible_deploy：双签票据已消费（人拍板）→ deploy:eligible 资格登记审计；
 *   机器级部署仍走执行官部署管线（绝不机器自部署，红线）；
 * - auto_rollback：published+探针红 → rolled_back 状态止血 + rollback 审计；
 *   机器级回滚走回滚位 runbook（DB 止血先行，绝不反向放大事故）。
 */
import { sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { rawRows } from "../routers/terminal";
import { complianceCheck, SANDBOX_DRYRUN_ACTION } from "./autonomy";
import { reviewProposal } from "./agenticSdlc";
import type { LoopAction } from "./loop";

export function conveyorExecuteEnabled(): boolean {
  return (process.env.EVO_CONVEYOR_EXECUTE ?? "").trim() === "1";
}

export interface ActionResult {
  kind: string;
  refId: number | null;
  ok: boolean;
  detail: string;
}

function actor(): string {
  return "nebula-conveyor";
}

async function queueConstruct(proposalId: number): Promise<ActionResult> {
  const base: ActionResult = { kind: "queue_construct", refId: proposalId, ok: false, detail: "" };
  const db = getDb();
  // 提案实况（施工对象必须仍是 approved，防拍板后状态漂移）
  const p = rawRows(
    await db.execute(
      sql`SELECT id, status, proposal_type, skill_key FROM st_evo_proposals WHERE id = ${proposalId} LIMIT 1`,
    ),
  )[0];
  if (!p || String(p.status) !== "approved") {
    base.detail = "提案不存在或已非 approved（漂移拦截）";
    return base;
  }
  // G4 合规牙齿：涉资金/数据/对外发声的提案不过合规检查，输送带拒收（走人工 L3 通道）
  const proposalText = `${String(p.proposal_type)} ${String(p.skill_key)}`;
  const verdict = complianceCheck(proposalText);
  if (!verdict.pass) {
    base.detail = `合规拦截（${verdict.hits.map((h) => h.reason).join("、")}）→ 转人工 L3 通道`;
    return base;
  }
  // v163 AI 预审（L1 报备制）：判定写审计，reject 也如实标注不静默拦（双签仍是最终闸）
  const review = await reviewProposal(proposalId).catch(() => null);
  if (review) {
    await db.execute(
      sql`INSERT INTO st_release_audit (release_id, channel, actor, action, detail)
          VALUES (0, 'server', ${actor()}, 'sdlc:review', ${`proposal:${proposalId} verdict:${review.verdict} risks:${review.risks.length} ${review.summary}`.slice(0, 300)})`,
    );
    // v165 学习环第一步：判决书底档落 st_sdlc_verdicts（对账的事实源；unreviewed 也如实落档）
    await db.execute(
      sql`INSERT INTO st_sdlc_verdicts (proposal_id, verdict, risks, summary) VALUES (${proposalId}, ${review.verdict}, ${JSON.stringify(review.risks)}, ${review.summary.slice(0, 600)})
          ON DUPLICATE KEY UPDATE verdict=VALUES(verdict), risks=VALUES(risks), summary=VALUES(summary)`,
    ).catch(() => undefined); // 表未建（旧库）不挡施工主链
  }
  // G2 沙盘预演闸：C 级以上施工必须已有沙箱干跑记录才进队列
  const dryrun = rawRows(
    await db.execute(
      sql`SELECT id FROM st_release_audit WHERE action = ${SANDBOX_DRYRUN_ACTION} AND detail LIKE ${`%proposal:${proposalId}%`} LIMIT 1`,
    ),
  );
  if (dryrun.length === 0) {
    base.detail = "缺沙盘预演记录（sandbox:dryrun）→ 先沙箱干跑再进双签队列";
    return base;
  }
  // 审计锁复查（并发双拍互斥）
  const locked = rawRows(
    await db.execute(
      sql`SELECT id FROM st_release_audit WHERE action = 'construct:queued' AND detail LIKE ${`%proposal:${proposalId}%`} LIMIT 1`,
    ),
  );
  if (locked.length > 0) {
    base.ok = true;
    base.detail = "已在施工队列（幂等命中）";
    return base;
  }
  const version = `auto-p${proposalId}-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
  const dup = rawRows(
    await db.execute(
      sql`SELECT id FROM st_releases WHERE channel = 'server' AND version = ${version} LIMIT 1`,
    ),
  );
  let releaseId: number;
  if (dup[0]) {
    releaseId = Number(dup[0].id);
  } else {
    const ins = await db.execute(
      sql`INSERT INTO st_releases (channel, version, status, note, created_by)
          VALUES ('server', ${version}, 'draft', ${`输送带自动立项：evo 提案 #${proposalId}（${String(p.proposal_type)} ${String(p.skill_key)}）`.slice(0, 300)}, ${actor()})`,
    );
    const first = Array.isArray(ins) ? (ins as unknown[])[0] : ins;
    releaseId = Number((first as { insertId?: number })?.insertId ?? 0);
  }
  await db.execute(
    // detail 契约：纯文本必须含字面量 proposal:<id>——候选查询的审计锁 LIKE '%proposal:<id>%' 靠它互斥
    //（v140 首产线实证踩雷：JSON {"proposal":N} 带引号不匹配 LIKE，锁空转重复施工；此处钉死）
    sql`INSERT INTO st_release_audit (release_id, channel, actor, action, detail)
        VALUES (${releaseId}, 'server', ${actor()}, 'construct:queued', ${`proposal:${proposalId} version:${version}`.slice(0, 300)})`,
  );
  base.ok = true;
  base.detail = `draft 发布 #${releaseId}（${version}）已建并入队`;
  base.refId = releaseId;
  return base;
}

async function autoVerify(releaseId: number): Promise<ActionResult> {
  const base: ActionResult = { kind: "auto_verify", refId: releaseId, ok: false, detail: "" };
  const db = getDb();
  // 证据复查（draftsGreen 候选口径在执行时重钉一遍：证据不在绝不翻状态）
  const upd = await db.execute(
    sql`UPDATE st_releases SET status = 'verified'
        WHERE id = ${releaseId} AND status = 'draft' AND verifier IS NOT NULL AND report_ref IS NOT NULL`,
  );
  const first = Array.isArray(upd) ? (upd as unknown[])[0] : upd;
  const affected = Number((first as { affectedRows?: number })?.affectedRows ?? 0);
  if (affected !== 1) {
    const cur = rawRows(await db.execute(sql`SELECT status FROM st_releases WHERE id = ${releaseId} LIMIT 1`))[0];
    if (cur && String(cur.status) === "verified") {
      base.ok = true;
      base.detail = "已是 verified（幂等命中）";
      return base;
    }
    base.detail = "证据不齐或状态漂移，未翻 verified";
    return base;
  }
  await db.execute(
    sql`INSERT INTO st_release_audit (release_id, channel, actor, action, detail)
        SELECT id, channel, ${actor()}, 'verify', ${'输送带自动登记：verifier+report_ref 证据在案'}
        FROM st_releases WHERE id = ${releaseId} LIMIT 1`,
  );
  base.ok = true;
  base.detail = "draft→verified 已登记";
  return base;
}

async function eligibleDeploy(releaseId: number): Promise<ActionResult> {
  const base: ActionResult = { kind: "eligible_deploy", refId: releaseId, ok: false, detail: "" };
  const db = getDb();
  // 资格复查：verified + 双签票据已消费（人拍板在先，机械臂只登记资格）
  const okRow = rawRows(
    await db.execute(
      sql`SELECT r.id FROM st_releases r
          JOIN st_release_tickets t ON t.release_id = r.id AND t.action = 'publish' AND t.status = 'consumed'
          WHERE r.id = ${releaseId} AND r.status = 'verified' LIMIT 1`,
    ),
  );
  if (okRow.length === 0) {
    base.detail = "资格复查未过（非 verified 或票据未消费）";
    return base;
  }
  await db.execute(
    sql`INSERT INTO st_release_audit (release_id, channel, actor, action, detail)
        SELECT id, channel, ${actor()}, 'deploy:eligible', '双签票据已消费，具备部署资格（机器部署走执行官管线）'
        FROM st_releases WHERE id = ${releaseId} LIMIT 1`,
  );
  base.ok = true;
  base.detail = "deploy:eligible 已登记";
  return base;
}

async function autoRollback(releaseId: number): Promise<ActionResult> {
  const base: ActionResult = { kind: "auto_rollback", refId: releaseId, ok: false, detail: "" };
  const db = getDb();
  const upd = await db.execute(
    sql`UPDATE st_releases SET status = 'rolled_back' WHERE id = ${releaseId} AND status = 'published'`,
  );
  const first = Array.isArray(upd) ? (upd as unknown[])[0] : upd;
  const affected = Number((first as { affectedRows?: number })?.affectedRows ?? 0);
  if (affected !== 1) {
    base.detail = "非 published（可能已止血），未重复动作";
    return base;
  }
  await db.execute(
    sql`INSERT INTO st_release_audit (release_id, channel, actor, action, detail)
        SELECT id, channel, ${actor()}, 'rollback', '输送带自动止血：探针红（机器级回滚走回滚位 runbook）'
        FROM st_releases WHERE id = ${releaseId} LIMIT 1`,
  );
  base.ok = true;
  base.detail = "published→rolled_back 已止血";
  return base;
}

/** 整拍真执行：逐动作落地，结果如实汇总（任一失败不中断后续） */
export async function executeConveyorActions(actions: LoopAction[]): Promise<ActionResult[]> {
  const out: ActionResult[] = [];
  for (const a of actions) {
    try {
      if (a.kind === "queue_construct") out.push(await queueConstruct(a.proposalId));
      else if (a.kind === "auto_verify") out.push(await autoVerify(a.releaseId));
      else if (a.kind === "eligible_deploy") out.push(await eligibleDeploy(a.releaseId));
      else if (a.kind === "auto_rollback") out.push(await autoRollback(a.releaseId));
      else out.push({ kind: a.kind, refId: null, ok: true, detail: "reason" in a ? String(a.reason) : "noop" });
    } catch (e) {
      out.push({
        kind: a.kind,
        refId: "releaseId" in a ? a.releaseId : "proposalId" in a ? a.proposalId : null,
        ok: false,
        detail: String((e as Error)?.message ?? e).slice(0, 160),
      });
    }
  }
  return out;
}
