/**
 * 表未建提示常量叶（R7-c160-⑥）：412 话术族单源——gate/devices/kb 等族的「数据表未初始化」提示
 *  归本中立足（此前寄居 terminalShared=枢总/会议 TDZ 叶，名实漂移+无关路由概念性依赖 terminal* 模块面封死）。
 *  纪律同 terminalShared：纯数据常量，零函数零运行时依赖（环外叶——任何路由可引不构 TDZ 边）。
 */

/** 闸口/意图族表未建提示（R7-c147-③）：st_gate_tickets/st_intents/st_device_rehearsals/st_constitution_amendments
 *  系 sync-iter100.mts（+m2/m3 分批）所建——gate.ts 四站 txInsertId/读面同引（412 指错脚本=运维空跑面封死） */
export const GATE_TABLES_HINT =
  "闸口/意图数据表未初始化，请先在服务器执行 db/sync-iter100.mts（含 -m2/-m3 分批）后再操作";
/** 杂族查询提示（R7-c151-④/R7-c154-⑩）：gate.ts 非 iter100 族表（st_corps=iter91/st_factory_plan=iter92/
 *  st_auto_constitution=iter96/st_device_commands=sync-devices/st_intent_plans=sync-intent-plans 等）——通用指代不冒 sync 名 */
export const GATE_MISC_TABLES_HINT = "闸口相关数据表未初始化——请按缺失表名执行对应的 db/sync-*.mts 迁移脚本后再操作";
/** 基座表提示（R7-c153-⑤/R7-c154-⑩）：wb_users 等平台基座表系 db/schema.ts+drizzle push/migrate 所建——无 sync-*.mts 脚本 */
export const BASE_TABLES_HINT = "平台基座数据表未初始化——基座表由 db/schema.ts + drizzle push/migrate 创建（无 db/sync-*.mts 脚本——查基座部署）";
/** 设备侧表未建提示单源（R7-c143-⑦/R7-c147-② 自 devices.ts/R7-c159-⑤ 暂归 terminalShared/R7-c160-⑥ 归本叶）：
 *  读/写径 412 同引——正确迁移脚本名入文（运维可执行） */
export const DEVICE_TABLES_HINT = "设备侧数据表未初始化，请先在服务器执行 db/sync-devices.mts 后再操作";
