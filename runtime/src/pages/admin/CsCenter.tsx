/**
 * CsCenter（/admin/cs-center）—— 客服中心（迭代 27，opsCenter.getCsConfig/saveCsConfig）。
 * 三个文本域（欢迎语 / 人设提示词 / 转人工话术）+ 保存；此配置实时驱动数字匠市与
 * 智能工作台的智能客服（assistant welcome/ask 读取 cs_config）。
 */
import { Fragment, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Headset, Save } from 'lucide-react'
import { useWbSession, wbQuery, wbMutation, wbErrorMessage } from '@/lib/wbSession'
import { WbButton, WbEmpty, WbError, WbLoading, WbNotice, WbPageHeader, WbPanel, wbInputCls, wbLabelCls } from '@/components/wb/ui'
import { AdminTable, adminTdCls, adminConfirm, fmtTime } from '@/pages/admin/shared'
import { cn } from '@/lib/utils'

interface CsConfig {
  welcome: string
  personaPrompt: string
  handoffHint: string
}

// ─── 访客会话（opsCenter.csSessions / csSessionDetail，迭代 28）────────────────
interface CsSessionRow {
  sessionKey: string
  ip: string
  ua: string
  firstAt: unknown
  lastAt: unknown
  msgCount: number
  lastMessage: string
}

interface CsSessionMessage {
  role: string
  content: string
  intent: string | null
  ts: unknown
}

function CsSessionDetail({ token, sessionKey }: { token: string; sessionKey: string }) {
  const [data, setData] = useState<{ sessionKey: string; messages: CsSessionMessage[] } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    wbQuery<{ sessionKey: string; messages: CsSessionMessage[] }>('opsCenter.csSessionDetail', { token, sessionKey })
      .then((res) => {
        setData(res)
        setError(null)
      })
      .catch((err) => setError(wbErrorMessage(err)))
  }, [token, sessionKey])

  if (error) return <WbError message={error} className="px-3 py-3" />
  if (!data) return <WbLoading text="会话详情加载中…" />
  if (data.messages.length === 0) return <WbEmpty text="该会话暂无消息记录" />

  return (
    <div className="space-y-2.5 rounded-xl border border-line-subtle bg-void/40 p-4">
      {data.messages.map((m, i) =>
        m.role === 'user' ? (
          <div key={i} className="flex justify-end">
            <div className="max-w-[78%] rounded-xl rounded-br-sm border border-forge-amber/30 bg-forge-amber/[0.12] px-3.5 py-2.5">
              <div className="mb-1 flex items-center justify-end gap-2">
                {m.intent && (
                  <span className="rounded-full border border-pulse-cyan/40 bg-pulse-cyan/10 px-2 py-0.5 font-mono text-[10px] text-pulse-cyan">
                    {m.intent}
                  </span>
                )}
                <span className="text-xs font-medium text-forge-amber">访客</span>
              </div>
              <p className="whitespace-pre-line text-sm leading-relaxed text-ink-primary">{m.content}</p>
              <p className="mt-1 text-right text-[10px] text-ink-faint">{fmtTime(m.ts)}</p>
            </div>
          </div>
        ) : (
          <div key={i} className="flex justify-start">
            <div className="max-w-[80%] rounded-xl rounded-bl-sm border border-line-subtle bg-panel/70 px-3.5 py-2.5">
              <div className="mb-1 flex items-center gap-2">
                <span className="text-xs font-medium text-ink-secondary">🤖 智能客服</span>
              </div>
              <p className="whitespace-pre-line text-sm leading-relaxed text-ink-primary">{m.content}</p>
              <p className="mt-1 text-[10px] text-ink-faint">{fmtTime(m.ts)}</p>
            </div>
          </div>
        ),
      )}
    </div>
  )
}

function CsSessionsPanel({ token }: { token: string }) {
  const [rows, setRows] = useState<CsSessionRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedKey, setExpandedKey] = useState<string | null>(null)

  useEffect(() => {
    wbQuery<{ rows: CsSessionRow[]; total: number }>('opsCenter.csSessions', { token })
      .then((res) => {
        setRows(res.rows)
        setError(null)
      })
      .catch((err) => setError(wbErrorMessage(err)))
  }, [token])

  return (
    <WbPanel title="访客会话" hud="CS SESSIONS" className="mt-6">
      <p className="mb-4 text-xs leading-relaxed text-ink-faint">
        数字匠市与智能工作台智能客服的访客会话记录（按最后活跃倒序，点击行展开对话详情）。
      </p>
      {rows === null && !error && <WbLoading />}
      <WbError message={error} />
      {rows && rows.length === 0 && <WbEmpty text="暂无访客会话记录" hint="访客与智能客服对话后将在此生成会话。" />}
      {rows && rows.length > 0 && (
        <AdminTable head={['会话 Key', 'IP', 'User-Agent', '消息数', '最后活跃', '最新摘要', '']}>
          {rows.map((r) => (
            <Fragment key={r.sessionKey}>
              <tr
                onClick={() => setExpandedKey((prev) => (prev === r.sessionKey ? null : r.sessionKey))}
                className="cursor-pointer transition-colors hover:bg-forge-amber/[0.04]"
              >
                <td className={adminTdCls + ' font-mono text-ink-primary'} title={r.sessionKey}>
                  {r.sessionKey.slice(0, 12)}…
                </td>
                <td className={adminTdCls}>{r.ip || '—'}</td>
                <td className={adminTdCls} title={r.ua}>
                  <span className="inline-block max-w-[220px] truncate align-middle">{r.ua ? r.ua.slice(0, 30) : '—'}</span>
                </td>
                <td className={adminTdCls}>{r.msgCount}</td>
                <td className={adminTdCls}>{fmtTime(r.lastAt)}</td>
                <td className={adminTdCls}>
                  <span className="inline-block max-w-[240px] truncate align-middle">{r.lastMessage || '—'}</span>
                </td>
                <td className={adminTdCls}>
                  {expandedKey === r.sessionKey ? (
                    <ChevronDown className="h-4 w-4 text-ink-faint" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-ink-faint" />
                  )}
                </td>
              </tr>
              {expandedKey === r.sessionKey && (
                <tr>
                  <td colSpan={7} className="px-3 py-3">
                    <CsSessionDetail token={token} sessionKey={r.sessionKey} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </AdminTable>
      )}
    </WbPanel>
  )
}

export default function AdminCsCenter() {
  const { session } = useWbSession()
  const [form, setForm] = useState<CsConfig>({ welcome: '', personaPrompt: '', handoffHint: '' })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [activeTab, setActiveTab] = useState<'config' | 'sessions'>('config')

  useEffect(() => {
    if (!session?.token) return
    wbQuery<CsConfig>('opsCenter.getCsConfig', { token: session.token })
      .then((res) => {
        setForm({
          welcome: res.welcome ?? '',
          personaPrompt: res.personaPrompt ?? '',
          handoffHint: res.handoffHint ?? '',
        })
        setLoading(false)
      })
      .catch((err) => {
        setError(wbErrorMessage(err))
        setLoading(false)
      })
  }, [session?.token])

  async function handleSave() {
    if (!session?.token) return
    if (!adminConfirm('保存智能客服配置')) return
    setError(null)
    setNotice(null)
    setPending(true)
    try {
      await wbMutation('opsCenter.saveCsConfig', { token: session.token, ...form })
      setNotice('客服配置已保存，提交后由系统执行，实时生效于数字匠市与智能工作台的智能客服。')
    } catch (err) {
      setError(wbErrorMessage(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <div>
      <WbPageHeader
        hud="CS CENTER"
        title="客服中心"
        desc="此配置实时驱动数字匠市与智能工作台的智能客服：欢迎语为会话开场白，人设提示词注入系统提示，转人工话术用于引导人工介入。"
      />

      {/* 分区 Tab：智能客服配置 / 访客会话 */}
      <div className="mb-6 flex gap-2 border-b border-line-subtle pb-3">
        {(
          [
            { key: 'config', label: '智能客服配置' },
            { key: 'sessions', label: '访客会话' },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActiveTab(t.key)}
            className={cn(
              'rounded-[8px] border px-3.5 py-1.5 text-xs transition-colors duration-300',
              activeTab === t.key
                ? 'border-forge-amber/40 bg-forge-amber/[0.12] text-forge-amber'
                : 'border-line-subtle text-ink-secondary hover:border-pulse-cyan/40 hover:text-ink-primary',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'sessions' && session?.token && <CsSessionsPanel token={session.token} />}

      {activeTab === 'config' && (
      <WbPanel
        hud="CS CONFIG"
        title="智能客服配置"
        actions={
          <WbButton loading={pending} onClick={() => void handleSave()}>
            <Save className="h-4 w-4" />
            保存配置
          </WbButton>
        }
      >
        {loading ? (
          <WbLoading text="客服配置加载中…" />
        ) : (
          <div className="space-y-4">
            <div>
              <label className={wbLabelCls}>欢迎语</label>
              <textarea
                className={cn(wbInputCls, 'min-h-[72px] resize-y')}
                value={form.welcome}
                onChange={(e) => setForm((f) => ({ ...f, welcome: e.target.value }))}
                placeholder="访客打开智能客服时的开场白"
              />
            </div>
            <div>
              <label className={wbLabelCls}>人设提示词</label>
              <textarea
                className={cn(wbInputCls, 'min-h-[140px] resize-y font-mono text-xs')}
                value={form.personaPrompt}
                onChange={(e) => setForm((f) => ({ ...f, personaPrompt: e.target.value }))}
                placeholder="注入 system prompt 的人设与口径约束（身份、语气、边界）"
              />
            </div>
            <div>
              <label className={wbLabelCls}>转人工话术</label>
              <textarea
                className={cn(wbInputCls, 'min-h-[72px] resize-y')}
                value={form.handoffHint}
                onChange={(e) => setForm((f) => ({ ...f, handoffHint: e.target.value }))}
                placeholder="用户要求人工或超出能力范围时的引导话术（如微信/电话）"
              />
            </div>
            <p className="flex items-center gap-1.5 text-[11px] leading-relaxed text-ink-faint">
              <Headset className="h-3 w-3" />
              留空字段将使用系统默认文案；保存后即时生效，无需重启服务。
            </p>
            <WbNotice message={notice} />
            <WbError message={error} />
          </div>
        )}
      </WbPanel>
      )}
    </div>
  )
}
