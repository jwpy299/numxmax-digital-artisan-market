/**
 * evolution 身份路由组（identity.*）—— 数字员工链上身份卡。
 *
 * 提炼自 Farcaster 三合约语义（IdRegistry + KeyRegistry + StorageRegistry），
 * 落地为企业内部哈希链注册表（不发激励、不收取链上费用，租用量语义改造为配额管理）：
 * - did = did:nebula:agent-<slug>（对应 fid，可读岗位编码）；
 * - keyState 状态机原样保留（NULL/ADDED/REMOVED，签发默认 ADDED）；
 * - 每次签发 = 一个区块：blockHash = sha256(prevHash + payload + height)，
 *   prevHash 链接同 factory 上一区块（创世区块 prevHash = 64 个 0）；
 * - 验证三要素（照搬 Farcaster 消息验证）：已注册 && keyState=ADDED && quota>0。
 * 签发幂等：同 (agentId, factoryId) 已有身份卡 → 返回既有卡片不重复出块。
 */
import { z } from "zod";
import { and, asc, desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { agents, wbEvoIdentities, wbEvoTrust, wbFactories } from "@db/schema";
import { sessionMe } from "./wbSession";
import { evoSha256 } from "./evolutionShared";

const GENESIS_PREV = "0".repeat(64);

/** 三要素校验（供 tools.invoke 防护栏复用）：返回身份卡或 null */
export async function verifyIdentityCore(did: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(wbEvoIdentities)
    .where(eq(wbEvoIdentities.did, did))
    .limit(1);
  if (!row) return { valid: false as const, reason: "身份未注册" };
  if (row.keyState !== "ADDED") {
    return { valid: false as const, reason: `签名密钥状态为 ${row.keyState}（非 ADDED）` };
  }
  if (row.quota <= 0) {
    return { valid: false as const, reason: "配额已用尽（quota=0）" };
  }
  return { valid: true as const, identity: row };
}

/** 按 agentId+factoryId 查身份卡 */
export async function identityOfAgent(agentId: number, factoryId: number) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(wbEvoIdentities)
    .where(
      and(
        eq(wbEvoIdentities.agentId, agentId),
        eq(wbEvoIdentities.factoryId, factoryId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export const evolutionIdentityRouter = createRouter({
  /**
   * identity.issue（mutation，需要 token）—— 幂等签发身份卡。
   * 输入 { token, agentId }；did + 创世/后续区块（prevHash 链接同 factory 链尾）。
   * 输出 { did, blockHash, blockHeight, card, reused }。
   */
  issue: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        agentId: z.number().int().positive(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { factory } = await sessionMe(input.token);
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, input.agentId))
        .limit(1);
      if (!agent) {
        throw new TRPCError({ code: "NOT_FOUND", message: `Agent #${input.agentId} 不存在` });
      }

      // 幂等：已有身份卡 → 返回既有结果（不重复出块）
      const existing = await identityOfAgent(agent.id, factory.id);
      if (existing) {
        return {
          did: existing.did,
          blockHash: existing.blockHash,
          blockHeight: existing.blockHeight,
          card: existing.card,
          quota: existing.quota,
          keyState: existing.keyState,
          reused: true,
        };
      }

      // 信任等级快照（无账本则 L0）
      const [trust] = await db
        .select()
        .from(wbEvoTrust)
        .where(eq(wbEvoTrust.agentId, agent.id))
        .limit(1);
      const did = `did:nebula:agent-${agent.slug || `agent-${agent.id}`}`;
      const card = {
        name: agent.name,
        role: `${agent.industry}数字工匠`,
        skillFingerprint: evoSha256((agent.capabilityTags ?? []).join("|")).slice(0, 16),
        issuedBy: "决策基因链",
        trustLevel: trust?.level ?? 0,
      };

      // 链接同 factory 链尾（创世区块 prevHash=0*64）
      const [tip] = await db
        .select()
        .from(wbEvoIdentities)
        .where(eq(wbEvoIdentities.factoryId, factory.id))
        .orderBy(desc(wbEvoIdentities.blockHeight))
        .limit(1);
      const prevHash = tip?.blockHash ?? GENESIS_PREV;
      const blockHeight = (tip?.blockHeight ?? 0) + 1;
      const payload = JSON.stringify({ did, agentId: agent.id, factoryId: factory.id, card });
      const blockHash = evoSha256(`${prevHash}|${payload}|${blockHeight}`);

      await db.insert(wbEvoIdentities).values({
        did,
        agentId: agent.id,
        factoryId: factory.id,
        keyState: "ADDED",
        quota: 1000,
        blockHash,
        prevHash,
        blockHeight,
        card,
      });
      return { did, blockHash, blockHeight, card, quota: 1000, keyState: "ADDED" as const, reused: false };
    }),

  /**
   * identity.verify（query，公开）—— 验证三要素。
   * 输入 { did }；输出 { valid, reason?, card?, blockHeight? }。
   */
  verify: publicQuery
    .input(z.object({ did: z.string().trim().min(3).max(128) }))
    .query(async ({ input }) => {
      const result = await verifyIdentityCore(input.did);
      if (!result.valid) {
        return { valid: false as const, reason: result.reason };
      }
      return {
        valid: true as const,
        card: result.identity.card,
        blockHeight: result.identity.blockHeight,
        keyState: result.identity.keyState,
        quota: result.identity.quota,
      };
    }),

  /**
   * identity.chain（query，公开）—— 身份链区块摘要（按 height 升序）。
   * 输入 { factoryId }。
   */
  chain: publicQuery
    .input(z.object({ factoryId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const db = getDb();
      const [factory] = await db
        .select({ id: wbFactories.id })
        .from(wbFactories)
        .where(eq(wbFactories.id, input.factoryId))
        .limit(1);
      if (!factory) {
        throw new TRPCError({ code: "NOT_FOUND", message: "企业不存在" });
      }
      const rows = await db
        .select()
        .from(wbEvoIdentities)
        .where(eq(wbEvoIdentities.factoryId, input.factoryId))
        .orderBy(asc(wbEvoIdentities.blockHeight));
      return {
        factoryId: input.factoryId,
        height: rows.length,
        blocks: rows.map((r) => ({
          blockHeight: r.blockHeight,
          did: r.did,
          agentName: r.card.name,
          keyState: r.keyState,
          quota: r.quota,
          blockHash: r.blockHash,
          prevHash: r.prevHash,
          createdAt: r.createdAt,
        })),
      };
    }),
});
