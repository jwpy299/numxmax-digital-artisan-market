/**
 * dshBridge —— DSH（个人智能工作台范式）⇄ Nebula Harness 驱动适配层（2026-08-30 彭总令开建）。
 *
 * 定位：DSH 出驾驶舱（皮），Harness 出发动机（神）——本层是唯一翻译官。
 * 铁律（彭总令）：灵智枢内部侧与用户侧同一套运行逻辑；适配永远只在桥层，Harness 内核一行不改；
 * 模型调用一律走统一网关槽位（竞速/熔断/日帽/缓存），桥层绝不直连模型。
 *
 * 映射表：session→对话线程 / task→工单（一单到底）/ skill→分身装扮 / event→汇报总线 / plan→三环调度。
 */

/** DSH 侧概念（工作台皮的语言） */
export type DshPrimitive = "session" | "task" | "skill" | "event" | "plan";

/** Harness 侧原语（运行时的语言） */
export type HarnessPrimitive =
  | "voice_session"      // 对话线程（记忆体系供血）
  | "hire_order"         // 雇佣工单（一单到底）
  | "intern_task"        // 实习任务（判分闸）
  | "agent_dress"        // 分身装扮（技能/工具/饰品位）
  | "report_bus"         // 汇报总线（dedupe/免打扰）
  | "ring_dispatch";     // 三环调度

/** 概念映射表（纯函数可测）——一对一，无多对一（防语义混流） */
export const DSH_MAP: Record<DshPrimitive, HarnessPrimitive> = {
  session: "voice_session",
  task: "hire_order",
  skill: "agent_dress",
  event: "report_bus",
  plan: "ring_dispatch",
} as const;

export function mapPrimitive(p: DshPrimitive): HarnessPrimitive {
  return DSH_MAP[p];
}

/** 任务拆分（DSH task → 实习 or 雇佣工单）：纯函数可测
 *  有有效雇佣合约 → hire_order（收费主链）；无合约 → intern_task（实习练兵） */
export function routeTask(hasHireContract: boolean): HarnessPrimitive {
  return hasHireContract ? "hire_order" : "intern_task";
}

/** 事件等级映射（DSH event level → 汇报总线 level）：纯函数 */
export function mapEventLevel(lv: string): "info" | "action" | "alert" {
  if (lv === "critical" || lv === "alert") return "alert";
  if (lv === "warn" || lv === "action") return "action";
  return "info";
}

/** 免打扰纪律桥接（DSH 事件落地前必过）：alert 穿透，其余夜间静默——与总线同纪律 */
export function mayEmitNow(level: "info" | "action" | "alert", quietNow: boolean): boolean {
  if (level === "alert") return true;
  return !quietNow;
}

/** 会话钥匙（DSH session ↔ 我们 persona+user）：同一账号同一人格同一线程——跨端续聊的事实源 */
export function sessionKey(userId: number, persona: "lingshu" | "xingyun"): string {
  return `dsh:u${userId}:${persona}`;
}
