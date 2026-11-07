import { useEffect, useState } from 'react'
import { QrCode, RefreshCw } from 'lucide-react'
import { callWb, wbErrorMessage, type WbSession } from '@/lib/wbSession'
import { WbError, WbLoading } from '@/components/wb/ui'

interface TrainingOrder {
  orderNo: string
  registrationId: number
  kind: string
  attemptNo: number
  amountCents: number
  status: string
}
interface QrState {
  orderNo: string
  pngBase64: string
  binding: { orderNo: string; outTradeNo: string; registrationId: number; kind: string; attemptNo: number; amountCents: number }
}

export default function WechatPendingOrderCard(props: {
  session: WbSession
  order: TrainingOrder
  onRefresh: () => Promise<unknown>
}) {
  const { session, order, onRefresh } = props
  const [qr, setQr] = useState<QrState | null>(null)
  const [status, setStatus] = useState(order.status)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    setError(null)
    setQr(null)
    void callWb('query', 'agentTraining.paymentQr', session, { orderNo: order.orderNo })
      .then((result) => { if (active) setQr(result as QrState) })
      .catch((cause) => { if (active) setError(wbErrorMessage(cause)) })
    return () => { active = false }
  }, [order.orderNo, session])

  async function refreshStatus() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await callWb('query', 'agentTraining.paymentStatus', session, { orderNo: order.orderNo }) as { status: string }
      setStatus(result.status)
      await onRefresh()
    } catch (cause) {
      setError(wbErrorMessage(cause))
    } finally { setBusy(false) }
  }

  return <div className="rounded-xl border border-pulse-cyan/30 bg-pulse-cyan/5 p-4" aria-label={`微信订单 ${order.orderNo}`}>
    <div className="flex flex-wrap items-start gap-4">
      {qr ? <img src={`data:image/png;base64,${qr.pngBase64}`} alt={`订单 ${order.orderNo} 的微信支付二维码`} className="h-40 w-40 rounded-lg bg-white p-2" /> : <WbLoading text="读取微信支付二维码" />}
      <div className="min-w-0 flex-1 text-xs text-ink-secondary">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink-primary"><QrCode className="h-4 w-4 text-pulse-cyan" />{order.kind === 'registration' ? '个人 Agent 报名费' : `第 ${order.attemptNo} 次补考费`} · 微信支付</h3>
        <p className="mt-2">金额：¥{(order.amountCents / 100).toFixed(2)} · registration #{order.registrationId}</p>
        <p className="mt-1 break-all font-mono">订单：{order.orderNo}</p>
        {qr && <p className="mt-1 break-all font-mono">out_trade_no：{qr.binding.outTradeNo}</p>}
        <p className="mt-2" aria-live="polite">订单状态：{status}。扫码只代表可付款，训练开通以签名回调和订单回读为准。</p>
        <button type="button" disabled={busy || !qr} onClick={() => void refreshStatus()} className="mt-3 inline-flex items-center gap-2 rounded-lg border border-pulse-cyan/40 px-3 py-2 text-pulse-cyan disabled:opacity-40">
          <RefreshCw className="h-3.5 w-3.5" />回读支付状态
        </button>
        {error && <div className="mt-3"><WbError message={error} /></div>}
      </div>
    </div>
  </div>
}
