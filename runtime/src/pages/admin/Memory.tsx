/**
 * Memory（/admin/memory）—— 记忆治理：查看/纠正/遗忘员工个体记忆。
 * 数据来自 st_agent_memories（iter55 自动沉淀），全部操作审计留痕。
 */
import { useState } from 'react'
import { Brain, Check, Pencil, RefreshCw, Trash2, X } from 'lucide-react'
import { useWbSession, useWbQuery, wbMutation } from '@/lib/wbSession'
import { WbError, WbLoading, WbPageHeader, WbPanel, WbButton, wbInputCls } from '@/components/wb/ui'

interface MemoryRow {
  id: number
  agentCode: string
  actor: string
  kind: string
  content: string
  source: string
  createdAt: string | null
  updatedAt: string | null
}

const KIND_LABEL: Record<string, string> = { preference: '偏好', fact: '事实', note: '备注' }

export default function AdminMemory() {
  const { session } = useWbSession()
  const [agentCode, setAgentCode] = useState('')
  const [actor, setActor] = useState('')
  const [filters, setFilters] = useState<{ agentCode?: string; actor?: string }>({})
  const { data, error, loading, refetch } = useWbQuery<{ items: MemoryRow[] }>('agentMemory.list', session, filters)
  const [editId, setEditId] = useState<number | null>(null)
  const [editContent, setEditContent] = useState('')
  const [mutErr, setMutErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<number | null>(null)

  const correct = async (id: number) => {
    if (!session) return
    setBusy(id)
    setMutErr(null)
    try {
      await wbMutation('agentMemory.correct', { token: session.token, id, content: editContent.trim() })
      setEditId(null)
      refetch()
    } catch (e) {
      setMutErr(e instanceof Error ? e.message : '纠正失败')
    } finally {
      setBusy(null)
    }
  }

  const forget = async (row: MemoryRow) => {
    if (!session) return
    if (!window.confirm(`确认遗忘这条记忆？\n${row.agentCode} 对 ${row.actor}：${row.content}`)) return
    setBusy(row.id)
    setMutErr(null)
    try {
      await wbMutation('agentMemory.forget', { token: session.token, id: row.id })
      refetch()
    } catch (e) {
      setMutErr(e instanceof Error ? e.message : '遗忘失败')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div>
      <WbPageHeader
        hud="MEMORY GOVERNANCE"
        title="记忆治理"
        desc="员工个体记忆的查看、纠正与遗忘。记忆由对话自动沉淀（iter55），此处全部操作审计留痕。"
      />
      <WbPanel
        title="个体记忆台账"
        hud="MEMORIES"
        actions={
          <div className="flex items-center gap-2">
            <input value={agentCode} onChange={(e) => setAgentCode(e.target.value)} placeholder="员工代码" className={wbInputCls + ' w-28'} />
            <input value={actor} onChange={(e) => setActor(e.target.value)} placeholder="对话对象" className={wbInputCls + ' w-28'} />
            <WbButton variant="secondary" onClick={() => setFilters({ agentCode: agentCode || undefined, actor: actor || undefined })}>过滤</WbButton>
            <WbButton variant="secondary" loading={loading} onClick={refetch}><RefreshCw className="h-4 w-4" />刷新</WbButton>
          </div>
        }
      >
        <WbError message={error ?? mutErr} className="mb-3" />
        {loading && !data && <WbLoading text="记忆加载中…" />}
        {data && (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-faint">
                <th className="py-2">员工</th><th>对象</th><th>类型</th><th className="w-1/2">记忆内容</th><th>来源</th><th>更新时间</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((m) => (
                <tr key={m.id} className="border-t border-line-subtle/50 text-ink-secondary">
                  <td className="py-2 font-mono text-ink-primary">{m.agentCode}</td>
                  <td className="font-mono">{m.actor}</td>
                  <td>{KIND_LABEL[m.kind] ?? m.kind}</td>
                  <td className="py-2">
                    {editId === m.id ? (
                      <div className="flex items-center gap-2">
                        <input value={editContent} onChange={(e) => setEditContent(e.target.value)} className={wbInputCls + ' flex-1'} />
                        <button type="button" disabled={busy === m.id} onClick={() => correct(m.id)} className="text-jade-green"><Check className="h-4 w-4" /></button>
                        <button type="button" onClick={() => setEditId(null)} className="text-ink-faint"><X className="h-4 w-4" /></button>
                      </div>
                    ) : (
                      <span className="text-ink-primary">{m.content}</span>
                    )}
                  </td>
                  <td className="font-mono text-[11px]">{m.source}</td>
                  <td className="font-mono text-[11px]">{m.updatedAt ? new Date(m.updatedAt).toLocaleString('zh-CN') : '—'}</td>
                  <td>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        title="纠正"
                        onClick={() => { setEditId(m.id); setEditContent(m.content) }}
                        className="text-pulse-cyan hover:text-ink-primary"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        title="遗忘"
                        disabled={busy === m.id}
                        onClick={() => forget(m)}
                        className="text-ember-red hover:text-red-400 disabled:opacity-50"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {data.items.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-ink-faint">
                    <Brain className="mx-auto mb-2 h-5 w-5" />
                    暂无记忆行——员工与用户的真实对话会异步沉淀偏好/事实到这里。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </WbPanel>
    </div>
  )
}
