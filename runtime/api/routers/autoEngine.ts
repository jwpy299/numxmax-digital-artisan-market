/**
 * autoEngine —— iter96 自主运行引擎 + 适应度榜接口。
 *
 * 信号等级宪法（写死为常量，这就是「宪法」，不得由各厂自行放开）：
 * - A 只读自动：汇总/报告类信号。引擎自动标记 auto_done 并生成一句摘要。
 * - B 低风险自动执行：问候/提醒/月度考核排期类。constitution 允许（max_auto_level='B'）时
 *   自动执行——当前实现为生成执行说明记录（detail 追加执行说明）→ auto_done。
 * - C 需企业确认：技能上架建议/套餐变更建议/训练扩招。引擎只转 pending_confirm，等企业主 confirm。
 * - D 永远人工：退款/权限提升/删除/对外承诺。引擎只报告，保持 open 并标注需人工，禁止任何自动动作。
 *
 * 契约：
 * - autoEngine.signals {token, status?} → 本厂最近 100 条信号（含等级/状态）
 * - autoEngine.constitutionGet {token} → {maxAutoLevel}
 * - autoEngine.constitutionSet {token, maxAutoLevel:'A'|'B'} → 企业自设（拒绝 C/D）
 * - autoEngine.runOnce {token} → {scanned, autoDone, pendingConfirm, needHuman}
 * - autoEngine.confirm {token, signalId} → 企业主确认 C 级信号 → resolved
 * - autoEngine.exceptions {token} → {openD, pendingC, recentAuto}
 * - autoEngine.fitness {token} → 本厂技能适应度榜
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { stQuery } from "./terminal";
import { sessionMe } from "./wbSession";
import { requireWbHead } from "./claw";
import { getFactoryFitness } from "./fitnessUtil";
import { getDb } from "../queries/connection";
import { refreshDutyBriefingSnapshot } from "./snapshots";
import { publishBroadcast } from "./streamBus";

// ─── 宪法常量 ────────────────────────────────────────────────────────────────
export type SignalLevel = "A" | "B" | "C" | "D";
export type SignalSource = "alert" | "training" | "plan" | "ticket" | "corps" | "dispatch";

/** 宪法：各等级处置策略（注释即宪法条文，任何改动必须过评审） */
export const SIGNAL_CONSTITUTION: Record<SignalLevel, string> = {
  A: "只读自动：引擎自动标记 auto_done 并生成一句摘要",
  B: "低风险自动执行：宪法允许时自动执行（生成执行说明记录）→ auto_done",
  C: "需企业确认：转 pending_confirm，等企业主 confirm",
  D: "永远人工：引擎只报告，保持 open 并标注需人工，禁止任何自动动作",
};

const VALID_LEVELS = new Set(["A", "B", "C", "D"]);
const VALID_SOURCES = new Set(["alert", "training", "plan", "ticket", "corps", "dispatch"]);
const VALID_STATUSES = new Set(["open", "auto_done", "pending_confirm", "resolved", "ignored"]);

/** 信号接入点：其它路由调用，发一条本厂信号（level/source 白名单兜底为 D/ticket，永不 throw） */
export async function emitSignal(
  factoryId: number,
  source: SignalSource | string,
  level: SignalLevel | string,
  title: string,
  detail?: string,
): Promise<void> {
  const src = VALID_SOURCES.has(source) ? source : "ticket";
  const lv = VALID_LEVELS.has(level) ? level : "D";
  try {
    await stQuery(
      sql`INSERT INTO st_auto_signals (factory_id, source, level, title, detail)
          VALUES (${factoryId}, ${src}, ${lv}, ${title.slice(0, 255)}, ${detail ?? null})`,
    );
  } catch (e) {
    console.error(
      "[autoEngine] st_auto_signals 写入失败:",
      e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
    );
  }
  // M8-b 快照引擎钩子：新信号落库（唯一写入点）后异步刷新值守晨报快照。
  // fire-and-forget：refreshDutyBriefingSnapshot 同步返回、内部 catch 静默，绝不影响 emitSignal 主流程。
  refreshDutyBriefingSnapshot();
  // M9-a 主动播报钩子：新信号 → 广播事件（fire-and-forget，persona 规则只播 B/C 级）
  publishBroadcast({ factoryId, level: lv, title });
}

/** 本厂宪法（无行 = 默认 'A'） */
async function getConstitution(factoryId: number): Promise<"A" | "B"> {
  const rows = await stQuery(
    sql`SELECT max_auto_level AS maxAutoLevel FROM st_auto_constitution WHERE factory_id = ${factoryId} LIMIT 1`,
  );
  const v = rows[0] ? String(rows[0].maxAutoLevel) : "A";
  return v === "B" ? "B" : "A";
}

/** A 级只读摘要：取 detail 首句或 title 前缀 */
function summarize(title: string, detail: string | null): string {
  const base = (detail ?? "").trim();
  const firstLine = base.split(/[\n。]/).map((s) => s.trim()).find(Boolean);
  const summary = firstLine || title;
  return `引擎摘要：${summary.slice(0, 120)}`;
}

/**
 * B 级自愈执行器（iter99）：按信号内容匹配真实动作，返回真实动作说明（含证据编号）。
 * - 用量阈值类（llm_usage/用量/额度）：真实创建一条企业通知工单（st_handoff_tickets），
 *   企业客服通道可见，返回 HD- 工单号作为处置证据。
 * - 其它低风险信号：归档记录（无外部副作用，如实说明）。
 * 永不 throw：执行失败返回失败说明，由调用方写回信号 detail。
 */
export async function executeSelfHeal(
  factoryId: number,
  source: string,
  title: string,
  detail: string | null,
): Promise<string> {
  if (/llm_usage|用量|额度|80%|100%/.test(title)) {
    try {
      const message = `【引擎自愈】${title}\n${detail ?? ""}`.slice(0, 500);
      const res = await getDb().execute(
        sql`INSERT INTO st_handoff_tickets (session_id, message, contact, status)
            VALUES (${`engine-${factoryId}`}, ${message}, NULL, 'open')`,
      );
      const id = Number(
        ((res as unknown as Array<{ insertId?: number | string }>)[0] as
          | { insertId?: number | string }
          | undefined)?.insertId ?? 0,
      );
      const ticket = id > 0 ? `HD-${String(id).padStart(6, "0")}` : "HD-PENDING";
      return `自愈动作：已创建企业通知工单 ${ticket}（st_handoff_tickets 真实行），提醒负责人关注用量阈值。`;
    } catch (e) {
      return `自愈动作执行失败（已保留信号待人工）：${e instanceof Error ? e.message.slice(0, 120) : "unknown"}`;
    }
  }
  return `低风险归档：source=${source}，引擎确认无需外部动作，记录归档。`;
}

export const autoEngineRouter = createRouter({
  /** autoEngine.signals（query, wb）：本厂最近 100 条信号（可按 status 过滤） */
  signals: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      status: z.string().trim().max(20).optional(),
    }))
    .query(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      const fid = factory.id;
      const status = input.status && VALID_STATUSES.has(input.status) ? input.status : null;
      const rows = status
        ? await stQuery(
            sql`SELECT id, source, level, title, detail, status, created_at AS createdAt, handled_at AS handledAt
                FROM st_auto_signals WHERE factory_id = ${fid} AND status = ${status}
                ORDER BY id DESC LIMIT 100`,
          )
        : await stQuery(
            sql`SELECT id, source, level, title, detail, status, created_at AS createdAt, handled_at AS handledAt
                FROM st_auto_signals WHERE factory_id = ${fid} ORDER BY id DESC LIMIT 100`,
          );
      return {
        signals: rows.map((r) => ({
          id: Number(r.id),
          source: String(r.source),
          level: String(r.level),
          title: String(r.title),
          detail: r.detail === null || r.detail === undefined ? null : String(r.detail),
          status: String(r.status),
          createdAt: r.createdAt ? String(r.createdAt) : null,
          handledAt: r.handledAt ? String(r.handledAt) : null,
        })),
      };
    }),

  /** autoEngine.constitutionGet（query, wb）：本厂宪法（缺省 A） */
  constitutionGet: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      return { maxAutoLevel: await getConstitution(factory.id) };
    }),

  /** autoEngine.constitutionSet（mutation, wb owner）：企业自设自动执行上限（只能 A/B；C/D 永远要人） */
  constitutionSet: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      maxAutoLevel: z.enum(["A", "B"]),
    }))
    .mutation(async ({ input }) => {
      const { factory } = await requireWbHead(input.token);
      // 双保险：zod 已限 A/B，此处再守一次并给宪法文案
      if (input.maxAutoLevel !== "A" && input.maxAutoLevel !== "B") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "C/D 级决策必须由人拍板" });
      }
      await stQuery(
        sql`INSERT INTO st_auto_constitution (factory_id, max_auto_level)
            VALUES (${factory.id}, ${input.maxAutoLevel})
            ON DUPLICATE KEY UPDATE max_auto_level = VALUES(max_auto_level)`,
      );
      return { ok: true as const, maxAutoLevel: input.maxAutoLevel };
    }),

  /** autoEngine.runOnce（mutation, wb）：扫描本厂 open 信号，按宪法分级处置 */
  runOnce: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .mutation(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      const fid = factory.id;
      const maxAuto = await getConstitution(fid);
      const open = await stQuery(
        sql`SELECT id, source, level, title, detail FROM st_auto_signals
            WHERE factory_id = ${fid} AND status = 'open' ORDER BY id ASC LIMIT 200`,
      );
      let autoDone = 0;
      let pendingConfirm = 0;
      let needHuman = 0;
      for (const sig of open) {
        const id = Number(sig.id);
        const level = String(sig.level);
        const title = String(sig.title);
        const detail = sig.detail === null || sig.detail === undefined ? null : String(sig.detail);
        if (level === "A") {
          // A 只读自动：auto_done + 一句摘要
          const summary = summarize(title, detail);
          await stQuery(
            sql`UPDATE st_auto_signals SET status = 'auto_done', handled_at = NOW(),
                    detail = CONCAT(IFNULL(detail, ''), ${`\n${summary}`})
                WHERE id = ${id} AND status = 'open'`,
          );
          autoDone += 1;
        } else if (level === "B" && maxAuto === "B") {
          // B 低风险自动执行（宪法允许，iter99 接真实自愈执行器）：动作说明（含证据）写回信号 detail
          const healNote = await executeSelfHeal(fid, String(sig.source ?? "alert"), title, detail);
          const note = `\n执行说明：引擎已按宪法 B 级自动处理「${title.slice(0, 80)}」。${healNote}`;
          await stQuery(
            sql`UPDATE st_auto_signals SET status = 'auto_done', handled_at = NOW(),
                    detail = CONCAT(IFNULL(detail, ''), ${note})
                WHERE id = ${id} AND status = 'open'`,
          );
          autoDone += 1;
        } else if (level === "C") {
          // C 需企业确认
          await stQuery(
            sql`UPDATE st_auto_signals SET status = 'pending_confirm', handled_at = NOW()
                WHERE id = ${id} AND status = 'open'`,
          );
          pendingConfirm += 1;
        } else {
          // D（以及 B 但宪法仅 A）：保持 open，标注需人工
          needHuman += 1;
          if (level === "D") {
            await stQuery(
              sql`UPDATE st_auto_signals
                  SET detail = CONCAT(IFNULL(detail, ''), '\n[引擎] D 级决策必须由人拍板，保持 open 待人工处理')
                  WHERE id = ${id} AND status = 'open' AND (detail IS NULL OR detail NOT LIKE '%必须由人拍板%')`,
            );
          }
        }
      }
      return { scanned: open.length, autoDone, pendingConfirm, needHuman };
    }),

  /** autoEngine.confirm（mutation, wb owner）：企业主确认 C 级信号 → resolved */
  confirm: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      signalId: z.number().int().positive(),
    }))
    .mutation(async ({ input }) => {
      const { factory } = await requireWbHead(input.token);
      const rows = await stQuery(
        sql`SELECT id, status FROM st_auto_signals
            WHERE id = ${input.signalId} AND factory_id = ${factory.id} LIMIT 1`,
      );
      const sig = rows[0];
      if (!sig) throw new TRPCError({ code: "NOT_FOUND", message: "信号不存在" });
      if (String(sig.status) !== "pending_confirm") {
        throw new TRPCError({ code: "BAD_REQUEST", message: `信号当前状态 ${String(sig.status)}，仅 pending_confirm 可确认` });
      }
      await stQuery(
        sql`UPDATE st_auto_signals SET status = 'resolved', handled_at = NOW() WHERE id = ${input.signalId}`,
      );
      return { ok: true as const, signalId: input.signalId, status: "resolved" as const };
    }),

  /** autoEngine.exceptions（query, wb）：异常控制台 {openD, pendingC, recentAuto} */
  exceptions: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      const fid = factory.id;
      const openD = await stQuery(
        sql`SELECT id, source, title, created_at AS createdAt FROM st_auto_signals
            WHERE factory_id = ${fid} AND level = 'D' AND status = 'open' ORDER BY id DESC LIMIT 50`,
      );
      const pendingC = await stQuery(
        sql`SELECT id, source, title, created_at AS createdAt FROM st_auto_signals
            WHERE factory_id = ${fid} AND status = 'pending_confirm' ORDER BY id DESC LIMIT 50`,
      );
      const recentAuto = await stQuery(
        sql`SELECT id, source, level, title, handled_at AS handledAt FROM st_auto_signals
            WHERE factory_id = ${fid} AND status = 'auto_done' ORDER BY id DESC LIMIT 20`,
      );
      const mapRow = (r: Record<string, unknown>, timeKey: string) => ({
        id: Number(r.id),
        source: String(r.source),
        level: r.level === undefined ? undefined : String(r.level),
        title: String(r.title),
        at: r[timeKey] ? String(r[timeKey]) : null,
      });
      return {
        openD: openD.map((r) => mapRow(r, "createdAt")),
        pendingC: pendingC.map((r) => mapRow(r, "createdAt")),
        recentAuto: recentAuto.map((r) => mapRow(r, "handledAt")),
      };
    }),

  /** autoEngine.fitness（query, wb）：本厂技能适应度榜（含成功率） */
  fitness: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      return { fitness: await getFactoryFitness(factory.id) };
    }),
});
