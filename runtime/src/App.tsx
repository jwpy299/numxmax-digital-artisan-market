import { useEffect } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router'
import Layout from '@/components/Layout'
import { WB_ONLY, WB_SITE_TITLE, ADMIN_ONLY, ADMIN_SITE_TITLE, ADMIN_LOGIN_PATH } from '@/lib/buildMode'
import { ROUTE_AGENT_EMPLOYMENT_SEGMENT } from '@/lib/portalRoutes'
import { ROUTE_ADMIN_AGENT_TRAINING_REVIEW_SEGMENT } from '@/lib/adminStations'
import Home from '@/pages/Home'
import Market from '@/pages/Market'
import AgentDetail from '@/pages/AgentDetail'
import Workbench from '@/pages/Workbench'
import AgentEmployment from '@/pages/AgentEmployment'
import AgentTrainingReview from '@/pages/admin/AgentTrainingReview'
import Enterprise from '@/pages/Enterprise'
import Masters from '@/pages/Masters'
import MasterDetail from '@/pages/MasterDetail'
import AdminReview from '@/pages/AdminReview'
import InternalHome from '@/pages/InternalHome'
import EntCabins from '@/pages/EntCabins'
import StationQueues from '@/pages/admin/StationQueues'
import Lifecycle from '@/pages/Lifecycle'
import Pricing from '@/pages/Pricing'
import Packages from '@/pages/Packages'
import Architecture from '@/pages/Architecture'
import Roadmap from '@/pages/Roadmap'
import Login from "./pages/Login"
import GetApp from "./pages/GetApp"
import GetDesktop from "./pages/GetDesktop"
import BuyerCenter from "./pages/BuyerCenter"
import HelpCenter from "./pages/HelpCenter"
import Certified from "./pages/Certified"
import ApplyBeta from "./pages/ApplyBeta"
import AdminBeta from "./pages/admin/AdminBeta"
import Developers from "@/pages/Developers"
import LeaderboardPage from "@/pages/Leaderboard"
import TokenPage from "@/pages/Token"
import NotFound from "./pages/NotFound"
import TermsPage from "@/pages/legal/TermsPage"
import PrivacyPage from "@/pages/legal/PrivacyPage"
import TradeRulesPage from "@/pages/legal/TradeRulesPage"
import WbBridge from "@/pages/wb/WbBridge"
import AssistantWidget from "@/components/AssistantWidget"
import MechaEntrance from "@/components/digitalhuman/MechaEntrance"
import AdminLogin from "@/pages/admin/AdminLogin"
import AdminLayout from "@/pages/admin/AdminLayout"
import AdminUsers from "@/pages/admin/Users"
import AdminFactories from "@/pages/admin/Factories"
import AdminAgents from "@/pages/admin/Agents"
import AdminRecruitments from "@/pages/admin/Recruitments"
import AdminOrders from "@/pages/admin/Orders"
import AdminTokens from "@/pages/admin/Tokens"
import AdminDevs from "@/pages/admin/Devs"
import AdminSystem from "@/pages/admin/System"
import AdminReleases from "@/pages/admin/Releases"
import AdminAgentReview from "@/pages/admin/AgentReview"
import AdminAgentReviewQueue from "@/pages/admin/AgentReviewQueue"
import AdminApprovals from "@/pages/admin/Approvals"
import AdminFinance from "@/pages/admin/Finance"
import AdminMemory from "@/pages/admin/Memory"
import AdminOps from "@/pages/admin/Ops"
import AdminSecurity from "@/pages/admin/Security"
import AdminVulns from "@/pages/admin/Vulns"
import AdminCsCenter from "@/pages/admin/CsCenter"
import AdminCockpit from "@/pages/admin/Cockpit"
import AdminDepartments from "@/pages/admin/Departments"
import AdminDeptConsoles from "@/pages/admin/DeptConsoles"
import AdminPluginStore from "@/pages/admin/PluginStore"
import AdminMeetingRoom from "@/pages/admin/MeetingRoom"
import AdminPandaBoard from "@/pages/admin/PandaBoard"
import AdminSandboxMonitor from "@/pages/admin/SandboxMonitor"
import AdminProtocols from "@/pages/admin/Protocols"
import AdminStaffAccounts from "@/pages/admin/StaffAccounts"
import AdminKnowledge from "@/pages/admin/Knowledge"
import AdminWechatCs from "@/pages/admin/WechatCs"
import AdminSkills from "@/pages/admin/Skills"
import AdminSkillShop from "@/pages/admin/SkillShopAdmin"
import AdminAnalytics from "@/pages/admin/Analytics"
import AdminFactoryHealth from "@/pages/admin/FactoryHealth"
import AdminEvoBoard from "@/pages/admin/EvoBoard"
import AdminAuditLog from "@/pages/admin/AuditLog"
import AdminTickets from "@/pages/admin/Tickets"
import AdminRecommend from "@/pages/admin/Recommend"
import AdminGodView from "@/pages/admin/GodView"
import AdminWall from "@/pages/admin/Wall"
import AdminTopups from "@/pages/admin/AdminTopups"
import AdminClawWhitelist from "@/pages/admin/ClawWhitelist"
import AdminCorpsList from "@/pages/admin/CorpsList"
import AdminClawTiers from "@/pages/admin/ClawTiers"
import AdminPlans from "@/pages/admin/Plans"
import AdminMarketReview from "@/pages/admin/MarketReview"
import AdminAlerts from "@/pages/admin/Alerts"
import StaffLogin from "@/pages/staff/StaffLogin"
import StaffWorkspace from "@/pages/staff/StaffWorkspace"

export default function App() {
  const { pathname } = useLocation()
  // 独立部署包站点标题：admin 变体优先，其次 workbench 变体
  useEffect(() => {
    if (ADMIN_ONLY) document.title = ADMIN_SITE_TITLE
    else if (WB_ONLY) document.title = WB_SITE_TITLE
  }, [])

  // NumX Max 超级终端独立部署包（VITE_NEBULA_MODE=admin，迭代 17 Stage 3）：
  // `/` 重定向 /admin/login；仅保留 /admin/* 与 /login，其余一律重定向 /admin/login；
  // 不渲染门户 Layout/Navbar（AdminLayout 自带导航）。
  if (ADMIN_ONLY) {
    return (
      <Routes>
        <Route path="/" element={<Navigate to={ADMIN_LOGIN_PATH} replace />} />
        <Route path="/login" element={<Login />} />
        <Route path={ADMIN_LOGIN_PATH} element={<AdminLogin />} />
        {/* M37：超级终端 SSO 消费端（与工作台同一座桥；消费后落 /admin） */}
        <Route path="/wb/bridge" element={<WbBridge />} />
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<AdminCockpit />} />
          <Route path="approvals" element={<AdminApprovals />} />
          <Route path="internal" element={<InternalHome />} />
          <Route path="stations" element={<StationQueues />} />
          <Route path="cabins" element={<EntCabins />} />
          <Route path="finance" element={<AdminFinance />} />
          <Route path="memory" element={<AdminMemory />} />
          <Route path="users" element={<AdminUsers />} />
          <Route path="factories" element={<AdminFactories />} />
          {/* iter91：龙虾租户化 + 熊猫军团流水线 */}
          <Route path="claw-whitelist" element={<AdminClawWhitelist />} />
          <Route path="corps" element={<AdminCorpsList />} />
          <Route path="claw-tiers" element={<AdminClawTiers />} />
          {/* iter92：套餐管理 / 技能审核 / 告警日志 */}
          <Route path="plans" element={<AdminPlans />} />
          <Route path="market-review" element={<AdminMarketReview />} />
          <Route path="alerts" element={<AdminAlerts />} />
          <Route path="agents" element={<AdminAgents />} />
          <Route path="recruitments" element={<AdminRecruitments />} />
          <Route path="orders" element={<AdminOrders />} />
          <Route path="tokens" element={<AdminTokens />} />
          <Route path="devs" element={<AdminDevs />} />
          {/* 迭代 27：运营监控与安全治理 */}
          <Route path="ops" element={<AdminOps />} />
          <Route path="beta" element={<AdminBeta />} />
          <Route path="security" element={<AdminSecurity />} />
          <Route path="vulns" element={<AdminVulns />} />
          <Route path="skills" element={<AdminSkills />} />
          {/* 迭代 31：技能商店管理 */}
          <Route path="skill-shop" element={<AdminSkillShop />} />
          <Route path="cs-center" element={<AdminCsCenter />} />
          <Route path="system" element={<AdminSystem />} />
          <Route path="releases" element={<AdminReleases />} />
          <Route path="agent-review" element={<AdminAgentReview />} />
          {/* P2-4（台账 W3）：待审员工审核流水线（pending 队列 → 逐条通过/驳回 + 留痕） */}
          <Route path="agent-review-queue" element={<AdminAgentReviewQueue />} />
          <Route path={ROUTE_ADMIN_AGENT_TRAINING_REVIEW_SEGMENT} element={<AgentTrainingReview />} />
          {/* 迭代 35：经营分析 / 企业健康 / 进化看板 / 审计日志（adminAnalytics.*） */}
          <Route path="analytics" element={<AdminAnalytics />} />
          <Route path="health" element={<AdminFactoryHealth />} />
          <Route path="evo-board" element={<AdminEvoBoard />} />
          <Route path="audit" element={<AdminAuditLog />} />
          {/* 迭代 35 批次B：客服工单 / 推荐位运营 / 只读上帝视角 */}
          <Route path="tickets" element={<AdminTickets />} />
          {/* 迭代 34：Token 充值处理（wbBilling.*） */}
          <Route path="topups" element={<AdminTopups />} />
          <Route path="recommend" element={<AdminRecommend />} />
          <Route path="god/:factoryId" element={<AdminGodView />} />
          {/* 迭代 18：灵智枢智能运营（广东灵智枢生态科技有限公司） */}
          <Route path="cockpit" element={<AdminCockpit />} />
          <Route path="departments" element={<AdminDepartments />} />
          {/* M47：三部门独立管理工作台（运营/品牌/市场，内嵌 DSH） */}
          <Route path="dept-consoles" element={<AdminDeptConsoles />} />
          {/* M48：插件仓管理台（dsh-plugin-store 装机/下架） */}
          <Route path="plugin-store" element={<AdminPluginStore />} />
          {/* M55：临时会议厅实况会议室（召集链接直达） */}
          <Route path="meeting/:id" element={<AdminMeetingRoom />} />
          {/* iter79：Panda 组织驾驶舱（四角色席位 + 分级审批） */}
          <Route path="panda" element={<AdminPandaBoard />} />
          {/* iter97：沙箱训练监考大盘 */}
          <Route path="sandbox-monitor" element={<AdminSandboxMonitor />} />
          {/* iter100 M2：组织中枢·协议评审台 */}
          <Route path="protocols" element={<AdminProtocols />} />
          {/* 迭代 19：部门账号分发体系 */}
          <Route path="staff-accounts" element={<AdminStaffAccounts />} />
          {/* 迭代 20：企业知识库 + 对外智能客服 */}
          <Route path="knowledge" element={<AdminKnowledge />} />
          <Route path="wechat-cs" element={<AdminWechatCs />} />
        </Route>
        {/* 迭代 35 批次B：实时数据大屏（独立路由，不带后台侧边栏） */}
        <Route path="/admin/wall" element={<AdminWall />} />
        {/* 迭代 19：部门独立工作台（负责人/员工统一入口） */}
        <Route path="/staff/login" element={<StaffLogin />} />
        <Route path="/staff/workspace" element={<StaffWorkspace />} />
        <Route path="*" element={<Navigate to={ADMIN_LOGIN_PATH} replace />} />
      </Routes>
    )
  }

  return (
    <>
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="market" element={<Market />} />
        <Route path="developers" element={<Developers />} />
        <Route path="leaderboard" element={<LeaderboardPage />} />
        <Route path="token" element={<TokenPage />} />
        <Route path="market/agent/:id" element={<AgentDetail />} />
        <Route path="workbench" element={<Workbench />} />
        <Route path={ROUTE_AGENT_EMPLOYMENT_SEGMENT} element={<AgentEmployment />} />
        <Route path="enterprise" element={<Enterprise />} />
        <Route path="masters" element={<Masters />} />
        <Route path="masters/:id" element={<MasterDetail />} />
        <Route path="admin/review" element={<AdminReview />} />
        <Route path="lifecycle" element={<Lifecycle />} />
        <Route path="pricing" element={<Pricing />} />
        {/* 迭代 27：套餐矩阵（packages.* 契约）——真挂 Packages 组件（portal#56 复审 bug·high 票：
            重定向到 /pricing=部门包页没挂=跳 /packages 看不到部门包矩阵+?dept= 归因丢面封死） */}
        <Route path="packages" element={<Packages />} />
        {/* 迭代 31：技能商店（skillShop.* 契约，免登录） */}
        <Route path="shop" element={<Navigate to="/market" replace />} />
        <Route path="architecture" element={<Architecture />} />
        <Route path="roadmap" element={<Roadmap />} />
        {/* 合规文书：用户协议 / 隐私政策 / 交易规则（门户可见） */}
        <Route path="legal/terms" element={<TermsPage />} />
        <Route path="legal/privacy" element={<PrivacyPage />} />
        <Route path="legal/trade-rules" element={<TradeRulesPage />} />
      </Route>
      <Route path="/login" element={<Login />} />
      <Route path="/get-app" element={<GetApp />} />
      <Route path="/get-desktop" element={<GetDesktop />} />
      <Route path="/my" element={<BuyerCenter />} />
      <Route path="/help" element={<HelpCenter />} />
      <Route path="/certified" element={<Certified />} />
      <Route path="/apply" element={<ApplyBeta />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
    {/* NumX Max 智能客服：全局挂载（portal 与 /wb 页面均出现），z 高但不遮挡主内容 */}
    <AssistantWidget />
    {/* M13.5 数字人具身入场层（每会话一次，sessionStorage 去重）：
        门户统一灵枢人格/声线，欢迎语播完后 dispatch 'portal:open-buddy' 唤起客服面板；
        /wb、/admin 端内各有自己的入场层（WbLayout/AdminLayout），门户层跳过避免双遮罩叠加 */}
    {!pathname.startsWith('/wb') && !pathname.startsWith('/admin') && (
      <MechaEntrance
        storageKey="portal_mecha_entered"
        openEventName="portal:open-buddy"
        enterLabel="开始体验 · 开启语音"
        persona="lingshu"
        welcomeText="老板，欢迎回来！我是灵枢，你的赛博同事。点击下方按钮进来，我随时听你差遣。"
      />
    )}
    </>
  )
}
