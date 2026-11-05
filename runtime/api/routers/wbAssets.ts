/**
 * wbAssets —— M22a 通用设备资产台账（App 扫码升级：生产设备二维码/条形码 + 办公设备扫码登记识别）。
 *
 * 纪律（与 wbPair/wbContacts 同构）：
 * - 框架层无自动鉴权，token 只在请求体；守卫复用 wbSession sessionMe/effectiveRoleOf 口径；
 * - codeValue 是扫码原始值（非凭证，可展示）：DB 列 utf8mb4_bin 大小写敏感，应用层再按 === 精确复核
 *   （防御 collation 漂移），比对前仅 trim 去首尾空格，绝不归一大小写；
 * - 权限（设计口径）：lookup 全体登录角色（扫码第一跳）；register 全体登录角色
 *   （员工发现新设备可报备，admin 后台再补全资产信息）；list 全体登录角色（一期不分权，
 *   二期如需按部门/责任人收敛再收紧）；retire 仅 admin（C 级，前端显式确认）；
 * - 幂等：register 同 factoryId+codeValue 已有 active → 不报错返回已有资产（重复扫码登记幂等）；
 *   retire 原子 UPDATE ... WHERE status='active'，影响 0 行（已退役/不存在）也 ok；
 * - 企业隔离：一切查询带 factoryId；跨企业 lookup 一律 {found:false}，绝不泄露他企业资产存在性；
 * - C 级注释：退役后扫码提示「该资产已退役」（lookup retired 分支文案），资产卡不含 boundBy 等人员字段。
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { wbAssets, type WbAsset } from "@db/schema";
import { requireWbRole, sessionMe } from "./wbSession";

const RETIRE_DENIED = "仅企业负责人可退役资产"; // C 级动作，前端显式确认
const ASSET_RETIRED_HINT = "该资产已退役，如需继续使用请联系企业负责人重新登记";

const tokenInput = { token: z.string().trim().min(1) };
const categoryInput = z.enum(["production", "hvac", "lighting", "printer", "office", "other"]);
const codeTypeInput = z.enum(["qr", "ean13", "code128", "manual", "other"]);
/** 扫码原始值：trim 去首尾空格；大小写敏感（绝不归一），1-256 */
const codeValueInput = z.string().trim().min(1, "扫码值不能为空").max(256);

/** 分类分组排序口径：枚举序即展示序（生产设备在前，办公设备随后） */
const CATEGORY_ORDER: Record<WbAsset["category"], number> = {
  production: 0,
  hvac: 1,
  lighting: 2,
  printer: 3,
  office: 4,
  other: 5,
};

/**
 * 资产卡（不含敏感/人员字段：不出 boundBy/updatedAt 内部审计列）。
 * codeValue 非凭证可展示（App 扫码详情页回显原始码值）。
 */
function assetCard(a: WbAsset) {
  return {
    assetId: a.id,
    assetNo: a.assetNo,
    name: a.name,
    category: a.category,
    codeType: a.codeType,
    codeValue: a.codeValue,
    location: a.location,
    status: a.status,
    createdAt: a.createdAt,
  };
}

/**
 * 精确命中复核：WHERE factoryId+codeValue 走联合索引取候选，再按 === 复核。
 * 双保险——DB 列已 utf8mb4_bin（大小写敏感），此处防御 collation 漂移/历史库默认 ci。
 */
function exactMatch(rows: WbAsset[], codeValue: string): WbAsset[] {
  return rows.filter((r) => r.codeValue === codeValue);
}

/** 缺省资产编号：AS-{factoryId}-{6位随机大写字数}（字母+数字，随机源 randomBytes） */
function newAssetNo(factoryId: number): string {
  const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = randomBytes(6);
  let suffix = "";
  for (const b of bytes) suffix += CHARS[b % CHARS.length];
  return `AS-${factoryId}-${suffix}`;
}

export const wbAssetsRouter = createRouter({
  /**
   * lookup（query，全体登录角色）：扫码第一跳——本企业台账按 codeValue 精确查
   * （大小写敏感、去首尾空格）。命中返回资产卡；已退役命中带 retired:true + 提示文案
   * （C 级语义：退役后扫码明确提示，不装作不存在）；未命中/他企业码一律 {found:false}
   * （不泄露他企业资产存在性）。
   */
  lookup: publicQuery
    .input(z.object({ ...tokenInput, codeValue: codeValueInput }))
    .query(async ({ input }) => {
      const db = getDb();
      const { factory } = await sessionMe(input.token);
      const rows = await db
        .select()
        .from(wbAssets)
        .where(and(eq(wbAssets.factoryId, factory.id), eq(wbAssets.codeValue, input.codeValue)));
      const [hit] = exactMatch(rows, input.codeValue);
      if (!hit) {
        return { found: false as const }; // 跨企业/未登记统一口径，不泄露存在性
      }
      if (hit.status === "retired") {
        // C 级注释：退役后扫码提示已退役（资产卡照给，App 展示退役态详情）
        return { found: true as const, retired: true as const, message: ASSET_RETIRED_HINT, asset: assetCard(hit) };
      }
      return { found: true as const, retired: false as const, asset: assetCard(hit) };
    }),

  /**
   * register（mutation，全体登录角色——员工发现新设备可报备，admin 后台再补全）。
   * 幂等：同 factoryId+codeValue 已有 active → 不报错，返回 { already:true, asset: 已有资产 }
   * （重复扫码登记幂等语义；并发双写兜底依赖应用层先查后插 + utf8mb4_bin 精确比对）。
   * assetNo 缺省自动生成 AS-{factoryId}-{6位随机大写字数}；retired 同码不拦（退役释放码值，可重新登记）。
   */
  register: publicQuery
    .input(
      z.object({
        ...tokenInput,
        name: z.string().trim().min(2, "资产名称至少 2 字").max(64),
        category: categoryInput,
        codeType: codeTypeInput,
        codeValue: codeValueInput,
        assetNo: z.string().trim().min(1).max(64).optional(),
        location: z.string().trim().min(1).max(128).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      // admin/manager/staff 均可登记：员工现场发现新设备扫码报备，降低企业资产漏登率
      const { user, factory } = await requireWbRole(input.token, ["admin", "manager", "staff"], "token 无效");
      const rows = await db
        .select()
        .from(wbAssets)
        .where(and(eq(wbAssets.factoryId, factory.id), eq(wbAssets.codeValue, input.codeValue)));
      const existing = exactMatch(rows, input.codeValue).find((r) => r.status === "active");
      if (existing) {
        // 幂等：重复扫码登记不报错，返回已有资产（App 可直接跳详情页）
        return { ok: true as const, already: true as const, asset: assetCard(existing) };
      }
      const assetNo = input.assetNo ?? newAssetNo(factory.id);
      const [{ id }] = await db
        .insert(wbAssets)
        .values({
          factoryId: factory.id,
          assetNo,
          name: input.name,
          category: input.category,
          codeType: input.codeType,
          codeValue: input.codeValue,
          location: input.location ?? null,
          boundBy: user.id,
        })
        .$returningId();
      const asset: WbAsset = {
        id,
        factoryId: factory.id,
        assetNo,
        name: input.name,
        category: input.category,
        codeType: input.codeType,
        codeValue: input.codeValue,
        location: input.location ?? null,
        status: "active",
        boundBy: user.id,
        createdAt: new Date(),
        updatedAt: new Date(),
        retiredAt: null,
      };
      return { ok: true as const, already: false as const, asset: assetCard(asset) };
    }),

  /**
   * list（query，全体登录角色——一期不分权：admin/manager/staff 均见本企业全量台账，
   * 二期如需按部门/责任人收敛再收紧）。按 category 分组排序（枚举序）+ 组内按 id 升序，
   * 前端可直接分组渲染；category 入参可选过滤。
   */
  list: publicQuery
    .input(z.object({ ...tokenInput, category: categoryInput.optional() }))
    .query(async ({ input }) => {
      const db = getDb();
      const { factory } = await requireWbRole(input.token, ["admin", "manager", "staff"], "token 无效");
      const rows = await db
        .select()
        .from(wbAssets)
        .where(
          input.category
            ? and(eq(wbAssets.factoryId, factory.id), eq(wbAssets.category, input.category))
            : eq(wbAssets.factoryId, factory.id),
        );
      const items = rows
        .sort(
          (a, b) =>
            CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category] || a.id - b.id,
        )
        .map(assetCard);
      return { items };
    }),

  /**
   * retire（mutation，仅 admin，C 级——前端显式确认）。
   * 幂等：UPDATE status/retiredAt WHERE id+factoryId+status='active'，影响 0 行
   * （已退役/不存在/他企业 id）也返回 ok，绝不泄露跨企业存在性。
   * C 级注释：退役后扫码提示已退役（lookup retired 分支文案 ASSET_RETIRED_HINT）。
   */
  retire: publicQuery
    .input(z.object({ ...tokenInput, assetId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const { factory } = await requireWbRole(input.token, ["admin"], RETIRE_DENIED);
      const upd = await db
        .update(wbAssets)
        .set({ status: "retired", retiredAt: new Date() })
        .where(
          and(
            eq(wbAssets.id, input.assetId),
            eq(wbAssets.factoryId, factory.id),
            eq(wbAssets.status, "active"),
          ),
        );
      const affected = Number(
        (upd[0] as { affectedRows?: number | string } | undefined)?.affectedRows ?? 0,
      );
      return { ok: true as const, alreadyRetired: affected === 0 };
    }),
});
