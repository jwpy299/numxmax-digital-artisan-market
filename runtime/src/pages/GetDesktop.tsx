/**
 * GetDesktop（/get-desktop）—— 下载注册中心（彭总 2026-10-16 令：安装包直发企业用户；2026-10-20 令：升级下载注册中心——下载+报名动线聚合）——
 * 「能发出去的页面链接」形态：裸 exe URL 发出去是文件，本页是带品牌/说明/引导的下载中心）。
 *
 * 面：企业/个人 Windows 安装包双大卡（直下 /dl/ 稳定名）+安装说明 4 步+系统要求+内测申请入口+手机 APP 引导。
 * 纪律：下载链=/dl/ 稳定名直链（发版换件不换名——销售发出去的链接永远指向最新包）；
 * 系统要求诚实面（Windows 10/11 64 位——Mac/Linux 客明说暂无，不钓鱼）。
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { Building2, CheckCircle2, Download, Smartphone, XCircle } from 'lucide-react'
import { DailyCodeCard } from '@/components/home/DailyCodeCard' // 每日口令卡（彭总 2026-10-23 令——下载注册中心同挂）
import HudCorner from '@/components/HudCorner'

import { PKG_DL_ORG as PKG_ORG } from '@contracts/portal' // 彭总 2026-10-22 令：下载中心只留组织运行时+APP（个人/企业工作台卡摘除——PKG_ENT/PKG_PERSONAL 零残用摘） // 包路径契约单源（OCR portal#69 maint 票：三处硬编码发散面封死——HeroSection 两处同引）
import { fetchDownloadSizeLabel } from '@/lib/downloadSize'

const PKG_OS_LABEL = 'Windows 10 / 11 · 64 位'

/** 安装步骤单源（双卡同引——步骤不双写；大小由实际文件响应头提供，不写死旧包值） */
const INSTALL_STEPS = [
  '下载安装包（.exe）',
  '双击运行安装程序，按提示完成安装',
  '桌面出现「NumX Max 智能工作台」图标，双击打开',
  '注册/登录账号——输企业邀请码即落编进部门舱',
]

function DownloadCard({
  title, desc, href, accent, icon, meta, btnLabel,
}: {
  title: string; desc: string; href: string; accent: 'cyan' | 'violet' | 'green'; icon: React.ReactNode; // green=APP 卡面（下载注册中心三面齐）
  meta: string; btnLabel?: string; // 可配面（APP 卡面 OS/尺寸/钮文不蹭 Windows 面[#91 漏面修]）
}) {
  const border = accent === 'cyan' ? 'border-pulse-cyan/40' : accent === 'violet' ? 'border-nebula-violet/40' : 'border-jade-green/40'
  return (
    <div className={`glass-panel relative flex flex-col rounded-xl border ${border} p-5`}>
      <HudCorner />
      <div className="flex items-center gap-3">
        {icon}
        <div>
          <p className="font-display text-base font-bold text-ink-primary">{title}</p>
          <p className="text-[11px] text-ink-faint">{meta}</p>
        </div>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-ink-secondary">{desc}</p>
      <a
        href={href}
        className="mt-4 inline-flex items-center justify-center gap-2 rounded-[10px] bg-amber-gradient px-4 py-2.5 text-sm font-medium text-[#1A1206] transition-shadow duration-300 hover:shadow-[0_0_20px_rgba(245,165,36,0.35)]"
      >
        <Download className="h-4 w-4" />
        {btnLabel ?? '下载 Windows 安装包'}
      </a>
    </div>
  )
}

function useDownloadSizeLabel(href: string) {
  const [label, setLabel] = useState('')
  useEffect(() => {
    setLabel('')
    if (!/\.(exe|apk)([?#]|$)/i.test(href)) return
    const controller = new AbortController()
    void fetchDownloadSizeLabel(href, controller.signal).then((value) => {
      if (!controller.signal.aborted) setLabel(value)
    })
    return () => controller.abort()
  }, [href])
  return label
}

export default function GetDesktop() {
  // APP 卡直下链=发布通道 json 真链（/app-release.json——发版换链不换页[GetApp 同律]；读不到=落 /get-app 扫码页兜底）
  const [apkUrl, setApkUrl] = useState('/get-app')
  const orgSize = useDownloadSizeLabel(PKG_ORG)
  const appSize = useDownloadSizeLabel(apkUrl)
  useEffect(() => {
    fetch('/app-release.json', { cache: 'no-store' }) // portal#112：通道件请求强制走网——浏览器启发式缓存旧版链雷面封死
      .then((r) => r.json())
      .then((d) => { if (typeof d?.url === 'string' && d.url) setApkUrl(d.url) })
      .catch(() => {})
  }, [])
  return (
    <section className="mx-auto max-w-site px-5 py-16 md:px-12 md:py-20">
      {/* 页头 */}
      <div className="text-center">
        <p className="hud-label text-pulse-cyan/80">DESKTOP DOWNLOAD & REGISTER</p>
        <h1 className="mt-3 font-display text-3xl font-bold tracking-[0.02em] text-ink-primary md:text-4xl">
          智能工作台 · 下载注册中心
        </h1>
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-ink-secondary">
          下载后双击即装，桌面出图标——组织智能体运行时桌面端（三屏本地渲染不拉网页）+手机 APP 移动端。代码留在你自己的边缘节点跑。
          <span className="text-jade-green">内测期免费。</span>
        </p>
      </div>

      {/* 每日邀测口令卡（彭总 2026-10-23 令——兑码开户动线同页闭环） */}
      <DailyCodeCard />

      {/* 三包卡（彭总 2026-10-20 令：APP 卡提首屏——下载注册中心=桌面双版+APP 三面齐） */}
      <div className="mt-12 grid gap-6 md:grid-cols-2"> {/* 彭总 2026-10-22 令：只留组织运行时+APP 两卡面 */}

        <DownloadCard
          title="NumX Max 组织智能体运行时 · Windows 版"
          desc="组织运行时桌面端——全企驾驶舱/部门舱长屏/岗位屏三屏本地渲染（不拉网页）：五舱矩阵、派活链、复核队列、推送铃铛、跨企业协同空间全在。装完输企业邀请码即进组织。"
          href={PKG_ORG}
          meta={`${PKG_OS_LABEL}${orgSize ? ` · ${orgSize}` : ''}`}
          accent="violet"
          icon={<Building2 className="h-9 w-9 text-nebula-violet" />}
        />
        <DownloadCard
          title="NumX Max APP · Android 版"
          desc="手机随身面——与桌面端扫码配对（带码预填免二次登录）：装完桌面端，里面扫码装；也可 Android 直下。iOS 上架中（不装假）。"
          href={apkUrl}
          meta={`Android 版${appSize ? ` · ${appSize}` : ''}`}
          btnLabel="下载 APP（Android 安装包）"
          accent="green"
          icon={<Smartphone className="h-9 w-9 text-jade-green" />}
        />
      </div>

      {/* 安装说明 */}
      <div className="glass-panel relative mx-auto mt-10 max-w-2xl rounded-xl p-6">
        <HudCorner />
        <p className="hud-label text-pulse-cyan/80">安装说明 · 4 步</p>
        <ol className="mt-4 space-y-2.5 text-sm">
          {INSTALL_STEPS.map((s, i) => (
            <li key={s} className="flex items-center gap-3 text-ink-secondary">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-pulse-cyan/40 font-mono text-[10px] text-pulse-cyan">{i + 1}</span>
              {s}
            </li>
          ))}
        </ol>
      </div>

      {/* 系统要求+申请入口+手机 APP 引导 */}
      <div className="mx-auto mt-6 grid max-w-2xl gap-4">
        <div className="rounded-xl border border-line-subtle/60 bg-void/40 p-4 text-xs leading-relaxed">
          <p className="flex items-center gap-2 text-jade-green"><CheckCircle2 className="h-4 w-4" />支持：{PKG_OS_LABEL}</p>
          <p className="mt-1.5 flex items-center gap-2 text-ink-faint"><XCircle className="h-4 w-4" />暂不支持：macOS / Linux（桌面端在途——不装假）</p>
        </div>
        <p className="text-center text-xs text-ink-faint">
          还没有账号？<Link to="/?beta=open" className="text-jade-green underline-offset-2 hover:underline">申请内测资格（名额有限，先到先得——报名面自动开）→</Link>
        </p>
        {/* 尾部 APP 小链已摘（彭总 2026-10-20：APP 卡提首屏=不重复面；/get-app 落地页保留为扫码落点） */}
      </div>
    </section>
  )
}
