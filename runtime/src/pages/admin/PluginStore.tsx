/**
 * PluginStore（/admin/plugin-store）—— dsh-plugin-store 插件仓管理台。
 * 仓目录浏览（名称/版本/用途/装机状态）+ 一键装机/下架。
 * 装机 = 写入 st_skills(layer='store')，此后全厂 MCP 工具面自动出现 run_store_<key>，
 * 全体智能体可调（会话内自取走 store_search/store_use，与此互补）。
 * 安全：装机服务端验 sha256 + 仅声明式插件 + 注入过滤（本页只展示结果）。
 */
import { useState } from 'react'
import { PackageCheck, RefreshCw, Store } from 'lucide-react'
import { useWbSession, useWbQuery, wbMutation, wbErrorMessage } from '@/lib/wbSession'
import { WbButton, WbEmpty, WbError, WbLoading, WbPageHeader, WbPanel } from '@/components/wb/ui'
import { adminConfirm } from './shared'
import { cn } from '@/lib/utils'

interface StoreItem {
  key: string
  name: string
  version: string
  kind: string
  description: string
  author: string
  installed: boolean
}

export default function AdminPluginStore() {
  const { session } = useWbSession()
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pendingKey, setPendingKey] = useState<string | null>(null)

  const { data, error, loading, refetch } = useWbQuery<StoreItem[]>('pluginStore.catalog', session, {})

  function install(key: string, name: string) {
    if (!adminConfirm(`将插件「${name}」装机为系统技能？装机后全体智能体的工具面自动可见。`)) return
    setPendingKey(key)
    setNotice(null)
    setActionError(null)
    wbMutation<{ name: string }>('pluginStore.install', { token: session!.token, key })
      .then((r) => {
        setNotice(`「${r.name}」已装机，30 秒内出现在全员 MCP 工具面`)
        refetch()
      })
      .catch((e) => setActionError(wbErrorMessage(e)))
      .finally(() => setPendingKey(null))
  }

  function uninstall(key: string, name: string) {
    if (!adminConfirm(`下架插件「${name}」？（软删保留审计轨迹）`)) return
    setPendingKey(key)
    setNotice(null)
    setActionError(null)
    wbMutation('pluginStore.uninstall', { token: session!.token, key })
      .then(() => {
        setNotice(`「${name}」已下架`)
        refetch()
      })
      .catch((e) => setActionError(wbErrorMessage(e)))
      .finally(() => setPendingKey(null))
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <WbPageHeader
          hud="DSH PLUGIN STORE"
          title="插件仓"
          desc="智能体插件统一仓库——装机即入全员工具体系；智能体也可在会话内自取（无需人工安装）"
        />
        <WbButton variant="secondary" onClick={() => refetch()} disabled={loading} className="mt-2">
          <RefreshCw className={cn('mr-1 h-4 w-4', loading && 'animate-spin')} />
          刷新
        </WbButton>
      </div>

      {error && <WbError message={error} />}
      {notice && <div className="rounded-[10px] border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-sm text-emerald-300">{notice}</div>}
      {actionError && <WbError message={actionError} />}
      {loading && !data && <WbLoading />}

      <WbPanel>
        {data && data.length === 0 && <WbEmpty text="插件仓当前为空" hint="把插件包放入 S3:/opt/dsh-plugin-store/plugins 并登记 index.json 即可上架" />}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {(data ?? []).map((p) => (
            <div key={p.key} className="rounded-xl border border-line-subtle bg-void/40 p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-ink-primary">{p.name}</p>
                <span className="font-mono text-[10px] text-ink-faint">v{p.version}</span>
              </div>
              <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-ink-secondary">{p.description}</p>
              <div className="mt-3 flex items-center justify-between">
                <span className="font-mono text-[10px] text-ink-faint">{p.key} · {p.author}</span>
                {p.installed ? (
                  <button
                    onClick={() => uninstall(p.key, p.name)}
                    disabled={pendingKey === p.key}
                    className="rounded-full border border-red-400/40 bg-red-400/[0.08] px-3 py-1 text-xs text-red-300 hover:bg-red-400/[0.15]"
                  >
                    {pendingKey === p.key ? '处理中…' : '下架'}
                  </button>
                ) : (
                  <button
                    onClick={() => install(p.key, p.name)}
                    disabled={pendingKey === p.key}
                    className="flex items-center gap-1 rounded-full border border-jade-green/40 bg-jade-green/[0.08] px-3 py-1 text-xs text-jade-green hover:bg-jade-green/[0.15]"
                  >
                    <PackageCheck className="h-3 w-3" />
                    {pendingKey === p.key ? '装机中…' : '一键装机'}
                  </button>
                )}
              </div>
              {p.installed && (
                <p className="mt-2 flex items-center gap-1 text-[11px] text-jade-green">
                  <Store className="h-3 w-3" /> 已装机 · 全员工具面 run_{p.key}
                </p>
              )}
            </div>
          ))}
        </div>
      </WbPanel>
    </div>
  )
}
