import { useMemo, useState } from 'react'
import { Download, Package, RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import { callWb, useWbQuery, wbErrorMessage, type WbSession } from '@/lib/wbSession'
import { savePluginArtifact } from '@/lib/agentPluginDownload'
import { WbError, WbLoading, WbNotice } from '@/components/wb/ui'

interface Registration { id: number; registrationNo: string; agentName: string }
interface PluginManifest { entry: string; permissions: string[]; platform: string; arch: string; dependencies: string[]; payloadSha256: string; signature: string; signerPublicKey: string }
interface PackageRow { id: number; packageKey: string; name: string; version: string; description: string | null; priceCents: number; durationDays: number; artifactSha256: string; status: string; manifest: PluginManifest; signatureVerified: boolean; trustedKeySha256: string }
interface PaymentState { orderNo: string; codeUrl: string; pngBase64: string; binding: { outTradeNo: string; registrationId: number; packageId: number; factoryId: number; amountCents: number; durationDays: number }; status?: string }
interface InstallRow { id: number; registrationId: number; packageId: number; packageKey: string; name: string; version: string; status: string; installTicket: string; rollbackOf: number | null; artifactSha256: string }
interface EntitlementRow { packageId: number; status: string; effectiveStatus: 'active' | 'inactive'; expiresAt: string | null }
interface DownloadResult { fileName: string; artifactBase64: string; artifactSha256: string; executable: boolean }

export default function AgentPluginWorkbench(props: {
  session: WbSession
  registrations: Registration[]
  registrationId: number
  onRegistrationChange: (id: number) => void
}) {
  const { session, registrations, registrationId, onRegistrationChange } = props
  const packages = useWbQuery<{ packages: PackageRow[] }>('agentPlugins.list', session, {}, { withToken: false })
  const mine = useWbQuery<{ installs: InstallRow[]; entitlements: EntitlementRow[] }>('agentPlugins.mine', session, { registrationId }, { enabled: registrationId > 0 })
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const entitlementByPackage = useMemo(() => new Map((mine.data?.entitlements ?? []).map((item) => [item.packageId, item])), [mine.data])
  const [retry, setRetry] = useState<(() => void) | null>(null)
  const [payment, setPayment] = useState<PaymentState | null>(null)
  const installedByPackage = useMemo(() => new Map((mine.data?.installs ?? []).filter((item) => item.status === 'installed').map((item) => [item.packageId, item])), [mine.data])

  async function run(key: string, action: () => Promise<string>): Promise<void> {
    if (busy) return
    setBusy(key)
    setNotice(null)
    setError(null)
    setRetry(() => () => run(key, action))
    try {
      const message = await action()
      setNotice(message)
      setRetry(null)
      await mine.refetch()
    } catch (err) {
      setError(wbErrorMessage(err))
      await mine.refetch()
    } finally { setBusy(null) }
  }
  function requireRegistration(): number {
    if (!registrationId || !registrations.some((item) => item.id === registrationId)) throw new Error('请选择训练达标且属于当前账号的 Agent')
    return registrationId
  }
  const install = (pkg: PackageRow) => run(`install-${pkg.id}`, async () => {
    const result = await callWb('mutation', 'agentPlugins.install', session, { registrationId: requireRegistration(), packageId: pkg.id }) as { installTicket: string; already: boolean }
    return `${pkg.name} ${pkg.version} 安装回执已回读：${result.installTicket}${result.already ? '（幂等）' : ''}`
  })
  const download = (pkg: PackageRow) => run(`download-${pkg.id}`, async () => {
    const result = await callWb('query', 'agentPlugins.download', session, { registrationId: requireRegistration(), packageId: pkg.id }) as DownloadResult
    await savePluginArtifact(result)
    return `${pkg.name} ${pkg.version} 验签制品已下载，SHA-256 ${result.artifactSha256.slice(0, 12)}…；未执行插件代码`
  })
  const uninstall = (item: InstallRow) => run(`uninstall-${item.id}`, async () => {
    const result = await callWb('mutation', 'agentPlugins.uninstall', session, { registrationId: requireRegistration(), packageId: item.packageId }) as { affectedRows: number }
    return result.affectedRows === 0 ? `${item.name} ${item.version} 已是卸载状态（幂等回读）` : `${item.name} ${item.version} 已卸载并回读`
  })
  const rollback = (item: InstallRow) => run(`rollback-${item.id}`, async () => {
    const result = await callWb('mutation', 'agentPlugins.rollback', session, { registrationId: requireRegistration(), packageId: item.packageId }) as { version: string; installTicket: string }
    return `已回滚到 ${result.version}，新回滚票据 ${result.installTicket}`
  })

  const subscribe = (pkg: PackageRow) => run(`subscribe-${pkg.id}`, async () => {
    const created = await callWb('mutation', 'agentPluginPayments.create', session, { registrationId: requireRegistration(), packageId: pkg.id, idempotencyKey: `plugin-subscription-${crypto.randomUUID()}` }) as { orderNo: string }
    const qr = await callWb('query', 'agentPluginPayments.qr', session, { orderNo: created.orderNo }) as PaymentState
    setPayment(qr)
    return `${pkg.name} 的 30 天订阅订单已创建，二维码已绑定订单 ${created.orderNo}`
  })
  const refreshPayment = () => run('payment-status', async () => {
    if (!payment) throw new Error('请先创建插件订阅订单')
    const status = await callWb('query', 'agentPluginPayments.status', session, { orderNo: payment.orderNo }) as { status: string }
    setPayment((current) => current ? { ...current, status: status.status } : current)
    return `支付状态已回读：${status.status}`
  })

  return <section className="mt-8 space-y-5" aria-label="Agent 插件工作台">
    <div className="rounded-xl border border-line-subtle bg-white/[0.02] p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold"><Package className="h-5 w-5 text-pulse-cyan" />Agent 插件工作台</h2>
          <p className="mt-2 text-xs leading-6 text-ink-faint">只展示服务端已登记、验签和授权的最小权限制品。下载不等于执行；安装、卸载与回滚均以 MySQL 回读为准。</p>
        </div>
        <button type="button" className="inline-flex items-center gap-2 rounded-lg border border-line-subtle px-3 py-2 text-xs text-ink-faint" onClick={() => { setError(null); void packages.refetch(); void mine.refetch() }}><RefreshCw className="h-4 w-4" />刷新与回读</button>
      </div>
      <label className="mt-4 block text-xs text-ink-secondary">选择训练达标 Agent
        <select className="mt-2 w-full rounded-lg border border-line-subtle bg-void px-3 py-2 text-sm" value={registrationId} onChange={(event) => onRegistrationChange(Number(event.target.value))}>
          <option value={0}>请选择 Agent</option>
          {registrations.map((item) => <option key={item.id} value={item.id}>{item.agentName} · {item.registrationNo}</option>)}
        </select>
      </label>
      {!registrationId && <p className="mt-3 text-xs text-forge-amber">训练达标并选择 Agent 后，才能下载、安装、卸载或回滚。</p>}
    </div>
    {notice && <WbNotice message={notice} />}
    {error && <div className="flex flex-wrap items-center gap-3"><WbError message={error} />{retry && <button type="button" disabled={Boolean(busy)} onClick={() => void retry()} className="rounded-lg border border-forge-amber px-3 py-2 text-xs text-forge-amber">重试（服务端幂等回读）</button>}</div>}
    {packages.error && <WbError message={packages.error} />}
    {mine.error && <WbError message={mine.error} />}
    {payment && <div className="rounded-xl border border-pulse-cyan/30 p-4">
      <div className="flex flex-wrap items-start gap-4">
        <img src={`data:image/png;base64,${payment.pngBase64}`} alt={`插件订阅订单 ${payment.orderNo} 的微信支付二维码`} className="h-40 w-40 rounded-lg bg-white p-2" />
        <div className="min-w-0 flex-1 text-xs text-ink-secondary">
          <h3 className="text-sm font-semibold text-ink-primary">微信 Native 订阅二维码</h3>
          <p className="mt-2">金额：¥{(payment.binding.amountCents / 100).toFixed(2)} · 期限：{payment.binding.durationDays} 天（一个月）</p>
          <p className="mt-1 break-all font-mono">订单：{payment.orderNo}</p>
          <p className="mt-1 break-all font-mono">out_trade_no：{payment.binding.outTradeNo}</p>
          <p className="mt-1">registration #{payment.binding.registrationId} · package #{payment.binding.packageId} · factory #{payment.binding.factoryId}</p>
          <p className="mt-2 text-forge-amber">扫码只代表可付款，支付结果以微信回调和订单回读为准{payment.status ? `：${payment.status}` : '。'}</p>
          <button type="button" disabled={Boolean(busy)} onClick={() => void refreshPayment()} className="mt-3 rounded-lg border border-pulse-cyan/40 px-3 py-2 text-pulse-cyan">回读支付状态</button>
        </div>
      </div>
    </div>}
    {packages.loading && <WbLoading text="读取已登记插件包" />}
    <div className="grid gap-4 lg:grid-cols-2">
      {(packages.data?.packages ?? []).map((pkg) => {
        const installed = installedByPackage.get(pkg.id)
        const entitlement = entitlementByPackage.get(pkg.id)
        const entitled = entitlement?.effectiveStatus === 'active'
        const operable = entitled && pkg.signatureVerified === true
        return <article key={pkg.id} className="rounded-xl border border-line-subtle p-4">
          <div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold text-ink-primary">{pkg.name}</h3><p className="mt-1 font-mono text-xs text-ink-faint">{pkg.packageKey} · {pkg.version}</p></div>{installed && <span className="rounded-full border border-jade-green/40 px-2 py-1 text-xs text-jade-green">已安装</span>}</div>
          <p className="mt-3 text-sm text-ink-secondary">{pkg.description || '最小权限 Agent 插件包'}</p>
          <p className="mt-2 font-mono text-[10px] text-ink-faint">SHA-256 {pkg.artifactSha256}</p>
          <div className="mt-3 space-y-1 rounded-lg border border-line-subtle p-3 text-xs text-ink-secondary">
            <p>签名：{pkg.signatureVerified ? 'Ed25519 已验签' : '未通过'} · 信任锚 {pkg.trustedKeySha256.slice(0, 12)}…</p>
            <p>平台：{pkg.manifest.platform}/{pkg.manifest.arch} · 入口 {pkg.manifest.entry}</p>
            <p>依赖：{pkg.manifest.dependencies.length ? pkg.manifest.dependencies.join('、') : '无'}</p>
            <p>最小权限：{pkg.manifest.permissions.join('、')}</p>
            <p>企业权益：{entitled ? '有效' : '不可用'}{entitlement?.expiresAt ? ` · 到期 ${String(entitlement.expiresAt)}` : ''}</p>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" disabled={Boolean(busy) || !registrationId || Boolean(installed) || !operable} onClick={() => void install(pkg)} className="rounded-lg bg-pulse-cyan px-3 py-2 text-xs font-semibold text-void disabled:opacity-40">{installed ? '已安装' : '安装'}</button>
            <button type="button" disabled={Boolean(busy) || !registrationId || !operable} onClick={() => void download(pkg)} className="inline-flex items-center gap-1 rounded-lg border border-pulse-cyan/40 px-3 py-2 text-xs text-pulse-cyan disabled:opacity-40"><Download className="h-3 w-3" />验签下载</button>
            {!entitled && pkg.priceCents > 0 && <button type="button" disabled={Boolean(busy) || !registrationId || pkg.signatureVerified !== true} onClick={() => void subscribe(pkg)} className="rounded-lg border border-forge-amber/50 px-3 py-2 text-xs text-forge-amber disabled:opacity-40">订阅30天 ¥{(pkg.priceCents / 100).toFixed(2)}</button>}
            {installed && <><button type="button" disabled={Boolean(busy)} onClick={() => void rollback(installed)} className="inline-flex items-center gap-1 rounded-lg border border-forge-amber/40 px-3 py-2 text-xs text-forge-amber"><RotateCcw className="h-3 w-3" />回滚</button><button type="button" disabled={Boolean(busy)} onClick={() => void uninstall(installed)} className="inline-flex items-center gap-1 rounded-lg border border-line-subtle px-3 py-2 text-xs text-ink-faint"><Trash2 className="h-3 w-3" />卸载</button></>}
          </div>
        </article>
      })}
    </div>
    {!packages.loading && packages.data?.packages.length === 0 && <p className="rounded-xl border border-line-subtle p-4 text-sm text-ink-faint">当前没有已登记并处于上架状态的插件包。</p>}
    <div className="rounded-xl border border-line-subtle p-5">
      <h3 className="font-semibold">安装票据与版本回读</h3>
      {mine.loading && registrationId > 0 && <WbLoading text="回读安装票据" />}
      <div className="mt-3 space-y-3">{(mine.data?.installs ?? []).map((item) => <div key={item.id} className="rounded-lg border border-line-subtle p-3 text-xs"><div className="flex flex-wrap justify-between gap-2"><span>{item.name} · {item.version}</span><span className={item.status === 'installed' ? 'text-jade-green' : 'text-ink-faint'}>{item.status}</span></div><p className="mt-2 break-all font-mono text-ink-faint">{item.installTicket}</p><p className="mt-1 font-mono text-ink-faint">SHA-256 {item.artifactSha256}{item.rollbackOf ? ` · rollback_of ${item.rollbackOf}` : ''}</p></div>)}</div>
      {registrationId > 0 && !mine.loading && mine.data?.installs.length === 0 && <p className="mt-3 text-xs text-ink-faint">该 Agent 尚无安装记录。</p>}
    </div>
  </section>
}
