/**
 * wechat —— 迭代 20「对外智能客服（微信公众号/服务号接入）」admin 系路由 + 共用应答逻辑。
 *
 * 模块构成：
 * - admin 系（requireAdmin，token 仅请求体）：getConfig（掩码返回）/ saveConfig（空串不更新）/ testChat；
 * - 共用函数：readWechatConfig()（api/wechat/callback.ts 读取 token/欢迎语）、
 *   answerWithKb(question, history)（真实回调与 testChat 同一套应答逻辑）。
 *
 * 安全口径：
 * - 配置密钥库内明文存储，但 getConfig 一律掩码返回（前 3 后 2，中间 *）；
 * - 应答走 llmReplyOrDegraded（callModelChat 故障转移 + 静默降级）；
 *   降级时对微信用户只给友好话术，绝不暴露错误原因/堆栈；
 * - 上下文注入：知识库（loadKbContext）+ buildContextDigest() 实时摘要，总长 clip 4500 字。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { requireAdmin, rawRows, buildContextDigest, llmReplyOrDegraded, clip } from "./terminal";
import { loadKbContext } from "./kb";
import type { LlmMessage } from "./modelGateway";

const tokenInput = z.object({ token: z.string().trim().min(1) });

const WECHAT_TABLES_HINT =
  "微信客服配置表未初始化，请先在服务器执行 db/sync-kb.mts 后再操作";

export const WECHAT_CALLBACK_PATH = "/api/wechat/callback";

const PORTAL_URL = "https://lingshu-nebulaai.com:3100";
const WORKBENCH_URL = "https://wb.lingshu-nebulaai.com:3000";

export const DEFAULT_WELCOME =
  "欢迎关注广东灵智枢生态科技有限公司！我是智能客服，可以为您介绍「NumX Max·数字匠市」（数字员工雇佣/招聘，Token 按调用计量结算）与「NumX Max 智能工作台」（企业账号组织/部门/数字员工管理）。直接输入您的问题即可。";

/** 微信用户可见的降级友好话术（绝不暴露错误/堆栈） */
const DEGRADED_REPLY =
  `智能客服暂时繁忙，请稍后再试；您也可以直接访问「NumX Max·数字匠市」${PORTAL_URL} 或「NumX Max 智能工作台」${WORKBENCH_URL} 自助了解，或在此留言，我们会尽快回复。`;

export interface WechatConfigRow {
  token: string;
  appId: string;
  encodingAesKey: string;
  welcome: string;
  updatedAt: unknown;
}

/**
 * 读取单行微信配置（id=1）。表缺失/无行一律返回 null（回调侧据此 503「客服未配置」）。
 * 仅供服务端内部使用，返回值是明文，绝不直接回传前端。
 */
export async function readWechatConfig(): Promise<WechatConfigRow | null> {
  try {
    const rows = rawRows(
      await getDb().execute(
        sql`SELECT token, appId, encodingAesKey, welcome, updatedAt FROM st_wechat_config WHERE id = 1 LIMIT 1`,
      ),
    );
    const r = rows[0];
    if (!r) return null;
    return {
      token: r.token == null ? "" : String(r.token),
      appId: r.appId == null ? "" : String(r.appId),
      encodingAesKey: r.encodingAesKey == null ? "" : String(r.encodingAesKey),
      welcome: r.welcome == null ? "" : String(r.welcome),
      updatedAt: r.updatedAt,
    };
  } catch {
    return null;
  }
}

/** 对外展示掩码：前 3 后 2，中间 *；过短串整体打码；空值返回 null */
export function maskSecret(value: string): string | null {
  if (!value) return null;
  if (value.length <= 5) return "*****";
  return `${value.slice(0, 3)}${"*".repeat(Math.max(4, value.length - 5))}${value.slice(-2)}`;
}

const SYSTEM_PROMPT = [
  "你是广东灵智枢生态科技有限公司的对外智能客服，服务对象是微信公众号用户。",
  "你的职责是介绍公司两套对外系统的功能与使用方式：",
  `1. 「NumX Max·数字匠市」（${PORTAL_URL}）：工业数字劳动力交易市场，可雇佣/招聘数字员工，Token 按调用量计量结算；门户注册后，企业用户可跳转工作台。`,
  `2. 「NumX Max 智能工作台」（${WORKBENCH_URL}）：企业账号的组织管理、部门管理与数字员工管理。`,
  "回答要求：务实友好中文，简明分点；Token 只按「结算/兑换/计量」口径表述，不使用金融/炒作/投机类词汇；",
  "不知道的问题不要编造，引导用户访问上述两个站点或留言等待人工回复。",
].join("\n");

/**
 * 对外智能客服共用应答逻辑（微信被动回复与配置页测试窗同一套）。
 * 注入知识库「企业资料」段 + 实时「当前平台规模」段（总上下文 clip 4500 字）。
 * timeoutMs 默认 20s；微信被动回复场景由调用方收紧到 4.5s 内。
 */
export async function answerWithKb(
  question: string,
  history: LlmMessage[] = [],
  timeoutMs = 20_000,
): Promise<{ reply: string; provider: string | null; degraded: boolean }> {
  const [kbText, digest] = await Promise.all([
    loadKbContext(3200),
    buildContextDigest().catch(() => ""),
  ]);
  const contextParts: string[] = [];
  if (kbText) contextParts.push(`【企业资料】\n${kbText}`);
  if (digest) contextParts.push(`【当前平台规模】\n${digest}`);
  const contextBlock = clip(contextParts.join("\n\n"), 4500);

  const messages: LlmMessage[] = [
    {
      role: "system",
      content: contextBlock ? `${SYSTEM_PROMPT}\n\n${contextBlock}` : SYSTEM_PROMPT,
    },
    ...history.slice(-8).map((m) => ({ role: m.role, content: clip(String(m.content), 800) })),
    { role: "user", content: clip(question, 800) },
  ];

  const reply = await llmReplyOrDegraded(messages, DEGRADED_REPLY, 600, timeoutMs, "chat");
  return {
    // 降级时对微信用户只给纯净友好话术（不带内部「规则生成」前缀）
    reply: reply.degraded ? DEGRADED_REPLY : reply.content,
    provider: reply.provider,
    degraded: reply.degraded,
  };
}

export const wechatRouter = createRouter({
  /** 读取配置（掩码返回）+ 回调路径 + 是否已配置 */
  getConfig: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireAdmin(input.token);
    const cfg = await readWechatConfig();
    return {
      configured: Boolean(cfg && cfg.token),
      callbackPath: WECHAT_CALLBACK_PATH,
      token: cfg ? maskSecret(cfg.token) : null,
      appId: cfg ? maskSecret(cfg.appId) : null,
      encodingAesKey: cfg ? maskSecret(cfg.encodingAesKey) : null,
      welcome: cfg?.welcome || DEFAULT_WELCOME,
      updatedAt: cfg?.updatedAt ?? null,
    };
  }),

  /** 保存配置（upsert id=1；传空字符串/未传的字段不更新，兼容掩码回填） */
  saveConfig: publicQuery
    .input(
      tokenInput.extend({
        wxToken: z.string().trim().max(128).optional(),
        appId: z.string().trim().max(64).optional(),
        encodingAesKey: z.string().trim().max(64).optional(),
        welcome: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const existing = await readWechatConfig();
      // 空字符串视为「保持不变」（掩码回填场景）
      const next = {
        token: input.wxToken ? input.wxToken : (existing?.token ?? ""),
        appId: input.appId ? input.appId : (existing?.appId ?? ""),
        encodingAesKey: input.encodingAesKey
          ? input.encodingAesKey
          : (existing?.encodingAesKey ?? ""),
        welcome: input.welcome ? input.welcome : (existing?.welcome ?? ""),
      };
      try {
        await getDb().execute(
          sql`INSERT INTO st_wechat_config (id, token, appId, encodingAesKey, welcome)
              VALUES (1, ${next.token}, ${next.appId}, ${next.encodingAesKey}, ${next.welcome})
              ON DUPLICATE KEY UPDATE
                token = VALUES(token), appId = VALUES(appId),
                encodingAesKey = VALUES(encodingAesKey), welcome = VALUES(welcome)`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (/doesn't exist|ER_NO_SUCH_TABLE/i.test(msg)) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: WECHAT_TABLES_HINT });
        }
        throw err;
      }
      return { ok: true as const, configured: Boolean(next.token) };
    }),

  /** 配置页测试窗：与真实微信回调相同的应答逻辑 */
  testChat: publicQuery
    .input(
      tokenInput.extend({
        message: z.string().trim().min(1, "消息不能为空").max(1000),
        history: z
          .array(
            z.object({
              role: z.enum(["user", "assistant"]),
              content: z.string().max(1000),
            }),
          )
          .max(10)
          .optional(),
      }),
    )
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const res = await answerWithKb(input.message, input.history ?? []);
      return { reply: res.reply, provider: res.provider, degraded: res.degraded };
    }),
});
