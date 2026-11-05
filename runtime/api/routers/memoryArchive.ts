/**
 * memoryArchive —— M49 记忆自动归档：灵枢/星云工作记忆达量后沉淀进企业知识库。
 *
 * 彭总口径：记忆系统达到一定程度的记忆后，将所有工作记忆自动归档到企业知识库和数据库。
 *
 * 两条自动触发链：
 * - auto_lru：wbMemory LRU 淘汰（个人超 MEMORY_CAP）前的抢救性归档——记忆不丢；
 * - auto_threshold：厂级活跃记忆 ≥ FACTORY_ARCHIVE_THRESHOLD 后的周期性知识沉淀
 *   （源记忆保留，仍参与召回；同厂同人格 24h 冷却防刷）。
 *
 * 纪律（与 wbMemory 同款）：
 * - 火忘式异步：调度返回 Promise 供测试 await，生产调用侧 void——任何失败静默，
 *   绝不阻断/拖慢记忆与语音主链；
 * - 内容再过一遍 stripSecrets（记忆写入已脱敏，归档双保险），正文 ≤ 8000 字；
 * - factory_id 强隔离：归档表独立（st_memory_archives），多厂记忆绝不混写 st_kb_docs
 *   （该表无 factory 隔离列，属本厂管理端）；
 * - LLM（flash 槽）提炼失败 → 纯文本拼接兜底（先保住记忆，再谈文采）；
 * - 归档表缺失（迁移未跑）→ 静默跳过。
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { callSlotChat } from "./modelGateway";
import { rawRows } from "./terminal";
import { stripSecrets } from "./voice";
import { requireWbRole, sessionMe } from "./wbSession";

/** 厂级活跃记忆阈值：达到后触发一次知识沉淀（scope 不限，按最旧/最低重要度取材） */
export const FACTORY_ARCHIVE_THRESHOLD = 500;
/** 单次沉淀取材上限 */
const ARCHIVE_BATCH = 100;
/** 同厂同人格冷却：24h 一次（LRU 抢救不受冷却限制——记忆不丢优先） */
const ARCHIVE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** 归档正文上限（字） */
const ARCHIVE_CONTENT_CAP = 8000;

export interface ArchiveItem {
  content: string;
  kind: string;
  importance: number;
}

interface ArchiveRow {
  id: number;
  factory_id: number;
  persona: string;
  title: string;
  content: string;
  source_count: number;
  source: string;
  created_at: string;
}

/** 归档表缺失时静默（迁移未跑不阻断主链） */
async function archiveTableReady(): Promise<boolean> {
  try {
    await getDb().execute(sql`SELECT 1 FROM st_memory_archives LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

/** 冷却检查：同厂同人格 24h 内已有 threshold 归档 → true（应跳过） */
async function inCooldown(factoryId: number, persona: string): Promise<boolean> {
  const rows = rawRows(
    await getDb().execute(
      sql`SELECT created_at FROM st_memory_archives
          WHERE factory_id = ${factoryId} AND persona = ${persona} AND source = 'auto_threshold'
          ORDER BY id DESC LIMIT 1`,
    ),
  );
  const last = rows[0]?.created_at;
  if (!last) return false;
  return Date.now() - new Date(String(last)).getTime() < ARCHIVE_COOLDOWN_MS;
}

/** LLM 提炼归档正文；失败/异常 → 纯文本拼接兜底（记忆不丢是底线） */
export async function distillArchive(
  persona: string,
  items: ArchiveItem[],
  llm: typeof callSlotChat = callSlotChat,
): Promise<string> {
  const listText = items.map((m, i) => `${i + 1}. [${m.kind}/重要度${m.importance}] ${m.content}`).join("\n");
  try {
    const r = await llm("flash", {
      messages: [
        {
          role: "system",
          content:
            `你在为企业的数字员工（${persona === "lingshu" ? "灵枢" : persona === "xingyun" ? "星云" : "小星"}）` +
            `归档工作记忆。把以下记忆条目提炼成一篇企业知识库文档：按主题分组、去重合并、保留关键事实与偏好，` +
            `中文务实表述，不超过 600 字。绝不编造条目里没有的信息，绝不输出密钥/票据号等编号串。`,
        },
        { role: "user", content: listText.slice(0, 6000) },
      ],
      maxTokens: 800,
      temperature: 0.3,
      timeoutMs: 30_000,
    });
    const text = String(r?.content ?? "").trim();
    if (text.length >= 20) return stripSecrets(text).slice(0, ARCHIVE_CONTENT_CAP);
  } catch {
    /* 落兜底 */
  }
  // 兜底：纯文本拼接（不丢任何一条）
  const body = items.map((m) => `- [${m.kind}] ${m.content}`).join("\n");
  return stripSecrets(`（自动归档·原始条目 ${items.length} 条）\n${body}`).slice(0, ARCHIVE_CONTENT_CAP);
}

/** 落一行归档（返回插入 id；表缺失/失败 → 0，静默） */
async function writeArchive(
  factoryId: number,
  persona: string,
  title: string,
  content: string,
  sourceCount: number,
  source: "auto_lru" | "auto_threshold" | "manual",
): Promise<number> {
  try {
    if (!(await archiveTableReady())) return 0;
    const r = await getDb().execute(
      sql`INSERT INTO st_memory_archives (factory_id, persona, title, content, source_count, source)
          VALUES (${factoryId}, ${persona}, ${title}, ${content}, ${sourceCount}, ${source})`,
    );
    const first = Array.isArray(r) ? (r[0] as { insertId?: number }) : null;
    return Number(first?.insertId ?? 0);
  } catch {
    return 0;
  }
}

/**
 * auto_lru 抢救归档：LRU 淘汰 victims 物理删除前调用（火忘式）。
 * 冷却豁免：记忆不丢优先于防刷；批量极小（每次淘汰几条）天然限流。
 */
export function scheduleLruArchive(
  factoryId: number,
  persona: string,
  items: ArchiveItem[],
): Promise<void> {
  return (async () => {
    if (items.length === 0) return;
    const content = await distillArchive(persona, items);
    const day = new Date().toISOString().slice(0, 10);
    await writeArchive(
      factoryId, persona,
      `${persona} 工作记忆归档（淘汰抢救 · ${day}）`,
      content, items.length, "auto_lru",
    );
  })();
}

/**
 * auto_threshold 阈值沉淀：厂级活跃记忆达阈值后，取最老/最低重要度一批提炼成知识文档。
 * 源记忆保留（仍参与召回）；同厂同人格 24h 冷却。
 * 返回是否实际归档（供测试断言）。
 */
export async function runThresholdArchive(
  factoryId: number,
  persona: string,
): Promise<boolean> {
  try {
    if (!(await archiveTableReady())) return false;
    const countRows = rawRows(
      await getDb().execute(
        sql`SELECT COUNT(*) AS c FROM wb_memories
            WHERE factory_id = ${factoryId} AND persona = ${persona} AND deletedAt IS NULL`,
      ),
    );
    if (Number(countRows[0]?.c ?? 0) < FACTORY_ARCHIVE_THRESHOLD) return false;
    if (await inCooldown(factoryId, persona)) return false;
    const items = rawRows(
      await getDb().execute(
        sql`SELECT content, kind, importance FROM wb_memories
            WHERE factory_id = ${factoryId} AND persona = ${persona} AND deletedAt IS NULL
            ORDER BY importance ASC, lastUsedAt ASC, id ASC
            LIMIT ${ARCHIVE_BATCH}`,
      ),
    ) as unknown as ArchiveItem[];
    if (items.length === 0) return false;
    const content = await distillArchive(persona, items);
    const day = new Date().toISOString().slice(0, 10);
    const id = await writeArchive(
      factoryId, persona,
      `${persona} 工作记忆知识沉淀（第 ${day} 期）`,
      content, items.length, "auto_threshold",
    );
    return id > 0;
  } catch {
    return false;
  }
}

// ─── 路由：本厂成员可查本厂归档（知识库呈现层）────────────────────────────────

export const memoryArchiveRouter = createRouter({
  /** 本厂归档列表（最新 50 条；factoryId 会话解析，客户端不传） */
  list: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      try {
        const rows = rawRows(
          await getDb().execute(
            sql`SELECT id, persona, title, source_count, source, created_at
                FROM st_memory_archives WHERE factory_id = ${factory.id}
                ORDER BY id DESC LIMIT 50`,
          ),
        );
        return { ok: true as const, items: rows };
      } catch {
        return { ok: true as const, items: [] as ArchiveRow[] }; // 表未建：空列表不报错
      }
    }),

  /** 归档正文（本厂成员可读；返回前再过 stripSecrets 双保险） */
  read: publicQuery
    .input(z.object({ token: z.string().trim().min(1), id: z.number().int().positive() }))
    .query(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      const rows = rawRows(
        await getDb().execute(
          sql`SELECT title, content, source_count, source, created_at
              FROM st_memory_archives WHERE id = ${input.id} AND factory_id = ${factory.id} LIMIT 1`,
        ),
      );
      const row = rows[0] as unknown as ArchiveRow | undefined;
      if (!row) return { ok: false as const };
      return {
        ok: true as const,
        title: String(row.title),
        content: stripSecrets(String(row.content)),
        sourceCount: Number(row.source_count),
        source: String(row.source),
        createdAt: String(row.created_at),
      };
    }),

  /** 管理端手动立即沉淀（本厂 admin；冷却仍生效，防连点刷库） */
  archiveNow: publicQuery
    .input(z.object({ token: z.string().trim().min(1), persona: z.enum(["lingshu", "xingyun"]).default("lingshu") }))
    .mutation(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      // 角色三级归一后 owner→admin（见 wbSession.normalizeRole），守卫只需 ["admin"]
      await requireWbRole(input.token, ["admin"], "仅本厂负责人可手动沉淀记忆");
      const done = await runThresholdArchive(factory.id, input.persona);
      return { ok: true as const, archived: done };
    }),
});
