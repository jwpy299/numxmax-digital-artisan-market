/**
 * MeetingRoom（/admin/meeting/:id）—— 临时会议厅实况会议室。
 * 人与智能体同席：主官圆桌商讨实时滚动（3s 轮询），人类随时打断插话
 * （meetingSay 落当前轮）；主持动作：推进一轮 / 纪要收口；支持上传文件
 * （wbFiles.upload 落台账 + 自动以附件名义代发言）；产出物（技能落盘件）陈列。
 * 召集链接即本页 URL——部门收到链接点击直接进入。
 */
import { useEffect, useRef, useState } from 'react'
import { useParams, Link } from 'react-router'
import { ArrowLeft, Copy, Paperclip, Play, ScrollText, Send } from 'lucide-react'
import { useWbSession, wbQuery, wbMutation, wbErrorMessage } from '@/lib/wbSession'
import { WbButton, WbEmpty, WbError, WbLoading, WbPanel, wbInputCls } from '@/components/wb/ui'
import { cn } from '@/lib/utils'

interface MeetingMsg {
  id: number
  participantType: string
  displayName: string
  content: string
  provider: string | null
  degraded: boolean
  round: number
  createdAt: unknown
}

interface MeetingArtifact {
  id: number
  kind: string
  title: string
  filename: string
  sizeBytes: number
  agentCode: string
}

interface MeetingView {
  meeting: {
    id: number
    topic: string
    status: string
    roomType: string
    summary: string | null
    participants: string[]
    createdAt: unknown
  }
  messages: MeetingMsg[]
  artifacts: MeetingArtifact[]
}

const ROOM_LABEL: Record<string, string> = { dept: '部门内部会', cross: '跨部门会', enterprise: '全公司大会', legacy: '会议' }

export default function AdminMeetingRoom() {
  const { id } = useParams()
  const meetingId = Number(id)
  const { session } = useWbSession()
  const [data, setData] = useState<MeetingView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [say, setSay] = useState('')
  const [busy, setBusy] = useState<'round' | 'summarize' | 'say' | 'upload' | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  async function poll() {
    try {
      const d = await wbQuery<MeetingView>('deptConsole.meetingView', { token: session!.token, meetingId })
      setData(d)
      setError(null)
    } catch (e) {
      setError(wbErrorMessage(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!session?.token || !meetingId) return
    poll()
    const t = setInterval(poll, 3000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.token, meetingId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [data?.messages.length])

  function interject() {
    const text = say.trim()
    if (!text || busy) return
    setBusy('say')
    setNotice(null)
    wbMutation('deptConsole.meetingSay', { token: session!.token, meetingId, content: text })
      .then(() => {
        setSay('')
        poll()
      })
      .catch((e) => setError(wbErrorMessage(e)))
      .finally(() => setBusy(null))
  }

  function runRound() {
    setBusy('round')
    wbMutation('deptConsole.meetingRound', { token: session!.token, meetingId })
      .then(() => poll())
      .catch((e) => setError(wbErrorMessage(e)))
      .finally(() => setBusy(null))
  }

  function summarize() {
    setBusy('summarize')
    wbMutation('deptConsole.meetingSummarize', { token: session!.token, meetingId })
      .then(() => {
        setNotice('纪要已收口')
        poll()
      })
      .catch((e) => setError(wbErrorMessage(e)))
      .finally(() => setBusy(null))
  }

  function onPickFile(ev: React.ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0]
    ev.target.value = ''
    if (!file || busy) return
    if (file.size > 8 * 1024 * 1024) {
      setError('文件过大（上限 8MB）')
      return
    }
    setBusy('upload')
    const reader = new FileReader()
    reader.onload = () => {
      const b64 = String(reader.result).split(',')[1] ?? ''
      wbMutation<{ title: string }>('wbFiles.upload', {
        token: session!.token,
        title: `会议附件·${file.name}`.slice(0, 64),
        fileName: file.name.slice(0, 128),
        mimeType: file.type || 'application/octet-stream',
        fileBase64: b64,
      })
        .then((r) =>
          wbMutation('deptConsole.meetingSay', {
            token: session!.token,
            meetingId,
            content: `【上传附件】《${r.title}》已入会议台账（企业附件库可查），请与会者围绕该附件研讨。`,
          }),
        )
        .then(() => {
          setNotice(`附件「${file.name}」已上传并知会会场`)
          poll()
        })
        .catch((e) => setError(wbErrorMessage(e)))
        .finally(() => setBusy(null))
    }
    reader.onerror = () => {
      setError('文件读取失败')
      setBusy(null)
    }
    reader.readAsDataURL(file)
  }

  if (loading && !data) return <WbLoading />
  if (!data) return <WbError message={error ?? '会议不存在'} />

  const m = data.meeting
  const closed = m.status === 'closed' || m.status === 'summarized'

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex items-center justify-between">
        <Link to="/admin/dept-consoles" className="flex items-center gap-1 text-sm text-ink-secondary hover:text-ink-primary">
          <ArrowLeft className="h-4 w-4" /> 部门工作台
        </Link>
        <button
          className="flex items-center gap-1 rounded-full border border-white/10 px-3 py-1 text-xs text-ink-secondary hover:text-ink-primary"
          onClick={() => {
            navigator.clipboard?.writeText(window.location.href).catch(() => {})
            setNotice('召集链接已复制——发给参会部门点击即入')
          }}
        >
          <Copy className="h-3.5 w-3.5" /> 召集链接
        </button>
      </div>

      <WbPanel>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-lg font-semibold text-ink-primary">#{m.id} {m.topic}</p>
            <p className="mt-1 text-xs text-ink-secondary">
              {ROOM_LABEL[m.roomType] ?? '会议'} · {m.status === 'open' ? '进行中' : '已收口'}
              {m.participants.length > 0 && ` · 参会：${m.participants.join('、')}`}
            </p>
          </div>
          {!closed && (
            <div className="flex gap-2">
              <WbButton variant="secondary" onClick={runRound} disabled={busy !== null}>
                <Play className="mr-1 h-4 w-4" /> {busy === 'round' ? '商讨中…' : '推进一轮'}
              </WbButton>
              <WbButton variant="secondary" onClick={summarize} disabled={busy !== null}>
                <ScrollText className="mr-1 h-4 w-4" /> {busy === 'summarize' ? '收口…' : '纪要收口'}
              </WbButton>
            </div>
          )}
        </div>
        {m.summary && (
          <div className="mt-3 rounded-[10px] border border-forge-amber/30 bg-forge-amber/[0.06] p-3">
            <p className="mb-1 text-xs text-forge-amber">会议纪要</p>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-primary">{m.summary}</p>
          </div>
        )}
      </WbPanel>

      {error && <WbError message={error} />}
      {notice && <div className="rounded-[10px] border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-sm text-emerald-300">{notice}</div>}

      {/* 会议实况流 */}
      <WbPanel>
        <div className="max-h-[52vh] space-y-3 overflow-y-auto rounded-[10px] bg-black/20 p-4">
          {data.messages.length === 0 && <WbEmpty text="会场就绪——推进一轮开始商讨" />}
          {data.messages.map((msg) => {
            const isHuman = msg.participantType === 'human'
            return (
              <div key={msg.id} className={cn('flex', isHuman ? 'justify-end' : 'justify-start')}>
                <div
                  className={cn(
                    'max-w-[82%] rounded-[12px] px-3.5 py-2.5',
                    isHuman
                      ? 'bg-pulse-cyan/15 text-ink-primary'
                      : 'border border-white/[0.08] bg-white/[0.04] text-ink-primary',
                  )}
                >
                  <div className="mb-1 flex items-center gap-2 text-[11px] text-ink-secondary">
                    <span className="font-medium">{msg.displayName}</span>
                    <span>第 {msg.round} 轮</span>
                    {msg.provider && <span>· {msg.provider}</span>}
                    {msg.degraded && <span className="text-forge-amber">· 降级</span>}
                  </div>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed">{msg.content}</p>
                </div>
              </div>
            )
          })}
          <div ref={bottomRef} />
        </div>

        {/* 人类打断插话 + 文件上传 */}
        <div className="mt-3 flex gap-2">
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            onChange={onPickFile}
          />
          <WbButton variant="secondary" onClick={() => fileRef.current?.click()} disabled={busy !== null} className="shrink-0">
            <Paperclip className="h-4 w-4" />
          </WbButton>
          <input
            className={wbInputCls}
            placeholder={closed ? '会议已收口' : '打断商讨，发表你的意见…（立即落当前轮，全员可见）'}
            value={say}
            onChange={(e) => setSay(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && interject()}
            disabled={busy !== null || closed}
          />
          <WbButton onClick={interject} disabled={busy !== null || !say.trim() || closed} className="shrink-0">
            <Send className="h-4 w-4" />
          </WbButton>
        </div>
      </WbPanel>

      {/* 会议产出物 */}
      {data.artifacts.length > 0 && (
        <WbPanel>
          <p className="mb-2 text-sm font-medium text-ink-primary">会议产出物</p>
          <div className="flex flex-wrap gap-2">
            {data.artifacts.map((a) => (
              <span key={a.id} className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs text-ink-primary">
                {a.title}（{a.filename}）
              </span>
            ))}
          </div>
        </WbPanel>
      )}
    </div>
  )
}
