/**
 * Nebula Harness · 记忆桥（2026-08-26 彭总令：记忆体系接产）。
 *
 * 接 TencentDB Agent Memory 网关（S2 本机 127.0.0.1:8420，standalone SQLite+中文 BM25，
 * 提炼脑=海禛云 flash 模型，Bearer 鉴权）。
 *
 * 纪律：
 * - 记忆是「给养」不是「判官」：recall 只注入上下文，capture 只写事件史；
 *   任何记忆故障都优雅降级（返回空），绝不阻塞/搞挂主链（P4 验收项）；
 * - 密钥只存服务端 env（MEMORY_GW_TOKEN），绝不回显不落日志；
 * - 总开关 HARNESS_MEMORY_ENABLED=1（缺省关，验证后开闸）。
 */

const GW = process.env.MEMORY_GW_URL ?? "http://127.0.0.1:8420";
const TOKEN = process.env.MEMORY_GW_TOKEN ?? "";
const ENABLED = process.env.HARNESS_MEMORY_ENABLED === "1";
const TIMEOUT_MS = 4000;

import { filterConfidentMemories } from "./autonomy";

async function call(path: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  if (!ENABLED || !TOKEN) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const r = await fetch(`${GW}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!r.ok) return null;
    return (await r.json()) as Record<string, unknown>;
  } catch {
    return null; // 记忆缺席不阻塞主链
  }
}

export function memoryEnabled(): boolean {
  return ENABLED && !!TOKEN;
}

/** 会话键派生用户面（dsh:u42:lingshu → u42——sessionKey 形制约定面；非约定形=原样兜） */
export function userIdOfSession(sessionKey: string): string {
  const m = /^dsh:u(\d+):/.exec(String(sessionKey ?? ""));
  return m?.[1] ?? String(sessionKey || "anon").slice(0, 48); // || 兜空串（?? 只兜 nullish 不兜空——契约⑧同族病[空串静默面封死]）
}

/** 召回：给重型/施工任务取相关组织记忆（G3 记忆代谢：低置信隔离，只信 score≥0.5）
 *  sessionKey 为按会话隔离的预留位次（当前检索口径不使用，_ 前缀保留形参位次） */
export async function recallForContext(query: string, _sessionKey: string): Promise<string | null> {
  // ★ session 隔离面[哨兵实证坐实——契约⑦成立：网关 persona 层全局共享=A 的私密记忆可被 B 召回]——检索带 session_key 过滤（网关 L1-query filter 面支持 sessionKey 收敛）
  const r = await call("/search/memories", { query, limit: 5, session_key: _sessionKey });
  const results = r?.results;
  if (typeof results !== "string" || !results || results.startsWith("No matching")) return null;
  const { text } = filterConfidentMemories(results);
  if (!text) return null; // 全部低置信 → 视为无给养（隔离区不进上下文）
  return text.slice(0, 2000); // 注入上限，防上下文膨胀
}

/** 回写：环事件/施工结果落记忆（L0 全量留底，L1 由网关异步提炼） */
export async function captureEvent(sessionKey: string, userText: string, assistantText: string): Promise<boolean> {
  const r = await call("/capture", {
    user_content: userText.slice(0, 4000),
    assistant_content: assistantText.slice(0, 4000),
    session_key: sessionKey,
    user_id: userIdOfSession(sessionKey), // 不写死 harness[哨兵面]——按会话派生用户（统一 harness=全用户画像混一锅面封死）
  });
  return !!r && Number(r.l0_recorded) > 0;
}

/** 会话收尾（触发提炼管线） */
export async function endMemorySession(sessionKey: string): Promise<void> {
  await call("/session/end", { session_key: sessionKey, user_id: userIdOfSession(sessionKey) });
}
