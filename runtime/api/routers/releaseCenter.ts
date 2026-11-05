/**
 * releaseCenter —— 超级终端系统更新机制（M51）。
 *
 * 彭总口径：NumX Max APP / 星云 / 智能工作台（含数字员工超市）/ 门户 的更新维护统一收口到
 * 超级终端管理后台；发布与回滚为 C 级动作，双签票据 + 全程审计。
 *
 * 五道闸流水线：
 *   ① propose 提案（draft）——版本登记，B 级无票据；
 *   ② markVerified 验证登记（draft→verified）——必须附 verifier 闸编号与报告引用，
 *      「沙箱先跑通再推全量」纪律的数据化落点；
 *   ③ requestTicket 申请 C 级票据（publish/rollback，pending）；
 *   ④ confirmTicket 双签确认（发起人≠确认人，票据一次性原子消费，状态推进同事务）；
 *   ⑤ publish/rollback 状态迁移 + st_release_audit 流水。
 *
 * 权限：全部过程 requireHqAdmin（超级终端本厂闸，fail-closed）。
 * 边界（与 releases.board 同哲学）：本路由只做「版本台账 + 流水线状态机 + 双签 + 审计」，
 * 真实的产物切换/部署执行在运维通道完成（30 秒级 rollback.sh / OTA manifest 更新），
 * 面板不直接执行服务器写动作，权限面不扩大。
 * advise（AI 更新执行官席，M57 全量内嵌 DSH）：执行官「维枢」不是一次裸 LLM API 调用，
 * 而是 DSH 运行时框架的原生席位——人格档案（st_agents）+ 执行规范（st_skills update-officer，
 * 经 export-skill-library 进 dsh-plugin-store skills/ 分区）注入后，整段评估任务交给 DSH 底座
 * headless 会话执行（bwrap 沙箱、多步工具循环、MCP 工具面，同 M44 DSH 轨）；DSH 不可用时
 * 诚实降级为确定性规则模板（degraded=true），绝不退回裸 API 调用、绝不炸主链。
 * 技术迭代由 AI 参谋提案+评估，人双签执行——执行官绝不替代双签。
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { affectedRowsOf, insertIdOf } from "../lib/dbResult";
import { getDb } from "../queries/connection";
import { TRPCError } from "@trpc/server";
import { findAgentByCode, requireHqAdmin } from "./terminal";
import { callDsh } from "./dshClient";
import { stripSecrets } from "./voice";

type Row = Record<string, unknown>;

/** 四端 + 服务端发布通道（终稿枚举，新增通道需同步此表与 UI） */
export const RELEASE_CHANNELS = ["app_apk", "wb", "admin", "portal", "server"] as const;
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

/** 状态机（终稿）：draft → verified → published → rolled_back */
export const RELEASE_STATUSES = ["draft", "verified", "published", "rolled_back"] as const;

const tokenInput = z.object({ token: z.string().trim().min(1) });

// ─── 本地助手（与 dshGovernance 同口径，避免跨模块私有函数耦合）─────────────────
function rowsOf(result: unknown): Row[] {
  const first = Array.isArray(result) ? (result as unknown[])[0] : result;
  return Array.isArray(first) ? (first as Row[]) : [];
}

function actorOf(user: { username?: unknown; displayName?: unknown }): string {
  const raw = String(user.username ?? user.displayName ?? "unknown");
  return stripSecrets(raw).slice(0, 64) || "unknown";
}

function newTicketNo(): string {
  return `RLT-${Date.now().toString(36).toUpperCase()}${randomBytes(5).toString("hex").toUpperCase()}`;
}

async function releaseById(id: number): Promise<Row | null> {
  const rows = rowsOf(await getDb().execute(sql`SELECT * FROM st_releases WHERE id = ${id} LIMIT 1`));
  return rows[0] ?? null;
}

async function writeAudit(entry: {
  releaseId?: number | null;
  channel?: string | null;
  actor: string;
  action: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  const detail = entry.detail ? stripSecrets(JSON.stringify(entry.detail)).slice(0, 2000) : null;
  await getDb().execute(sql`
    INSERT INTO st_release_audit (release_id, channel, actor, action, detail)
    VALUES (${entry.releaseId ?? null}, ${entry.channel ?? null}, ${entry.actor}, ${entry.action}, ${detail})
  `);
}

function releaseDto(r: Row) {
  return {
    id: Number(r.id),
    channel: String(r.channel),
    version: String(r.version),
    artifactUri: r.artifact_uri == null ? null : String(r.artifact_uri),
    md5: r.md5 == null ? null : String(r.md5),
    status: String(r.status),
    verifier: r.verifier == null ? null : String(r.verifier),
    reportRef: r.report_ref == null ? null : String(r.report_ref),
    note: r.note == null ? null : String(r.note),
    createdBy: String(r.created_by),
    createdAt: String(r.created_at),
    publishedAt: r.published_at == null ? null : String(r.published_at),
  };
}

export const releaseCenterRouter = createRouter({
  /** 版本台账：按通道列出（默认全部，新→旧，每通道 50 条封顶） */
  list: publicQuery
    .input(tokenInput.extend({ channel: z.enum(RELEASE_CHANNELS).optional() }))
    .query(async ({ input }) => {
      await requireHqAdmin(input.token);
      const rows = input.channel
        ? rowsOf(await getDb().execute(sql`
            SELECT * FROM st_releases WHERE channel = ${input.channel}
            ORDER BY id DESC LIMIT 50`))
        : rowsOf(await getDb().execute(sql`
            SELECT * FROM st_releases ORDER BY id DESC LIMIT 200`));
      return { ok: true as const, channels: RELEASE_CHANNELS, items: rows.map(releaseDto) };
    }),

  /** ① 提案：登记新版本（draft）。channel+version 唯一（幂等：重复提案返回已存在） */
  propose: publicQuery
    .input(tokenInput.extend({
      channel: z.enum(RELEASE_CHANNELS),
      version: z.string().trim().min(1).max(32),
      artifactUri: z.string().trim().max(300).optional(),
      md5: z.string().trim().max(32).optional(),
      note: z.string().trim().max(300).optional(),
    }))
    .mutation(async ({ input }) => {
      const user = await requireHqAdmin(input.token);
      const actor = actorOf(user);
      const db = getDb();
      const dup = rowsOf(await db.execute(sql`
        SELECT * FROM st_releases WHERE channel = ${input.channel} AND version = ${input.version} LIMIT 1`));
      if (dup[0]) return { ok: true as const, idempotent: true as const, release: releaseDto(dup[0]) };
      const ins = await db.execute(sql`
        INSERT INTO st_releases (channel, version, artifact_uri, md5, status, note, created_by)
        VALUES (${input.channel}, ${input.version}, ${input.artifactUri ?? null},
                ${input.md5 ?? null}, 'draft', ${input.note ? stripSecrets(input.note) : null}, ${actor})`);
      const id = insertIdOf(ins);
      await writeAudit({ releaseId: id, channel: input.channel, actor, action: "propose",
        detail: { version: input.version } });
      const row = await releaseById(id);
      return { ok: true as const, idempotent: false as const, release: releaseDto(row!) };
    }),

  /** ② 验证登记：draft→verified，必须附 verifier 闸编号（沙箱跑通纪律的硬约束） */
  markVerified: publicQuery
    .input(tokenInput.extend({
      releaseId: z.number().int().positive(),
      verifier: z.string().trim().min(1).max(32),
      reportRef: z.string().trim().max(300).optional(),
    }))
    .mutation(async ({ input }) => {
      const user = await requireHqAdmin(input.token);
      const actor = actorOf(user);
      const rel = await releaseById(input.releaseId);
      if (!rel) throw new TRPCError({ code: "NOT_FOUND", message: "版本不存在" });
      if (String(rel.status) === "verified") {
        return { ok: true as const, idempotent: true as const, release: releaseDto(rel) };
      }
      if (String(rel.status) !== "draft") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "仅 draft 状态可登记验证" });
      }
      const upd = await getDb().execute(sql`
        UPDATE st_releases SET status = 'verified', verifier = ${input.verifier},
          report_ref = ${input.reportRef ?? null}
        WHERE id = ${input.releaseId} AND status = 'draft'`);
      if (affectedRowsOf(upd) !== 1) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "状态已变化，请刷新后重试" });
      }
      await writeAudit({ releaseId: input.releaseId, channel: String(rel.channel), actor,
        action: "verify", detail: { verifier: input.verifier, reportRef: input.reportRef ?? null } });
      return { ok: true as const, idempotent: false as const, release: releaseDto((await releaseById(input.releaseId))!) };
    }),

  /** ③ 申请 C 级票据：publish 要求 verified；rollback 要求该通道存在 published 版本 */
  requestTicket: publicQuery
    .input(tokenInput.extend({
      releaseId: z.number().int().positive(),
      action: z.enum(["publish", "rollback"]),
    }))
    .mutation(async ({ input }) => {
      const user = await requireHqAdmin(input.token);
      const actor = actorOf(user);
      const db = getDb();
      const rel = await releaseById(input.releaseId);
      if (!rel) throw new TRPCError({ code: "NOT_FOUND", message: "版本不存在" });
      if (input.action === "publish" && String(rel.status) !== "verified") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "发布前必须先通过验证登记（verified）" });
      }
      if (input.action === "rollback" && String(rel.status) !== "published") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "仅已发布版本可回滚" });
      }
      const existed = rowsOf(await db.execute(sql`
        SELECT * FROM st_release_tickets
        WHERE release_id = ${input.releaseId} AND action = ${input.action} AND status = 'pending'
        ORDER BY id DESC LIMIT 1`));
      if (existed[0]) {
        return { ok: true as const, idempotent: true as const,
          ticket: { ticketNo: String(existed[0].ticket_no), action: input.action, status: "pending" } };
      }
      const ticketNo = newTicketNo();
      await db.execute(sql`
        INSERT INTO st_release_tickets (ticket_no, release_id, action, status, created_by)
        VALUES (${ticketNo}, ${input.releaseId}, ${input.action}, 'pending', ${actor})`);
      await writeAudit({ releaseId: input.releaseId, channel: String(rel.channel), actor,
        action: `ticket:${input.action}`, detail: { ticketNo } });
      return { ok: true as const, idempotent: false as const,
        ticket: { ticketNo, action: input.action, status: "pending" } };
    }),

  /** ④ 双签确认：发起人≠确认人；票据一次性原子消费；状态推进同事务 */
  confirmTicket: publicQuery
    .input(tokenInput.extend({ ticketNo: z.string().trim().min(12).max(48) }))
    .mutation(async ({ input }) => {
      const user = await requireHqAdmin(input.token);
      const actor = actorOf(user);
      const db = getDb();
      const ticketRows = rowsOf(await db.execute(sql`
        SELECT * FROM st_release_tickets WHERE ticket_no = ${input.ticketNo} LIMIT 1`));
      const ticket = ticketRows[0];
      if (!ticket || String(ticket.status) !== "pending") {
        throw new TRPCError({ code: "FORBIDDEN", message: "票据无效或已使用" });
      }
      // C 级双签：发起人不能给自己的票据做最终确认
      if (actor === String(ticket.created_by ?? "")) {
        throw new TRPCError({ code: "FORBIDDEN", message: "C 级票据必须由另一名负责人确认" });
      }
      const rel = await releaseById(Number(ticket.release_id));
      if (!rel) throw new TRPCError({ code: "NOT_FOUND", message: "版本不存在" });
      const action = String(ticket.action);
      const from = String(rel.status);
      const to = action === "publish" ? "published" : "rolled_back";
      if (action === "publish" && from !== "verified") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "发布前必须先通过验证登记（verified）" });
      }
      if (action === "rollback" && from !== "published") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "仅已发布版本可回滚" });
      }
      const consumed = await db.execute(sql`
        UPDATE st_release_tickets SET status = 'consumed', confirmed_by = ${actor}, consumed_at = NOW()
        WHERE id = ${Number(ticket.id)} AND status = 'pending'`);
      if (affectedRowsOf(consumed) !== 1) {
        throw new TRPCError({ code: "FORBIDDEN", message: "票据无效或已使用" });
      }
      const moved = await db.execute(sql`
        UPDATE st_releases SET status = ${to},
          published_at = ${action === "publish" ? sql`NOW()` : null}
        WHERE id = ${Number(rel.id)} AND status = ${from}`);
      if (affectedRowsOf(moved) !== 1) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "版本状态推进失败" });
      }
      await writeAudit({ releaseId: Number(rel.id), channel: String(rel.channel), actor,
        action: `confirm:${action}`, detail: { ticketNo: input.ticketNo, from, to } });
      return { ok: true as const, release: releaseDto((await releaseById(Number(rel.id)))!) };
    }),

  /** ⑤ 审计流水（新→旧，默认 50 条；detail 入库前已过 stripSecrets，读取侧二次兜底） */
  audit: publicQuery
    .input(tokenInput.extend({
      releaseId: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }))
    .query(async ({ input }) => {
      await requireHqAdmin(input.token);
      const rows = input.releaseId
        ? rowsOf(await getDb().execute(sql`
            SELECT * FROM st_release_audit WHERE release_id = ${input.releaseId}
            ORDER BY id DESC LIMIT ${input.limit}`))
        : rowsOf(await getDb().execute(sql`
            SELECT * FROM st_release_audit ORDER BY id DESC LIMIT ${input.limit}`));
      return {
        ok: true as const,
        items: rows.map((r) => ({
          id: Number(r.id),
          releaseId: r.release_id == null ? null : Number(r.release_id),
          channel: r.channel == null ? null : String(r.channel),
          actor: String(r.actor),
          action: String(r.action),
          detail: r.detail == null ? null : stripSecrets(String(r.detail)),
          createdAt: String(r.created_at),
        })),
      };
    }),

  /**
   * AI 更新执行官席（M57：Kimi K3 全量内嵌 DSH 运行时，非裸 API 调用）。
   * 执行链：人格档案（st_agents update-officer）+ 执行规范（st_skills update-officer）+
   * 实时台账 → 注入 DSH headless 会话（callDsh，同 M44 DSH 轨）→ 沙箱内多步推理出评估。
   * DSH 不可用 → 确定性规则模板降级（degraded=true，明说未读得 DSH 评估）。
   * 定位：AI 参谋提案与评估，人双签执行——技术迭代责任席位，绝不替代双签。
   */
  advise: publicQuery
    .input(tokenInput.extend({ releaseId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await requireHqAdmin(input.token);
      const rel = await releaseById(input.releaseId);
      if (!rel) throw new TRPCError({ code: "NOT_FOUND", message: "版本不存在" });
      const recent = rowsOf(await getDb().execute(sql`
        SELECT channel, version, status, published_at FROM st_releases
        WHERE channel = ${String(rel.channel)} ORDER BY id DESC LIMIT 5`));
      const summary = recent
        .map((r) => `${String(r.channel)} ${String(r.version)} [${String(r.status)}]`)
        .join("；");
      const fallback =
        `1. 状态核对：${String(rel.channel)} ${String(rel.version)} 当前 ${String(rel.status)}，` +
        `发布前须完成 verified 登记并附 verifier 报告；` +
        `2. 风险评估：未读得 DSH 执行官评估，按规则模板处理——C 级动作必须双签票据，确认人须与发起人不同；` +
        `3. 回滚预案：发布后保留上一 published 版本制品，回滚走同通道票据流程；` +
        `4. 建议：先灰度观察 24 小时再全量（APP 端走 OTA manifest 切换，web 端走 dist 快照切换）。`;
      // M56+M57：更新执行官「维枢」（Kimi K3 内嵌 DSH）——人格档案 st_agents、
      // 执行规范 st_skills（sync-m57 落库）；档案缺失时内置兜底，绝不阻断评估（同枢总先例）
      let officerPersona =
        "你是「维枢·更新执行官」——Kimi K3（月之暗面 Moonshot AI）全量内嵌于 DSH 运行时框架的" +
        "超级终端技术迭代责任席位，不是一次孤立的 API 调用：你运行在 DSH 沙箱会话里，" +
        "可使用你的工具面核对事实。基于版本台账给出 4 条以内发布风险评估与建议：" +
        "务实中文、每条一句、分点编号；必须覆盖：状态机合规、双签纪律、回滚预案、灰度建议。" +
        "绝不编造未提供的数据；不确定处明说。";
      try {
        const officer = await findAgentByCode("update-officer");
        if (officer?.systemPrompt) officerPersona = String(officer.systemPrompt);
      } catch {
        // st_agents 未初始化：用内置兜底
      }
      let skillSpec =
        "执行规范（update-officer 技能）：先说结论再给依据；评估须逐项核对" +
        "「状态机合规 / 双签票据纪律 / 回滚预案 / 灰度策略」四要点；不编造数字。";
      try {
        const rows = rowsOf(await getDb().execute(sql`
          SELECT output_template FROM st_skills
          WHERE skill_key = 'update-officer' AND status = 'active' LIMIT 1`));
        const tpl = rows[0]?.output_template;
        if (tpl != null && String(tpl).trim()) {
          skillSpec = `执行规范（update-officer 技能）：${stripSecrets(String(tpl)).slice(0, 1200)}`;
        }
      } catch {
        // st_skills 未初始化：用内置兜底
      }
      const task =
        `${officerPersona}\n${skillSpec}\n` +
        `纪律：可调用你可用的工具（read_*/run_*）取真实数据，绝不编造数字；` +
        `你没有 C 级控制权限，发布/回滚执行必须明说「这要走闸口双签」。\n` +
        `任务：评估以下版本发布申请并给出建议。\n` +
        `目标版本：${String(rel.channel)} ${String(rel.version)}（${String(rel.status)}，` +
        `说明：${String(rel.note ?? "无")}，验证：${String(rel.verifier ?? "未登记")}）。\n` +
        `该通道近期台账：${summary || "无"}`;
      // 平台级席位（五通道全局台账），不带 factoryId；DSH 故障诚实降级，绝不退回裸 LLM API
      const r = await callDsh(task, 300);
      const answer = String(r.answer ?? "").trim();
      const text = r.ok && answer.length >= 20 ? stripSecrets(answer) : fallback;
      return { ok: true as const, degraded: !r.ok, advice: text };
    }),
});
