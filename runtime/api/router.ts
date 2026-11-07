import { createRouter, publicQuery } from "./middleware";
import { isAdminDeploy } from "./lib/deployRole";
import { agentsRouter } from "./routers/agents";
import { hireRouter } from "./routers/hire";
import { buyerCenterRouter } from "./routers/buyerCenter";
import { betaApplyRouter } from "./routers/betaApply";
import { betaDailyRouter } from "./routers/betaDaily"; // 每日口令兑专属邀测码（彭总 2026-10-23 令——双仓同轨面：wb 仓同件）
import { adminDailyRouter } from "./routers/adminDaily";
import { adminReleaseRouter } from "./routers/adminRelease";
import { adminQrLoginRouter } from "./routers/adminQrLogin";
import { adminTrainingRouter } from "./routers/adminTraining";
import { trialsRouter } from "./routers/trials";
import { tasksRouter } from "./routers/tasks";
import { pricingRouter } from "./routers/pricing";
import { settlementRouter } from "./routers/settlement";
import { memoriesRouter } from "./routers/memories";
import { recruitmentsRouter } from "./routers/recruitments";
import { skillsRouter } from "./routers/skills";
import { authRouter } from "./auth-router";
import { workbenchLinkRouter } from "./routers/workbenchLink";
import { mastersRouter } from "./routers/masters";
import { applicationsRouter } from "./routers/applications";
import { reviewRouter } from "./routers/review";
import { agenticRouter } from "./routers/agentic";
import { nebulaLinkRouter } from "./routers/nebulaLink";
import { workbenchMarketRouter } from "./routers/workbenchMarket";
import { harnessRouter } from "./routers/harness";
import { showroomPortalRouter } from "./routers/showroomPortal";
import { evolutionMemoryRouter } from "./routers/evolutionMemory";
import { evolutionIdentityRouter } from "./routers/evolutionIdentity";
import { evolutionToolsRouter } from "./routers/evolutionTools";
import { evolutionAutonomyRouter } from "./routers/evolutionAutonomy";
import { assistantRouter } from "./routers/assistant";
import { modelGatewayRouter } from "./routers/modelGateway";
import { developerRouter } from "./routers/developer";
import { leaderboardRouter } from "./routers/leaderboard";
import { tokenEconomyRouter } from "./routers/tokenEconomy";
import { adminRouter } from "./routers/admin";
import { terminalRouter } from "./routers/terminal";
import { staffRouter } from "./routers/staff";
import { kbRouter } from "./routers/kb";
import { wechatRouter } from "./routers/wechat";
import { wbOrgRouter } from "./routers/wbOrg";
import { packagesRouter } from "./routers/packages";
import { opsCenterRouter } from "./routers/opsCenter";
import { clawRouter } from "./routers/claw";
import { corpsRouter } from "./routers/corps";
import { approvalsRouter } from "./routers/approvals";
import { financeRouter } from "./routers/finance";
import { memoryRouter } from "./routers/memory";
import { evoRouter } from "./routers/evo";
import { skillShopRouter } from "./routers/skillShop";
import { adminAnalyticsRouter } from "./routers/adminAnalytics";
import { adminAuthRouter } from "./routers/adminAuth";
import { nebulaHarnessRouter } from "./harness/router";
import { opsTicketsRouter } from "./routers/opsTickets";
import { opsRecommendRouter } from "./routers/opsRecommend";
import { wbProfileRouter } from "./routers/wbProfile";
import { wbInvitesRouter } from "./routers/wbInvites";
import { wbPairRouter } from "./routers/wbPair";
import { wbAssetsRouter } from "./routers/wbAssets";
import { wbCareerRouter } from "./routers/wbCareer";
import { wbMemoryRouter } from "./routers/wbMemory";
import { wbProactiveRouter } from "./routers/wbProactive";
import { wbCallsRouter } from "./routers/wbCalls";
import { wbRoomsRouter } from "./routers/wbRooms";
import { wbFilesRouter } from "./routers/wbFiles";
import { wbBillingRouter } from "./routers/wbBilling";
import { agreementRouter, sandboxRouter } from "./routers/sandbox";
import { billingRouter } from "./routers/billing";
import { corpsBoardRouter, marketRouter } from "./routers/skillMarket";
import { voiceBuddyRouter } from "./routers/voiceBuddy";
import { spiritIntentRouter } from "./routers/spiritIntent"; // 恢复挂载[portal#72 阻断 B1——文件救回了挂载没补=孤儿端点面封死]
import { voiceRouter } from "./routers/voice";
import { guidedFormRouter } from "./routers/guidedForm";
import { releasesRouter } from "./routers/releases";
import { agentReviewRouter, agentReviewQueueRouter } from "./routers/agentReview";
import { deptConsoleRouter } from "./routers/deptConsole";
import { identityBindingRouter } from "./routers/identityBinding";
import { reportBusRouter } from "./routers/reportBus";
import { deptCustomRouter } from "./routers/deptCustom";
import { personalAgentRouter } from "./routers/personalAgent";
import { entAgentRouter } from "./routers/entAgent";
import { deviceMcpRouter } from "./routers/deviceMcp";
import { nebulaScreenRouter } from "./routers/nebulaScreen";
import { partnerRouter } from "./routers/partner";
import { hireOrdersRouter } from "./routers/hireOrders";
import { todoCenterRouter } from "./routers/todoCenter";
import { dshBridgeRouter } from "./routers/dshBridge";
import { entCabinRouter } from "./routers/entCabin";
import { internalOpsRouter } from "./routers/internalOps";
import { userAuditRouter } from "./routers/userAudit";
import { crashReportRouter } from "./routers/crashReport";
import { modelEvalRouter } from "./routers/modelEval";
import { deptRingRouter } from "./harness/deptRing";
import { pluginStoreRouter } from "./routers/pluginStore";
import { skillPacksRouter } from "./routers/skillPacks";
import { dagRunsRouter } from "./routers/dagRuns";
import { devicePluginsRouter } from "./routers/devicePlugins";
import { mcpBridgeRouter } from "./routers/mcpBridge";
import { voiceMediaRouter } from "./routers/voiceMedia";
import { walletPayRouter } from "./routers/walletPay";
import { splitRulesRouter } from "./routers/splitRules";
import { evolveRouter } from "./routers/evolveAudit";
import { evolveActivateRouter } from "./routers/evolveActivate";
import { evolveDistillRouter } from "./routers/evolveDistill";
import { evolvePostRouter } from "./routers/evolvePost";
import { rentalRouter } from "./routers/rental";
import { reconRouter } from "./routers/recon";
import { edgeNodeRouter } from "./routers/edgeNode";
import { paymentChannelRouter } from "./routers/paymentChannel";
import { agentTrainingReviewRouter, agentTrainingRouter, agentWorkRouter } from "./routers/agentEmployment";
import { agentPluginsRouter } from "./routers/agentPlugins";
import { agentPluginPaymentsRouter } from "./routers/agentPluginPayments";
import { wechatPaymentsEnabled } from "./lib/wechatPayV2";
import { agentMarketLiveRouter } from "./routers/agentMarketLive";
import { userModeRouter } from "./routers/userMode";
import { cabinTalkRouter } from "./routers/cabinTalk";
import { meetRoomRouter } from "./routers/meetRoom";
import { clientLogRouter } from "./routers/clientLog";
import { evoSignalsRouter } from "./routers/evoSignals";
import { wbAccountRouter } from "./routers/wbAccount";
import { plannerRouter } from "./routers/planner";
import { adminAiRouter } from "./routers/adminAi";
import { autoEngineRouter } from "./routers/autoEngine";
import { gateRouter } from "./routers/gate";
import { dshGovernanceRouter } from "./routers/dshGovernance";
import { memoryArchiveRouter } from "./routers/memoryArchive";
import { releaseCenterRouter } from "./routers/releaseCenter";
import { evoArmRouter } from "./routers/evoArm";
import { devicesRouter } from "./routers/devices";
import { smsRouter } from "./routers/sms";

/** 部署角色面（彭总 2026-10-20 令——公网挂载面按角色收口）：公网服务（3470）不挂内管 API 面
 *  （admin/opsCenter/gate/dshGovernance 等 22 面——公网攻击暴露面收口[settlement 闸同族纪律]）。
 *  NEBULA_DEPLOY_ROLE=admin（admin 部署 3472）=全树照挂；缺省/public=内管面 404 不存在。 */
const IS_ADMIN_ROLE = isAdminDeploy();

/** 内管面挂载组（仅 admin 角色挂——公开面零调用实证[门户双核审面]） */
const ADMIN_MOUNTS = {
  agentTrainingReview: agentTrainingReviewRouter,
  admin: adminRouter,
  adminAi: adminAiRouter,
  adminAnalytics: adminAnalyticsRouter,
  adminAuth: adminAuthRouter,
  adminDaily: adminDailyRouter,
  adminRelease: adminReleaseRouter,
  adminQr: adminQrLoginRouter,
  adminTraining: adminTrainingRouter,
  agentMemory: memoryRouter,
  agentReview: agentReviewRouter,
  agentReviewQueue: agentReviewQueueRouter,
  approvals: approvalsRouter,
  deptConsole: deptConsoleRouter,
  evo: evoRouter,
  finance: financeRouter,
  gate: gateRouter,
  modelGateway: modelGatewayRouter,
  nebulaHarness: nebulaHarnessRouter,
  opsCenter: opsCenterRouter,
  opsRecommend: opsRecommendRouter,
  opsTickets: opsTicketsRouter,
  pluginStore: pluginStoreRouter,
  releases: releasesRouter,
  wbBilling: wbBillingRouter,
  wbFiles: wbFilesRouter,
  wechat: wechatRouter,
};

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  auth: authRouter,

  agents: agentsRouter,
  hire: hireRouter,
  buyerCenter: buyerCenterRouter,
  betaApply: betaApplyRouter,
  betaDaily: betaDailyRouter,
  trials: trialsRouter,
  tasks: tasksRouter,
  pricing: pricingRouter,
  settlement: settlementRouter,
  memories: memoriesRouter,
  recruitments: recruitmentsRouter,
  skills: skillsRouter,
  workbenchLink: workbenchLinkRouter,
  masters: mastersRouter,
  applications: applicationsRouter,
  review: reviewRouter,
  agentic: agenticRouter,
  nebulaLink: nebulaLinkRouter,
  workbenchMarket: workbenchMarketRouter,
  showroomPortal: showroomPortalRouter,

  // 后端自进化能力（evo：记忆/反思/身份/工具/自主循环）
  memory: evolutionMemoryRouter,
  identity: evolutionIdentityRouter,
  tools: evolutionToolsRouter,
  autonomy: evolutionAutonomyRouter,

  assistant: assistantRouter,

  developer: developerRouter,
  leaderboard: leaderboardRouter,
  tokenEconomy: tokenEconomyRouter,

  // NumX Max 超级终端（迭代 17 Stage 3，VITE_NEBULA_MODE=admin 变体）

  terminal: terminalRouter,

  // DeepSeek Harness 插件仓代理（App 超市 DSH 货源；App 永不直连 GitHub，统一服务端收口）
  harness: harnessRouter,

  // 部门账号分发体系 + 部门独立工作台（迭代 19：st_staff_accounts，nt_ 单点 token）
  staff: staffRouter,

  // 企业知识库（迭代 20：st_kb_docs，供智能客服/驻部智能体引用）
  kb: kbRouter,

  // 对外智能客服（迭代 20：微信公众号/服务号，st_wechat_config + /api/wechat/callback）

  wbOrg: wbOrgRouter,

  // 套餐售卖（迭代 27：五套餐目录/下单/认领码/企业权益，pkg_ 表 raw SQL）
  packages: packagesRouter,

  // 运营中心（迭代 27：访问日志/IP 封锁/安全报告/漏洞扫描/客服配置）

  claw: clawRouter,

  // 熊猫军团流水线（iter91：行业编制组建/训练/毕业驻场）
  corps: corpsRouter,


  skillShop: skillShopRouter,

  // 管理后台数据分析 + 运营工单 + 审计（迭代 35 批次A，API-CONTRACT-v6）





  wbInvites: wbInvitesRouter,

  // M17 扫码绑设备（pd_ 配对码 + dt_ 设备凭证 + 终端台账）（通讯录面随 wbContacts 摘除[portal#72]——本行只留 wbPair 活面）
  wbPair: wbPairRouter,

  // M21 数字职业档案（本人授权驱动：my/share/revoke/orgView + 入编离职钩子）
  wbCareer: wbCareerRouter,

  // M22a 通用设备资产台账（App 扫码：lookup 第一跳 / register 幂等登记 / list / retire 仅 admin）
  wbAssets: wbAssetsRouter,

  // M23a 数字人记忆（myMemories/forget；写入口径在 voice 三通道）+ M23b 主动服务（poll/markRead）
  wbMemory: wbMemoryRouter,
  wbProactive: wbProactiveRouter,

  // M26 v1.4.0 呼叫信令（成员 1v1 音视频 invite/accept/reject/hangup + 灵枢来电；UserSig 仅服务端签发）
  wbCalls: wbCallsRouter,

  // M30 班组语音房（腾讯会议式：人与多 Agent 同席；TRTC 群组房 + agentBridge 应答房流）
  wbRooms: wbRoomsRouter,

  // M31 工作台附件中心（文件/图片/附件统一入口；企业隔离+类型白名单+8MB 上限）

  wbProfile: wbProfileRouter,

  sandbox: sandboxRouter,
  agreement: agreementRouter,
  billing: billingRouter,
  market: marketRouter,
  corpsBoard: corpsBoardRouter,

  // iter93 灵枢/星云语音助手（情绪识别+回复生成单次 LLM，rate/pitch 后端映射）
  voiceBuddy: voiceBuddyRouter,
  spiritIntent: spiritIntentRouter, // 恢复挂载（同 B1——端点面恢复：APP 端据此出动作卡）

  // iter96 自主运行引擎（信号宪法 A/B/C/D + 异常控制台 + 技能适应度榜）
  autoEngine: autoEngineRouter,

  // iter100 组织中枢闸门（具名协议/双签票据/WAL/授权链/冻结协议）

  dshGovernance: dshGovernanceRouter,
  memoryArchive: memoryArchiveRouter,

  // M51 超级终端系统更新机制（四端版本台账/五道闸流水线/C 级双签票据/审计/AI 更新执行官席）
  releaseCenter: releaseCenterRouter,

  // M58 执行官施工臂（沙箱演练闸 EVO_ARM_ENABLED；draft 限定；/tmp 隔离工作区；mock/codex 双执行器；审计落 st_release_audit）
  evoArm: evoArmRouter,

  // M7-c 语音入口 V1（语音即意图，同权同闸；C 级复述确认；全程审计）
  voice: voiceRouter,

  // M24 对话式引导填写引擎（剧本 JSON+会话状态机；confirm 才写库，复用 wbAssets.register 契约）
  guidedForm: guidedFormRouter,

  // Harness 交付装配线·发布观测板（只读：制品仓库/发布流水/live md5/回滚指引）


  // requireAdmin + reviewedAt/reviewedBy/rejectReason 留痕 + st_admin_audit；决策台第 5 组待办数据源）


  identityBinding: identityBindingRouter,
  reportBus: reportBusRouter,
  deptCustom: deptCustomRouter,
  personalAgent: personalAgentRouter,
  agentTraining: agentTrainingRouter,
  agentWork: agentWorkRouter,
  agentPlugins: agentPluginsRouter,
  ...(wechatPaymentsEnabled() ? { agentPluginPayments: agentPluginPaymentsRouter } : {}),
  agentMarketLive: agentMarketLiveRouter,
  entAgent: entAgentRouter,
  deviceMcp: deviceMcpRouter,
  nebulaScreen: nebulaScreenRouter,
  partner: partnerRouter,
  hireOrders: hireOrdersRouter,
  todoCenter: todoCenterRouter,
  dshBridge: dshBridgeRouter,
  entCabin: entCabinRouter,
  internalOps: internalOpsRouter,
  userAudit: userAuditRouter,
  crashReport: crashReportRouter,
  modelEval: modelEvalRouter,
  deptRing: deptRingRouter, // M80 小环拍板

  skillPacks: skillPacksRouter,

  // M33 Agent DAG 任务编排（目标→拆步→多智能体接力执行；立即返回+轮询终态+断点续跑）
  dagRuns: dagRunsRouter,

  // M35 账号注销（PIPL 硬项：PII 真匿名化；企业管理员/在企成员先离企）
  wbAccount: wbAccountRouter,

  // M7-d 集群规划骨架（AI 拆解目标 → 具名协议组合 → 元意图过闸，规划/执行物理分离）
  planner: plannerRouter,

  // M7-e S3 管理终端 AI 原生化（灵枢值守台晨报/追问 + NL 评审指令 + 规划器监管看板）

  devices: devicesRouter,

  // M37 万物皆可插件（扫一扫生产设备→模板化生成控制插件；读 B 级直接，控 C 级双签票据；
  // 同一 manifest 由 DSH 底座 MCP 面发布为 mcp__lingshu_devices__* 工具）
  devicePlugins: devicePluginsRouter,

  // M38 技能插件上总线（S2 内部桥：MCP 面工具执行回主栈，同执行器同预算同记账；
  // 内部令牌时序安全校验，仅隧道可达）
  mcpBridge: mcpBridgeRouter,

  // M40 云端语音双引擎（服务端 ASR sherpa+误听归一 / 服务端 TTS agent-gw+缓存；
  // 端侧只留麦和喇叭，任意国产 ROM 可用）
  voiceMedia: voiceMediaRouter,

  // M45 Agent 支付闭环（供给侧钱包真入账 + 提现管线 + 流水台账；
  // 出金复核 admin 双人留痕，真实清算通道挂债待牌照）
  walletPay: walletPayRouter,
  splitRules: splitRulesRouter,
  evolve: evolveRouter,
  evolveActivate: evolveActivateRouter,
  evolveDistill: evolveDistillRouter,
  evolvePost: evolvePostRouter,
  rental: rentalRouter,
  recon: reconRouter,
  edgeNode: edgeNodeRouter,
  paymentChannel: paymentChannelRouter,
  userMode: userModeRouter,
  cabinTalk: cabinTalkRouter,
  meetRoom: meetRoomRouter,

  // M46 客户端信标（无鉴权设备级，闪退取证专用；payload 无 PII）
  clientLog: clientLogRouter,

  // M45 自进化信号总线 E1（客户端/服务端异常统一上报；匿名限 crash 类+软顶）
  evoSignals: evoSignalsRouter,

  // M25 手机短信注册通道（阿里云 SendSms 零依赖签名；验证码 sha256 落库，统一 ok 不泄露）
  sms: smsRouter,
  ...(IS_ADMIN_ROLE ? ADMIN_MOUNTS : {}),

});

export type AppRouter = typeof appRouter;
