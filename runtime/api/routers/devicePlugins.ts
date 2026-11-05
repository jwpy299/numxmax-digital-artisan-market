/**
 * devicePlugins —— M37「万物皆可插件」：APP 扫一扫生产设备 → 自动生成设备控制插件。
 *
 * 全链路：
 *   APP 扫码（LINGSHU-DEV:{...} 或含 protocol 字段的裸 JSON）
 *   → scanGenerate：解析校验 → 模板化生成插件 manifest（确定性模板，绝不用 LLM 自由生成代码）
 *     → sha256 校验和 → 入库（factoryId 强隔离）
 *   → 三条消费路径同一 manifest 口径：
 *     ① 灵枢语音/工作台：readData 读设备数据（B 级直接执行）；
 *     ② DSH 底座：S3 上 lingshu-device-mcp（streamable-http）把在册插件发布为
 *        mcp__lingshu_devices__read_<slug> 工具，DSH 每次新跑自动发现（tools/list 实时读库）；
 *     ③ 控制动作 sendCommand：C 级必须双签票据（st_gate_tickets），执行成功核销——与
 *        devices.issueCommand 同款纪律；票据不存在/过期/已用一律 FORBIDDEN。
 *
 * 安全铁律：
 * - 适配器 MVP 只真实执行 http_api；mqtt/modbus_tcp 模板照生成但调用明确报 adapter_pending
 *   （诚实声明，绝不假装成功）；
 * - SSRF 闸：endpoint 禁指 169.254.0.0/16（云元数据）、本系统三端公网 IP、非 http(s) scheme、
 *   URL 携带凭据；设备在内网是正常场景（私网段放行），执行超时 8s 硬顶；
 * - 控制类动作绝不进语音链（语音只读）；C 级票据一次性，核销后才算完成；
 * - manifest 由固定模板渲染 + 校验和落库，任何篡改都会在校验和比对中现形。
 */
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { stQuery } from "./terminal";
import { sessionMe, normalizeRole } from "./wbSession";
import { parseDbUtc } from "./dbTime";
import { enqueueDeviceCommand } from "./devices";

// ─── 协议与 schema ────────────────────────────────────────────────────────────

export const PLUGIN_PROTOCOLS = ["http_api", "mqtt", "modbus_tcp"] as const;
export type PluginProtocol = (typeof PLUGIN_PROTOCOLS)[number];

const metricSchema = z.object({
  key: z.string().trim().min(1).max(32).regex(/^[a-zA-Z0-9_]+$/, "指标键仅限字母数字下划线"),
  label: z.string().trim().min(1).max(32),
  unit: z.string().trim().max(16).optional().default(""),
  path: z.string().trim().min(1).max(120),
});

const actionSchema = z.object({
  key: z.string().trim().min(1).max(32).regex(/^[a-zA-Z0-9_]+$/, "动作键仅限字母数字下划线"),
  label: z.string().trim().min(1).max(32),
  level: z.enum(["B", "C"]).optional().default("C"),
  method: z.enum(["GET", "POST"]).optional().default("POST"),
  path: z.string().trim().min(1).max(120),
});

const profileSchema = z.object({
  name: z.string().trim().min(1).max(64),
  model: z.string().trim().max(64).optional().default(""),
  protocol: z.enum(PLUGIN_PROTOCOLS),
  endpoint: z.string().trim().min(3).max(255),
  /** M41：true=设备在厂区 LAN（云上不可达），经边缘网关 plugin_invoke 执行；false=云上直连 */
  viaEdge: z.boolean().optional().default(false),
  metrics: z.array(metricSchema).max(16).optional().default([]),
  actions: z.array(actionSchema).max(16).optional().default([]),
});

export type DeviceProfile = z.infer<typeof profileSchema>;
export type DeviceMetric = z.infer<typeof metricSchema>;
export type DeviceAction = z.infer<typeof actionSchema>;

/** 扫码前缀：设备插件码以 LINGSHU-DEV: 开头（余下为 JSON）；裸 JSON 含 protocol 字段同样识别 */
export const DEVICE_QR_PREFIX = "LINGSHU-DEV:";

// ─── M42 安全补课①：二维码验真纪律 ────────────────────────────────────────────
// 审计发现：扫码即建插件零验真——一张恶意打印的二维码可指挥边缘网关探测厂区 LAN
// （边缘侧虽有 LAN 闸，但闸内横向仍是攻击面）。收口：viaEdge 插件生成即
// pending_review，须本厂 owner/admin 显式 activate 后才可读写；云直连插件维持
// 即扫即用（SSRF 闸已收口，读数只回给扫码者本厂，无跨厂面）。

/** 工具文本清洗（防注入进入 DSH prompt 面）：去控制字符/零宽字符/换行，截断 */
export function sanitizeToolText(s: string, max = 64): string {
  return String(s ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[\u200B-\u200F\uFEFF\u202A-\u202E]/g, "")
    .trim()
    .slice(0, max);
}

/** 注入疑似词（进入 prompt 面的名称/描述/标签一律拒收；宁严勿宽，误伤可改名重扫） */
const INJECTION_PATTERNS = [
  /忽略.{0,12}(指令|要求|规则)/i,
  /ignore\s+(all\s+)?(previous\s+)?instructions?/i,
  /system\s*prompt/i,
  /你现在是/,
  /jailbreak/i,
  /\bDAN\b/,
];

export function assertNoInjection(fields: Array<string>): void {
  for (const f of fields) {
    if (INJECTION_PATTERNS.some((re) => re.test(f))) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "设备码文本含疑似注入指令，已拒收（如属误伤请改名后重扫）" });
    }
  }
}

// ─── QR 解析 ─────────────────────────────────────────────────────────────────

/** 识别并解析设备插件码；非设备码（配对码/资产码/普通文本）返回 null，格式坏抛 BAD_REQUEST */
export function parseDeviceQr(raw: string): DeviceProfile | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  let jsonText: string | null = null;
  if (s.startsWith(DEVICE_QR_PREFIX)) {
    jsonText = s.slice(DEVICE_QR_PREFIX.length).trim();
  } else if (s.startsWith("{")) {
    // 裸 JSON：必须带 protocol 字段才视为设备插件码，否则让位资产/配对分流
    if (/"(protocol)"\s*:/.test(s)) jsonText = s;
  }
  if (!jsonText) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(jsonText);
  } catch {
    throw new TRPCError({ code: "BAD_REQUEST", message: "设备码 JSON 损坏，请扫设备铭牌上的灵枢插件码" });
  }
  const r = profileSchema.safeParse(obj);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `设备码字段不合规：${first ? `${first.path.join(".")} ${first.message}` : "格式错误"}`,
    });
  }
  return r.data;
}

// ─── SSRF 闸 ─────────────────────────────────────────────────────────────────

/** 本系统三端公网 IP（设备 endpoint 绝不允许指回我们自己） */
const OWN_HOSTS = new Set(["192.0.2.10", "192.0.2.11", "192.0.2.12", "example.invalid"]);

/** 规范化 endpoint 为 http base URL 并过 SSRF 闸；违规抛 BAD_REQUEST */
export function normalizeEndpoint(endpoint: string): string {
  // 显式 scheme 识别：带 scheme 但非 http(s)（如 ftp://）一律拒，绝不让 scheme 滑成主机名
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(endpoint) && !/^https?:\/\//i.test(endpoint)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "设备地址仅支持 http/https" });
  }
  const withScheme = /^https?:\/\//i.test(endpoint) ? endpoint : `http://${endpoint}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new TRPCError({ code: "BAD_REQUEST", message: "设备地址无法解析" });
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "设备地址仅支持 http/https" });
  }
  if (u.username || u.password) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "设备地址不得携带账号口令" });
  }
  const host = u.hostname.toLowerCase();
  if (host === "169.254.169.254" || host.startsWith("169.254.")) {
    throw new TRPCError({ code: "FORBIDDEN", message: "该地址段为云厂商元数据保留段，禁止作为设备地址" });
  }
  if (OWN_HOSTS.has(host)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "设备地址不得指向 NumX Max 自身服务器" });
  }
  return `${u.protocol}//${u.host}`;
}

// ─── manifest 生成（固定模板，确定性） ────────────────────────────────────────

function buildManifest(profile: DeviceProfile, slug: string, base: string, generatedAt: string) {
  return {
    schemaVersion: "lingshu-device-plugin/1",
    slug,
    name: profile.name,
    model: profile.model,
    protocol: profile.protocol,
    endpoint: base,
    viaEdge: profile.viaEdge,
    metrics: profile.metrics.map((m) => ({ key: m.key, label: m.label, unit: m.unit, path: m.path })),
    actions: profile.actions.map((a) => ({
      key: a.key,
      label: a.label,
      level: a.level,
      method: a.method,
      path: a.path,
    })),
    generator: "lingshu-m37",
    generatedAt,
  };
}

type Manifest = ReturnType<typeof buildManifest>;

function checksumOf(manifest: Manifest): string {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function newSlug(): string {
  return `dev-${randomBytes(5).toString("hex")}`; // dev- + 10 hex，全厂唯一约束兜底
}

// ─── 行读取 ──────────────────────────────────────────────────────────────────

interface PluginRow {
  id: number;
  factoryId: number;
  slug: string;
  name: string;
  model: string;
  protocol: string;
  endpoint: string;
  viaEdge: number;
  metrics: unknown;
  actions: unknown;
  checksum: string;
  status: string;
  source: string;
  createdAt: unknown;
}

function parseJsonArray<T>(raw: unknown): T[] {
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function rowToCard(r: PluginRow) {
  return {
    id: Number(r.id),
    slug: String(r.slug),
    name: String(r.name),
    model: String(r.model),
    protocol: String(r.protocol),
    endpoint: String(r.endpoint),
    viaEdge: Number(r.viaEdge) === 1,
    metrics: parseJsonArray<DeviceMetric>(r.metrics),
    actions: parseJsonArray<DeviceAction>(r.actions),
    status: String(r.status),
    createdAt: r.createdAt ? String(r.createdAt) : null,
  };
}

export async function loadPlugin(id: number, factoryId: number): Promise<PluginRow> {
  const rows = await stQuery(
    sql`SELECT id, factory_id AS factoryId, slug, name, model, protocol, endpoint, via_edge AS viaEdge, metrics, actions,
               checksum, status, source, created_at AS createdAt
        FROM st_device_plugins WHERE id = ${id} AND factory_id = ${factoryId} LIMIT 1`,
  );
  const r = rows[0] as unknown as PluginRow | undefined;
  if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "插件不存在或不属本企业" });
  if (String(r.status) !== "active") throw new TRPCError({ code: "FORBIDDEN", message: String(r.status) === "pending_review" ? "插件待激活：请本厂负责人确认后再用" : "插件已停用" });
  return r;
}

// ─── 适配器执行器（http_api 真实执行；mqtt/modbus 诚实报 pending） ────────────

const EXEC_TIMEOUT_MS = 8000;

async function httpJson(method: "GET" | "POST", url: string, body?: unknown): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), EXEC_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* 非 JSON 按原文返回 */
    }
    if (!res.ok) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `设备应答异常（HTTP ${res.status}）` });
    }
    return data;
  } catch (e) {
    if (e instanceof TRPCError) throw e;
    const msg = e instanceof Error && e.name === "AbortError" ? "设备应答超时（8 秒硬顶）" : "设备不可达或连接被拒";
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: msg });
  } finally {
    clearTimeout(timer);
  }
}

/** 适配器就绪口径：http_api 全通；mqtt/modbus_tcp 仅 viaEdge（M41c 起边缘适配器真实执行）；
 * 云直连 mqtt/modbus 仍 pending（云上也够不到厂区 broker/PLC，硬连没意义） */
function assertAdapterReady(protocol: string, viaEdge: boolean): void {
  if (protocol === "http_api") return;
  if ((protocol === "mqtt" || protocol === "modbus_tcp") && viaEdge) return;
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: `adapter_pending：${protocol} ${viaEdge ? "" : "云直连"}适配器未启用（mqtt/modbus 请走边缘网关：扫码带 viaEdge）`,
  });
}

// ─── M41 边缘网关执行（via_edge 设备：云上不可达，经厂区边缘 Agent 中继） ──────
// 纪律：复用 M12 通道（enrollKey 认证/原子认领/回报核销票据）；边缘只拿到
// 「该插件声明过的 method+path」的转发载荷，绝不传任意自由指令（协议收敛）。

interface EdgeDeviceRow {
  id: number;
  name: string;
}

/** 找本厂在线边缘网关（声明 plugin_invoke 能力的最近在线设备）；无 → null */
async function resolveEdgeDevice(factoryId: number): Promise<EdgeDeviceRow | null> {
  const rows = await stQuery(
    sql`SELECT id, name FROM st_devices
        WHERE factory_id = ${factoryId} AND status = 'online'
          AND JSON_CONTAINS(caps, '"plugin_invoke"')
        ORDER BY last_seen_at DESC LIMIT 1`,
  );
  return rows[0] ? { id: Number((rows[0] as Record<string, unknown>).id), name: String((rows[0] as Record<string, unknown>).name) } : null;
}

/** 等边缘回报：400ms 轮询，9s 硬顶；failed 诚实抛出 */
async function awaitCommandResult(commandId: number, factoryId: number, deadlineMs = 9000): Promise<string> {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    const rows = await stQuery(
      sql`SELECT status, result FROM st_device_commands WHERE id = ${commandId} AND factory_id = ${factoryId} LIMIT 1`,
    );
    const c = rows[0] as { status?: string; result?: string | null } | undefined;
    if (c && (c.status === "done" || c.status === "failed")) {
      if (c.status === "failed") {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `边缘执行失败：${String(c.result ?? "").slice(0, 120)}` });
      }
      return String(c.result ?? "");
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "边缘网关应答超时（9 秒硬顶）" });
}

/** 经边缘网关调用插件声明的端点（读/控同通道；票据由回报环节自动核销） */
async function execViaEdge(
  row: PluginRow,
  opts: { method: "GET" | "POST"; path: string; params?: Record<string, unknown>; ticketId?: number },
): Promise<unknown> {
  const edge = await resolveEdgeDevice(row.factoryId);
  if (!edge) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "边缘网关不在线：请确认厂区的灵枢边缘网关已通电联网（声明 plugin_invoke 能力）" });
  }
  const r = await enqueueDeviceCommand({
    factoryId: row.factoryId,
    deviceId: edge.id,
    cap: "plugin_invoke",
    payload: {
      endpoint: String(row.endpoint),
      protocol: String(row.protocol),
      method: opts.method,
      path: opts.path,
      params: opts.params ?? {},
    },
    ticketId: opts.ticketId ?? null,
    clientKey: null,
  });
  const text = await awaitCommandResult(r.commandId, row.factoryId);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** 从设备应答 JSON 按声明 key 取值（兼容 {key} / {value} / 裸数值） */
function extractMetricValue(data: unknown, key: string): unknown {
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const rec = data as Record<string, unknown>;
    return key in rec ? rec[key] : "value" in rec ? rec.value : data;
  }
  return data;
}

/** 读设备数据：按 metric.path GET，从应答 JSON 按 metric.key 取值；via_edge 设备经边缘网关中继 */
export async function execReadMetric(row: PluginRow, metricKey?: string): Promise<Array<{ key: string; label: string; value: unknown; unit: string }>> {
  const viaEdge = Number(row.viaEdge) === 1;
  assertAdapterReady(String(row.protocol), viaEdge);
  const metrics = parseJsonArray<DeviceMetric>(row.metrics);
  if (metrics.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "该插件未声明任何可读指标" });
  const picked = metricKey ? metrics.filter((m) => m.key === metricKey) : metrics;
  if (metricKey && picked.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `指标 ${metricKey} 不在插件清单内` });
  }
  const base = viaEdge ? null : normalizeEndpoint(String(row.endpoint)); // 边缘路径的端点归一在边缘侧做
  const out: Array<{ key: string; label: string; value: unknown; unit: string }> = [];
  for (const m of picked) {
    const data = viaEdge
      ? await execViaEdge(row, { method: "GET", path: m.path })
      : await httpJson("GET", `${base}${m.path}`);
    out.push({ key: m.key, label: m.label, value: extractMetricValue(data, m.key), unit: m.unit ?? "" });
  }
  return out;
}

/** 控设备：按 action.method/path 下发；via_edge 设备经边缘网关（票据随命令，回报自动核销） */
export async function execControlAction(row: PluginRow, actionKey: string, params: Record<string, unknown>, ticketId?: number): Promise<{ action: DeviceAction; response: unknown }> {
  const viaEdgeForAction = Number(row.viaEdge) === 1;
  assertAdapterReady(String(row.protocol), viaEdgeForAction);
  const actions = parseJsonArray<DeviceAction>(row.actions);
  const action = actions.find((a) => a.key === actionKey);
  if (!action) throw new TRPCError({ code: "BAD_REQUEST", message: `动作 ${actionKey} 不在插件清单内` });
  const viaEdge = viaEdgeForAction;
  const response = viaEdge
    ? await execViaEdge(row, { method: action.method, path: action.path, params, ticketId })
    : await httpJson(action.method, `${normalizeEndpoint(String(row.endpoint))}${action.path}`, action.method === "POST" ? params : undefined);
  return { action, response };
}

// ─── 票据（与 devices.issueCommand 同款纪律） ────────────────────────────────

async function validateTicket(ticketId: number, factoryId: number): Promise<void> {
  const rows = await stQuery(
    sql`SELECT id, used_at AS usedAt, expires_at AS expiresAt FROM st_gate_tickets
        WHERE id = ${ticketId} AND factory_id = ${factoryId} LIMIT 1`,
  );
  const t = rows[0];
  if (!t) throw new TRPCError({ code: "FORBIDDEN", message: "票据不存在或不属本厂" });
  if (t.usedAt) throw new TRPCError({ code: "FORBIDDEN", message: "票据已使用（一次性）" });
  if (parseDbUtc(t.expiresAt) < Date.now()) {
    throw new TRPCError({ code: "FORBIDDEN", message: "票据已过期" });
  }
}

async function consumeTicket(ticketId: number): Promise<void> {
  await stQuery(sql`UPDATE st_gate_tickets SET used_at = NOW() WHERE id = ${ticketId} AND used_at IS NULL`);
}

// ─── 路由 ────────────────────────────────────────────────────────────────────

export const devicePluginsRouter = createRouter({
  /** scanGenerate（mutation, wb/app 登录态）：扫设备码 → 生成插件（幂等：同厂同型号同地址命中在册插件直接返回） */
  scanGenerate: publicQuery
    .input(z.object({ token: z.string().trim().min(1), qr: z.string().trim().min(1).max(2048) }))
    .mutation(async ({ input }) => {
      const { user, factory } = await sessionMe(input.token);
      const profile = parseDeviceQr(input.qr);
      if (!profile) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "这不是设备插件码（需 LINGSHU-DEV: 前缀或含 protocol 字段）" });
      }
      // M42：进入 prompt 面的全部文本先过注入闸 + 清洗
      assertNoInjection([
        profile.name,
        profile.model,
        ...profile.metrics.flatMap((m) => [m.key, m.label, m.path]),
        ...profile.actions.flatMap((a) => [a.key, a.label, a.path]),
      ]);
      profile.name = sanitizeToolText(profile.name, 64);
      profile.model = sanitizeToolText(profile.model, 64);
      for (const m of profile.metrics) {
        m.label = sanitizeToolText(m.label, 32);
        m.unit = sanitizeToolText(m.unit ?? "", 16);
      }
      for (const a of profile.actions) a.label = sanitizeToolText(a.label, 32);
      const base = normalizeEndpoint(profile.endpoint);
      // M42：viaEdge 插件（触厂区 LAN）生成即待审，本厂负责人激活后方可读写
      const initialStatus = profile.viaEdge ? "pending_review" : "active";
      // 幂等去重：同厂 + 同地址 + 同型号 + active → 已在册
      const dup = await stQuery(
        sql`SELECT id FROM st_device_plugins
            WHERE factory_id = ${factory.id} AND endpoint = ${base} AND model = ${profile.model} AND status IN ('active', 'pending_review')
            LIMIT 1`,
      );
      if (dup[0]) {
        const existing = await loadPlugin(Number(dup[0].id), factory.id);
        return { ok: true as const, already: true as const, plugin: rowToCard(existing) };
      }
      const slug = newSlug();
      const manifest = buildManifest(profile, slug, base, new Date().toISOString());
      const checksum = checksumOf(manifest);
      const res = await stQuery(
        sql`INSERT INTO st_device_plugins
            (factory_id, slug, name, model, protocol, endpoint, via_edge, metrics, actions, manifest, checksum, status, source, created_by)
            VALUES (${factory.id}, ${slug}, ${profile.name}, ${profile.model}, ${profile.protocol}, ${base},
                    ${profile.viaEdge ? 1 : 0},
                    ${JSON.stringify(profile.metrics)}, ${JSON.stringify(profile.actions)},
                    ${JSON.stringify(manifest)}, ${checksum}, ${initialStatus}, 'scan', ${user.id})`,
      );
      const insertId = Number((res[0] as { insertId?: number } | undefined)?.insertId ?? 0);
      return {
        ok: true as const,
        already: false as const,
        plugin: {
          id: insertId,
          slug,
          name: profile.name,
          model: profile.model,
          protocol: profile.protocol,
          endpoint: base,
          viaEdge: profile.viaEdge,
          metrics: profile.metrics,
          actions: profile.actions,
          status: initialStatus,
          createdAt: manifest.generatedAt,
        },
      };
    }),

  /** list（query）：本厂在册插件卡（含待激活，便于负责人过审激活；不含 manifest 正文） */
  list: publicQuery.input(z.object({ token: z.string().trim().min(1) })).query(async ({ input }) => {
    const { factory } = await sessionMe(input.token);
    const rows = (await stQuery(
      sql`SELECT id, factory_id AS factoryId, slug, name, model, protocol, endpoint, via_edge AS viaEdge, metrics, actions,
                 checksum, status, source, created_at AS createdAt
          FROM st_device_plugins WHERE factory_id = ${factory.id} AND status IN ('active', 'pending_review')
          ORDER BY id DESC LIMIT 100`,
    )) as unknown as PluginRow[];
    return { plugins: rows.map(rowToCard) };
  }),

  /** readData（query, B 级）：读设备指标；metricKey 空 = 全指标轮询 */
  readData: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        id: z.number().int().positive(),
        metricKey: z.string().trim().min(1).max(32).optional(),
      }),
    )
    .query(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      const row = await loadPlugin(input.id, factory.id);
      const values = await execReadMetric(row, input.metricKey);
      return { ok: true as const, slug: String(row.slug), name: String(row.name), values, ts: new Date().toISOString() };
    }),

  /** sendCommand（mutation, C 级）：控制动作，必须双签票据；执行成功核销（一次性） */
  sendCommand: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        id: z.number().int().positive(),
        actionKey: z.string().trim().min(1).max(32),
        params: z.record(z.string(), z.unknown()).optional().default({}),
        ticketId: z.number().int().positive().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      const row = await loadPlugin(input.id, factory.id);
      const actions = parseJsonArray<DeviceAction>(row.actions);
      const action = actions.find((a) => a.key === input.actionKey);
      if (!action) throw new TRPCError({ code: "BAD_REQUEST", message: `动作 ${input.actionKey} 不在插件清单内` });
      if (action.level === "C") {
        if (!input.ticketId) {
          throw new TRPCError({ code: "FORBIDDEN", message: `C 级控制动作 ${action.label} 必须携带有效双签票据（ticketId）` });
        }
        await validateTicket(input.ticketId, factory.id);
      }
      const { response } = await execControlAction(row, input.actionKey, input.params, input.ticketId);
      // 票据核销口径：云直连=执行成功即核销；边缘=命令行携带票据、设备回报环节一次性核销
      // （reportResult 同款纪律），此处不再重复核销（consumeTicket 幂等兜底）
      if (Number(row.viaEdge) !== 1 && action.level === "C" && input.ticketId) await consumeTicket(input.ticketId);
      return {
        ok: true as const,
        slug: String(row.slug),
        name: String(row.name),
        action: action.key,
        level: action.level,
        response,
        ts: new Date().toISOString(),
      };
    }),

  /** remove（mutation, 本厂 owner/admin）：停用插件（软删除，审计留痕） */
  remove: publicQuery
    .input(z.object({ token: z.string().trim().min(1), id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const { user, factory } = await sessionMe(input.token);
      const role = normalizeRole(String(user.role));
      if (role === "staff") throw new TRPCError({ code: "FORBIDDEN", message: "停用插件需要负责人或管理员权限" });
      const upd = await stQuery(
        sql`UPDATE st_device_plugins SET status = 'disabled' WHERE id = ${input.id} AND factory_id = ${factory.id}`,
      );
      const affected = Number((upd[0] as { affectedRows?: number | string } | undefined)?.affectedRows ?? 0);
      if (affected !== 1) throw new TRPCError({ code: "NOT_FOUND", message: "插件不存在或不属本企业" });
      return { ok: true as const, id: input.id, status: "disabled" };
    }),

  /** activate（mutation, 本厂 owner/admin）：M42 待审插件激活（viaEdge 必经此闸才可用） */
  activate: publicQuery
    .input(z.object({ token: z.string().trim().min(1), id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const { user, factory } = await sessionMe(input.token);
      const role = normalizeRole(String(user.role));
      if (role === "staff") throw new TRPCError({ code: "FORBIDDEN", message: "激活插件需要负责人或管理员权限" });
      const upd = await stQuery(
        sql`UPDATE st_device_plugins SET status = 'active' WHERE id = ${input.id} AND factory_id = ${factory.id} AND status = 'pending_review'`,
      );
      const affected = Number((upd[0] as { affectedRows?: number | string } | undefined)?.affectedRows ?? 0);
      if (affected !== 1) throw new TRPCError({ code: "NOT_FOUND", message: "插件不存在、不属本企业或不在待激活态" });
      return { ok: true as const, id: input.id, status: "active" };
    }),

  /** digest（query）：灵枢语音/工作台注入用的设备清单摘要（名字+指标标签，≤8 台） */
  digest: publicQuery.input(z.object({ token: z.string().trim().min(1) })).query(async ({ input }) => {
    const { factory } = await sessionMe(input.token);
    const rows = (await stQuery(
      sql`SELECT id, factory_id AS factoryId, slug, name, model, protocol, endpoint, via_edge AS viaEdge, metrics, actions,
                 checksum, status, source, created_at AS createdAt
          FROM st_device_plugins WHERE factory_id = ${factory.id} AND status = 'active'
          ORDER BY id DESC LIMIT 8`,
    )) as unknown as PluginRow[];
    return {
      devices: rows.map((r) => ({
        id: Number(r.id),
        slug: String(r.slug),
        name: String(r.name),
        metrics: parseJsonArray<DeviceMetric>(r.metrics).map((m) => ({ key: m.key, label: m.label, unit: m.unit })),
      })),
    };
  }),
});

/** 语音链免 token 的内部摘要（voice.ts 注入用；工厂内 active 插件，≤8 台） */
export async function listDevicePluginDigest(factoryId: number): Promise<Array<{ id: number; slug: string; name: string; metrics: Array<{ key: string; label: string; unit: string }> }>> {
  try {
    const rows = (await stQuery(
      sql`SELECT id, factory_id AS factoryId, slug, name, model, protocol, endpoint, via_edge AS viaEdge, metrics, actions,
                 checksum, status, source, created_at AS createdAt
          FROM st_device_plugins WHERE factory_id = ${factoryId} AND status = 'active'
          ORDER BY id DESC LIMIT 8`,
    )) as unknown as PluginRow[];
    return rows.map((r) => ({
      id: Number(r.id),
      slug: String(r.slug),
      name: String(r.name),
      metrics: parseJsonArray<DeviceMetric>(r.metrics).map((m) => ({ key: m.key, label: m.label, unit: m.unit })),
    }));
  } catch {
    return []; // fail-safe：表未建/库抖动时语音主链照常
  }
}

/**
 * 语音链按名读数（B 级只读）：nameOrSlug 精确匹配 slug/name，失败退化为 name 包含匹配；
 * 匹配不到返回 null（调用方转人话说明，绝不编造读数）。metricLabel 为空 = 全指标轮询。
 */
export async function readDeviceByName(
  factoryId: number,
  nameOrSlug: string,
  metricLabel?: string,
): Promise<{ name: string; values: Array<{ key: string; label: string; value: unknown; unit: string }> } | null> {
  const rows = (await stQuery(
    sql`SELECT id, factory_id AS factoryId, slug, name, model, protocol, endpoint, via_edge AS viaEdge, metrics, actions,
               checksum, status, source, created_at AS createdAt
        FROM st_device_plugins WHERE factory_id = ${factoryId} AND status = 'active'
        ORDER BY id DESC LIMIT 100`,
  )) as unknown as PluginRow[];
  const want = nameOrSlug.trim().toLowerCase();
  if (!want) return null;
  const exact = rows.find((r) => String(r.slug).toLowerCase() === want || String(r.name).toLowerCase() === want);
  const fuzzy = exact ?? rows.find((r) => String(r.name).toLowerCase().includes(want) || want.includes(String(r.name).toLowerCase()));
  if (!fuzzy) return null;
  let metricKey: string | undefined;
  if (metricLabel) {
    const ml = metricLabel.trim().toLowerCase();
    const m = parseJsonArray<DeviceMetric>(fuzzy.metrics).find(
      (x) => x.key.toLowerCase() === ml || x.label.toLowerCase() === ml || x.label.toLowerCase().includes(ml) || ml.includes(x.label.toLowerCase()),
    );
    metricKey = m?.key;
  }
  const values = await execReadMetric(fuzzy, metricKey);
  return { name: String(fuzzy.name), values };
}
