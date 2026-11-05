/**
 * skillPacks —— M54「租用即带基础技能包」：超市数字员工按岗位匹配技能包。
 *
 * 机制：雇佣落单成功 → applyOccupationPack 把该岗位的基础技能写进产品技能目录
 * （skills 表，pricePerCall=0 随租用赠送）→ loadVisibleSkills 的雇佣段自动可见可执行。
 * 幂等：(agentId, name) 查重；对存量在役雇佣可 backfillAll 追装。
 * 技能名/描述以 st_skills 技能库为准（真实技能），缺行时用内置兜底文案。
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { requireAdmin as requireAdminToken, rawRows } from "./terminal";

/** 岗位 → 基础技能包（技能 key 均为执行器在役的 base/evo 键，真实可执行） */
export const OCCUPATION_PACKS: Record<string, string[]> = {
  "OCC-0001": ["doc_write", "weekly_report", "excel_report", "tax_notice"], // 财务·灵算师
  "OCC-0002": ["cs_faq", "email_compose", "kb_qa", "daily_report"], // 客户管理·聆商
  "OCC-0003": ["task_plan", "excel_report", "daily_report", "doc_write"], // 仓储订单·仓策
  "OCC-0004": ["task_plan", "excel_report", "data_report", "daily_report"], // 订单管理·单衡
  "OCC-0005": ["doc_write", "ppt_make", "kb_qa", "task_plan"], // 研发·创衡
  "OCC-0006": ["data_report", "excel_report", "daily_report", "task_plan"], // 能耗·节衡
  "OCC-0007": ["device_daily_check", "daily_report", "task_plan", "doc_write"], // 设备管理·械衡
};

/** 技能库缺行时的兜底名片（执行不受影响——执行器按 key 走） */
const FALLBACK_META: Record<string, { name: string; description: string }> = {
  doc_write: { name: "文档撰写", description: "公文/方案/报告成稿" },
  weekly_report: { name: "周报生成", description: "周期工作结构化周报" },
  daily_report: { name: "日报生成", description: "当日工作结构化日报" },
  meeting_notes: { name: "会议纪要", description: "会议内容整理成纪要" },
  task_plan: { name: "任务拆解", description: "目标拆解为可执行任务清单" },
  excel_report: { name: "Excel报表", description: "数据成表，结构化输出" },
  data_report: { name: "数据分析报告", description: "数据归因与指标解读" },
  tax_notice: { name: "财税实务解答", description: "政策口径分析与解答" },
  cs_faq: { name: "客服FAQ应答", description: "知识库接地客服话术" },
  email_compose: { name: "商务函件", description: "商务邮件/函件起草" },
  kb_qa: { name: "知识库问答", description: "企业知识库接地作答" },
  ppt_make: { name: "PPT制作", description: "演示文档大纲与成稿" },
  device_daily_check: { name: "设备点检表", description: "班次点检项/标准值/实测/异常处置" },
};

/** 岗位包落进产品技能目录（随租赠送，pricePerCall=0），返回新装数量 */
export async function applyOccupationPack(agentCode: string): Promise<{ agentId: number; added: number }> {
  const pack = OCCUPATION_PACKS[agentCode];
  if (!pack) return { agentId: 0, added: 0 };
  const db = getDb();

  const aRows = rawRows(
    await db.execute(sql`SELECT id FROM agents WHERE code = ${agentCode} LIMIT 1`),
  ) as Array<Record<string, unknown>>;
  if (aRows.length === 0) return { agentId: 0, added: 0 };
  const agentId = Number(aRows[0]!.id);

  // 技能库真名真描述（一次读齐）
  const metaRows = rawRows(
    await db.execute(sql`SELECT skill_key, name, description FROM st_skills WHERE status = 'active'`),
  ) as Array<Record<string, unknown>>;
  const meta = new Map(metaRows.map((r) => [String(r.skill_key), { name: String(r.name), description: String(r.description ?? "") }]));

  let added = 0;
  for (const key of pack) {
    const m = meta.get(key) ?? FALLBACK_META[key] ?? { name: key, description: "" };
    const exist = rawRows(
      await db.execute(sql`SELECT id FROM skills WHERE agentId = ${agentId} AND name = ${m.name} LIMIT 1`),
    ) as Array<Record<string, unknown>>;
    if (exist.length > 0) continue;
    await db.execute(
      sql`INSERT INTO skills (agentId, name, description, pricePerCall, type, complexity, executor, executorKind)
          VALUES (${agentId}, ${m.name}, ${`${m.description}（基础技能包随租赠送）`.slice(0, 255)}, 0, 'V', 1, 'llm_analysis', 'generic')`,
    );
    added++;
  }
  // 产品技能数校正（目录展示计数口径一致）
  await db.execute(
    sql`UPDATE agents SET skillCount = (SELECT COUNT(*) FROM skills WHERE agentId = ${agentId}) WHERE id = ${agentId}`,
  );
  return { agentId, added };
}

/** 存量追装：遍历在役雇佣的产品，逐岗位补装基础包 */
async function backfillAll(): Promise<{ products: number; added: number }> {
  const db = getDb();
  const rows = rawRows(
    await db.execute(
      sql`SELECT DISTINCT a.code FROM agent_hire_records h JOIN agents a ON a.id = h.agentId
          WHERE h.status IN ('trial','active') AND h.endsAt > NOW()`,
    ),
  ) as Array<Record<string, unknown>>;
  let added = 0;
  for (const r of rows) {
    const res = await applyOccupationPack(String(r.code));
    added += res.added;
  }
  return { products: rows.length, added };
}

const adminInput = z.object({ token: z.string().trim().min(1) });

export const skillPacksRouter = createRouter({
  /** 岗位包名册（超终展示用） */
  packs: publicQuery.input(adminInput).query(async ({ input }) => {
    await requireAdminToken(input.token);
    return Object.entries(OCCUPATION_PACKS).map(([code, keys]) => ({
      productCode: code,
      skills: keys.map((k) => ({ key: k, name: (FALLBACK_META[k] ?? { name: k }).name })),
    }));
  }),

  /** 存量在役雇佣全部追装基础包 */
  backfill: publicQuery.input(adminInput).mutation(async ({ input }) => {
    await requireAdminToken(input.token);
    return { ok: true as const, ...(await backfillAll()) };
  }),

  /** 单产品即时补装（新上架产品用） */
  applyOne: publicQuery
    .input(adminInput.extend({ productCode: z.string().trim().min(1).max(32) }))
    .mutation(async ({ input }) => {
      await requireAdminToken(input.token);
      const r = await applyOccupationPack(input.productCode);
      if (r.agentId === 0) {
        return { ok: false as const, reason: "产品不存在或无岗位包" };
      }
      return { ok: true as const, ...r };
    }),
});
