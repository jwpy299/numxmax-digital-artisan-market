/**
 * Finance（/admin/finance）—— 财务中心 · 经营总账（只读）：
 * 充值收入 / Token 流通 / 钱包存量 / 北极星 / 技能工具健康，一屏看清。
 */
import { useState } from 'react'
import { Coins, Download, Landmark, RefreshCw, Star, TrendingUp, Wallet, Wrench } from 'lucide-react'
import { useWbSession, useWbQuery, wbMutation } from '@/lib/wbSession'
import { WbError, WbLoading, WbPageHeader, WbPanel, WbButton } from '@/components/wb/ui'

interface FinanceResp {
  topups: { confirmedCount: number; confirmedAmount: number; confirmedCny: number; d30Count: number; d30Cny: number; d7Cny: number; pendingCount: number }
  flows: { flowCount: number; flowTotal: number; feeTotal: number; shareTotal: number; d30Total: number; d30Fee: number }
  wallets: { walletTotal: number; walletHolders: number }
  northStar: { weekAdopted: number; weekRejected: number; adoptRate: number | null }
  skillTools: { ok: number; fail: number; failRate: number }
}

function StatCard({ title, icon: Icon, main, lines }: {
  title: string
  icon: typeof Coins
  main: string
  lines: [string, string][]
}) {
  return (
    <div className="glass-panel relative rounded-xl px-5 py-4">
      <p className="flex items-center gap-2 text-sm font-medium text-ink-primary">
        <Icon className="h-4 w-4 text-forge-amber" />
        {title}
      </p>
      <p className="mt-3 font-mono text-2xl text-ink-primary">{main}</p>
      <div className="mt-3 space-y-1">
        {lines.map(([k, v]) => (
          <p key={k} className="flex justify-between text-xs text-ink-secondary">
            <span>{k}</span>
            <span className="font-mono text-ink-primary">{v}</span>
          </p>
        ))}
      </div>
    </div>
  )
}

interface ByEnterpriseResp {
  market: { id: number; name: string; tokenBalance: number; flowCount: number; flowTotal: number; feeTotal: number; shareTotal: number }[]
  topups: { id: number; name: string; confirmedCount: number; confirmedAmount: number; confirmedCny: number; pendingCount: number }[]
}

export default function AdminFinance() {
  const { session } = useWbSession()
  const { data, error, loading, refetch } = useWbQuery<FinanceResp>('finance.overview', session)
  const ent = useWbQuery<ByEnterpriseResp>('finance.byEnterprise', session)
  const now = new Date()
  const [month, setMonth] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`)
  const [exporting, setExporting] = useState(false)
  const [exportErr, setExportErr] = useState<string | null>(null)
  const fmt = (n: number) => n.toLocaleString('zh-CN')
  const cny = (n: number) => `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  async function exportLedger() {
    if (!session) return
    setExporting(true)
    setExportErr(null)
    try {
      const r = await wbMutation<{ artifact: { id: number } }>('finance.exportLedger', { token: session.token, yearMonth: month })
      const res = await wbMutation<{ filename: string; mime: string; base64: string }>(
        'terminal.artifactDownload',
        { token: session.token, artifactId: r.artifact.id },
      )
      const bin = atob(res.base64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const url = URL.createObjectURL(new Blob([bytes], { type: res.mime }))
      const link = document.createElement('a')
      link.href = url
      link.download = res.filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      setExportErr(e instanceof Error ? e.message : '对账导出失败')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div>
      <WbPageHeader
        hud="FINANCE LEDGER"
        title="财务中心 · 经营总账"
        desc="充值收入、Token 流通、钱包存量、北极星与技能工具健康一屏总览。本页只读，数字全部来自台账表现查。"
      />
      <WbPanel
        title="经营总账"
        hud="LEDGER"
        actions={<WbButton variant="secondary" loading={loading} onClick={refetch}><RefreshCw className="h-4 w-4" />刷新</WbButton>}
      >
        <WbError message={error} className="mb-3" />
        {loading && !data && <WbLoading text="总账汇总中…" />}
        {data && (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <StatCard
              title="充值收入"
              icon={Landmark}
              main={cny(data.topups.confirmedCny)}
              lines={[
                ['累计确认', `${fmt(data.topups.confirmedCount)} 笔 / ${fmt(data.topups.confirmedAmount)} Token`],
                ['近 30 天', `${fmt(data.topups.d30Count)} 笔 / ${cny(data.topups.d30Cny)}`],
                ['近 7 天', cny(data.topups.d7Cny)],
                ['待审批', `${fmt(data.topups.pendingCount)} 笔`],
              ]}
            />
            <StatCard
              title="Token 流通"
              icon={TrendingUp}
              main={`${fmt(data.flows.flowTotal)} Token`}
              lines={[
                ['累计笔数', fmt(data.flows.flowCount)],
                ['平台抽成累计', fmt(data.flows.feeTotal)],
                ['匠师分成累计', fmt(data.flows.shareTotal)],
                ['近 30 天流通', `${fmt(data.flows.d30Total)}（抽成 ${fmt(data.flows.d30Fee)}）`],
              ]}
            />
            <StatCard
              title="企业钱包存量"
              icon={Wallet}
              main={`${fmt(data.wallets.walletTotal)} Token`}
              lines={[
                ['有余额企业', `${fmt(data.wallets.walletHolders)} 家`],
              ]}
            />
            <StatCard
              title="北极星 · 产出采纳"
              icon={Star}
              main={data.northStar.adoptRate === null ? '—' : `${data.northStar.adoptRate}%`}
              lines={[
                ['近 7 天采纳', fmt(data.northStar.weekAdopted)],
                ['近 7 天驳回', fmt(data.northStar.weekRejected)],
              ]}
            />
            <StatCard
              title="技能工具健康"
              icon={Wrench}
              main={`${data.skillTools.failRate.toFixed(1)}%`}
              lines={[
                ['工具成功', fmt(data.skillTools.ok)],
                ['工具失败', fmt(data.skillTools.fail)],
              ]}
            />
            <div className="glass-panel relative rounded-xl px-5 py-4">
              <p className="flex items-center gap-2 text-sm font-medium text-ink-primary">
                <Coins className="h-4 w-4 text-forge-amber" />
                口径说明
              </p>
              <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
                充值收入按 st_token_topups confirmed 口径；流通按 token_transactions
                台账（含 hire_commission / skill_call 等类型）；钱包存量为 enterprises.tokenBalance
                现值；北极星为近 7 天产出物采纳率（采纳 /（采纳+驳回））。本页数字与
                「Token 流水」「充值处理」「运营监控」页同源。
              </p>
            </div>
          </div>
        )}
      </WbPanel>

      <WbPanel
        title="月度对账导出"
        hud="EXPORT"
        className="mt-4"
        actions={
          <div className="flex items-center gap-2">
            <input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="rounded-md border border-line-subtle bg-transparent px-2 py-1 text-sm text-ink-primary"
            />
            <WbButton variant="secondary" loading={exporting} onClick={exportLedger}>
              <Download className="h-4 w-4" />导出对账（xlsx）
            </WbButton>
          </div>
        }
      >
        <WbError message={exportErr} className="mb-2" />
        <p className="text-[11px] text-ink-faint">
          导出所选月份的真 .xlsx 对账单，含 5 个 sheet：月度汇总 / 按企业-匠市流通 / 按企业-充值 / 充值明细 / 流通明细。
          文件经产出物管线落台账，可重复下载。
        </p>
      </WbPanel>

      <WbPanel title="按企业拆账 · 匠市流通与钱包" hud="MARKET LEDGER" className="mt-4"
        actions={<WbButton variant="secondary" loading={ent.loading} onClick={ent.refetch}><RefreshCw className="h-4 w-4" />刷新</WbButton>}>
        <WbError message={ent.error} className="mb-2" />
        {ent.loading && !ent.data && <WbLoading text="拆账汇总中…" />}
        {ent.data && (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-faint">
                <th className="py-2">企业</th><th>钱包余额</th><th>流通笔数</th><th>流通Token</th><th>平台费</th><th>大师分成</th>
              </tr>
            </thead>
            <tbody>
              {ent.data.market.map((r) => (
                <tr key={r.id} className="border-t border-line-subtle/50 text-ink-secondary">
                  <td className="py-2 text-ink-primary">{r.name}</td>
                  <td className="font-mono">{fmt(r.tokenBalance)}</td>
                  <td className="font-mono">{fmt(r.flowCount)}</td>
                  <td className="font-mono">{fmt(r.flowTotal)}</td>
                  <td className="font-mono">{fmt(r.feeTotal)}</td>
                  <td className="font-mono">{fmt(r.shareTotal)}</td>
                </tr>
              ))}
              <tr className="border-t border-line-subtle font-medium text-ink-primary">
                <td className="py-2">合计</td>
                <td className="font-mono">{fmt(ent.data.market.reduce((a, r) => a + r.tokenBalance, 0))}</td>
                <td className="font-mono">{fmt(ent.data.market.reduce((a, r) => a + r.flowCount, 0))}</td>
                <td className="font-mono">{fmt(ent.data.market.reduce((a, r) => a + r.flowTotal, 0))}</td>
                <td className="font-mono">{fmt(ent.data.market.reduce((a, r) => a + r.feeTotal, 0))}</td>
                <td className="font-mono">{fmt(ent.data.market.reduce((a, r) => a + r.shareTotal, 0))}</td>
              </tr>
            </tbody>
          </table>
        )}
      </WbPanel>

      <WbPanel title="按企业拆账 · 充值（工作台企业空间）" hud="TOPUP LEDGER" className="mt-4">
        {ent.data && (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-faint">
                <th className="py-2">企业</th><th>确认笔数</th><th>充值Token</th><th>充值金额</th><th>待审批</th>
              </tr>
            </thead>
            <tbody>
              {ent.data.topups.map((r) => (
                <tr key={r.id} className="border-t border-line-subtle/50 text-ink-secondary">
                  <td className="py-2 text-ink-primary">{r.name}</td>
                  <td className="font-mono">{fmt(r.confirmedCount)}</td>
                  <td className="font-mono">{fmt(r.confirmedAmount)}</td>
                  <td className="font-mono">{cny(r.confirmedCny)}</td>
                  <td className="font-mono">{fmt(r.pendingCount)}</td>
                </tr>
              ))}
              {ent.data.topups.length === 0 && (
                <tr><td colSpan={5} className="py-4 text-center text-ink-faint">暂无充值记录</td></tr>
              )}
            </tbody>
          </table>
        )}
        <p className="mt-2 text-[11px] text-ink-faint">
          口径说明：匠市流通/钱包（enterprises）与充值台账（wb_factories）分属两套企业空间，无跨系统外键，本页如实分列不做名称猜测合并。
        </p>
      </WbPanel>
    </div>
  )
}
