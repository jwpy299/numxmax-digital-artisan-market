/**
 * Packages（/packages）—— 数字员工订阅插件包体系页（迭代 28：彭总《数字员工订阅插件包体系》V1.0 NEBULA-DE-SUB-001 落地重写）。
 *
 * 页面结构（文档章节对位）：
 *   ① 定价体系区（第六章：单部门定价 4 档+多部门折扣表+子包折扣表——采购依据透明面）
 *   ② 13 部门订阅插件包区（第三章：按部门组卡——复核 Agent 标配标+子包档清单+「订阅 →」跳工作台申请链[?pkg= 归因]）
 *   ③ 跨部门协同包区（第四章 5 件——购买模态链）
 *   ④ 企业全域包区（第五章 2 件年费大卡——购买模态链）
 *   ⑤ 交付与激活（第七章 5 步）+售后服务（第八章 4 项）
 *   ⑥ 订单查询（既有面不动）
 *
 * 数据源：packages.list（生产库 37 件文档体系种子真源）——只渲 packageTier 非空件；
 * tier=null 旧件不渲（旧 5 规模包彭总 2026-10-15 拍板退役+旧 3 部门包由文档体系接棒——退役面=前端不显示）。
 * 动线：部门子包→工作台订阅申请链（企业内部面）；协同/全域包→购买模态（createOrder→线下支付→认领码——既有闭环不动）。
 */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router'
import { resolveWorkbenchUrl } from '@/config/workbench' // 工作台跳链单点（OCR portal#58 票：base 归一+空兜+路径补全单源——不手拼）
import {
  BadgeCheck,
  Building2,
  Copy,
  Layers,
  Loader2,
  Package,
  Phone,
  Search,
  ShieldCheck,
  Sparkles,
  User,
  X,
} from 'lucide-react'
import HudCorner from '@/components/HudCorner'
import { wbQuery, wbMutation, wbErrorMessage } from '@/lib/wbSession'
import { cn } from '@/lib/utils'

// ─── 契约类型 ────────────────────────────────────────────────────────────────

/** 部门包团队规格（契约层单源直引——portal#57 复审票：手抄复刻后端漂移面封死） */
import type { DeptTeamSpec } from '@contracts/deptTeamSpec';
/** 文档体系键集型（契约单源直引——DEPT_NAME/TIER_LABEL 全键 Record 强迫：契约加/改键=编译期即红，不静默渲英文键[OCR portal#58 maint 票]） */
import type { PkgDeptKey, PkgTier } from '@contracts/pkgCatalog';

interface Pkg {
  id: number
  key: string
  name: string
  priceYuan: number
  periodLabel: string
  agentsCount: number
  scopeLabel: string
  synergyLabel: string
  monetizeLabel: string
  scaleLabel: string
  posterUrl: string
  features: string[]
  sortOrder: number
  deptCode: string | null // 部门键（部门级订阅插件包面——非部门包=null）
  packageTier: string | null // 子包级（wb#81 透出：basic/management/strategic/synergy/global——页面分区锚）
  teamSpec: DeptTeamSpec | null // 团队规格（部门包带——主管+专员清单透出面）
}

/** ③A 导购卡（彭总 2026-10-18 令「得能让用户真正用起来」——客户说人话，导购专员给配） */
type RecommendItem = { pkgKey: string; name: string; deptKey: string | null; priceYuan: number; periodLabel: string; agentsCount: number; reason: string }
function advisorSid(): string {
  // 访客会话键（读+写双面具[high③——只有读没有写=恒 null 的病]）：首次访问生成 uuid 存 sessionStorage（导购对话连续面）
  let sid = sessionStorage.getItem('numx_portal_sid')
  if (!sid) {
    sid = crypto.randomUUID?.() ?? `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
    sessionStorage.setItem('numx_portal_sid', sid)
  }
  return sid
}
function AdvisorCard({ pkgs, onPick }: { pkgs: Pkg[]; onPick: (p: Pkg) => void }) {
  const [need, setNeed] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ source: string; items: RecommendItem[] } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const warmedRef = useRef(false)
  // 聚焦预热[2026-10-20 彭总令修「用户没法交流」——冷工位首答 10-25s 的根错配]：用户聚焦输入框才暖（意向才暖不空烧[模型调用成本面]）——
  //  打完字时工位已暖，首答从「可能撞上 15s 帽落空」变「多数秒回」；暖火即忘（fire-and-forget 不等不挡）
  function warmAdvisor() {
    if (warmedRef.current) return
    warmedRef.current = true
    void wbMutation('packages.recommendByNeed', { need: '你好', sessionId: advisorSid() }).catch(() => {})
  }

  function handleAsk(e: FormEvent) {
    e.preventDefault()
    const v = need.trim()
    if (v.length < 2 || busy) return
    setBusy(true)
    setErr(null)
    wbMutation<{ ok: boolean; source: string; items: RecommendItem[]; message?: string; error?: string }>(
      'packages.recommendByNeed',
      { need: v, sessionId: advisorSid() },
    )
      .then((r) => {
        if (!r.ok) { setErr(r.message ?? '导购专员暂时忙——稍后再试'); return }
        setResult({ source: r.source, items: r.items })
      })
      .catch((e2) => setErr(wbErrorMessage(e2)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="glass-panel relative mt-8 rounded-xl border border-forge-amber/30 p-6">
      <HudCorner />
      <p className="hud-label text-forge-amber/90">AI ADVISOR · 导购专员</p>
      <p className="mt-2 text-sm text-ink-secondary">
        不知道买哪个包？<span className="font-bold text-ink-primary">说一句你的痛点</span>，导购专员（数字员工）给你配——别家超市列表筛选，我们家导购是数字员工本人。
      </p>
      <form onSubmit={handleAsk} className="mt-4 flex flex-col gap-3 sm:flex-row">
        <textarea
          value={need}
          onFocus={warmAdvisor}
          onChange={(e) => setNeed(e.target.value)}
          placeholder="比如：我们报销流程太乱，月底对账要疯……"
          rows={2}
          maxLength={500}
          className="flex-1 rounded-lg border border-line-subtle bg-void/60 px-4 py-2.5 text-sm text-ink-primary placeholder:text-ink-faint focus:border-forge-amber/60 focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy || need.trim().length < 2 || pkgs.length === 0}
          title={pkgs.length === 0 ? '订阅插件包清单加载中——加载完再让导购看' : undefined}
          className="rounded-lg bg-forge-amber px-5 py-2.5 text-sm font-bold text-void transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 sm:self-end"
        >
          {busy ? '导购专员上岗中…（数字员工真身——首答约 30 秒）' : '让导购专员看看 →'}
        </button>
      </form>
      {err && <p className="mt-3 text-xs text-ember-red">{err}</p>}
      {result && (
        <div className="mt-5 space-y-3">
          <p className="text-xs text-ink-faint">
            {result.source === 'advisor' ? '导购专员为你配了：' : '导购专员暂忙——按关键词为你标准匹配：'}
          </p>
          <div className="grid gap-3 md:grid-cols-3">
            {result.items.map((it) => {
              const pkg = pkgs.find((p) => p.key === it.pkgKey)
              return (
                <div key={it.pkgKey} className="rounded-xl border border-pulse-cyan/25 bg-void/40 p-4">
                  <p className="font-display text-sm font-bold text-ink-primary">{it.name}</p>
                  <p className="mt-1 font-mono text-xs text-forge-amber">¥{it.priceYuan}/{it.periodLabel} · {it.agentsCount} 岗</p>
                  <p className="mt-2 text-xs leading-relaxed text-ink-secondary">{it.reason}</p>
                  <button
                    type="button"
                    onClick={() => pkg && onPick(pkg)}
                    disabled={!pkg}
                    title={pkg ? undefined : '该包暂不在架（导购匹配的包面未在架——看看其他推荐）'}
                    className="mt-3 w-full rounded-lg border border-forge-amber/50 px-3 py-1.5 text-xs font-bold text-forge-amber transition hover:bg-forge-amber/10 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {pkg ? '按部门订阅 →' : '该包暂不在架'}
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}



interface CreateOrderResult {
  orderId: number
  orderNo: string
  claimCode: string
  amountYuan: number
  status: 'pending'
}

interface OrderStatusResult {
  orderNo: string
  status: string
  packageName: string
  amountYuan: number
  claimCode: string
  configuredFactoryId?: number
}

/** 智能工作台地址（独立部署包，写死） */
import { NEBULA_WORKBENCH_URL as WORKBENCH_URL } from '@/config/workbench' // 硬编码归单源（丝滑度审面——三处自持=漂移面封）
/** 线下支付微信号（写死） */
const PAY_WECHAT = '13501261908'
const PHONE_RE = /^1[3-9]\d{9}$/

const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: '待支付',
  paid: '已支付',
  configured: '已配置',
  cancelled: '已取消',
}

/** 工作台注册入口（workbench 模式实际注册路由为 /wb/login?tab=register） */
function workbenchRegisterUrl(claimCode: string): string {
  return `${WORKBENCH_URL}/wb/login?tab=register&claim=${encodeURIComponent(claimCode)}`
}

// ─── 文档体系展示常量（彭总文档 V1.0 对位面） ─────────────────────────────────

/** 13 部门中文名（文档第三章标题面——Record<PkgDeptKey> 全键强迫：契约 PKG_DEPT_KEYS 加键而本表漏名=tsc 编译即红[漂移构建期逼出面]） */
const DEPT_NAME: Record<PkgDeptKey, string> = {
  finance: '财务部',
  sales: '销售部',
  production: '生产部',
  procurement: '采购部',
  quality: '质检部',
  hr: '人力资源部',
  research: '研发部',
  warehouse: '仓储物流部',
  it: 'IT与数字化部',
  legal: '法务部',
  admin: '行政部',
  cs: '客户服务部',
  marketing: '市场部',
}

/** 子包级展示名（文档第六章 6.1 面——Record<PkgTier> 全键强迫同律） */
const TIER_LABEL: Record<PkgTier, string> = {
  basic: '基础包',
  management: '管理包',
  strategic: '战略包',
  synergy: '协同包',
  global: '全域包',
}

/** 部门卡内子包档排序（基础→管理→战略——同档多件[财务数字资产包]按 sortOrder） */
const TIER_ORDER: Record<string, number> = { basic: 0, management: 1, strategic: 2 }

// ─── 海报图（加载失败/加载中骨架） ────────────────────────────────────────────

function Poster({ src, alt }: { src: string; alt: string }) {
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  return (
    <div className="relative aspect-[16/9] w-full overflow-hidden rounded-t-xl bg-deep">
      {!loaded && !failed && (
        <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-nebula-violet/15 via-panel to-pulse-cyan/10" />
      )}
      {failed ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-gradient-to-br from-nebula-violet/15 to-pulse-cyan/10">
          <Package className="h-10 w-10 text-pulse-cyan/60" />
          <span className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">{alt}</span>
        </div>
      ) : (
        <img
          src={src}
          alt={alt}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={cn('h-full w-full object-cover transition-opacity duration-500', loaded ? 'opacity-100' : 'opacity-0')}
        />
      )}
    </div>
  )
}

// ─── 定价体系区（文档第六章——采购依据透明面） ─────────────────────────────────

function PricingTables({ tierPrice, digitalAssetPrice }: { tierPrice: Partial<Record<PkgTier, number>>; digitalAssetPrice: number | null }) {
  // 价目行=库真源派生（packages.list——与订单同源[OCR portal#58 maint 票：营销表与订单真源不一致=静默误导买家封死]）；
  // 缺档兜文档 6.1 静态价（PKG_CATALOG 种子单源同价——一致性由全目录钉逼出）；折扣率=文档 6.2/6.3 面（契约无此面——改版走文档修订）
  const priceRows: Array<[string, number]> = [
    ['基础包', tierPrice.basic ?? 2800],
    ['管理包', tierPrice.management ?? 3800],
    ['战略包', tierPrice.strategic ?? 4800],
    ['数字资产包（财务专属）', digitalAssetPrice ?? 4800],
  ]
  return (
    <div className="mt-12 grid gap-6 lg:grid-cols-3">
      {/* 单部门定价 4 档（6.1） */}
      <div className="glass-panel relative rounded-xl p-5">
        <HudCorner />
        <p className="hud-label text-pulse-cyan/80">单部门定价 · 季付</p>
        <ul className="mt-4 space-y-2.5 text-sm">
          {priceRows.map(([k, v]) => (
            <li key={k} className="flex items-center justify-between border-b border-line-subtle/40 pb-2.5 last:border-0 last:pb-0">
              <span className="text-ink-secondary">{k}</span>
              <span className="font-display font-bold text-forge-amber">¥{v.toLocaleString()}/季度</span>
            </li>
          ))}
        </ul>
      </div>
      {/* 多部门折扣（6.2） */}
      <div className="glass-panel relative rounded-xl p-5">
        <HudCorner />
        <p className="hud-label text-pulse-cyan/80">多部门折扣 · 按需组合</p>
        <ul className="mt-4 space-y-2.5 text-sm">
          {[
            ['1 个部门', '无折扣'],
            ['2 个部门', '9 折'],
            ['3 个部门', '8.5 折'],
            ['5 个部门', '8 折'],
            ['8 个部门及以上', '7.5 折'],
          ].map(([k, v]) => (
            <li key={k} className="flex items-center justify-between border-b border-line-subtle/40 pb-2.5 last:border-0 last:pb-0">
              <span className="text-ink-secondary">{k}</span>
              <span className="font-medium text-jade-green">{v}</span>
            </li>
          ))}
        </ul>
      </div>
      {/* 子包折扣（6.3） */}
      <div className="glass-panel relative rounded-xl p-5">
        <HudCorner />
        <p className="hud-label text-pulse-cyan/80">部门包内子包折扣</p>
        <ul className="mt-4 space-y-2.5 text-sm">
          {[
            ['1 个子包', '无折扣'],
            ['2 个子包', '9 折'],
            ['3 个子包及以上', '8 折'],
          ].map(([k, v]) => (
            <li key={k} className="flex items-center justify-between border-b border-line-subtle/40 pb-2.5 last:border-0 last:pb-0">
              <span className="text-ink-secondary">{k}</span>
              <span className="font-medium text-jade-green">{v}</span>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-[11px] leading-relaxed text-ink-faint">全域包按年付费，均价更低——见底部全域包区。</p>
      </div>
    </div>
  )
}

// ─── 部门订阅插件包卡（第三章——13 部门组卡：复核 Agent 标配+子包档清单+订阅钮） ────

function DeptGroupCard({ deptCode, subs, onSubscribe }: { deptCode: string; subs: Pkg[]; onSubscribe: () => void }) {
  const deptName = DEPT_NAME[deptCode as PkgDeptKey] ?? deptCode // as 断言+运行时兜（库面键超契约时兜原始键——定义面全键强迫仍在=漏名编译即红）
  // 双层架构面（文档 2.1）：任一子包的 teamSpec.lead=复核 Agent 标配（随任意子包提供——文档第三章每部门同句）
  const leadDuty = subs.find((s) => s.teamSpec)?.teamSpec?.lead.duty ?? null
  const ordered = [...subs].sort((a, b) => (TIER_ORDER[a.packageTier ?? ''] ?? 9) - (TIER_ORDER[b.packageTier ?? ''] ?? 9) || a.sortOrder - b.sortOrder)
  return (
    <article className="glass-panel group relative flex flex-col overflow-hidden rounded-xl transition-transform duration-300 hover:-translate-y-1">
      <HudCorner />
      <div className="flex flex-1 flex-col p-5">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-display text-lg font-bold text-ink-primary">{deptName}数字员工订阅插件包</h3>
          <Building2 className="h-5 w-5 text-pulse-cyan/60" />
        </div>
        {/* 复核 Agent 标配标（双层架构复核层——文档 2.1） */}
        {leadDuty && (
          <p className="mt-2 flex items-start gap-1.5 rounded-lg border border-jade-green/30 bg-jade-green/[0.06] px-3 py-2 text-[11px] leading-relaxed text-jade-green">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            复核 Agent 标配随任意子包提供——{leadDuty}
          </p>
        )}
        {/* 子包档清单 */}
        <ul className="mt-4 flex-1 space-y-3 border-t border-line-subtle/60 pt-4">
          {ordered.map((s) => (
            <li key={s.key} className="rounded-lg border border-line-subtle/40 bg-void/30 p-3">
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-sm font-semibold text-ink-primary">
                  <span className="mr-1.5 rounded-full border border-pulse-cyan/30 bg-pulse-cyan/[0.08] px-2 py-0.5 text-[10px] text-pulse-cyan">
                    {TIER_LABEL[(s.packageTier ?? '') as PkgTier] ?? s.packageTier}
                  </span>
                  {s.name}
                </p>
                <p className="shrink-0">
                  <span className="font-display text-base font-bold text-forge-amber">{s.priceYuan}元</span>
                  <span className="ml-1 text-[10px] text-ink-faint">/{s.periodLabel}</span>
                </p>
              </div>
              {/* 岗位 Agent 清单（teamSpec.members=执行层真编面） */}
              {s.teamSpec && (
                <p className="mt-1.5 text-[11px] leading-relaxed text-ink-secondary">
                  {s.teamSpec.members.map((m) => m.duty).join(' · ')}
                </p>
              )}
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={onSubscribe}
          className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-[10px] bg-amber-gradient px-4 py-2.5 text-sm font-medium text-[#1A1206] transition-shadow duration-300 hover:shadow-[0_0_20px_rgba(245,165,36,0.35)]"
        >
          订阅{deptName} →
        </button>
      </div>
    </article>
  )
}

// ─── 协同/全域包卡共享件（双写漂移面封死——第四章/第五章两区同引；唯一差面：大卡标记） ────

function SynGlobalCard({ pkg, wide, onBuy }: { pkg: Pkg; wide?: boolean; onBuy: () => void }) {
  return (
    <article className={cn('glass-panel group relative flex flex-col overflow-hidden rounded-xl transition-transform duration-300 hover:-translate-y-1', wide && 'md:col-span-2')}>
      <HudCorner />
      {pkg.packageTier === 'global' && <Poster src={pkg.posterUrl} alt={pkg.name} />}
      <div className="flex flex-1 flex-col p-5">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-display text-lg font-bold text-ink-primary">{pkg.name}</h3>
          {pkg.packageTier === 'global' ? (
            <Sparkles className="h-5 w-5 text-forge-amber/70" />
          ) : (
            <Layers className="h-5 w-5 text-pulse-cyan/60" />
          )}
        </div>
        <p className="mt-2">
          <span className="font-display text-3xl font-bold text-forge-amber">{pkg.priceYuan}元</span>
          <span className="ml-2 text-sm text-ink-faint">/{pkg.periodLabel}</span>
        </p>
        <dl className="mt-4 flex-1 space-y-2 border-t border-line-subtle/60 pt-4 text-xs">
          {[
            ['覆盖范围', pkg.scopeLabel],
            ['协同能力', pkg.synergyLabel],
            ['适用规模', pkg.scaleLabel],
            ...(pkg.monetizeLabel && pkg.monetizeLabel !== '无' ? [['对外变现', pkg.monetizeLabel]] : []),
          ].map(([k, v]) => (
            <div key={k} className="flex items-start justify-between gap-3">
              <dt className="shrink-0 text-ink-faint">{k}</dt>
              <dd className="text-right font-medium leading-relaxed text-ink-primary">{v}</dd>
            </div>
          ))}
        </dl>
        {pkg.features?.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {pkg.features.map((f) => (
              <span
                key={f}
                className="rounded-full border border-pulse-cyan/30 bg-pulse-cyan/[0.06] px-2.5 py-0.5 text-[11px] text-pulse-cyan"
              >
                {f}
              </span>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={onBuy}
          className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-[10px] bg-amber-gradient px-4 py-2.5 text-sm font-medium text-[#1A1206] transition-shadow duration-300 hover:shadow-[0_0_20px_rgba(245,165,36,0.35)]"
        >
          申请采购 →
        </button>
      </div>
    </article>
  )
}

// ─── 交付与售后区（文档第七章 5 步+第八章 4 项——销售手册完整面） ──────────────────

function DeliveryAfterSale() {
  return (
    <div className="mt-14 grid gap-6 lg:grid-cols-2">
      <div className="glass-panel relative rounded-xl p-6">
        <HudCorner />
        <p className="hud-label text-pulse-cyan/80">交付与激活 · 5 步</p>
        <ol className="mt-4 space-y-3 text-sm">
          {[
            ['企业注册，AI 自动识别组织架构', '5 分钟'],
            ['选择部门包，签订订阅协议', '1 天'],
            ['系统自动生成该部门所有岗位 Agent', '即时'],
            ['部门负责人确认 Agent 配置', '1 天'],
            ['Agent 正式上岗，开始工作', '即时'],
          ].map(([step, cycle], i) => (
            <li key={step} className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2.5 text-ink-secondary">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-pulse-cyan/40 font-mono text-[10px] text-pulse-cyan">{i + 1}</span>
                {step}
              </span>
              <span className="shrink-0 font-mono text-[11px] text-jade-green">{cycle}</span>
            </li>
          ))}
        </ol>
      </div>
      <div className="glass-panel relative rounded-xl p-6">
        <HudCorner />
        <p className="hud-label text-pulse-cyan/80">售后服务</p>
        <ul className="mt-4 space-y-3 text-sm">
          {[
            ['技术支持', '7x24 小时在线支持，严重问题 2 小时响应'],
            ['Agent 优化', '根据使用反馈持续优化 Agent 行为策略'],
            ['版本升级', '订阅期内免费升级至最新版本'],
            ['培训服务', '提供管理员培训、部门负责人培训'],
          ].map(([k, v]) => (
            <li key={k} className="flex items-start gap-2.5">
              <BadgeCheck className="mt-0.5 h-4 w-4 shrink-0 text-jade-green" />
              <span className="text-ink-secondary"><span className="font-medium text-ink-primary">{k}</span>——{v}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

// ─── 购买表单弹窗 ────────────────────────────────────────────────────────────

function BuyModal({ pkg, onClose, onDone }: { pkg: Pkg; onClose: () => void; onDone: (r: CreateOrderResult, pkg: Pkg) => void }) {
  const [form, setForm] = useState({ buyerName: '', buyerPhone: '', companyName: '' })
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!PHONE_RE.test(form.buyerPhone.trim())) {
      setError('手机号格式不正确（1[3-9] 开头的 11 位手机号）')
      return
    }
    setPending(true)
    try {
      const res = await wbMutation<CreateOrderResult>('packages.createOrder', {
        packageId: pkg.id,
        buyerName: form.buyerName.trim(),
        buyerPhone: form.buyerPhone.trim(),
        companyName: form.companyName.trim(),
      })
      onDone(res, pkg)
    } catch (err) {
      setError(wbErrorMessage(err))
    } finally {
      setPending(false)
    }
  }

  const fieldCls =
    'w-full rounded-[10px] border border-line-subtle bg-void/60 px-3.5 py-2.5 text-sm text-ink-primary outline-none transition-colors placeholder:text-ink-faint focus:border-pulse-cyan/60'

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-void/80 px-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="glass-panel relative w-full max-w-md rounded-xl p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <HudCorner />
        <button
          type="button"
          aria-label="关闭"
          onClick={onClose}
          className="absolute right-4 top-4 rounded-full p-1.5 text-ink-secondary transition-colors hover:text-ink-primary"
        >
          <X className="h-4 w-4" />
        </button>
        <p className="hud-label text-pulse-cyan/80">PACKAGE ORDER</p>
        <h3 className="mt-1 font-display text-xl font-bold text-ink-primary">
          采购「{pkg.name}」
        </h3>
        <p className="mt-1 text-sm text-ink-secondary">
          <span className="font-display text-lg font-bold text-forge-amber">{pkg.priceYuan}元</span>
          <span className="ml-1 text-xs text-ink-faint">/{pkg.periodLabel}</span>
        </p>
        <form onSubmit={(e) => void handleSubmit(e)} className="mt-5 space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-secondary">姓名</label>
            <div className="relative">
              <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
              <input
                className={cn(fieldCls, 'pl-9')}
                value={form.buyerName}
                onChange={(e) => setForm((f) => ({ ...f, buyerName: e.target.value }))}
                placeholder="联系人姓名"
                required
                minLength={2}
              />
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-secondary">手机号</label>
            <div className="relative">
              <Phone className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
              <input
                className={cn(fieldCls, 'pl-9')}
                value={form.buyerPhone}
                onChange={(e) => setForm((f) => ({ ...f, buyerPhone: e.target.value }))}
                placeholder="11 位手机号"
                required
                maxLength={11}
                inputMode="numeric"
              />
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-secondary">公司名称</label>
            <div className="relative">
              <Building2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
              <input
                className={cn(fieldCls, 'pl-9')}
                value={form.companyName}
                onChange={(e) => setForm((f) => ({ ...f, companyName: e.target.value }))}
                placeholder="企业全称"
                required
                minLength={2}
              />
            </div>
          </div>
          {error && (
            <p className="rounded-xl border border-ember-red/30 bg-ember-red/[0.06] px-4 py-3 text-xs leading-relaxed text-ember-red">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={pending}
            className="inline-flex w-full items-center justify-center gap-2 rounded-[10px] bg-amber-gradient px-4 py-2.5 text-sm font-medium text-[#1A1206] transition-shadow duration-300 hover:shadow-[0_0_20px_rgba(245,165,36,0.35)] disabled:opacity-50"
          >
            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
            提交订单
          </button>
        </form>
      </div>
    </div>
  )
}

// ─── 下单成功页 ──────────────────────────────────────────────────────────────

function OrderSuccess({ order, pkg, onBack }: { order: CreateOrderResult; pkg: Pkg; onBack: () => void }) {
  const [copied, setCopied] = useState(false)

  function copyClaim() {
    void navigator.clipboard?.writeText(order.claimCode).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <section className="mx-auto max-w-2xl px-5 py-16 md:py-24">
      <div className="glass-panel relative rounded-xl p-8 text-center">
        <HudCorner />
        <BadgeCheck className="mx-auto h-12 w-12 text-jade-green" />
        <h2 className="mt-4 font-display text-2xl font-bold text-ink-primary">订单创建成功</h2>
        <p className="mt-2 text-sm text-ink-secondary">
          「{pkg.name}」订单已生成，请按下方指引完成线下支付并保存配置码。
        </p>

        <div className="mt-6 grid gap-3 text-left sm:grid-cols-2">
          <div className="rounded-xl border border-line-subtle bg-void/40 p-4">
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">订单号</p>
            <p className="mt-1 font-mono text-sm text-ink-primary">{order.orderNo}</p>
          </div>
          <div className="rounded-xl border border-line-subtle bg-void/40 p-4">
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">应付金额</p>
            <p className="mt-1 font-display text-lg font-bold text-forge-amber">{order.amountYuan}元</p>
          </div>
        </div>

        {/* 配置码：醒目提示 */}
        <div className="mt-4 rounded-xl border border-forge-amber/50 bg-forge-amber/[0.08] p-5">
          <p className="flex items-center justify-center gap-1.5 text-sm font-bold text-forge-amber">
            <ShieldCheck className="h-4 w-4" />
            请保存配置码（仅此一次完整展示）
          </p>
          <p className="mt-2 break-all font-mono text-lg font-bold tracking-wider text-ink-primary">
            {order.claimCode}
          </p>
          <button
            type="button"
            onClick={copyClaim}
            className="mt-3 inline-flex items-center gap-1.5 rounded-[8px] border border-line-subtle px-3 py-1.5 text-xs text-ink-secondary transition-colors hover:border-pulse-cyan/50 hover:text-pulse-cyan"
          >
            <Copy className="h-3.5 w-3.5" />
            {copied ? '已复制' : '复制配置码'}
          </button>
        </div>

        {/* 线下支付指引 */}
        <div className="mt-4 rounded-xl border border-line-subtle bg-void/40 p-5 text-left">
          <p className="text-sm font-bold text-ink-primary">线下支付指引</p>
          <p className="mt-2 text-sm leading-relaxed text-ink-secondary">
            请添加微信支付：<span className="font-mono font-bold text-pulse-cyan">{PAY_WECHAT}</span>
            ，备注订单号 <span className="font-mono text-ink-primary">{order.orderNo}</span>。
          </p>
          <p className="mt-2 text-xs leading-relaxed text-ink-faint">
            支付后运营确认开通；也可先凭配置码到工作台预配置企业组织，支付确认后套餐自动生效。
          </p>
        </div>

        <div className="mt-6 flex flex-col items-center gap-3">
          <a
            href={workbenchRegisterUrl(order.claimCode)}
            className="inline-flex w-full items-center justify-center gap-2 rounded-[10px] bg-amber-gradient px-6 py-3 text-sm font-medium text-[#1A1206] transition-shadow duration-300 hover:shadow-[0_0_24px_rgba(245,165,36,0.4)] sm:w-auto"
          >
            <Sparkles className="h-4 w-4" />
            前往智能工作台配置企业
          </a>
          <button
            type="button"
            onClick={onBack}
            className="text-xs text-ink-faint transition-colors hover:text-pulse-cyan"
          >
            返回订阅插件包体系
          </button>
        </div>
      </div>
    </section>
  )
}

// ─── 订单查询 ────────────────────────────────────────────────────────────────

function OrderQuery() {
  const [form, setForm] = useState({ orderNo: '', buyerPhone: '' })
  const [result, setResult] = useState<OrderStatusResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setResult(null)
    if (!PHONE_RE.test(form.buyerPhone.trim())) {
      setError('手机号格式不正确（1[3-9] 开头的 11 位手机号）')
      return
    }
    setPending(true)
    try {
      const res = await wbQuery<OrderStatusResult>('packages.orderStatus', {
        orderNo: form.orderNo.trim(),
        buyerPhone: form.buyerPhone.trim(),
      })
      setResult(res)
    } catch (err) {
      setError(wbErrorMessage(err))
    } finally {
      setPending(false)
    }
  }

  const fieldCls =
    'rounded-[10px] border border-line-subtle bg-void/60 px-3.5 py-2 text-sm text-ink-primary outline-none transition-colors placeholder:text-ink-faint focus:border-pulse-cyan/60'

  return (
    <div className="glass-panel relative mx-auto mt-14 max-w-2xl rounded-xl p-6">
      <HudCorner />
      <p className="hud-label text-pulse-cyan/80">ORDER QUERY</p>
      <h3 className="mt-1 text-base font-bold text-ink-primary">订单查询</h3>
      <form onSubmit={(e) => void handleSubmit(e)} className="mt-4 flex flex-wrap items-end gap-3">
        <input
          className={cn(fieldCls, 'min-w-0 flex-1')}
          value={form.orderNo}
          onChange={(e) => setForm((f) => ({ ...f, orderNo: e.target.value }))}
          placeholder="订单号"
          required
        />
        <input
          className={cn(fieldCls, 'min-w-0 flex-1')}
          value={form.buyerPhone}
          onChange={(e) => setForm((f) => ({ ...f, buyerPhone: e.target.value }))}
          placeholder="下单手机号"
          required
          maxLength={11}
          inputMode="numeric"
        />
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-[10px] border border-pulse-cyan/50 px-4 py-2 text-sm text-pulse-cyan transition-colors hover:bg-pulse-cyan/[0.08] disabled:opacity-50"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          查询
        </button>
      </form>
      {error && (
        <p className="mt-3 rounded-xl border border-ember-red/30 bg-ember-red/[0.06] px-4 py-3 text-xs text-ember-red">
          {error}
        </p>
      )}
      {result && (
        <div className="mt-4 rounded-xl border border-line-subtle bg-void/40 p-4 text-sm">
          <div className="grid gap-2 sm:grid-cols-2">
            <p className="text-ink-secondary">
              套餐：<span className="text-ink-primary">{result.packageName}</span>
            </p>
            <p className="text-ink-secondary">
              状态：
              <span
                className={cn(
                  'font-medium',
                  result.status === 'paid' || result.status === 'configured' ? 'text-jade-green' : 'text-forge-amber',
                )}
              >
                {ORDER_STATUS_LABELS[result.status] ?? result.status}
              </span>
            </p>
            <p className="text-ink-secondary">
              金额：<span className="font-mono text-ink-primary">{result.amountYuan}元</span>
            </p>
            <p className="text-ink-secondary">
              订单号：<span className="font-mono text-ink-primary">{result.orderNo}</span>
            </p>
          </div>
          {result.claimCode && (
            <p className="mt-3 border-t border-line-subtle/60 pt-3 text-xs text-ink-secondary">
              配置码：<span className="font-mono text-forge-amber">{result.claimCode}</span>
              <a
                href={workbenchRegisterUrl(result.claimCode)}
                className="ml-2 text-pulse-cyan underline-offset-2 hover:underline"
              >
                前往工作台认领
              </a>
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ─── 页面 ────────────────────────────────────────────────────────────────────

export default function Packages() {
  const [pkgs, setPkgs] = useState<Pkg[] | null>(null)
  // 员工归因面（战区② 2.2：匠市「按部门订阅」跳来带 ?dept=——聚焦该部门包[沉底其余]；文档 13 键天然支持[P-DEPT-MAP-UNIFY 页面侧同收]）
  const [params] = useSearchParams()
  const deptFocus = params.get('dept') // 归因部门键（null=全量展示面）
  const [error, setError] = useState<string | null>(null)
  const [buying, setBuying] = useState<Pkg | null>(null)
  const [done, setDone] = useState<{ order: CreateOrderResult; pkg: Pkg } | null>(null)

  useEffect(() => {
    wbQuery<Pkg[]>('packages.list')
      .then((rows) => setPkgs([...rows].sort((a, b) => a.sortOrder - b.sortOrder)))
      .catch((err) => setError(wbErrorMessage(err)))
  }, [])

  if (done) {
    return <OrderSuccess order={done.order} pkg={done.pkg} onBack={() => setDone(null)} />
  }

  // 文档体系分区（只渲 packageTier 非空件——tier=null 旧件退役面不显示[旧 5 规模包彭总 2026-10-15 拍板退役+旧 3 部门包由文档体系接棒]）
  const alive = (pkgs ?? []).filter((p) => p.packageTier)
  const deptSubs = alive.filter((p) => p.packageTier === 'basic' || p.packageTier === 'management' || p.packageTier === 'strategic')
  // 13 部门分组（按 deptCode——归因聚焦置顶面：?dept= 命中的部门排最前）
  const deptGroups = deptSubs.reduce<Map<string, Pkg[]>>((m, p) => {
    const k = p.deptCode ?? ''
    if (!k) return m
    const arr = m.get(k) ?? []
    arr.push(p)
    m.set(k, arr)
    return m
  }, new Map())
  const deptKeys = [...deptGroups.keys()].sort((a, b) => {
    if (deptFocus && a === deptFocus) return -1
    if (deptFocus && b === deptFocus) return 1
    return (deptGroups.get(a)?.[0]?.sortOrder ?? 0) - (deptGroups.get(b)?.[0]?.sortOrder ?? 0)
  })
  const synergyPkgs = alive.filter((p) => p.packageTier === 'synergy')
  const globalPkgs = alive.filter((p) => p.packageTier === 'global')
  // 定价表库真源派生（每 tier 取首件价——种子单源同价[OCR portal#58 maint 票：价目=订单同源]）
  const tierPrice: Partial<Record<PkgTier, number>> = {}
  for (const p of alive) {
    const t = p.packageTier as PkgTier | null
    if (t && tierPrice[t] === undefined) tierPrice[t] = p.priceYuan
  }
  const digitalAssetPrice = alive.find((p) => p.key === 'fin_digital')?.priceYuan ?? null

  return (
    <section className="mx-auto max-w-site px-5 py-16 md:px-12 md:py-20">
      {/* 页头（文档 V1.0 口径） */}
      <div className="text-center">
        <p className="hud-label text-pulse-cyan/80">SUBSCRIPTION MATRIX · V1.0</p>
        <h1 className="mt-3 font-display text-3xl font-bold tracking-[0.02em] text-ink-primary md:text-4xl">
          数字员工订阅插件包体系
        </h1>
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-ink-secondary">
          按部门订阅 · 双层架构（每部门标配复核 Agent）· 天然协同（跨部门任务自动流转）· 按需组合（单部门起步至全域覆盖）。
          13 个部门 133 名岗位 Agent+13 名复核 Agent，全链路待命。
        </p>
      </div>

      {/* ③A 导购卡（页顶——客户说痛点导购专员配包=转化面） */}
      <AdvisorCard pkgs={pkgs ?? []} onPick={(p) => setBuying(p)} />

      {error ? (
        <p className="mx-auto mt-12 max-w-xl rounded-xl border border-ember-red/30 bg-ember-red/[0.06] px-4 py-3 text-center text-xs text-ember-red">
          {error}
        </p>
      ) : !pkgs ? (
        <div className="mt-12 grid gap-6 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="glass-panel animate-pulse rounded-xl">
              <div className="space-y-3 p-5">
                <div className="h-5 w-1/2 rounded bg-panel" />
                <div className="h-8 w-2/3 rounded bg-panel" />
                <div className="h-20 rounded bg-panel" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <>
          {/* ① 定价体系区（第六章） */}
          <PricingTables tierPrice={tierPrice} digitalAssetPrice={digitalAssetPrice} />

          {/* ② 13 部门订阅插件包区（第三章——主调面） */}
          {deptKeys.length > 0 && (
            <>
              <div className="mt-14">
                <p className="hud-label text-pulse-cyan/80">DEPT PACKAGES · 13 部门订阅插件包</p>
                <p className="mt-1 text-xs text-ink-faint">
                  按部门雇佣整个数字员工团队——复核 Agent 标配随任意子包提供；订阅后自动生成该部门全部岗位 Agent，负责人确认即上岗
                </p>
              </div>
              <div className="mt-6 grid gap-6 md:grid-cols-2 xl:grid-cols-3">
                {deptKeys.map((dk) => (
                  <DeptGroupCard
                    key={dk}
                    deptCode={dk}
                    subs={deptGroups.get(dk) ?? []}
                    onSubscribe={() => {
                      // 战区② 2.7 同律：跳企业工作台订阅确认面（?pkg= 归因=部门键——一部门一卡聚合面；未开户落登录页接主线①链）；
                      // resolveWorkbenchUrl 单点（base 归一+路径补全+encode——OCR portal#58 票）
                      window.location.href = resolveWorkbenchUrl(`/wb/enterprise-v3?pkg=${encodeURIComponent(dk)}`)
                    }}
                  />
                ))}
              </div>
            </>
          )}

          {/* ③ 跨部门协同包区（第四章 5 件） */}
          {synergyPkgs.length > 0 && (
            <>
              <div className="mt-14">
                <p className="hud-label text-pulse-cyan/80">SYNERGY PACKAGES · 跨部门协同包</p>
                <p className="mt-1 text-xs text-ink-faint">部门包之间天然协同——跨部门任务自动流转，无需人工协调</p>
              </div>
              <div className="mt-6 grid gap-6 md:grid-cols-2 xl:grid-cols-3">
                {synergyPkgs.map((p) => (
                  <SynGlobalCard key={p.id} pkg={p} onBuy={() => setBuying(p)} />
                ))}
              </div>
            </>
          )}

          {/* ④ 企业全域包区（第五章 2 件年费大卡） */}
          {globalPkgs.length > 0 && (
            <>
              <div className="mt-14">
                <p className="hud-label text-forge-amber/80">GLOBAL PACKAGES · 企业全域包</p>
                <p className="mt-1 text-xs text-ink-faint">全部 13 部门所有子包全岗位覆盖+所有复核 Agent——按年付费，均价更低</p>
              </div>
              <div className="mt-6 grid gap-6 md:grid-cols-2">
                {globalPkgs.map((p) => (
                  <SynGlobalCard key={p.id} pkg={p} wide onBuy={() => setBuying(p)} />
                ))}
              </div>
            </>
          )}

          {/* ⑤ 交付与售后（第七章+第八章） */}
          <DeliveryAfterSale />
        </>
      )}

      {/* ⑥ 订单查询（既有面） */}
      <OrderQuery />

      {buying && (
        <BuyModal
          pkg={buying}
          onClose={() => setBuying(null)}
          onDone={(order, pkg) => {
            setBuying(null)
            setDone({ order, pkg })
            window.scrollTo({ top: 0 })
          }}
        />
      )}
    </section>
  )
}
