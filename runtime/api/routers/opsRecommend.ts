/**
 * opsRecommend —— 迭代 35 批次B「推荐位运营」服务端路由（API-CONTRACT-v7 §2）。
 *
 * 数据表：st_recommend_slots（db/sync-ops.mts 幂等创建，uk_slot_target 唯一）。
 * 槽位：portal_agents（门户数字员工=agents.id）/ portal_packs / shop_packs（=st_skill_packs.pack_key）。
 *
 * 消费侧契约：只影响排序（pinned desc, weight desc, 原排序稳定保持），绝不滤除任何条目。
 * applyRecommendOrder 导出供 agents.list / skillShop.list 复用；表缺失时静默返回原序。
 *
 * 写操作（recoSet/recoRemove）均 requireAdmin + writeAdminAudit（fire-and-forget）。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { rawRows, requireAdmin } from "./terminal";
import { writeAdminAudit, adminDisplayName } from "./adminAnalytics";

const tokenInput = z.object({ token: z.string().trim().min(1) });
const slotKeyEnum = z.enum(["portal_agents", "portal_packs", "shop_packs"]);

type SlotKey = z.infer<typeof slotKeyEnum>;

interface SlotRow {
  targetId: string;
  weight: number;
  pinned: boolean;
  note: string;
}

/** 读取某槽位全部推荐位（表缺失/查询失败 → null，调用方按原序降级） */
async function readSlots(slotKey: SlotKey): Promise<Map<string, SlotRow> | null> {
  try {
    const rows = rawRows(
      await getDb().execute(
        sql`SELECT target_id, weight, pinned, note FROM st_recommend_slots WHERE slot_key = ${slotKey}`,
      ),
    );
    const map = new Map<string, SlotRow>();
    for (const r of rows) {
      map.set(String(r.target_id), {
        targetId: String(r.target_id),
        weight: Number(r.weight ?? 0),
        pinned: Number(r.pinned) === 1,
        note: r.note == null ? "" : String(r.note),
      });
    }
    return map;
  } catch {
    return null;
  }
}

/**
 * 消费侧重排（只排序不滤除）：pinned desc → weight desc → 原相对顺序（稳定）。
 * slots 为 null（表缺失）或无命中时原样返回。
 */
export function applyRecommendOrder<T>(items: T[], slots: Map<string, SlotRow> | null, getKey: (item: T) => string): T[] {
  if (!slots || slots.size === 0 || items.length === 0) return items;
  const decorated = items.map((item, index) => {
    const s = slots.get(getKey(item));
    return { item, index, pinned: s?.pinned ? 1 : 0, weight: s?.weight ?? 0 };
  });
  // 无任何命中：保持原序
  if (!decorated.some((d) => d.pinned === 1 || d.weight !== 0)) return items;
  decorated.sort((a, b) => b.pinned - a.pinned || b.weight - a.weight || a.index - b.index);
  return decorated.map((d) => d.item);
}

/** 供消费侧调用：读取槽位（agents.list / skillShop.list） */
export async function loadRecommendSlots(slotKey: SlotKey): Promise<Map<string, SlotRow> | null> {
  return readSlots(slotKey);
}

export const opsRecommendRouter = createRouter({
  /** recoList：槽位条目 + 目标名称（portal_agents→agents.name；packs→st_skill_packs.title） */
  recoList: publicQuery
    .input(tokenInput.extend({ slotKey: slotKeyEnum }))
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const slots = await readSlots(input.slotKey);
      const items = [...(slots?.values() ?? [])].sort(
        (a, b) => Number(b.pinned) - Number(a.pinned) || b.weight - a.weight,
      );
      // join 名称（尽力而为，失败则 targetName=null）
      const names = new Map<string, string>();
      try {
        if (input.slotKey === "portal_agents" && items.length > 0) {
          const rows = rawRows(
            await getDb().execute(
              sql`SELECT id, name FROM agents WHERE id IN (${sql.join(
                items.map((s) => sql`${Number(s.targetId) || 0}`),
                sql`, `,
              )})`,
            ),
          );
          for (const r of rows) names.set(String(r.id), String(r.name ?? ""));
        } else if (items.length > 0) {
          const rows = rawRows(
            await getDb().execute(
              sql`SELECT pack_key, title FROM st_skill_packs WHERE pack_key IN (${sql.join(
                items.map((s) => sql`${s.targetId}`),
                sql`, `,
              )})`,
            ),
          );
          for (const r of rows) names.set(String(r.pack_key), String(r.title ?? ""));
        }
      } catch {
        // 静默：名称缺失不阻断
      }
      return {
        items: items.map((s) => ({
          targetId: s.targetId,
          weight: s.weight,
          pinned: s.pinned,
          note: s.note,
          targetName: names.get(s.targetId) ?? null,
        })),
        degraded: slots == null,
      };
    }),

  /** recoSet：upsert（uk_slot_target）+ 审计 */
  recoSet: publicQuery
    .input(
      tokenInput.extend({
        slotKey: slotKeyEnum,
        targetId: z.string().trim().min(1).max(64),
        weight: z.number().int().min(-100000).max(100000).optional(),
        pinned: z.boolean().optional(),
        note: z.string().trim().max(255).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      const name = adminDisplayName(admin);
      // 合并语义：未提供的字段保留既有值（先读旧值再 upsert）
      const existing = await readSlots(input.slotKey);
      const prev = existing?.get(input.targetId);
      const weight = input.weight ?? prev?.weight ?? 0;
      const pinned = input.pinned ?? prev?.pinned ?? false;
      const note = input.note ?? prev?.note ?? "";
      await getDb().execute(
        sql`INSERT INTO st_recommend_slots (slot_key, target_id, weight, pinned, note, updated_by)
            VALUES (${input.slotKey}, ${input.targetId}, ${weight},
                    ${pinned ? 1 : 0}, ${note}, ${name})
            ON DUPLICATE KEY UPDATE
              weight = VALUES(weight),
              pinned = VALUES(pinned),
              note = VALUES(note),
              updated_by = VALUES(updated_by)`,
      );
      writeAdminAudit(Number(admin.id), name, "opsRecommend.set", `${input.slotKey}:${input.targetId}`, {
        weight,
        pinned,
        note,
      });
      return { ok: true as const, slotKey: input.slotKey, targetId: input.targetId, weight, pinned };
    }),

  /** recoRemove：删除槽位条目 + 审计 */
  recoRemove: publicQuery
    .input(
      tokenInput.extend({
        slotKey: slotKeyEnum,
        targetId: z.string().trim().min(1).max(64),
      }),
    )
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      const name = adminDisplayName(admin);
      await getDb().execute(
        sql`DELETE FROM st_recommend_slots WHERE slot_key = ${input.slotKey} AND target_id = ${input.targetId}`,
      );
      writeAdminAudit(Number(admin.id), name, "opsRecommend.remove", `${input.slotKey}:${input.targetId}`);
      return { ok: true as const, slotKey: input.slotKey, targetId: input.targetId };
    }),
});
