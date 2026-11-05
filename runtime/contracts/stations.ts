/**
 * 队列舱（九席）典序双端单源（批七 R7-c4-③/R7-c8-② 标题钉准：本表=九席队列舱，「十舱」含舱上之舱不占本表——勿因名补第十码）：站码 STATION_CODES 原在 api/routers/internalOps.ts（服务端），
 *  StationQueues.TABS 与 AdminLayout.StationKey 各持一份——三面手抄必漂移。
 *  收编 contracts 层：服务端 internalOps 与前端 AdminLayout/StationQueues 同引，改序/增舱=改本表，三侧编译期互锁。
 *  典序（彭总定调 2026-08-30，十舱补齐 2026-09-05）：更新→市场→财务→运行→运营→法务→品牌→渠道→文化知识。
 *  口径钉准（R7-c5-④）：队列舱九席（本表）；「十舱」含舱上之舱（总经理驾驶舱，不占队列 tab 位）——两数分工，勿对不齐时互改。
 */
export const STATION_CODES = Object.freeze(["x_rel", "x_mkt", "x_fin", "x_ops", "x_runops", "x_law", "x_brand", "x_ch", "x_know"] as const);
export type StationCode = (typeof STATION_CODES)[number];

/** 舱展示元数据单源（R7-c9-④）：AdminLayout.NAV_STATION_DEFS 与 StationQueues.TAB_META 两份手维护同收本表——
 *  label/color 漂移不再靠人脑同步（lockstep 测试已改为断言两侧同引本表，色值不一致即红）。
 *  双配色是有意的：侧栏色缀（admin）与队列页配色（queue）系不同语境，单源各持一值。
 */
export const STATION_UI = {
  x_rel: { label: "更新舱", sidebarSuffix: "· 进化发布", adminColor: "text-amber-300/80", queueColor: "text-forge-amber" },
  x_mkt: { label: "市场舱", sidebarSuffix: "· 超市运营", adminColor: "text-pink-300/80", queueColor: "text-pink-300" },
  x_fin: { label: "财务舱", sidebarSuffix: "· 账房", adminColor: "text-yellow-300/80", queueColor: "text-yellow-300" },
  x_ops: { label: "运行舱", sidebarSuffix: "· 系统健康", adminColor: "text-emerald-300/80", queueColor: "text-emerald-300" },
  x_runops: { label: "运营舱", sidebarSuffix: "· 运营与经营", adminColor: "text-teal-300/80", queueColor: "text-teal-300" },
  x_law: { label: "法务舱", sidebarSuffix: "· 备案合规", adminColor: "text-sky-300/80", queueColor: "text-sky-300" },
  x_brand: { label: "品牌舱", sidebarSuffix: "· 品牌与客服", adminColor: "text-rose-300/80", queueColor: "text-rose-300" },
  x_ch: { label: "渠道舱", sidebarSuffix: "· 用户与合伙人", adminColor: "text-indigo-300/80", queueColor: "text-indigo-300" },
  x_know: { label: "文化知识舱", sidebarSuffix: "· 品牌人格", adminColor: "text-violet-300/80", queueColor: "text-violet-300" },
} as const satisfies Record<StationCode, { label: string; sidebarSuffix: string; adminColor: string; queueColor: string }>;

/** 默认舱码（R7-c11-②）：URL 兜底等「非码回默认」场景默认值单源——StationQueues 两处裸 'x_ops' 字面量收编本常量 */
export const DEFAULT_STATION: StationCode = "x_ops";

/** 站元映射工厂（R7-c11-③）：Record<StationCode, T> 的键集与 as 载重习语单点——AdminLayout.NAV_STATION_DEFS 与
 *  StationQueues.TAB_META 同引本厂（两页形状不再各抄一份 fromEntries+as）；漏键真闸在 STATION_UI satisfies 全键必填 */
export function stationMetaMap<T>(pick: (ui: (typeof STATION_UI)[StationCode]) => T): Record<StationCode, T> {
  return Object.fromEntries(STATION_CODES.map((c) => [c, pick(STATION_UI[c])])) as Record<StationCode, T>;
}
