/**
 * ArtifactChips —— 迭代 41：技能产出物下载条。
 * 迭代 44（B1 反馈环）：附件卡追加「采用 / 驳回」按钮，terminal.artifactFeedback
 * 落账（同 actor 覆盖），北极星「周均被采纳产出物数」的数据源。
 */
import { useEffect, useState } from 'react'
import { Check, FileSpreadsheet, FileText, Loader2, Presentation, X } from 'lucide-react'
import { wbMutation, wbQuery, wbErrorMessage } from '@/lib/wbSession'
import { formatByteSize as fmtSize } from '@/lib/byteSize'

export interface ChatArtifact {
  id: number
  kind: string
  title: string
  filename: string
  sizeBytes: number
}

const KIND_ICON = {
  docx: FileText,
  xlsx: FileSpreadsheet,
  pptx: Presentation,
} as const

const KIND_LABEL: Record<string, string> = {
  docx: 'Word',
  xlsx: 'Excel',
  pptx: 'PPT',
}

export function ArtifactChips({ token, artifacts, onRevise }: { token: string; artifacts: ChatArtifact[]; onRevise?: (a: ChatArtifact) => void }) {
  const [busyId, setBusyId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mine, setMine] = useState<Record<number, string>>({})

  useEffect(() => {
    if (!artifacts || artifacts.length === 0) return
    wbQuery<{ rows: { artifactId: number; signal: string }[] }>('terminal.artifactFeedbackMine', {
      token,
      artifactIds: artifacts.map((a) => a.id),
    })
      .then((res) => {
        const m: Record<number, string> = {}
        for (const r of res.rows) m[r.artifactId] = r.signal
        setMine(m)
      })
      .catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, artifacts?.map((a) => a.id).join(',')])

  if (!artifacts || artifacts.length === 0) return null

  async function download(a: ChatArtifact) {
    if (busyId) return
    setBusyId(a.id)
    setError(null)
    try {
      const res = await wbMutation<{ filename: string; mime: string; base64: string }>(
        'terminal.artifactDownload',
        { token, artifactId: a.id },
      )
      const bin = atob(res.base64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const blob = new Blob([bytes], { type: res.mime })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${a.title}.${a.kind}`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(wbErrorMessage(err))
    } finally {
      setBusyId(null)
    }
  }

  async function feedback(a: ChatArtifact, signal: 'adopted' | 'rejected') {
    setError(null)
    try {
      await wbMutation('terminal.artifactFeedback', { token, artifactId: a.id, signal })
      setMine((m) => ({ ...m, [a.id]: signal }))
    } catch (err) {
      setError(wbErrorMessage(err))
    }
  }

  return (
    <div className="mt-2 space-y-1.5">
      {artifacts.map((a) => {
        const Icon = KIND_ICON[a.kind as keyof typeof KIND_ICON] ?? FileText
        const sig = mine[a.id]
        return (
          <div
            key={a.id}
            className="flex w-full items-center gap-2 rounded-lg border border-pulse-cyan/30 bg-pulse-cyan/[0.08] px-3 py-2 text-left text-xs"
          >
            <button
              type="button"
              onClick={() => download(a)}
              disabled={busyId !== null}
              className="flex min-w-0 flex-1 items-center gap-2 transition-colors hover:opacity-80 disabled:opacity-60"
            >
              {busyId === a.id ? <Loader2 className="h-3.5 w-3.5 animate-spin text-pulse-cyan" /> : <Icon className="h-3.5 w-3.5 shrink-0 text-pulse-cyan" />}
              <span className="flex-1 truncate text-ink-primary">{a.title}</span>
              <span className="text-ink-faint">
                {KIND_LABEL[a.kind] ?? a.kind} · {fmtSize(a.sizeBytes)}
              </span>
            </button>
            <span className="flex shrink-0 items-center gap-1 border-l border-white/10 pl-2">
              {onRevise && (
                <button
                  type="button"
                  title="让TA接着改"
                  onClick={() => onRevise(a)}
                  className="rounded-md px-1.5 py-1 text-[10px] text-ink-faint transition-colors hover:bg-white/10 hover:text-pulse-cyan"
                >
                  接着改
                </button>
              )}
              <button
                type="button"
                title="采用"
                onClick={() => feedback(a, 'adopted')}
                className={`rounded-md p-1 transition-colors ${sig === 'adopted' ? 'bg-jade-green/20 text-jade-green' : 'text-ink-faint hover:bg-white/10 hover:text-jade-green'}`}
              >
                <Check className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                title="驳回"
                onClick={() => feedback(a, 'rejected')}
                className={`rounded-md p-1 transition-colors ${sig === 'rejected' ? 'bg-ember-red/20 text-ember-red' : 'text-ink-faint hover:bg-white/10 hover:text-ember-red'}`}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          </div>
        )
      })}
      {error && <p className="text-[11px] text-ember-red">{error}</p>}
    </div>
  )
}
