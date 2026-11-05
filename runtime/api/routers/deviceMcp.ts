/**
 * deviceMcp —— 物理 MCP 注册中心（2026-08-28 彭总令：扫一扫适配物理 MCP，生产设备也走起）。
 *
 * 定位：设备从「指令通道」升级为「MCP 工具源」。纪律钉死：
 * - MCP 面只做「能力枚举 + 调用路由」；真正下发永远走 devices.issueCommand 指令面
 *   （白名单/分级/双签票据一条不绕）——控制施工永不进 MCP 面，MCP 是它的标准化翻译层；
 * - factoryId 服务端会话口径，跨厂枚举都枚举不到；
 * - manifest 注入清洗（desc/schema 过 sanitize，设备上报不可信）；
 * - B 级直排，C 级必须有效双签票据（与 CAP_LEVEL 同构，不另立规矩）。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { sessionMe } from "./wbSession";
import { enqueueDeviceCommand } from "./devices";
import { rawRows } from "../queries/rawRows"; // 战区④批A-lite：私有副本退役→canonical 叶单源


// ─── manifest 清洗与校验（纯函数可测） ────────────────────────────────────────
export interface McpToolSpec {
  name: string;
  desc: string;
  level: "B" | "C";
  schema: Record<string, unknown>;
}
export interface DeviceManifest {
  device_class: string;
  tools: McpToolSpec[];
}

const SAFE = /[^\w一-龥（）()·，。：、\-\s]/g;
function sanitizeText(s: string, max = 120): string {
  return s.replace(SAFE, "").trim().slice(0, max);
}

/** manifest 校验+清洗：结构不对/工具为空/级别非法一律拒收；文本字段全消毒 */
export function parseManifest(raw: unknown): DeviceManifest {
  const m = raw as Partial<DeviceManifest>;
  if (!m || typeof m.device_class !== "string" || !m.device_class.trim()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "manifest 缺 device_class" });
  }
  if (!Array.isArray(m.tools) || m.tools.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "manifest 至少一个工具" });
  }
  if (m.tools.length > 20) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "单设备工具上限 20" });
  }
  const tools: McpToolSpec[] = m.tools.map((t) => {
    if (!t || typeof t.name !== "string" || !/^[\w-]{2,48}$/.test(t.name)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "工具名须 2-48 位字母数字" });
    }
    const level = t.level === "C" ? "C" : "B";
    return {
      name: t.name,
      desc: sanitizeText(String(t.desc ?? "")),
      level,
      schema: typeof t.schema === "object" && t.schema !== null ? t.schema : { type: "object", properties: {} },
    };
  });
  return { device_class: sanitizeText(m.device_class, 32), tools };
}

/** 工具名 → 指令面 cap 映射（MCP 名到 devices cap；未登记的工具按 run_script 最严级） */
export function capOfTool(toolName: string): { cap: string; level: "B" | "C" } {
  const MAP: Record<string, string> = {
    print_document: "print",
    print: "print",
    read_sensor: "plugin_invoke",
    snapshot: "screenshot",
    open_gate: "lock",
    lock: "lock",
    run_script: "run_script",
  };
  const cap = MAP[toolName] ?? "run_script";
  const C_CAPS = new Set(["lock", "run_script", "plugin_invoke"]);
  return { cap, level: C_CAPS.has(cap) ? "C" : "B" };
}

const tokenInput = { token: z.string().trim().min(1) };

export const deviceMcpRouter = createRouter({
  /** 设备上线注册 manifest（enroll 后自报；幂等 UPSERT） */
  registerManifest: publicQuery
    .input(z.object({ ...tokenInput, deviceId: z.string().trim().min(1).max(64), manifest: z.unknown() }))
    .mutation(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      const m = parseManifest(input.manifest);
      await getDb().execute(
        sql`INSERT INTO st_device_mcp (device_id, factory_id, device_class, manifest, status)
            VALUES (${input.deviceId}, ${factory.id}, ${m.device_class}, ${JSON.stringify(m)}, 'online')
            ON DUPLICATE KEY UPDATE manifest=VALUES(manifest), device_class=VALUES(device_class), status='online', last_seen=NOW()`,
      );
      // 联动指令面建档：st_devices 以 mcp_key 落册（能力=manifest 工具映射出的 cap 集），无则建
      const caps = [...new Set(m.tools.map((t) => capOfTool(t.name).cap))];
      const { createHash } = await import("node:crypto");
      const ekHash = createHash("sha256").update(`mcp-enroll:${input.deviceId}`).digest("hex");
      await getDb().execute(
        sql`INSERT INTO st_devices (factory_id, name, dtype, caps, enroll_key_hash, status)
            VALUES (${factory.id}, ${`MCP·${m.device_class}·${input.deviceId.slice(-8)}`}, ${m.device_class}, ${JSON.stringify(caps)}, ${ekHash}, 'online')
            ON DUPLICATE KEY UPDATE caps=VALUES(caps), status='online', last_seen_at=NOW()`,
      ).catch(async () => {
        // mcp_key 列未上时按 name 幂等（additive 兼容窗）
        await getDb().execute(
          sql`UPDATE st_devices SET caps=${JSON.stringify(caps)}, status='online', last_seen_at=NOW()
              WHERE factory_id=${factory.id} AND name=${`MCP·${m.device_class}·${input.deviceId.slice(-8)}`} LIMIT 1`,
        );
      });
      return { ok: true as const, toolCount: m.tools.length };
    }),

  /** MCP tools/list（本厂在线设备的全工具目录） */
  toolsList: publicQuery.input(z.object(tokenInput)).query(async ({ input }) => {
    const { factory } = await sessionMe(input.token);
    const rows = rawRows(
      await getDb().execute(sql`SELECT device_id AS deviceId, device_class AS deviceClass, manifest FROM st_device_mcp WHERE factory_id=${factory.id} AND status='online'`),
    );
    const tools: Array<{ device: string; deviceClass: string; name: string; desc: string; level: string; schema: unknown }> = [];
    for (const r of rows) {
      let manifest: DeviceManifest | null = null;
      const raw = r.manifest;
      manifest = (typeof raw === "object" && raw !== null ? raw : null) as DeviceManifest | null;
      if (!manifest) { try { manifest = JSON.parse(String(raw)) as DeviceManifest; } catch { continue; } }
      for (const t of manifest?.tools ?? []) {
        tools.push({ device: String(r.deviceId), deviceClass: String(r.deviceClass), name: String(t.name), desc: t.desc, level: t.level, schema: t.schema });
      }
    }
    return { tools };
  }),

  /** MCP tools/call（路由到指令面：B 直排，C 验票——绝不绕过 issueCommand） */
  toolsCall: publicQuery
    .input(z.object({
      ...tokenInput,
      deviceId: z.string().trim().min(1).max(64),
      tool: z.string().trim().min(1).max(48),
      args: z.record(z.string(), z.unknown()).optional().default({}),
      ticketId: z.number().int().positive().optional(),
    }))
    .mutation(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      const factoryId = Number(factory.id);
      const rows = rawRows(
        await getDb().execute(sql`SELECT manifest FROM st_device_mcp WHERE device_id=${input.deviceId} AND factory_id=${factoryId} AND status='online' LIMIT 1`),
      );
      if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "设备未注册 MCP 或已离线" });
      const rawM = rows[0].manifest;
      const manifest = (typeof rawM === "object" && rawM !== null ? rawM : null) as DeviceManifest | null
        ?? (() => { try { return JSON.parse(String(rawM)) as DeviceManifest; } catch { return null; } })();
      if (!manifest) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "manifest 损坏" });
      const tool = manifest.tools.find((t) => t.name === input.tool);
      if (!tool) throw new TRPCError({ code: "NOT_FOUND", message: `设备无工具 ${input.tool}` });
      const { cap, level } = capOfTool(input.tool);
      // C 级必须有效票据（票据说指面验；此处只查存在性，执核在回执）
      if (tool.level === "C" || level === "C") {
        if (!input.ticketId) {
          throw new TRPCError({ code: "FORBIDDEN", message: `C 级工具 ${input.tool} 必须携带有效双签票据（ticketId）` });
        }
      }
      // 设备解析走指令面 st_devices：数字 id 或 mcp_key 双模（本厂核验）
      let devId = Number(input.deviceId) || 0;
      if (!devId) {
        const byKey = rawRows(
          await getDb().execute(sql`SELECT id FROM st_devices WHERE factory_id=${factoryId} AND name LIKE ${`%${input.deviceId.slice(-8)}`} ORDER BY id DESC LIMIT 1`),
        );
        devId = Number(byKey[0]?.id ?? 0);
      }
      const dev = rawRows(
        await getDb().execute(sql`SELECT id FROM st_devices WHERE id=${devId || -1} AND factory_id=${factoryId} LIMIT 1`),
      );
      if (!dev[0]) throw new TRPCError({ code: "NOT_FOUND", message: "设备未在本厂登记" });
      const r = await enqueueDeviceCommand({
        factoryId,
        deviceId: Number(dev[0].id),
        cap,
        payload: { ...input.args, _mcp_tool: input.tool },
        ticketId: input.ticketId ?? null,
        clientKey: `mcp-${input.deviceId}-${input.tool}`,
      });
      return { ok: true as const, commandId: r.commandId, deduped: r.deduped, level: tool.level };
    }),
});
