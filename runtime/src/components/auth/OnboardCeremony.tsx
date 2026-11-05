/**
 * OnboardCeremony —— 「建军过场页」（M7-a S1 注册体验核心）。
 *
 * 企业注册成功后调用 agentic.orgAutoSetup（幂等）真实生成组织：
 * 部门编制 / 角色分工 / 专属数字工匠，逐条点亮展示，最后灵枢宣告
 * 「组织已就绪」，一键进入工作台。orgAutoSetup 失败不阻断入驻（可稍后
 * 在工作台组织页重试）。
 */
import { useEffect, useRef, useState } from 'react'
import { ArrowRight, BadgeCheck, Building2, Loader2, ShieldCheck } from 'lucide-react'
import { wbMutation, wbErrorMessage, type WbSession } from '@/lib/wbSession'
import { CEREMONY_GUIDES } from './guideCopy'
import DigitalGuide from './DigitalGuide'
import { cn } from '@/lib/utils'

interface OrgDept {
  name: string
  roles: { role: string; agentName: string; agentId: number | null; agentSource: string }[]
}
interface OrgResult {
  departments: OrgDept[]
  summary: string
  reused?: boolean
}

export default function OnboardCeremony({
  session,
  industryHint,
  onEnter,
}: {
  session: WbSession
  industryHint?: string
  onEnter: () => void
}) {
  const [org, setOrg] = useState<OrgResult | null>(null)
  const [fail, setFail] = useState<string | null>(null)
  const [litCount, setLitCount] = useState(0)
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true
    ;(async () => {
      try {
        const res = await wbMutation<OrgResult>('agentic.orgAutoSetup', {
          token: session.token,
          industryHint: industryHint || undefined,
        })
        setOrg(res)
      } catch (err) {
        setFail(wbErrorMessage(err))
      }
    })()
  }, [session.token, industryHint])

  const totalRoles = org ? org.departments.reduce((n, d) => n + d.roles.length, 0) : 0
  // 逐条点亮动画：组织数据到达后按 250ms/条推进
  useEffect(() => {
    if (!org || totalRoles === 0) return
    const t = setInterval(() => {
      setLitCount((c) => {
        if (c >= totalRoles) {
          clearInterval(t)
          return c
        }
        return c + 1
      })
    }, 250)
    return () => clearInterval(t)
  }, [org, totalRoles])

  const building = !org && !fail
  const done = !!org && litCount >= totalRoles
  const guide = building ? CEREMONY_GUIDES.building : fail ? CEREMONY_GUIDES.fallback : CEREMONY_GUIDES.done

  // 已点亮的角色展平（按部门顺序）
  let litBudget = litCount

  return (
    <div className="space-y-5">
      <div className="text-center">
        <p className="font-mono text-[11px] tracking-[0.3em] text-pulse-cyan">ORGANIZATION BOOTSTRAP</p>
        <h2 className="mt-2 text-2xl font-bold text-ink-primary">
          {building ? '正在为你组建数字军团…' : fail ? '入驻成功' : done ? '组织已就绪' : '军团集结中…'}
        </h2>
        <p className="mt-1 text-sm text-ink-faint">{session.enterpriseName || '你的企业'} · 组织中枢实时编排</p>
      </div>

      <DigitalGuide lines={[guide]} />

      {building && (
        <div className="flex flex-col items-center gap-3 py-10">
          <Loader2 className="h-10 w-10 animate-spin text-pulse-cyan" />
          <p className="text-xs text-ink-faint">orgAutoSetup · 部门编制 / 角色分工 / 工匠匹配中</p>
        </div>
      )}

      {fail && (
        <div className="rounded-xl border border-forge-amber/40 bg-forge-amber/[0.06] px-4 py-3 text-xs leading-relaxed text-forge-amber">
          组织自动配置暂时未完成（{fail}）。不影响入驻——进入工作台后可随时在「组织管理」一键重试。
        </div>
      )}

      {org && (
        <div className="space-y-3">
          {org.departments.map((dept) => {
            const deptRoles = dept.roles.map((r) => {
              const lit = litBudget > 0
              litBudget -= 1
              return { ...r, lit }
            })
            const deptLit = deptRoles.some((r) => r.lit)
            return (
              <div
                key={dept.name}
                className={cn(
                  'rounded-xl border px-4 py-3 transition-all duration-500',
                  deptLit ? 'border-pulse-cyan/30 bg-pulse-cyan/[0.04] opacity-100' : 'border-ink-faint/15 opacity-40',
                )}
              >
                <div className="flex items-center gap-2 text-sm font-medium text-ink-primary">
                  <Building2 className="h-4 w-4 text-pulse-cyan" />
                  {dept.name}
                </div>
                <div className="mt-2 space-y-1.5">
                  {deptRoles.map((r) => (
                    <div
                      key={`${dept.name}-${r.role}`}
                      className={cn(
                        'flex items-center gap-2 text-xs transition-all duration-500',
                        r.lit ? 'translate-x-0 opacity-100' : 'translate-x-2 opacity-0',
                      )}
                    >
                      <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-jade-green" />
                      <span className="text-ink-secondary">{r.role}</span>
                      <span className="text-ink-faint">·</span>
                      <span className="font-medium text-forge-amber">{r.agentName}</span>
                      <span className="text-ink-faint">已到位</span>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
          <p className="flex items-center gap-2 text-xs text-ink-faint">
            <ShieldCheck className="h-3.5 w-3.5 text-jade-green" />
            {org.summary}
            {org.reused ? '（组织此前已生成，幂等复用）' : ''}
          </p>
        </div>
      )}

      <button
        type="button"
        onClick={onEnter}
        disabled={building}
        className="flex w-full items-center justify-center gap-2 rounded-[10px] bg-amber-gradient py-2.5 text-sm font-medium text-[#1A1206] transition-shadow hover:shadow-[0_0_24px_rgba(245,165,36,0.4)] disabled:opacity-50"
      >
        {done || fail ? (
          <>
            进入智能工作台 <ArrowRight className="h-4 w-4" />
          </>
        ) : (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> 军团集结中…
          </>
        )}
      </button>
    </div>
  )
}
