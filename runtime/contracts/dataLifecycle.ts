/**
 * dataLifecycle —— 数据生命周期台账（契约②·彭总拍板：「隐私红线唯一可核形态——新表票必填保留期面」）。
 *
 * 纪律面：
 *  - 本件=SYNC_LOCK 双仓同轨件（wb/portal 共享同一库——台账单源，双仓机器守门）；
 *  - **新表闸**：任何 CREATE TABLE 落代码=本台账必须有同表行（否则闸钉红——新表票必填保留期面的机器化）；
 *  - retentionDays=null=现状永久/未设清理（如实登记——「宣称=实现」：没写清理面就写 none，不许写漂亮数）；
 *  - 台账登记≠清理实现——cleanup 字段写「none」是诚实面；新设清理面的票另走 DDL/真跑证据（契约 §E）。
 */
export type LifecycleRow = {
  table: string;
  dataClass: "会话" | "事件" | "账务" | "凭证" | "配置" | "遥测" | "组织";
  retentionDays: number | null; // null=永久/现状未设（如实面）
  cleanup: string; // 清理机制（none=无——诚实登记）
  note?: string;
};

export const DATA_LIFECYCLE: LifecycleRow[] = [
  { table: "st_beta_daily_codes", dataClass: "凭证", retentionDays: null, cleanup: "none", note: "每日邀测口令（code_text 明文落库=对外公开口令，与 st_beta_invites 的 sha256 纪律不同）+名额与兑换计数——当前未设自动清理" },
  { table: "st_beta_invites", dataClass: "凭证", retentionDays: null, cleanup: "none", note: "内测邀请码（sha256 不落明文[凭证纪律]）——内测期台账长期留" },
  { table: "st_beta_applications", dataClass: "事件", retentionDays: null, cleanup: "none", note: "报名申请流水" },
  { table: "st_buddy_chats", dataClass: "会话", retentionDays: 90, cleanup: "metabolizeLifeChats(life 轨 90 天代谢[wb#99])+clearMyLifeChats 用户手动清", note: "work 轨永久/life 轨 90 天——隐私红线面" },
  { table: "st_cabin_messages", dataClass: "会话", retentionDays: null, cleanup: "none", note: "舱内会话" },
  { table: "st_channel_calls", dataClass: "事件", retentionDays: null, cleanup: "none", note: "支付渠道调用流水" },
  { table: "st_dpo_pairs", dataClass: "组织", retentionDays: null, cleanup: "none", note: "进化偏好对" },
  { table: "st_edge_commands", dataClass: "事件", retentionDays: null, cleanup: "none", note: "边缘节点指令" },
  { table: "st_edge_nodes", dataClass: "配置", retentionDays: null, cleanup: "none", note: "边缘节点登记" },
  { table: "st_evolve_inbox", dataClass: "事件", retentionDays: null, cleanup: "none", note: "进化收件箱" },
  { table: "st_evolve_lessons", dataClass: "组织", retentionDays: null, cleanup: "none", note: "经验课台账" },
  { table: "st_lesson_usage", dataClass: "遥测", retentionDays: null, cleanup: "none", note: "课引用计数" },
  { table: "st_mcp_calls", dataClass: "遥测", retentionDays: null, cleanup: "none", note: "MCP 调用流水" },
  { table: "st_nf_beacons", dataClass: "遥测", retentionDays: null, cleanup: "none", note: "信标面" },
  { table: "st_personal_uploads", dataClass: "会话", retentionDays: null, cleanup: "none", note: "个人上传件登记" },
  { table: "st_push_dispatches", dataClass: "事件", retentionDays: null, cleanup: "none", note: "推送派发流水" },
  { table: "st_qr_rate", dataClass: "遥测", retentionDays: 1, cleanup: "cleanupAdminQrThrottled(db)/cleanupWbQr(db)+60s 双仓后台定时+open/status 内联分前缀清理", note: "admin-qr 分钟桶 10 分钟清；其余桶（含历史裸 IP/__global__）24h 兜底清；键优先 HMAC(RATE_KEY_SECRET)，未配密钥时为可枚举无盐 SHA-256 并告警——全表最长保留 1 日" },
  { table: "st_qr_sessions", dataClass: "凭证", retentionDays: 1, cleanup: "cleanupAdminQr(db)/cleanupWbQr(db)+60s 双仓后台定时+open/status 内联清理", note: "管理台密文 5 分钟销毁、历史行 1 日清；WB 会话按状态/TTL 清理，status 仅惰性过期不删行" },
  { table: "st_recon_reports", dataClass: "事件", retentionDays: null, cleanup: "none", note: "对账报告" },
  { table: "st_referral_ledger", dataClass: "账务", retentionDays: null, cleanup: "none", note: "推荐台账——账务面永久" },
  { table: "st_rental_orders", dataClass: "账务", retentionDays: null, cleanup: "none", note: "租赁订单——账务面永久" },
  { table: "st_sms_mo", dataClass: "事件", retentionDays: null, cleanup: "none", note: "短信上行" },
  { table: "st_sms_outbox", dataClass: "事件", retentionDays: null, cleanup: "none", note: "短信下行" },
  { table: "st_sms_reports", dataClass: "事件", retentionDays: null, cleanup: "none", note: "短信回执" },
  { table: "st_split_rules", dataClass: "配置", retentionDays: null, cleanup: "none", note: "分账规则" },
  { table: "st_spirit_tool_grants", dataClass: "配置", retentionDays: null, cleanup: "none", note: "企业与用户技能启停授权——按 factory_id+user_id+tool_key 隔离，当前未设自动清理" },
  { table: "st_training_jobs", dataClass: "组织", retentionDays: null, cleanup: "none", note: "部门订阅包训练、评测与上架任务——当前未设自动清理" },
  { table: "st_vp_challenges", dataClass: "凭证", retentionDays: null, cleanup: "none", note: "声纹挑战串" },
  { table: "st_vp_gate_fails", dataClass: "遥测", retentionDays: null, cleanup: "none", note: "声纹闸失败面" },
  { table: "wb_voiceprints", dataClass: "凭证", retentionDays: null, cleanup: "none", note: "声纹注册面" },
  { table: "nh_recommend_queries", dataClass: "遥测", retentionDays: null, cleanup: "none", note: "导购留痕（命名面：nh_ 前缀在 wb 库=命名约定滑——登记不掩）" },
];
