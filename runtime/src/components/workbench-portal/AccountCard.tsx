import { useState, type FormEvent } from 'react'
import { motion } from 'framer-motion'
import { CloudOff, Loader2, LogIn, LogOut, ShieldCheck, UserRound, Building2 } from 'lucide-react'
import SectionHeader from '@/components/SectionHeader'
import HudCorner from '@/components/HudCorner'
import EnterpriseRegisterForm from '@/components/auth/EnterpriseRegisterForm'
import { trpc } from '@/providers/trpc'
import { wbMutation, wbErrorMessage, type WbSession } from '@/lib/wbSession'
import { WbError, wbInputCls, wbLabelCls } from '@/components/wb/ui'
import { cn } from '@/lib/utils'
import type { WorkbenchSession } from './session'
import { resolveWorkbenchUrl, WB_LOGIN_PERSON_PATH } from '@/config/workbench' // 跳链单点（个人注册引导——wb 登录页个人 tab）

/** 账号卡锚点 ID：跳转主卡在「无 token」时滚动引导至此 */
export const ACCOUNT_CARD_ANCHOR_ID = 'workbench-account-card'

interface AccountCardProps {
  session: WorkbenchSession | null
  onSessionChange: (session: WorkbenchSession | null) => void
}

/**
 * 工作台账号卡：企业注册 / 登录两个 Tab，成功后会话写入 localStorage("nebula_auth")。
 * 迭代 21：注册与登录表单与智能工作台（3000 /wb/login）完全一致——
 * 注册复用 EnterpriseRegisterForm（agentic.authRegisterEnterprise，含行业 12 大类 /
 * 人员规模 / 信用代码 / 部门组织架构编辑器 / 经营痛点）；
 * 登录走 agentic.authLogin（identifier 按手机号/账号匹配）。
 */
export default function AccountCard({ session, onSessionChange }: AccountCardProps) {
  const [tab, setTab] = useState<'register' | 'login'>('login')

  // 登录表单（与 WbLogin 一致：手机号或账号 + 密码）
  const [loginForm, setLoginForm] = useState({ identifier: '', password: '' })
  const [formError, setFormError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  // 已连接时用 authMe 校验本地 token 是否仍然有效（token 单点有效，可能已失效）
  const meQuery = trpc.workbenchLink.workbenchMe.useQuery(
    { token: session?.token ?? '' },
    { enabled: !!session?.token, retry: false, staleTime: 60_000 },
  )

  function handleResult(info: WbSession) {
    // 会话对象（含 token）原样存入 localStorage("nebula_auth")，沿用官方文档约定
    onSessionChange({ ...info })
    setFormError(null)
  }

  async function handleLogin(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    setPending(true)
    try {
      const info = await wbMutation<WbSession>('agentic.authLogin', {
        identifier: loginForm.identifier.trim(),
        password: loginForm.password,
      })
      handleResult(info)
    } catch (err) {
      setFormError(wbErrorMessage(err))
    } finally {
      setPending(false)
    }
  }

  function handleDisconnect() {
    onSessionChange(null) // 清除 localStorage("nebula_auth")
    setFormError(null)
  }

  const meInvalid =
    meQuery.isSuccess && meQuery.data.ok && meQuery.data.me === null

  return (
    <section id={ACCOUNT_CARD_ANCHOR_ID} className="relative scroll-mt-24 bg-void">
      <div className="mx-auto max-w-site px-5 py-16 md:px-12 md:py-24">
        <SectionHeader
          hud="WORKBENCH ACCOUNT"
          title="工作台账号"
          subtitle="注册企业或登录已有账号，会话将保存在本机 localStorage(nebula_auth)，用于一键免密跳转工作台。"
        />

        <motion.div
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className="glass-panel relative mx-auto mt-12 max-w-2xl rounded-2xl p-7 md:p-10"
        >
          <HudCorner />

          {session ? (
            /* 已连接状态 */
            <div className="text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl border border-jade-green/30 bg-jade-green/10">
                <ShieldCheck className="h-7 w-7 text-jade-green" />
              </div>
              <h3 className="mt-5 text-lg font-bold text-ink-primary">
                已连接{session.enterpriseName ? ` · ${session.enterpriseName}` : ''}
              </h3>
              <p className="mt-2 text-sm text-ink-secondary">
                {session.displayName || session.username || '工作台用户'}
                {session.role ? `（${session.role}）` : ''}
              </p>

              {meInvalid && (
                <p className="mx-auto mt-4 flex max-w-sm items-center justify-center gap-2 rounded-xl border border-forge-amber/30 bg-forge-amber/[0.06] px-4 py-3 text-xs text-forge-amber">
                  <CloudOff className="h-4 w-4 shrink-0" />
                  当前登录态已失效（token 单点有效，可能在别处重新登录），请断开后重新登录。
                </p>
              )}
              {meQuery.isSuccess && !meQuery.data.ok && !meQuery.data.reachable && (
                <p className="mx-auto mt-4 flex max-w-sm items-center justify-center gap-2 rounded-xl border border-forge-amber/30 bg-forge-amber/[0.06] px-4 py-3 text-xs text-forge-amber">
                  <CloudOff className="h-4 w-4 shrink-0" />
                  {meQuery.data.message}
                </p>
              )}

              <div className="mt-6 flex justify-center">
                <button
                  type="button"
                  onClick={handleDisconnect}
                  className="inline-flex items-center gap-2 rounded-[10px] border border-line-subtle px-5 py-2.5 text-sm text-ink-primary transition-colors duration-300 hover:border-ember-red/50 hover:bg-ember-red/[0.08] hover:text-ember-red"
                >
                  <LogOut className="h-4 w-4" />
                  断开连接
                </button>
              </div>
              <p className="mt-4 font-mono text-[11px] tracking-wider text-ink-faint">
                SESSION · localStorage(nebula_auth)
              </p>
            </div>
          ) : (
            /* 注册 / 登录 Tab（与 3000 智能工作台 /wb/login 一致） */
            <>
              <div className="mb-6 grid grid-cols-2 gap-1 rounded-[10px] border border-line-subtle bg-void/60 p-1">
                {(
                  [
                    { key: 'login', label: '登录', icon: UserRound },
                    { key: 'register', label: '企业注册', icon: Building2 },
                  ] as const
                ).map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => {
                      setTab(t.key)
                      setFormError(null)
                    }}
                    className={cn(
                      'flex items-center justify-center gap-2 rounded-[8px] py-2 text-sm font-medium transition-colors duration-300',
                      tab === t.key
                        ? 'bg-pulse-cyan/[0.12] text-pulse-cyan'
                        : 'text-ink-secondary hover:text-ink-primary',
                    )}
                  >
                    <t.icon className="h-4 w-4" />
                    {t.label}
                  </button>
                ))}
              </div>

              {/* 个人注册引导（彭总 2026-10-15 令——注册链路归动线层）：跳 wb 登录页个人 tab（?tab=person=手机号+验证码+邀测码面[主线①个人报名链]）；表单不双写（portal#57 双写漂移钉） */}
              <p className="mt-4 text-center text-xs text-ink-faint">
                个人用户？
                <a
                  href={resolveWorkbenchUrl(WB_LOGIN_PERSON_PATH)}
                  className="ml-1 font-medium text-pulse-cyan underline-offset-2 hover:underline"
                >
                  前往个人工作台注册（手机号+邀测码） →
                </a>
              </p>
              {tab === 'login' ? (
                <form onSubmit={(e) => void handleLogin(e)} className="space-y-4">
                  <div>
                    <label className={wbLabelCls}>手机号或账号</label>
                    <input
                      className={wbInputCls}
                      value={loginForm.identifier}
                      onChange={(e) => setLoginForm({ ...loginForm, identifier: e.target.value })}
                      placeholder="手机号 / 工作台账号"
                      autoComplete="username"
                      required
                    />
                  </div>
                  <div>
                    <label className={wbLabelCls}>密码</label>
                    <input
                      type="password"
                      className={wbInputCls}
                      value={loginForm.password}
                      onChange={(e) => setLoginForm({ ...loginForm, password: e.target.value })}
                      placeholder="登录密码"
                      autoComplete="current-password"
                      required
                    />
                  </div>
                  <WbError message={formError} />
                  <button
                    type="submit"
                    disabled={pending}
                    className="flex w-full items-center justify-center gap-2 rounded-[10px] bg-amber-gradient px-6 py-3 text-sm font-medium text-[#1A1206] transition-shadow duration-300 hover:shadow-[0_0_28px_rgba(245,165,36,0.45)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
                    登录并连接工作台
                  </button>
                  <p className="text-center text-xs text-ink-faint">
                    登录会重颁 token（单点有效），其他端的旧登录态将失效。
                  </p>
                </form>
              ) : (
                <EnterpriseRegisterForm
                  onSuccess={handleResult}
                  submitLabel="注册企业并连接工作台"
                />
              )}
            </>
          )}
        </motion.div>
      </div>
    </section>
  )
}
