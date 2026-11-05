/**
 * evolution 工具路由组（tools.*）—— 跨系统工具调用目录。
 *
 * 提炼自 Coinbase AgentKit 三层抽象（装配器 → ActionProvider → Action）工业化改造：
 * - 代码内 ActionProvider 目录（不建表）：market / workbench / showroom / gateway
 *   四类 provider，类名前缀即命名空间（market.hire_agent 风格）；
 * - 每 Action 含 name/description/zod schema/防护栏前置校验链
 *   （照搬参考实现的防护栏前置校验模式：参数范围 → 身份三要素 → 配额 → 业务校验，
 *   失败返回自然语言可自纠错误 { ok:false, message:"Error: ..." } 而非抛异常）；
 * - 执行为真实读写业务表的轻量确定性动作；配额按次扣减（quota-1）。
 * token 仅在请求体，由 sessionMe(token) 校验。
 */
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { wbContracts, wbEvoIdentities, wbListings, wbShowroom } from "@db/schema";
import { sessionMe } from "./wbSession";
import { identityOfAgent } from "./evolutionIdentity";
import { recallCore, writeMemoryCore } from "./evolutionMemory";

// ─── 确定性派生辅助（同设备同分钟内输出稳定）─────────────────────────────────
function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}
function minuteBucket(): number {
  return Math.floor(Date.now() / 60000);
}

// ─── Action 定义（AgentKit Action 接口工业化版）──────────────────────────────
interface ToolContext {
  factoryId: number;
  agentId: number;
}
interface ToolAction {
  name: string;
  provider: "market" | "workbench" | "showroom" | "gateway";
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  paramsSpec: { field: string; type: string; required: boolean; description: string }[];
  invoke: (ctx: ToolContext, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

const TOOL_ACTIONS: ToolAction[] = [
  {
    name: "market.hire_agent",
    provider: "market",
    description: "对匠市已上架（listed）的智能体/技能发起招募，生成 pending 合同，等待人工审批（两段式）。",
    schema: z.object({ listingId: z.number().int().positive() }),
    paramsSpec: [
      { field: "listingId", type: "number", required: true, description: "目标上架 ID（须为 listed）" },
    ],
    invoke: async (ctx, params) => {
      const db = getDb();
      const listingId = params.listingId as number;
      const [listing] = await db
        .select()
        .from(wbListings)
        .where(eq(wbListings.id, listingId))
        .limit(1);
      if (!listing) {
        return { ok: false, message: `Error: 上架 #${listingId} 不存在，请先用 workbenchMarket.listListings 查询可用上架。` };
      }
      if (listing.status !== "listed") {
        return { ok: false, message: `Error: 上架 #${listingId} 当前为 ${listing.status}，仅 listed 可招募；可改选其他已上架目标。` };
      }
      return await db.transaction(async (tx) => {
        await tx
          .update(wbListings)
          .set({ hires: sql`${wbListings.hires} + 1` })
          .where(eq(wbListings.id, listing.id));
        const [{ id: contractId }] = await tx
          .insert(wbContracts)
          .values({
            factoryId: ctx.factoryId,
            listingId: listing.id,
            roleScope: `工具调用招募（agent #${ctx.agentId}）`,
            workMode: "7×24 远程值守",
            status: "pending",
          })
          .$returningId();
        return {
          ok: true,
          contractId,
          status: "pending",
          message: `已提交对「${listing.title}」的招募合同 #${contractId}，等待人工审批（两段式：提交 pending + 人工确认，不即时生效）。`,
        };
      });
    },
  },
  {
    name: "market.recall_memory",
    provider: "market",
    description: "按查询文本在本企业工业向量记忆库中做余弦相似度召回（TopK，过滤过期）。",
    schema: z.object({
      queryText: z.string().trim().min(1).max(2000),
      limit: z.number().int().positive().max(20).optional(),
    }),
    paramsSpec: [
      { field: "queryText", type: "string", required: true, description: "召回查询文本" },
      { field: "limit", type: "number", required: false, description: "返回条数，默认 5" },
    ],
    invoke: async (ctx, params) => {
      const items = await recallCore({
        factoryId: ctx.factoryId,
        agentId: ctx.agentId,
        queryText: params.queryText as string,
        limit: (params.limit as number | undefined) ?? 5,
      });
      return { ok: true, total: items.length, items };
    },
  },
  {
    name: "workbench.dispatch_task",
    provider: "workbench",
    description: "向工作台下达一条轻量任务指令：写入 events 记忆流水并返回确定性执行摘要（重任务请走 tasks.create）。",
    schema: z.object({
      instruction: z.string().trim().min(2).max(500),
      deviceId: z.string().trim().min(1).max(64).optional(),
    }),
    paramsSpec: [
      { field: "instruction", type: "string", required: true, description: "任务指令文本" },
      { field: "deviceId", type: "string", required: false, description: "目标设备号，如 CNC-03" },
    ],
    invoke: async (ctx, params) => {
      const instruction = params.instruction as string;
      const deviceId = (params.deviceId as string | undefined) ?? "未指定设备";
      const { id } = await writeMemoryCore({
        factoryId: ctx.factoryId,
        agentId: ctx.agentId,
        store: "events",
        text: `派工指令：${instruction}（目标 ${deviceId}）`,
        metadata: { action: "workbench.dispatch_task", deviceId },
        severity: 2,
      });
      return {
        ok: true,
        eventId: id,
        message: `派工指令已登记至事件流水（event #${id}），目标 ${deviceId}；已提交，等待班组确认执行（两段式，不即时生效）。`,
      };
    },
  },
  {
    name: "workbench.read_sensor",
    provider: "workbench",
    description: "读取设备传感器快照（振动/温度/状态，确定性派生，同设备同分钟内稳定）。",
    schema: z.object({ deviceId: z.string().trim().min(1).max(64) }),
    paramsSpec: [
      { field: "deviceId", type: "string", required: true, description: "设备号，如 CNC-03" },
    ],
    invoke: async (_ctx, params) => {
      const deviceId = params.deviceId as string;
      const seed = (djb2(deviceId) + minuteBucket()) % 1000;
      const vibration = Math.round((1.2 + (seed % 40) / 10) * 100) / 100; // mm/s
      const temperature = Math.round((38 + (seed % 90) / 10) * 10) / 10; // ℃
      const status = vibration > 4.5 ? "warn" : "normal";
      return {
        ok: true,
        deviceId,
        vibrationMmS: vibration,
        temperatureC: temperature,
        status,
        sampledAt: new Date(minuteBucket() * 60000),
      };
    },
  },
  {
    name: "showroom.publish_status",
    provider: "showroom",
    description: "查询本企业数字展厅发布状态与学习评分（只读）。",
    schema: z.object({}),
    paramsSpec: [],
    invoke: async (ctx) => {
      const db = getDb();
      const [row] = await db
        .select()
        .from(wbShowroom)
        .where(eq(wbShowroom.factoryId, ctx.factoryId))
        .limit(1);
      if (!row) {
        return { ok: false, message: "Error: 展厅尚未初始化，请先调用 showroomPortal.status 完成学习评分。" };
      }
      return {
        ok: true,
        status: row.status,
        score: row.score,
        productCount: row.productCount,
      };
    },
  },
  {
    name: "gateway.heartbeat",
    provider: "gateway",
    description: "探测 IoT 网关心跳（确定性派生：设备号 + 当前分钟），返回在线状态与延迟。",
    schema: z.object({ deviceId: z.string().trim().min(1).max(64) }),
    paramsSpec: [
      { field: "deviceId", type: "string", required: true, description: "网关/设备号" },
    ],
    invoke: async (_ctx, params) => {
      const deviceId = params.deviceId as string;
      const seed = djb2(deviceId) % 97;
      return {
        ok: true,
        deviceId,
        online: true,
        latencyMs: 8 + (seed % 40),
        heartbeatAt: new Date(minuteBucket() * 60000 - seed * 1000),
      };
    },
  },
];

const ACTION_MAP = new Map(TOOL_ACTIONS.map((a) => [a.name, a]));

export const evolutionToolsRouter = createRouter({
  /**
   * tools.catalog（query，无输入）—— 全量工具目录（provider 分组）。
   */
  catalog: publicQuery.query(() => {
    const providers = ["market", "workbench", "showroom", "gateway"] as const;
    return {
      providers: providers.map((p) => ({
        provider: p,
        actions: TOOL_ACTIONS.filter((a) => a.provider === p).map((a) => ({
          name: a.name,
          description: a.description,
          params: a.paramsSpec,
        })),
      })),
      total: TOOL_ACTIONS.length,
    };
  }),

  /**
   * tools.invoke（mutation，需要 token）。
   * 输入 { token, agentId, action, params }。
   * 防护栏校验链：动作存在 → 身份三要素（已注册 && keyState=ADDED && quota>0）
   * → 参数范围（zod）→ 配额扣减 → 确定性执行 → 结构化返回。
   * 失败返回 { ok:false, message:"Error: ...（可自纠建议）" }，不抛异常。
   */
  invoke: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        agentId: z.number().int().positive(),
        action: z.string().trim().min(1).max(64),
        params: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .mutation(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      const action = ACTION_MAP.get(input.action);
      if (!action) {
        return {
          ok: false as const,
          action: input.action,
          message: `Error: 未找到动作「${input.action}」。请先从 tools.catalog 获取目录并选择合法动作名（如 market.recall_memory）。`,
        };
      }
      // 身份三要素校验（IdRegistry 注册 + KeyRegistry ADDED + Quota>0）
      const identity = await identityOfAgent(input.agentId, factory.id);
      if (!identity) {
        return {
          ok: false as const,
          action: input.action,
          message: `Error: Agent #${input.agentId} 尚未签发身份卡。请先调用 identity.issue 完成注册后再执行「${input.action}」。`,
        };
      }
      if (identity.keyState !== "ADDED") {
        return {
          ok: false as const,
          action: input.action,
          message: `Error: ${identity.did} 的签名密钥状态为 ${identity.keyState}（非 ADDED），本次调用被拒绝并计入审计。`,
        };
      }
      if (identity.quota <= 0) {
        return {
          ok: false as const,
          action: input.action,
          message: `Error: ${identity.did} 配额已用尽（quota=0），请申请配额扩容后重试。`,
        };
      }
      // 参数范围校验（zod，可自纠错误文案）
      const parsed = action.schema.safeParse(input.params);
      if (!parsed.success) {
        const issue = parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        return {
          ok: false as const,
          action: input.action,
          message: `Error: 参数校验失败 — ${issue}。请参考 tools.catalog 中「${input.action}」的参数说明修正后重试。`,
        };
      }
      // 配额扣减（每调用一次 -1）
      const db = getDb();
      await db
        .update(wbEvoIdentities)
        .set({ quota: sql`${wbEvoIdentities.quota} - 1` })
        .where(
          and(
            eq(wbEvoIdentities.id, identity.id),
            sql`${wbEvoIdentities.quota} > 0`,
          ),
        );
      const result = await action.invoke(
        { factoryId: factory.id, agentId: input.agentId },
        parsed.data,
      );
      return {
        ...result,
        action: input.action,
        did: identity.did,
        quotaRemaining: identity.quota - 1,
      };
    }),
});
