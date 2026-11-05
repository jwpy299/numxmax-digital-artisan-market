/**
 * 分发动作词表（仓级唯一来源，OCR 批五 R11）——st_release_audit.action 的分发语义字面值。
 *
 * 写侧：
 * - conveyor.recordProbeReport：probe:ok / probe:fail（探针回写）；
 * - releaseCenter.confirmTicket：confirm:publish / confirm:rollback（人工双签确认）；
 * - executor：deploy:eligible（双签票据核销放行）/ rollback（输送带自动止血）。
 * 读侧：codespace 分发核验白名单（DISTRIBUTION_ACTIONS）。
 *
 * 纪律：rename/新增分发动作只改本文件——读写两侧同源，面板不再静默漏行。
 *
 * 诚实登记（OCR 批五 R12，「唯一来源」仅覆盖以下分发语义字面值）：
 * - 已收口：conveyor（probe:*）、executor（deploy:eligible/rollback）、releaseCenter.confirmTicket（confirm:*）、
 *   读侧 loop.ts / sdlcLearning.ts 的 'rollback' 判定；
 * - 未收口（语义不同，刻意不归本表）：releaseCenter 的 `ticket:${action}` 票据签发、'verify' 验证登记。
 * - loop.ts「发布后又回滚」观测段已于 R15 收口：发布侧 = confirmPublish（裸 'publish' 无任何写侧，
 *   旧 join 永不命中），回滚侧 = rollback ∪ confirmRollback——两侧全走本表。
 */
export const AUDIT_ACTION = {
  probeOk: "probe:ok",
  probeFail: "probe:fail",
  confirmPublish: "confirm:publish",
  confirmRollback: "confirm:rollback",
  rollback: "rollback",
  deployEligible: "deploy:eligible",
} as const;

export type AuditAction = (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION];

/** 票据动作词表（仓级唯一来源，OCR R18）：st_release_tickets.action 无 CHECK，
 *  写侧 releaseCenter（签发/确认）与读侧 executor/controlledRepair join 全同源，
 *  rename/新增只改这里，不再三文件分叉静默漏命中 */
export const TICKET_ACTION = { publish: "publish", rollback: "rollback" } as const; // 命名锚点：读侧按名取用，不靠下标（OCR R19）
export const TICKET_ACTIONS = [TICKET_ACTION.publish, TICKET_ACTION.rollback] as const;
export type TicketAction = (typeof TICKET_ACTIONS)[number];

/** 分发核验白名单（读侧用，OCR 批五 R12）：显式列举面板关心的人工/放行/回滚动作——
 *  不含 probe:ok/probe:fail 高频心跳行（探针每心跳一条会把 LIMIT 行位挤光，反把双签确认挤出榜）；
 *  不用 Object.values 全量派生：写侧未来加非分发动作时不被静默带进面板 */
export const DISTRIBUTION_ACTIONS: readonly AuditAction[] = [
  AUDIT_ACTION.confirmPublish,
  AUDIT_ACTION.confirmRollback,
  AUDIT_ACTION.deployEligible,
  AUDIT_ACTION.rollback,
];
