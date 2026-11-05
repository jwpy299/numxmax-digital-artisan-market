/**
 * Releases（/admin/releases）—— Harness 交付装配线·发布观测板（P0-③④）。
 * 数据：releases.board（只读）——本机制品仓库 / live boot.js md5 / 发布流水 / 回滚指引。
 * 口径：md5 8 位短码与 verifier runs 记录一致；「跑的就是发的」一眼可核。
 */
import { RefreshCw, TerminalSquare } from 'lucide-react'
import { useWbSession, useWbQuery } from '@/lib/wbSession'
import { WbError, WbLoading, WbPageHeader, WbPanel, WbEmpty } from '@/components/wb/ui'
import { ReleaseCenterPanel } from '@/components/release/ReleaseCenterPanel'
import { cn } from '@/lib/utils'

interface ReleaseArtifact {
  name: string
  bootMd5: string | null
  sizeBytes: number
  createdAt: string
}

interface BoardResp {
  host: string
  service: string
  serviceActive: boolean
  liveBootMd5: string | null
  liveBootMtime: string | null
  artifactsDir: string
  artifacts: ReleaseArtifact[]
  log: string[]
  rollback: { command: string; note: string }
}

function fmtSize(n: number): string {
  if (!n) return '—'
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${Math.round(n / 1024)} KB`
}

function fmtTime(iso: string): string {
  if (!iso) return '—'
  return iso.replace('T', ' ').slice(0, 19)
}

export default function AdminReleases() {
  const { session } = useWbSession()
  const q = useWbQuery<BoardResp>('releases.board', session)

  if (q.loading) return <WbLoading text="读取发布观测板…" />
  if (q.error) return <WbError message={q.error} />
  if (!q.data) return <WbLoading text="读取发布观测板…" />
  const b = q.data

  return (
    <div className="space-y-6 p-6">
      <WbPageHeader
        hud="RELEASES"
        title="发布观测板"
        desc="Harness 交付装配线：本机制品仓库（近 10 版）/ 在跑制品指纹 / 发布流水。md5 短码与 verifier 记录同口径，一眼核对「跑的就是发的」。"
      />
      <div className="mb-4 flex justify-end">
        <button
          className="flex items-center gap-1.5 rounded-lg border border-line-subtle px-3 py-1.5 text-xs text-ink-secondary hover:bg-pulse-cyan/[0.06] hover:text-ink-primary"
          onClick={() => q.refetch()}
        >
          <RefreshCw className="h-3.5 w-3.5" /> 刷新
        </button>
      </div>

      {/* 在跑状态 */}
      <WbPanel
        title={`在跑制品（本机 ${b.host}）`}
      >
        <div className="grid gap-3 text-sm md:grid-cols-4">
          <div>
            <p className="text-xs text-ink-faint">服务</p>
            <p className="mt-1 font-mono text-ink-primary">{b.service}</p>
          </div>
          <div>
            <p className="text-xs text-ink-faint">状态</p>
            <p className={cn('mt-1 font-medium', b.serviceActive ? 'text-jade-green' : 'text-ember-red')}>
              {b.serviceActive ? 'active' : '非 active（或无 systemd）'}
            </p>
          </div>
          <div>
            <p className="text-xs text-ink-faint">live boot.js md5</p>
            <p className="mt-1 font-mono text-pulse-cyan">{b.liveBootMd5 ?? '—'}</p>
          </div>
          <div>
            <p className="text-xs text-ink-faint">更新时间</p>
            <p className="mt-1 font-mono text-xs text-ink-primary">{fmtTime(b.liveBootMtime ?? '')}</p>
          </div>
        </div>
      </WbPanel>

      {/* 制品仓库 */}
      <WbPanel
        title="制品仓库（近 10 版）"
      >
        {b.artifacts.length === 0 ? (
          <WbEmpty text="制品仓库未初始化" hint={`首次发布归档后在此列出。目录：${b.artifactsDir}`} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line-subtle text-left text-xs text-ink-faint">
                  <th className="px-3 py-2">版本</th>
                  <th className="px-3 py-2">boot md5</th>
                  <th className="px-3 py-2">大小</th>
                  <th className="px-3 py-2">归档时间</th>
                  <th className="px-3 py-2">对照</th>
                </tr>
              </thead>
              <tbody>
                {b.artifacts.map((a) => (
                  <tr key={a.name} className="border-b border-line-subtle/50">
                    <td className="px-3 py-2 font-mono text-ink-primary">{a.name}</td>
                    <td className="px-3 py-2 font-mono text-pulse-cyan">{a.bootMd5 ?? '—'}</td>
                    <td className="px-3 py-2 text-ink-secondary">{fmtSize(a.sizeBytes)}</td>
                    <td className="px-3 py-2 font-mono text-xs text-ink-secondary">{fmtTime(a.createdAt)}</td>
                    <td className="px-3 py-2">
                      {a.bootMd5 && a.bootMd5 === b.liveBootMd5 ? (
                        <span className="rounded-full bg-jade-green/15 px-2 py-0.5 text-[11px] text-jade-green">在跑</span>
                      ) : (
                        <span className="text-[11px] text-ink-faint">历史</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </WbPanel>

      {/* M51 系统更新机制：四端版本台账 + 五道闸流水线 + C 级双签 + AI 更新执行官席 */}
      <WbPanel
        title="系统更新机制（四端版本流水线）"
        hud="RELEASE-CENTER"
      >
        <ReleaseCenterPanel />
      </WbPanel>

      {/* 回滚指引 + 发布流水 */}
      <div className="grid gap-6 lg:grid-cols-2">
        <WbPanel
          title="30 秒回滚（CLI）"
        >
          <p className="text-xs text-ink-secondary">{b.rollback.note}</p>
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-line-subtle bg-void/60 px-3 py-2">
            <TerminalSquare className="h-4 w-4 shrink-0 text-pulse-cyan" />
            <code className="break-all font-mono text-xs text-pulse-cyan">{b.rollback.command}</code>
          </div>
        </WbPanel>

        <WbPanel
          title="发布流水（近 20 条）"
        >
          {b.log.length === 0 ? (
            <WbEmpty text="暂无发布流水" hint="首次发布后写入 dist/RELEASES.log" />
          ) : (
            <ul className="space-y-1.5">
              {b.log.map((line, i) => (
                <li key={i} className="break-all font-mono text-xs text-ink-secondary">
                  {line}
                </li>
              ))}
            </ul>
          )}
        </WbPanel>
      </div>
    </div>
  )
}
