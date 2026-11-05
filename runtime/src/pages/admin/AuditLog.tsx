/**
 * AuditLog（/admin/audit）—— 管理端审计日志（迭代 35，adminAnalytics.auditList）。
 * 表格：操作人 / 动作 / 对象 / 时间 / 详情（detail_json 展开）。
 * 字段 camelCase/snake_case 双兼容。
 */
import { Fragment, useState } from 'react'
import { ChevronDown, ChevronUp, FileJson, ScrollText } from 'lucide-react'
import { useWbSession, useWbQuery } from '@/lib/wbSession'
import { WbEmpty, WbError, WbLoading, WbPageHeader, WbPanel } from '@/components/wb/ui'

interface AuditRow {
  id?: number
  adminUserId?: number
  admin_user_id?: number
  adminName?: string
  admin_name?: string
  action?: string
  target?: string
  detailJson?: string | null
  detail_json?: string | null
  createdAt?: string
  created_at?: string
}

function prettyDetail(raw: string | null): string | null {
  if (!raw) return null
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

export default function AdminAuditLog() {
  const { session } = useWbSession()
  const query = useWbQuery<AuditRow[] | { rows?: AuditRow[]; items?: AuditRow[] }>('adminAnalytics.auditList', session, { limit: 100 }, { enabled: !!session?.token })
  const rows: AuditRow[] = Array.isArray(query.data) ? query.data : (query.data?.rows ?? query.data?.items ?? [])
  const [expanded, setExpanded] = useState<number | null>(null)

  return (
    <div>
      <WbPageHeader
        hud="AUDIT LOG"
        title="审计日志"
        desc="关键管理操作留痕（审核 / 确权 / 下架 / 进化决策 / 告警处置等），最近 100 条倒序展示。"
      />
      <WbPanel hud="ADMIN AUDIT" title="操作留痕">
        {query.loading && !query.data ? (
          <WbLoading text="审计日志加载中…" />
        ) : query.error ? (
          <WbError message={query.error} />
        ) : rows.length === 0 ? (
          <WbEmpty text="暂无数据" hint="关键 mutation 执行后自动写入审计。" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-line-subtle text-xs text-ink-faint">
                  <th className="pb-2 pr-3 font-medium">时间</th>
                  <th className="pb-2 pr-3 font-medium">操作人</th>
                  <th className="pb-2 pr-3 font-medium">动作</th>
                  <th className="pb-2 pr-3 font-medium">操作对象</th>
                  <th className="pb-2 font-medium">详情</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const id = r.id ?? i
                  const detail = prettyDetail((r.detailJson ?? r.detail_json ?? null) as string | null)
                  const isOpen = expanded === id
                  const createdAt = r.createdAt ?? r.created_at
                  return (
                    <Fragment key={id}>
                      <tr className="border-b border-line-subtle/60">
                        <td className="py-2.5 pr-3 font-mono text-[11px] text-ink-faint">
                          {createdAt ? new Date(String(createdAt)).toLocaleString('zh-CN', { hour12: false }) : '—'}
                        </td>
                        <td className="py-2.5 pr-3 text-ink-primary">
                          {r.adminName ?? r.admin_name ?? '—'}
                          <span className="ml-1 font-mono text-[11px] text-ink-faint">#{r.adminUserId ?? r.admin_user_id ?? '—'}</span>
                        </td>
                        <td className="py-2.5 pr-3">
                          <span className="inline-flex items-center gap-1 rounded-full border border-pulse-cyan/40 bg-pulse-cyan/10 px-2 py-0.5 font-mono text-[10px] text-pulse-cyan">
                            <ScrollText className="h-3 w-3" />
                            {r.action ?? '—'}
                          </span>
                        </td>
                        <td className="max-w-[220px] truncate py-2.5 pr-3 font-mono text-xs text-ink-secondary">{r.target || '—'}</td>
                        <td className="py-2.5">
                          {detail ? (
                            <button
                              type="button"
                              onClick={() => setExpanded(isOpen ? null : id)}
                              className="flex items-center gap-1 rounded-md border border-line-subtle px-2.5 py-1 text-[11px] text-ink-secondary transition-colors hover:border-pulse-cyan/50 hover:text-ink-primary"
                            >
                              <FileJson className="h-3 w-3" />
                              detail_json {isOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                            </button>
                          ) : (
                            <span className="text-[11px] text-ink-faint">—</span>
                          )}
                        </td>
                      </tr>
                      {isOpen && detail && (
                        <tr className="border-b border-line-subtle/60 last:border-0">
                          <td colSpan={5} className="py-2">
                            <pre className="overflow-x-auto rounded-lg border border-line-subtle bg-panel/40 px-3.5 py-2.5 font-mono text-[11px] leading-relaxed text-ink-secondary">
                              {detail}
                            </pre>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </WbPanel>
    </div>
  )
}
