/**
 * adminStations —— 超终舱码/队列默认舱单源（门禁 PR#28 R14 票②③）：
 * DEFAULT_STATION_TAB 与提案拍板舱 STATION_TAB_EVOL 统一收口本文件——
 * AdminLayout / StationQueues / Cockpit 同引，layout 不再 import page 组件模块。
 */
/** 舱码九席=契约件单源（contracts/stations STATION_CODES——服务端 internalOps 同引[双端单源面补全：NumX portal#85 残留②「只完成服务端一半」收口]）；
 *  x_misc=导航防丢分组标记非真舱，不属 API 码表（本件自留）。具名导出保鲜（消费面零改）。 */
import { STATION_CODES, DEFAULT_STATION } from '@contracts/stations'
export const STATION_CODE_REL = STATION_CODES[0]
export const STATION_CODE_MKT = STATION_CODES[1]
export const STATION_CODE_FIN = STATION_CODES[2]
export const STATION_CODE_OPS = STATION_CODES[3]
export const STATION_CODE_RUNOPS = STATION_CODES[4]
export const STATION_CODE_LAW = STATION_CODES[5]
export const STATION_CODE_BRAND = STATION_CODES[6]
export const STATION_CODE_CH = STATION_CODES[7]
export const STATION_CODE_KNOW = STATION_CODES[8]
export const STATION_CODE_MISC = 'x_misc'

export const DEFAULT_STATION_TAB = DEFAULT_STATION // 契约件单源（=x_ops——DEFAULT_STATION 同码面）
/** 提案拍板面=更新舱队列（与 api/routers/internalOps QUEUE_STATION.proposal → x_rel 同码） */
export const STATION_TAB_EVOL = STATION_CODE_REL

/** 队列页路径单源（R23 票②） */
export const ROUTE_ADMIN_STATIONS = '/admin/stations'

/** 舱队列链接单源组装（R18 票②：AdminLayout/Cockpit 同引，模板不再两处手写） */
export function stationQueueUrl(id: string): string {
  return `${ROUTE_ADMIN_STATIONS}?tab=${encodeURIComponent(id)}` // R26 票③：参数 encode（仓惯例同 InternalHome）
}

/** 耦合钉（门禁 R17 票⑤）：StationQueues.TABS 的 tab 键必须与本文件舱码同步——
 *  AdminLayout 队列链接与本常量组同源组装；TABS 键改名/新增时同步本文件。
 *  （挪 TABS 进本 lib 为更大单源化工程，挂账 P-STATION-TABS-SINGLE。） */

/** 拍板三条路由单源（R20 票②：Cockpit BoardLink 与 AdminLayout NAV_ITEMS 同径——改名单点） */
export const ROUTE_ADMIN_APPROVALS = '/admin/approvals'
export const ROUTE_ADMIN_PROTOCOLS = '/admin/protocols'
export const ROUTE_ADMIN_KNOWLEDGE = '/admin/knowledge'
export const ROUTE_ADMIN_WECHAT_CS = '/admin/wechat-cs'
/** P2-4 待审员工审核队列（决策台第 5 组待办 → 本页；Cockpit BoardLink 与 AdminLayout NAV 同径单源） */
export const ROUTE_ADMIN_AGENT_REVIEW_QUEUE = '/admin/agent-review-queue'
/** 个人 Agent 隔离训练独立复核队列。 */
export const ROUTE_ADMIN_AGENT_TRAINING_REVIEW_SEGMENT = 'agent-training-review'
export const ROUTE_ADMIN_AGENT_TRAINING_REVIEW = `/admin/${ROUTE_ADMIN_AGENT_TRAINING_REVIEW_SEGMENT}`
