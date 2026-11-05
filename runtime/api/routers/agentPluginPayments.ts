import { createHash } from 'node:crypto'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { TRPCError } from '@trpc/server'
import QRCode from 'qrcode'
import { createRouter, publicQuery } from '../middleware'
import { getDb } from '../queries/connection'
import { rawRows } from '../queries/rawRows'
import { sessionMe } from './wbSession'
import { requireDualSign } from '../auth/adminDualSign'
import { createWechatNativeOrder, createWechatRefund, queryWechatOrder, verifyWechatCallback, wechatPayloadSha256, wechatXml, type WechatRequest } from '../lib/wechatPayV2'

type Db = ReturnType<typeof getDb>
function sha(value: string): string { return createHash('sha256').update(value).digest('hex') }
function tradeTime(date: Date): string { return date.toISOString().replace(/[-:TZ]/g, '').slice(0, 14) }
function orderNumber(registrationId: number, packageId: number, factoryId: number, idem: string): string { return `pp_${sha(`${registrationId}|${packageId}|${factoryId}|${idem}`).slice(0, 48)}` }
async function ownedOrder(db: Db, orderNo: string, uid: number, factoryId: number) {
  const order = rawRows(await db.execute(sql`SELECT o.*, r.owner_user_id AS ownerUserId FROM st_agent_plugin_payment_orders o JOIN st_agent_registrations r ON r.id=o.registration_id WHERE o.order_no=${orderNo} AND o.factory_id=${factoryId} LIMIT 1`))[0]
  if (!order || Number(order.ownerUserId) !== uid) throw new TRPCError({ code: 'NOT_FOUND', message: '插件订阅订单不存在' })
  return order
}

export async function grantPluginOrder(args: { outTradeNo: string; transactionId: string; totalFee: number; tradeState: string; timeEnd: string; eventType: 'paid' | 'reconciled' }, db = getDb()) {
  if (args.tradeState !== 'SUCCESS') throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '微信支付尚未成功' })
  return db.transaction(async (tx) => {
    const order = rawRows(await tx.execute(sql`SELECT * FROM st_agent_plugin_payment_orders WHERE out_trade_no=${args.outTradeNo} FOR UPDATE`))[0]
    if (!order) throw new TRPCError({ code: 'NOT_FOUND', message: '插件订单不存在' })
    if (Number(order.amount_cents) !== args.totalFee) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '回调金额与插件订单不一致' })
    if (order.status === 'paid' || order.status === 'refunded') {
      if (String(order.transaction_id) !== args.transactionId) throw new TRPCError({ code: 'CONFLICT', message: '订单已支付，但微信交易号不一致' })
      return { ok: true as const, already: true as const, orderNo: String(order.order_no) }
    }
    if (order.status !== 'pending') throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '插件订单当前状态不可开通权益' })
    const eventId = `wechat:${args.transactionId}:${args.outTradeNo}`
    const inserted = await tx.execute(sql`INSERT INTO st_agent_plugin_payment_events (event_id, order_id, event_type, transaction_id, payload_sha256) VALUES (${eventId}, ${Number(order.id)}, ${args.eventType}, ${args.transactionId}, ${wechatPayloadSha256(JSON.stringify(args))}) ON DUPLICATE KEY UPDATE event_id=event_id`)
    const affected = Number((Array.isArray(inserted) ? inserted[0] : inserted as { affectedRows?: number })?.affectedRows ?? 0)
    if (affected === 0) return { ok: true as const, already: true as const, orderNo: String(order.order_no) }
    await tx.execute(sql`UPDATE st_agent_plugin_payment_orders SET status='paid', transaction_id=${args.transactionId}, paid_at=${args.timeEnd ? new Date(args.timeEnd.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3T$4:$5:$6+08:00')) : new Date() } WHERE id=${Number(order.id)}`)
    await tx.execute(sql`INSERT INTO st_agent_plugin_entitlements (registration_id, package_id, factory_id, payment_order_no, status, expires_at)
      VALUES (${Number(order.registration_id)}, ${Number(order.package_id)}, ${Number(order.factory_id)}, ${String(order.order_no)}, 'active', DATE_ADD(${args.timeEnd ? new Date(args.timeEnd.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3T$4:$5:$6+08:00')) : new Date()}, INTERVAL ${Number(order.duration_days)} DAY))
      ON DUPLICATE KEY UPDATE factory_id=VALUES(factory_id), payment_order_no=VALUES(payment_order_no), status='active', expires_at=VALUES(expires_at)`)
    return { ok: true as const, already: false as const, orderNo: String(order.order_no) }
  })
}

export const agentPluginPaymentsRouter = createRouter({
  create: publicQuery.input(z.object({ token: z.string().trim().min(1), registrationId: z.number().int().positive(), packageId: z.number().int().positive(), idempotencyKey: z.string().trim().min(8).max(128) })).mutation(async ({ input, ctx }) => {
    const session = await sessionMe(input.token)
    const db = getDb()
    const registration = rawRows(await db.execute(sql`SELECT owner_user_id AS ownerUserId, status FROM st_agent_registrations WHERE id=${input.registrationId} LIMIT 1`))[0]
    if (!registration || Number(registration.ownerUserId) !== Number(session.user.id) || registration.status !== 'qualified') throw new TRPCError({ code: 'FORBIDDEN', message: '仅本人训练达标 Agent 可订阅插件' })
    const pkg = rawRows(await db.execute(sql`SELECT id, package_key AS packageKey, name, price_cents AS priceCents, duration_days AS durationDays FROM st_agent_plugin_packages WHERE id=${input.packageId} AND status='active' LIMIT 1`))[0]
    if (!pkg || !Number.isSafeInteger(Number(pkg.priceCents)) || Number(pkg.priceCents) <= 0 || Number(pkg.durationDays) < 1 || Number(pkg.durationDays) > 365) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '插件订阅价格或期限未配置' })
    const factoryId = Number(session.factory.id)
    const orderNo = orderNumber(input.registrationId, input.packageId, factoryId, input.idempotencyKey)
    const existing = rawRows(await db.execute(sql`SELECT order_no AS orderNo, out_trade_no AS outTradeNo, code_url AS codeUrl, status FROM st_agent_plugin_payment_orders WHERE order_no=${orderNo} LIMIT 1`))[0]
    if (existing) return { orderNo: String(existing.orderNo), outTradeNo: String(existing.outTradeNo), codeUrl: existing.codeUrl ? String(existing.codeUrl) : null, status: String(existing.status), already: true as const }
    const entitlement = rawRows(await db.execute(sql`SELECT status, expires_at AS expiresAt FROM st_agent_plugin_entitlements WHERE registration_id=${input.registrationId} AND package_id=${input.packageId} AND factory_id=${factoryId} LIMIT 1`))[0]
    if (entitlement?.status === 'active' && (!entitlement.expiresAt || new Date(String(entitlement.expiresAt)).getTime() > Date.now())) throw new TRPCError({ code: 'CONFLICT', message: '当前插件权益仍有效，无需重复订阅' })
    const now = new Date()
    const expires = new Date(now.getTime() + 30 * 60_000)
    const outTradeNo = orderNo
    await db.execute(sql`INSERT INTO st_agent_plugin_payment_orders (order_no, registration_id, package_id, factory_id, amount_cents, duration_days, status, out_trade_no, expires_at, idempotency_key) VALUES (${orderNo}, ${input.registrationId}, ${input.packageId}, ${factoryId}, ${Number(pkg.priceCents)}, ${Number(pkg.durationDays)}, 'creating', ${outTradeNo}, ${expires}, ${input.idempotencyKey})`)
    try {
      const clientIp = String((ctx as { clientIp?: string }).clientIp ?? '')
      if (!clientIp) throw new TRPCError({ code: 'BAD_REQUEST', message: '无法确认下单客户端 IP' })
      const result = await createWechatNativeOrder({ outTradeNo, totalFee: Number(pkg.priceCents), description: `${String(pkg.name)} 插件订阅 ${Number(pkg.durationDays)} 天`, clientIp, productId: String(pkg.id), timeStart: tradeTime(now), timeExpire: tradeTime(expires) })
      await db.execute(sql`UPDATE st_agent_plugin_payment_orders SET status='pending', prepay_id=${result.prepayId}, code_url=${result.codeUrl} WHERE order_no=${orderNo}`)
      return { orderNo, outTradeNo, codeUrl: result.codeUrl, status: 'pending' as const, already: false as const }
    } catch (error) {
      await db.execute(sql`UPDATE st_agent_plugin_payment_orders SET status='failed' WHERE order_no=${orderNo}`)
      throw error
    }
  }),
  qr: publicQuery.input(z.object({ token: z.string().trim().min(1), orderNo: z.string().trim().min(8).max(64) })).query(async ({ input }) => {
    const session = await sessionMe(input.token)
    const order = await ownedOrder(getDb(), input.orderNo, Number(session.user.id), Number(session.factory.id))
    if (!order.code_url) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '订单尚未取得微信支付 code_url' })
    const png = await QRCode.toBuffer(String(order.code_url), { type: 'png', width: 512, margin: 1, errorCorrectionLevel: 'M' })
    return { pngBase64: png.toString('base64'), codeUrl: String(order.code_url), binding: { orderNo: String(order.order_no), outTradeNo: String(order.out_trade_no), registrationId: Number(order.registration_id), packageId: Number(order.package_id), factoryId: Number(order.factory_id), amountCents: Number(order.amount_cents), durationDays: Number(order.duration_days) } }
  }),
  status: publicQuery.input(z.object({ token: z.string().trim().min(1), orderNo: z.string().trim().min(8).max(64) })).query(async ({ input }) => {
    const session = await sessionMe(input.token)
    const order = await ownedOrder(getDb(), input.orderNo, Number(session.user.id), Number(session.factory.id))
    const entitlement = rawRows(await getDb().execute(sql`SELECT status, expires_at AS expiresAt, payment_order_no AS paymentOrderNo FROM st_agent_plugin_entitlements WHERE registration_id=${Number(order.registration_id)} AND package_id=${Number(order.package_id)} AND factory_id=${Number(session.factory.id)} LIMIT 1`))[0]
    return { orderNo: String(order.order_no), status: String(order.status), amountCents: Number(order.amount_cents), durationDays: Number(order.duration_days), transactionId: order.transaction_id ? String(order.transaction_id) : null, paidAt: order.paid_at, entitlement: entitlement ?? null }
  }),
  reconcile: publicQuery.input(z.object({ token: z.string().trim().min(1), reviewToken: z.string().trim().min(1), orderNo: z.string().trim().min(8).max(64) })).mutation(async ({ input }) => {
    await requireDualSign(input.token, input.reviewToken, 'release')
    const db = getDb()
    const order = rawRows(await db.execute(sql`SELECT order_no AS orderNo, out_trade_no AS outTradeNo FROM st_agent_plugin_payment_orders WHERE order_no=${input.orderNo} AND status='pending' LIMIT 1`))[0]
    if (!order) throw new TRPCError({ code: 'NOT_FOUND', message: '待对账插件订单不存在' })
    const result = await queryWechatOrder(String(order.outTradeNo))
    return grantPluginOrder({ outTradeNo: String(order.outTradeNo), transactionId: String(result.transaction_id), totalFee: Number(result.total_fee), tradeState: String(result.trade_state), timeEnd: String(result.time_end ?? ''), eventType: 'reconciled' }, db)
  }),
  refund: publicQuery.input(z.object({ token: z.string().trim().min(1), reviewToken: z.string().trim().min(1), orderNo: z.string().trim().min(8).max(64) })).mutation(async ({ input }) => {
    await requireDualSign(input.token, input.reviewToken, 'release')
    const db = getDb()
    const order = rawRows(await db.execute(sql`SELECT * FROM st_agent_plugin_payment_orders WHERE order_no=${input.orderNo} AND status='paid' LIMIT 1`))[0]
    if (!order) throw new TRPCError({ code: 'NOT_FOUND', message: '可退款插件订单不存在' })
    const outRefundNo = `pr_${sha(`${input.orderNo}|refund`).slice(0, 48)}`
    const result = await createWechatRefund({ outTradeNo: String(order.out_trade_no), outRefundNo, totalFee: Number(order.amount_cents), refundFee: Number(order.amount_cents), transactionId: String(order.transaction_id) })
    await db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE st_agent_plugin_payment_orders SET status='refunded', refunded_at=NOW() WHERE order_no=${input.orderNo}`)
      await tx.execute(sql`UPDATE st_agent_plugin_entitlements SET status='revoked' WHERE registration_id=${Number(order.registration_id)} AND package_id=${Number(order.package_id)} AND factory_id=${Number(order.factory_id)}`)
      await tx.execute(sql`INSERT INTO st_agent_plugin_payment_events (event_id, order_id, event_type, transaction_id, payload_sha256) VALUES (${`wechat-refund:${outRefundNo}`}, ${Number(order.id)}, 'refunded', ${String(order.transaction_id)}, ${wechatPayloadSha256(JSON.stringify(result))})`)
    })
    return { ok: true as const, orderNo: input.orderNo, refundId: result.refund_id ? String(result.refund_id) : null }
  }),
})

export async function handleWechatPayCallback(c: { req: { text: () => Promise<string> }, text: (text: string, status?: number) => Response }) {
  try {
    const xml = await c.req.text()
    const verified = verifyWechatCallback(xml)
    await grantPluginOrder({ ...verified, eventType: 'paid' })
    return c.text(wechatXml({ return_code: 'SUCCESS', return_msg: 'OK' }), 200)
  } catch {
    return c.text(wechatXml({ return_code: 'FAIL', return_msg: 'invalid payment callback' }), 400)
  }
}

export type { WechatRequest }
