/**
 * WechatCs（/admin/wechat-cs）—— 灵智枢智能运营 · 对外智能客服（微信公众号/服务号接入）。
 *
 * 分区一「接入配置」：回调地址展示（只读可复制）+ Token/AppID/EncodingAESKey/欢迎语表单
 *   （已存值掩码显示，留空保持不变 → wechat.saveConfig）；
 * 分区二「接入指引」：微信公众平台 → 设置与开发 → 基本配置 → 服务器配置；
 * 分区三「测试对话」：wechat.testChat，与真实微信回调同一应答逻辑（带 degraded 标注与 provider）。
 *
 * 数据：wechat.getConfig / wechat.saveConfig / wechat.testChat（token 仅在请求体；密钥掩码返回）。
 */
import { useState } from 'react'
import { Copy, MessageCircleQuestion, Save, Send } from 'lucide-react'
import { useWbSession, useWbQuery, wbMutation, wbErrorMessage } from '@/lib/wbSession'
import {
  WbButton,
  WbError,
  WbLoading,
  WbNotice,
  WbPageHeader,
  WbPanel,
  wbInputCls,
  wbLabelCls,
} from '@/components/wb/ui'
import { ProviderTag } from './shared'

interface WechatConfigView {
  configured: boolean
  callbackPath: string
  token: string | null
  appId: string | null
  encodingAesKey: string | null
  welcome: string
  updatedAt: unknown
}

interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
  provider?: string | null
  degraded?: boolean
}

export default function AdminWechatCs() {
  const { session } = useWbSession()
  const configQuery = useWbQuery<WechatConfigView>('wechat.getConfig', session)
  const cfg = configQuery.data

  const callbackUrl = `${window.location.origin}${cfg?.callbackPath ?? '/api/wechat/callback'}`

  const [form, setForm] = useState({ wxToken: '', appId: '', encodingAesKey: '', welcome: '' })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [chatInput, setChatInput] = useState('')
  const [chatLog, setChatLog] = useState<ChatMsg[]>([])
  const [chatting, setChatting] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)

  async function copyCallback() {
    try {
      await navigator.clipboard.writeText(callbackUrl)
      setNotice('回调地址已复制。')
    } catch {
      window.prompt('请手动复制回调地址：', callbackUrl)
    }
  }

  async function handleSave() {
    if (!session?.token) return
    setSaveError(null)
    setNotice(null)
    setSaving(true)
    try {
      await wbMutation('wechat.saveConfig', {
        token: session.token,
        wxToken: form.wxToken.trim(),
        appId: form.appId.trim(),
        encodingAesKey: form.encodingAesKey.trim(),
        welcome: form.welcome.trim(),
      })
      setNotice('配置已保存。提交后由系统执行，页面刷新后生效。')
      setForm({ wxToken: '', appId: '', encodingAesKey: '', welcome: '' })
      configQuery.refetch()
    } catch (err) {
      setSaveError(wbErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  async function handleSend() {
    if (!session?.token || !chatInput.trim()) return
    const message = chatInput.trim()
    setChatError(null)
    setChatting(true)
    setChatInput('')
    const history = chatLog.slice(-8).map((m) => ({ role: m.role, content: m.content }))
    setChatLog((log) => [...log, { role: 'user', content: message }])
    try {
      const res = await wbMutation<{ reply: string; provider: string | null; degraded: boolean }>(
        'wechat.testChat',
        { token: session.token, message, history },
      )
      setChatLog((log) => [
        ...log,
        { role: 'assistant', content: res.reply, provider: res.provider, degraded: res.degraded },
      ])
    } catch (err) {
      setChatError(wbErrorMessage(err))
    } finally {
      setChatting(false)
    }
  }

  return (
    <div>
      <WbPageHeader
        hud="LINGZHISHU OPS · WECHAT CUSTOMER SERVICE"
        title="对外智能客服"
        desc="微信公众号/服务号文本自动回复：以企业知识库为资料，向微信用户介绍「NumX Max·数字匠市」与「NumX Max 智能工作台」。"
      />

      {/* 分区一：接入配置 */}
      <WbPanel title="接入配置" hud="SERVER CONFIG">
        {configQuery.loading && <WbLoading />}
        <WbError message={configQuery.error} />
        {cfg && (
          <>
            <div className="mb-4 flex items-center gap-2 text-xs">
              <span
                className={
                  cfg.configured
                    ? 'inline-flex rounded-full border border-pulse-cyan/40 bg-pulse-cyan/10 px-2 py-0.5 text-pulse-cyan'
                    : 'inline-flex rounded-full border border-forge-amber/40 bg-forge-amber/10 px-2 py-0.5 text-forge-amber'
                }
              >
                {cfg.configured ? '已配置' : '未配置'}
              </span>
              <span className="text-ink-faint">服务号/订阅号均可接入文本自动回复</span>
            </div>
            <div>
              <label className={wbLabelCls}>回调地址（填入微信公众平台服务器配置 URL）</label>
              <div className="flex gap-2">
                <input className={wbInputCls} readOnly value={callbackUrl} onFocus={(e) => e.target.select()} />
                <WbButton variant="secondary" onClick={() => void copyCallback()}>
                  <Copy className="h-4 w-4" />
                  复制
                </WbButton>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
              <div>
                <label className={wbLabelCls}>Token{cfg.token ? `（当前：${cfg.token}）` : ''}</label>
                <input
                  className={wbInputCls}
                  value={form.wxToken}
                  onChange={(e) => setForm({ ...form, wxToken: e.target.value })}
                  placeholder={cfg.token ? '留空保持不变' : '自定义校验令牌'}
                  maxLength={128}
                  autoComplete="off"
                />
              </div>
              <div>
                <label className={wbLabelCls}>AppID{cfg.appId ? `（当前：${cfg.appId}）` : ''}</label>
                <input
                  className={wbInputCls}
                  value={form.appId}
                  onChange={(e) => setForm({ ...form, appId: e.target.value })}
                  placeholder={cfg.appId ? '留空保持不变' : '公众号 AppID（可空）'}
                  maxLength={64}
                  autoComplete="off"
                />
              </div>
              <div>
                <label className={wbLabelCls}>
                  EncodingAESKey{cfg.encodingAesKey ? `（当前：${cfg.encodingAesKey}）` : ''}
                </label>
                <input
                  className={wbInputCls}
                  value={form.encodingAesKey}
                  onChange={(e) => setForm({ ...form, encodingAesKey: e.target.value })}
                  placeholder={cfg.encodingAesKey ? '留空保持不变' : '消息加解密密钥（可空）'}
                  maxLength={64}
                  autoComplete="off"
                />
              </div>
            </div>
            <div className="mt-3">
              <label className={wbLabelCls}>关注欢迎语</label>
              <textarea
                className={wbInputCls + ' min-h-[72px]'}
                value={form.welcome}
                onChange={(e) => setForm({ ...form, welcome: e.target.value })}
                placeholder={cfg.welcome || '留空保持不变'}
                maxLength={500}
              />
            </div>
            <p className="mt-2 text-[11px] text-ink-faint">
              已存密钥以掩码显示；输入框留空表示保持不变，不会被覆盖。
            </p>
            <div className="mt-4">
              <WbButton onClick={() => void handleSave()} loading={saving}>
                <Save className="h-4 w-4" />
                保存配置
              </WbButton>
            </div>
            <WbError message={saveError} className="mt-3" />
            <WbNotice message={notice} className="mt-3" />
          </>
        )}
      </WbPanel>

      {/* 分区二：接入指引 */}
      <WbPanel title="接入指引" hud="SETUP GUIDE" className="mt-6">
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-ink-secondary">
          <li>登录微信公众平台 →「设置与开发」→「基本配置」→「服务器配置」。</li>
          <li>在 URL 中填入上方回调地址，Token 填入与此处一致的自定义令牌。</li>
          <li>消息加解密方式建议先选「明文模式」；启用安全模式时再回填 EncodingAESKey。</li>
          <li>点击「启用」后，公众号文本消息将由智能客服自动回复；服务号/订阅号均可接入文本自动回复。</li>
          <li>可先在下方「测试对话」中验证应答效果，知识库资料见「企业知识库」页面。</li>
        </ol>
      </WbPanel>

      {/* 分区三：测试对话 */}
      <WbPanel title="测试对话" hud="TEST CHAT" className="mt-6">
        <p className="mb-3 flex items-center gap-1.5 text-[11px] text-ink-faint">
          <MessageCircleQuestion className="h-3.5 w-3.5" />
          与真实微信回调使用同一套应答逻辑（企业知识库 + 实时平台摘要 + 故障转移降级）。
        </p>
        <div className="max-h-[360px] space-y-3 overflow-y-auto rounded-[10px] border border-line-subtle bg-void/40 p-3">
          {chatLog.length === 0 && <p className="text-xs text-ink-faint">输入消息开始测试，例如「数字匠市怎么注册？」</p>}
          {chatLog.map((m, i) =>
            m.role === 'user' ? (
              <div key={i} className="flex justify-end">
                <p className="max-w-[80%] whitespace-pre-wrap rounded-[10px] bg-forge-amber/[0.12] px-3 py-2 text-sm text-ink-primary">
                  {m.content}
                </p>
              </div>
            ) : (
              <div key={i} className="flex flex-col items-start gap-1">
                <p className="max-w-[80%] whitespace-pre-wrap rounded-[10px] border border-line-subtle bg-panel px-3 py-2 text-sm text-ink-secondary">
                  {m.content}
                </p>
                <ProviderTag provider={m.provider} degraded={m.degraded} />
              </div>
            ),
          )}
          {chatting && <WbLoading text="智能客服应答中…" />}
        </div>
        <WbError message={chatError} className="mt-3" />
        <div className="mt-3 flex gap-2">
          <input
            className={wbInputCls}
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) void handleSend()
            }}
            placeholder="输入测试消息…"
            maxLength={1000}
          />
          <WbButton onClick={() => void handleSend()} loading={chatting} disabled={!chatInput.trim()}>
            <Send className="h-4 w-4" />
            发送
          </WbButton>
        </div>
      </WbPanel>
    </div>
  )
}
