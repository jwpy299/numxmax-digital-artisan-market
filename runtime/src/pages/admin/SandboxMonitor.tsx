/**
 * SandboxMonitor（/admin/sandbox-monitor）—— iter97 全平台沙箱训练监考大盘。
 * 跨厂匿名（厂#id 掩码），异常标记：连续失败 / 通过率偏低。数据：admin.sandboxMonitor。
 */
import { Download, ShieldCheck } from 'lucide-react'
import { useWbSession, useWbQuery } from '@/lib/wbSession'
import { WbButton, WbError, WbLoading, WbPageHeader, WbPanel } from '@/components/wb/ui'
import { cn } from '@/lib/utils'

/** iter99：监考数据导出 CSV（含 BOM，Excel 直开不乱码） */
function exportCsv(items: MonitorItem[]) {
  const header = '厂区,任务数,通过,失败,通过率%,毕业技能,最近训练,状态'
  const lines = items.map((f) =>
    [
      f.factoryRef,
      f.taskTotal,
      f.passRate > 0 ? Math.round((f.passRate / 100) * f.taskTotal) : 0,
      f.failedTotal,
      f.passRate,
      f.graduatedSkills,
      f.lastAt ? String(f.lastAt).slice(0, 16) : '',
      f.alert ?? '正常',
    ].join(','),
  )
  const blob = new Blob(['﻿' + [header, ...lines].join('\n')], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `sandbox-monitor-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}

interface MonitorItem {
  factoryRef: string
  taskTotal: number
  doneTotal: number
  failedTotal: number
  passRate: number
  graduatedSkills: number
  lastAt: string | null
  alert: string | null
}

export default function SandboxMonitor() {
  const { session } = useWbSession()
  const { data, error, loading } = useWbQuery<{ items: MonitorItem[]; factoryCount: number }>(
    'admin.sandboxMonitor',
    session,
  )
  if (loading) return <WbLoading />
  if (error || !data) return <WbError message={String(error ?? '加载失败')} />
  return (
    <div>
      <WbPageHeader hud="SANDBOX MONITOR" title="沙箱训练监考大盘" desc={`全平台 ${data.factoryCount} 个训练中的厂区 · 匿名监考视图（不暴露企业名）`} />
      <WbPanel
        title="各厂训练概况"
        hud="SANDBOX MONITOR"
        className="mt-4"
        actions={
          <WbButton variant="secondary" onClick={() => exportCsv(data.items)}>
            <Download className="h-4 w-4" />
            导出 CSV
          </WbButton>
        }
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left font-mono text-[10px] tracking-widest text-ink-faint">
              <th className="py-2">厂区</th><th>任务数</th><th>通过</th><th>失败</th><th>通过率</th><th>毕业技能</th><th>最近训练</th><th>状态</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((f) => (
              <tr key={f.factoryRef} className="border-b border-white/5 text-ink-secondary">
                <td className="py-2 font-medium text-ink-primary">{f.factoryRef}</td>
                <td>{f.taskTotal}</td>
                <td className="text-jade-green">{f.passRate > 0 ? Math.round((f.passRate / 100) * f.taskTotal) : 0}</td>
                <td className={f.failedTotal > 0 ? 'text-red-400' : ''}>{f.failedTotal}</td>
                <td className={cn(f.passRate >= 95 ? 'text-jade-green' : f.passRate < 60 ? 'text-forge-amber' : '')}>
                  {f.passRate}%
                </td>
                <td>{f.graduatedSkills}</td>
                <td className="text-xs text-ink-faint">{f.lastAt ? String(f.lastAt).slice(0, 16) : '—'}</td>
                <td>
                  {f.alert ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-forge-amber/50 bg-forge-amber/10 px-2 py-0.5 text-[11px] text-forge-amber">
                      <ShieldCheck className="h-3 w-3" />{f.alert}
                    </span>
                  ) : (
                    <span className="text-[11px] text-jade-green">正常</span>
                  )}
                </td>
              </tr>
            ))}
            {data.items.length === 0 && (
              <tr><td colSpan={8} className="py-8 text-center text-ink-faint">暂无训练数据</td></tr>
            )}
          </tbody>
        </table>
      </WbPanel>
    </div>
  )
}
