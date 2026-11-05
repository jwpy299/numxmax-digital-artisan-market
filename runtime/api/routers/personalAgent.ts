/**
 * personalAgent —— 个人版分身系统 API（2026-08-27 彭总定调四环：养成→装扮→上架→晋升）。
 *
 * 口径：
 * - 首分身免费领（只会聊天）；晋升解锁：任一分身在职满 2 月且评分≥4.0 → +1 名额（上限 10）；
 *   低评（<3.5）解雇 → 冻结该名额冷却 30 天；名额永不可交易；
 * - 装扮=付费穿戴（skill 职业/tool 执行器/cosmetic 形象音色），词元扣账走钱包；
 * - 上架闸：实习评价达标（完成≥10 实习单且评分≥4.2）才允许 listed——防货架水化；
 * - 全部数据只见自己的（owner_user_id 服务端会话口径）。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { sessionMe } from "./wbSession";
import { AVATAR_PRESETS, DRESS_ACCESSORIES, generateAvatar, type AvatarSpec } from "./avatarService";
import { debitForPurchase } from "./tokenLedger";
import { emitEmotionNode } from "./emotionNodes";
import { runInternTask } from "./internJobs";
import { rawRows } from "../queries/rawRows"; // 战区④批A-lite：私有副本退役→canonical 叶单源

const tokenInput = { token: z.string().trim().min(1) };


// ─── 晋升纯规则（可测） ─────────────────────────────────────────────────────
export const PROMOTION = {
  MAX_SLOTS: 10,
  QUALIFY_MONTHS: 2,
  QUALIFY_SCORE: 4.0,
  FREEZE_SCORE: 3.5,
  FREEZE_DAYS: 30,
  LIST_MIN_TASKS: 10,
  LIST_MIN_SCORE: 4.2,
} as const;

export function canUnlockSlot(hireMonths: number, score: number | null): boolean {
  return hireMonths >= PROMOTION.QUALIFY_MONTHS && (score ?? 0) >= PROMOTION.QUALIFY_SCORE;
}
export function shouldFreeze(score: number | null): boolean {
  return score != null && score < PROMOTION.FREEZE_SCORE;
}
export function canList(internTasks: number, score: number | null): boolean {
  return internTasks >= PROMOTION.LIST_MIN_TASKS && (score ?? 0) >= PROMOTION.LIST_MIN_SCORE;
}
export function nextSlotState(slots: { slot_no: number; state: string }[]): { openSlots: number; usedSlots: number; nextUnlockHint: string } {
  const open = slots.filter((s) => s.state === "open").length;
  const used = slots.filter((s) => s.state === "used").length;
  return { openSlots: open, usedSlots: used, nextUnlockHint: open > 0 ? "有空闲名额可造新分身" : "让在职分身满 2 个月且评分≥4.0 解锁新名额" };
}

export const personalAgentRouter = createRouter({
  /** 我的分身全景：分身列表 + 名额 + 晋升提示（APP 首页数据源） */
  myAgents: publicQuery.input(z.object(tokenInput)).query(async ({ input }) => {
    const session = await sessionMe(input.token);
    const uid = session.user.id;
    const db = getDb();
    const agents = rawRows(
      await db.execute(
        sql`SELECT id, slot_no AS slotNo, name, avatar_config AS avatarConfig, persona_text AS personaText,
                   status, hire_score AS hireScore, hire_months AS hireMonths, list_price AS listPrice, listed_at AS listedAt
            FROM st_personal_agents WHERE owner_user_id=${uid} ORDER BY slot_no ASC`,
      ),
    );
    const slots = rawRows(
      await db.execute(sql`SELECT slot_no, state, frozen_until AS frozenUntil FROM st_agent_slots WHERE owner_user_id=${uid} ORDER BY slot_no ASC`),
    ) as { slot_no: number; state: string }[];
    const dress = rawRows(
      await db.execute(
        sql`SELECT d.agent_id AS agentId, d.dress_kind AS dressKind, d.item_key AS itemKey
            FROM st_agent_dress d JOIN st_personal_agents a ON a.id=d.agent_id
            WHERE a.owner_user_id=${uid} AND d.unequipped_at IS NULL`,
      ),
    );
    const summary = nextSlotState(slots);
    // v176 今日收成（个人工作台实况卡）：今日验收单数 + 词元入账（task_ref 带 pa: 前缀归属个人分身）
    let today = { tasks: 0, tokens: 0 };
    try {
      const ids = (agents as { id: number }[]).map((a) => a.id);
      if (ids.length > 0) {
        const t = rawRows(
          await db.execute(
            sql`SELECT COUNT(*) AS c, COALESCE(SUM(token_cost),0) AS tk FROM st_delivery_acceptances
                WHERE accepted_at >= CURDATE() AND (${sql.join(ids.map((i) => sql`task_ref LIKE ${`pa:${i}:%`}`), sql` OR `)})`,
          ),
        )[0];
        today = { tasks: Number(t?.c ?? 0), tokens: Number(t?.tk ?? 0) };
      }
    } catch { /* 统计失败不挡主链 */ }
    return { agents, slots, dress, summary, maxSlots: PROMOTION.MAX_SLOTS, today };
  }),

  /** 领取首分身（免费基础版：只会聊天；名额 1 必须 open） */
  claimFirst: publicQuery
    .input(z.object({ ...tokenInput, name: z.string().trim().min(1).max(16) }))
    .mutation(async ({ input }) => {
      const session = await sessionMe(input.token);
      const uid = session.user.id;
      const db = getDb();
      const existing = rawRows(await db.execute(sql`SELECT id FROM st_personal_agents WHERE owner_user_id=${uid} LIMIT 1`));
      if (existing.length > 0) throw new TRPCError({ code: "CONFLICT", message: "你已有分身，请在晋升之路查看名额" });
      await db.execute(
        sql`INSERT INTO st_agent_slots (owner_user_id, slot_no, state, unlocked_at)
            VALUES (${uid}, 1, 'used', NOW())
            ON DUPLICATE KEY UPDATE state='used', unlocked_at=COALESCE(unlocked_at, NOW())`,
      );
      const ins = await db.execute(
        sql`INSERT INTO st_personal_agents (owner_user_id, slot_no, name, status) VALUES (${uid}, 1, ${input.name}, 'chat')`,
      );
      const first = Array.isArray(ins) ? (ins as unknown[])[0] : ins;
      const agentId = Number((first as { insertId?: number })?.insertId ?? 0);
      // v152 分身形象：个人默认玉绿皮，生成失败静默（APP 端回落默认形象）
      void generateAvatar(`pa-${agentId}`, AVATAR_PRESETS.personal_jade).then(async (url) => {
        if (url) await getDb().execute(sql`UPDATE st_personal_agents SET avatar_config=${JSON.stringify({ url, preset: "personal_jade" })} WHERE id=${agentId}`).catch(() => {});
      });
      return { ok: true as const, agentId };
    }),

  /** 装扮（付费穿戴；钱包扣账由调用方 wbBilling 联动，此处落穿戴事实） */
  dress: publicQuery
    .input(z.object({
      ...tokenInput,
      agentId: z.number().int().positive(),
      dressKind: z.enum(["skill", "tool", "cosmetic"]),
      itemKey: z.string().trim().min(1).max(64),
      paidTokens: z.number().int().min(0).default(0),
    }))
    .mutation(async ({ input }) => {
      const session = await sessionMe(input.token);
      const db = getDb();
      const own = rawRows(await db.execute(sql`SELECT id, status FROM st_personal_agents WHERE id=${input.agentId} AND owner_user_id=${session.user.id} LIMIT 1`));
      if (!own[0]) throw new TRPCError({ code: "NOT_FOUND", message: "分身不存在或不是你的" });
      const dup = rawRows(
        await db.execute(sql`SELECT id FROM st_agent_dress WHERE agent_id=${input.agentId} AND dress_kind=${input.dressKind} AND item_key=${input.itemKey} AND unequipped_at IS NULL LIMIT 1`),
      );
      if (dup[0]) return { ok: true as const, already: true as const };
      // v153 真实扣词元（原子不透支；余额不足抛 PAYMENT_REQUIRED 人话文案）
      await debitForPurchase({ factoryId: session.factory.id, amount: input.paidTokens, packKey: `dress:${input.itemKey}` });
      await db.execute(
        sql`INSERT INTO st_agent_dress (agent_id, dress_kind, item_key, paid_tokens) VALUES (${input.agentId}, ${input.dressKind}, ${input.itemKey}, ${input.paidTokens})`,
      );
      if (String(own[0].status) === "chat") {
        await db.execute(sql`UPDATE st_personal_agents SET status='dressed' WHERE id=${input.agentId}`);
      }
      // v152 装扮可见化：技能/饰品穿上身（重生成形象，失败保留旧图）
      const accKey = `${input.dressKind}:${input.itemKey}`;
      const acc = DRESS_ACCESSORIES[accKey];
      if (acc) {
        void (async () => {
          const cur = rawRows(await getDb().execute(sql`SELECT avatar_config AS ac FROM st_personal_agents WHERE id=${input.agentId} LIMIT 1`));
          let spec: { palette?: AvatarSpec["palette"]; accessories?: string[] } = { ...AVATAR_PRESETS.personal_jade, accessories: [] };
          try { const prev = JSON.parse(String(cur[0]?.ac ?? "{}")); spec = { ...spec, ...(prev.spec ?? {}) }; } catch { /* ignore */ }
          const accs = new Set([...(spec.accessories ?? []), acc]);
          const url = await generateAvatar(`pa-${input.agentId}`, { ...spec, accessories: [...accs] });
          if (url) await getDb().execute(sql`UPDATE st_personal_agents SET avatar_config=${JSON.stringify({ url, spec: { ...spec, accessories: [...accs] } })} WHERE id=${input.agentId}`).catch(() => {});
        })();
      }
      return { ok: true as const, already: false as const };
    }),

  /** 上架申请（达标闸：实习单+评分双过线） */
  applyListing: publicQuery
    .input(z.object({ ...tokenInput, agentId: z.number().int().positive(), price: z.number().int().min(1).max(100000) }))
    .mutation(async ({ input }) => {
      const session = await sessionMe(input.token);
      const db = getDb();
      const a = rawRows(
        await db.execute(sql`SELECT id, status, hire_score AS score FROM st_personal_agents WHERE id=${input.agentId} AND owner_user_id=${session.user.id} LIMIT 1`),
      )[0];
      if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "分身不存在或不是你的" });
      const intern = rawRows(
        await db.execute(sql`SELECT COUNT(*) AS c FROM st_delivery_acceptances WHERE task_ref LIKE ${`pa:${input.agentId}:%`}`),
      );
      const internTasks = Number(intern[0]?.c ?? 0);
      if (!canList(internTasks, a.score == null ? null : Number(a.score))) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `未达上架标准：需实习单≥${PROMOTION.LIST_MIN_TASKS} 且评分≥${PROMOTION.LIST_MIN_SCORE}（当前 ${internTasks} 单/${a.score ?? "暂无评分"}）` });
      }
      await db.execute(
        sql`UPDATE st_personal_agents SET status='listed', list_price=${input.price}, listed_at=NOW() WHERE id=${input.agentId}`,
      );
      return { ok: true as const, status: "listed" as const };
    }),

  /** 手动领一单实习（确定性派单执行判分；每日上限 3 单） */
  takeInternTask: publicQuery
    .input(z.object({ ...tokenInput, agentId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const session = await sessionMe(input.token);
      const own = rawRows(await getDb().execute(sql`SELECT id FROM st_personal_agents WHERE id=${input.agentId} AND owner_user_id=${session.user.id} LIMIT 1`));
      if (!own[0]) throw new TRPCError({ code: "NOT_FOUND", message: "分身不存在或不是你的" });
      const r = await runInternTask(input.agentId, session.user.id, session.factory.id);
      return { ok: r.ok, detail: r.detail };
    }),

  /** 晋升检查（环/手动触发均可）：达标分身→解锁下一名额；低评→冻结 */
  evaluatePromotion: publicQuery.input(z.object(tokenInput)).mutation(async ({ input }) => {
    const session = await sessionMe(input.token);
    const uid = session.user.id;
    const db = getDb();
    const agents = rawRows(
      await db.execute(sql`SELECT id, hire_months AS m, hire_score AS s FROM st_personal_agents WHERE owner_user_id=${uid}`),
    ) as { id: number; m: number; s: number | null }[];
    const slots = rawRows(await db.execute(sql`SELECT slot_no, state FROM st_agent_slots WHERE owner_user_id=${uid} ORDER BY slot_no`)) as { slot_no: number; state: string }[];
    const openCount = slots.filter((s) => s.state === "open").length;
    const nextNo = slots.length + 1;
    let unlocked = 0;
    let frozen = 0;
    // 解锁：有达标分身 + 无空闲名额 + 未超上限
    const qualified = agents.find((a) => canUnlockSlot(Number(a.m), a.s == null ? null : Number(a.s)));
    if (qualified && openCount === 0 && nextNo <= PROMOTION.MAX_SLOTS) {
      await db.execute(
        sql`INSERT INTO st_agent_slots (owner_user_id, slot_no, state, unlocked_by, unlocked_at) VALUES (${uid}, ${nextNo}, 'open', ${qualified.id}, NOW())`,
      );
      unlocked = 1;
      // 情绪节点（fire-and-forget）：晋升解锁——灵枢记得这一刻
      void emitEmotionNode(uid, "promotion", `emo:promo:u${uid}:slot${nextNo}`, { slotNo: nextNo });
    }
    // 冻结：低评分身占用的名额冷却
    for (const a of agents) {
      if (shouldFreeze(a.s == null ? null : Number(a.s))) {
        await db.execute(
          sql`UPDATE st_agent_slots SET state='frozen', frozen_until=DATE_ADD(NOW(), INTERVAL ${PROMOTION.FREEZE_DAYS} DAY)
              WHERE owner_user_id=${uid} AND state='open' AND frozen_until IS NULL LIMIT 1`,
        );
        frozen++;
        break; // 每次评估最多冻一个，防误伤
      }
    }
    return { ok: true as const, unlocked, frozen, nextNo, qualified: !!qualified };
  }),
});
