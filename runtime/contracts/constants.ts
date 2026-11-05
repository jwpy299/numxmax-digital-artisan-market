export const Session = {
  cookieName: "kimi_sid",
  maxAgeMs: 365 * 24 * 60 * 60 * 1000,
} as const;

export const ErrorMessages = {
  unauthenticated: "Authentication required",
  insufficientRole: "Insufficient permissions",
} as const;

export const Paths = {
  login: "/login",
  healthz: "/api/healthz", // P1-4 门户独有面（深健康探测路径——ops/nginx 引[搬链合并面：portal 独有保留]）
  oauthCallback: "/api/oauth/callback",
  adminQrImage: "/api/admin-qr",
  teamProgress: "/api/team-progress", // 工程团队进度面（彭总令 2026-10-05）
  teamProgressStream: "/api/team-progress/stream", // SSE 实时流（EventSource GET 例外面）
} as const;

/** 灵智枢公司名（R7-c105-②/R7-c106-④/R7-c114-① 措辞收窄）：本常量=【HQ 闸话术缺省】单源——其余域文案（wechat/terminal 提示词等）未迁、不归本常量管（不谎称全域同引）；env HQ_COMPANY_NAME 可覆盖 HQ 闸话术；
 *  本字面量=在产现值兼缺省（记录级常量——env 未配时的话术即它；改公司名=改本行+配 env，双通道显式） */
export const HQ_COMPANY_NAME_DEFAULT = "广东灵智枢生态科技有限公司";

export const TicketList = {
  pageSize: 20,
} as const; // 工单列表页尺寸双端单源（OCR R100-4）：服务端 LIMIT 与前端 maxPage/满页探针同引——此前两侧各持字面值 20，单边改即分页静默分叉
