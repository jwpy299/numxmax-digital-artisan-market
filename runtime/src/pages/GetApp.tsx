/**
 * GetApp（/get-app）—— APP 配对下载落地页（波四片 2，2026-10-01）。
 *
 * 桌面端「手机中心」二维码统一指向本页（?from=wb-ent / wb-personal / portal / qr）：
 * - Android：自动触发 APK 下载（发布通道 json 真链）+手动钮兜底；
 * - iOS：诚实条「上架中」（P-IOS-STORE 在途）——不装假、不钓鱼，Android 用户可转链；
 * - PC 直访：给 APK 直链+提示回桌面端扫码配对。
 * 归因：from 参数展示来源（统计面挂账 P-APP-ATTRIB）。
 * 彭总链路钉：#code=iv_xxx fragment 带码预填（wb#77 六轮票：fragment 永不发服务器=日志不落明文治本）——
 * 码卡出示同一邀请码+复制（注册时连同手机号粘进邀请码栏）；
 * 只收 iv_+48hex 形态（共享件 INVITE_CODE_RE 单源——杂串不上屏=钓鱼文案面封死）；无 code 不渲卡（原口径不破）。
 */
import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import { Download, Smartphone, ArrowLeft, Copy, Check } from 'lucide-react'
import HudCorner from '@/components/HudCorner'
import { useDeviceKind } from '@/hooks/use-device-kind'
import { parseInviteCode } from '@/lib/wbInvites'
import { useCopyToClipboard, type CopyState } from '@/lib/useCopyToClipboard'

const FROM_LABEL: Record<string, string> = {
  'wb-ent': '企业智能工作台',
  'wb-personal': '个人智能工作台',
  portal: '门户网页',
  qr: '二维码分享',
}

/** 复制钮文案单点（portal#55 复审票：JSX 嵌套三元拆平——三态一读即懂；态机本体+CopyState 类型同走共享 hook 单源） */
function copyLabelOf(state: CopyState): string {
  if (state === 'failed') return '复制失败·请手动选择复制'
  if (state === 'copied') return '已复制'
  return '复制'
}


export default function GetApp() {
  const [params] = useSearchParams()
  const from = params.get('from') ?? 'qr'
  const fromLabel = FROM_LABEL[from] ?? '二维码分享'

  const device = useDeviceKind()

  const [apkUrl, setApkUrl] = useState<string | null>(null)
  const [version, setVersion] = useState<string>('')
  const [manifestErr, setManifestErr] = useState(false)
  // 带码面（彭总链路钉）：iv_+48hex 形态才出示——React 转义之上再加形态闸，杂串/钓串不上屏
  // 凭证钉（wb#77 六轮 security 票）：码走 fragment（#code=）不走 query——fragment 永不发服务器，访问日志天然不落明文；
  // useLocation().hash 响应式+parseInviteCode 单源（剥 # 后 URLSearchParams 契约同构）
  const { hash } = useLocation()
  const pairCode = useMemo(() => parseInviteCode(hash.replace(/^#/, '')), [hash])
  // 复制态机走共享 hook（portal#55 四轮票：双旗标互斥失控矛盾态封死——三态天然互斥；缺失判/复位窗/定时器清单点）
  const { state: copyState, copy } = useCopyToClipboard()
  function loadManifest() {
    setManifestErr(false)
    fetch('/app-release.json', { cache: 'no-store' }) // portal#112：通道件请求强制走网——浏览器启发式缓存旧版链雷面封死
      .then((r) => r.json())
      .then((d) => {
        if (d?.url) setApkUrl(d.url)
        if (d?.version) setVersion(String(d.version))
        if (!d?.url) setManifestErr(true)
      })
      .catch(() => setManifestErr(true))
  }
  useEffect(loadManifest, [])

  // Android：落地即自动触发下载（浏览器多会弹确认，属正常）
  useEffect(() => {
    if (device === 'android' && apkUrl) {
      const t = setTimeout(() => { window.location.href = apkUrl }, 600)
      return () => clearTimeout(t)
    }
  }, [device, apkUrl])

  return (
    <div className="cyber-grid-bg relative flex min-h-screen items-center justify-center overflow-hidden bg-void px-4">
      <div className="pointer-events-none absolute -top-40 left-1/2 h-[420px] w-[720px] -translate-x-1/2 bg-[radial-gradient(ellipse,rgba(245,165,36,0.12),transparent_65%)]" />
      <div className="cyber-glow-card relative w-full max-w-md rounded-2xl bg-zinc-950/85 p-8 text-center">
        <HudCorner />
        <img src="/logo-mark.png" alt="NumX Max" className="mx-auto h-12 w-12 object-contain" />
        <p className="mt-4 font-display text-xl font-bold text-ink-primary">NumX Max APP</p>
        <p className="mt-1.5 text-xs text-ink-faint">
          来自「{fromLabel}」的配对下载{version ? ` · v${version}` : ''}
        </p>

        {pairCode && (
          <div className="mt-5 rounded-[12px] border border-amber-400/30 bg-amber-400/[0.06] px-4 py-3 text-left">
            <p className="text-[11px] text-ink-faint">你的邀请码（随链带到——注册时连同手机号一起输入）</p>
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <code className="break-all font-mono text-[13px] leading-snug text-amber-300">{pairCode}</code>
              <button
                onClick={() => copy(pairCode)}
                className="flex shrink-0 items-center gap-1 rounded-[8px] border border-line-subtle px-2 py-1 text-[11px] text-ink-secondary transition-colors hover:border-amber-400/40 hover:text-amber-300"
              >
                {copyState === 'copied' ? <Check className="h-3 w-3 text-jade-green" /> : <Copy className="h-3 w-3" />}
                {copyLabelOf(copyState)}
              </button>
            </div>
          </div>
        )}

        {device === 'android' && (
          <div className="mt-6 space-y-4">
            {manifestErr ? (
              <button onClick={loadManifest}
                className="w-full rounded-[12px] border border-ember-red/40 bg-ember-red/[0.06] px-4 py-3 text-sm text-ember-red transition-colors hover:bg-ember-red/[0.12]">
                下载通道异常——点我重试
              </button>
            ) : (
              <div className="rounded-[12px] border border-jade-green/30 bg-jade-green/[0.06] px-4 py-3 text-sm text-jade-green">
                正在为你启动下载…没反应就点下面按钮
              </div>
            )}
            <button
              onClick={() => { if (apkUrl) window.location.href = apkUrl }}
              className="flex w-full items-center justify-center gap-2 rounded-[10px] bg-amber-400 py-3 text-base font-semibold text-zinc-950 transition-colors hover:bg-amber-300"
            >
              <Download className="h-4 w-4" /> 下载 Android 安装包（APK）
            </button>
            <p className="text-xs text-ink-faint">
              安装后打开——企业版/个人版自动适配；与「{fromLabel}」同一账号直接登录
            </p>
          </div>
        )}

        {device === 'ios' && (
          <div className="mt-6 space-y-4">
            <div className="rounded-[12px] border border-amber-400/30 bg-amber-400/[0.06] px-4 py-4 text-sm leading-relaxed text-ink-secondary">
              <p className="font-semibold text-amber-400">iOS 版上架中</p>
              <p className="mt-2">
                App Store 审核在途（彭总督办了）。到货后 APP 内和门户会第一时间开放——
                现在可以先用电脑访问门户，或让 Android 手机扫码本页下载。
              </p>
            </div>
            <Link
              to="/"
              className="flex w-full items-center justify-center gap-2 rounded-[10px] border border-pulse-cyan/40 bg-pulse-cyan/[0.08] py-3 text-sm font-medium text-pulse-cyan transition-colors hover:bg-pulse-cyan/[0.15]"
            >
              <ArrowLeft className="h-4 w-4" /> 先去门户逛逛（电脑体验更完整）
            </Link>
          </div>
        )}

        {device === 'pc' && (
          <div className="mt-6 space-y-4">
            <div className="rounded-[12px] border border-line-subtle bg-zinc-900/60 px-4 py-4 text-sm leading-relaxed text-ink-secondary">
              这页是给手机准备的——用 Android 手机扫码本页二维码即可下载；
              也可以直接把安装包发到手机：
            </div>
            <button
              onClick={() => { if (apkUrl) window.location.href = apkUrl }}
              className="flex w-full items-center justify-center gap-2 rounded-[10px] border border-jade-green/40 bg-jade-green/[0.08] py-3 text-sm font-medium text-jade-green transition-colors hover:bg-jade-green/[0.15]"
            >
              <Download className="h-4 w-4" /> 直接下载 APK（手动传到手机）
            </button>
            <Link to="/" className="block text-xs text-ink-faint transition-colors hover:text-pulse-cyan">
              <Smartphone className="mr-1 inline h-3.5 w-3.5" /> 回门户首页
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}
