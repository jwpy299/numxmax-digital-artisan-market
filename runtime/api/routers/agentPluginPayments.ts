import { createHash } from 'node:crypto'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { TRPCError } from '@trpc/server'
import QRCode from 'qrcode'
import { createRouter, publicQuery } from '../middleware'
import { getDb } from '../queries/connection'
import { rawRows, logQueryErrorThrottled } from '../queries/rawRows'
import { sessionMe } from './wbSession'
import { requireDualSign } from '../auth/adminDualSign'
import { writeAdminAuditResult } from './adminAnalytics'
import { createWechatNativeOrder, createWechatRefund, queryWechatOrder, verifyWechatCallback, wechatPayloadSha256, wechatXml, type WechatRequest } from '../lib/wechatPayV2'
import { getCachedAgentPluginVerification, verifyAndCacheAgentPluginPackage } from '../lib/agentPluginVerification'
import { readTrustedAgentPluginPublicKeys } from '../lib/agentPluginTrust'
import { affectedRowsOf } from '../lib/dbResult'
import { isDupEntry } from '../lib/dupEntry'
import { assertVerifiedPackageIdentity } from './agentPlugins'
import { processWechatRegistrationCallback } from './agentEmployment'

type Db = ReturnType<typeof getDb>
type DbExecutor = Pick<Db, 'execute'>
type PluginOrderIdentity = Record<string, unknown>
function sha(value: string): string { return createHash('sha256').update(value).digest('hex') }
function tradeTime(date: Date): string { return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().replace(/[-:TZ]/g, '').slice(0, 14) }
function orderNumber(registrationId: number, packageId: number, factoryId: number, cycle: number): string { return `pp_${sha(`${registrationId}|${packageId}|${factoryId}|${cycle}`).slice(0, 28)}` }
function assertOrderTransition(result: unknown): void {
  if (affectedRowsOf(result) !== 1) throw new TRPCError({ code: 'CONFLICT', message: '订单状态已被其他流程推进，未覆盖' })
}
function auditWarning(outcome: 'written' | 'failed' | 'timeout'): string | null {
  return outcome === 'written' ? null : outcome === 'timeout' ? '审计结果未知（写入超时），请人工核查，禁止盲目重试' : '操作已完成，审计写入失败；请人工核查，禁止盲目重试'
}
/** 只允许撤销该订单当前仍持有的权益；旧订单退款不能撤销后续订单已开通的权益。 */
export async function revokeCurrentPluginOrderEntitlement(db: DbExecutor, order: PluginOrderIdentity): Promise<void> {
  await db.execute(sql`UPDATE st_agent_plugin_entitlements SET status='revoked' WHERE registration_id=${Number(order.registration_id)} AND package_id=${Number(order.package_id)} AND factory_id=${Number(order.factory_id)} AND payment_order_no=${String(order.order_no)}`)
}
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
    const entitlementFactories = rawRows(await tx.execute(sql`SELECT factory_id AS factoryId FROM st_agent_plugin_entitlements WHERE registration_id=${Number(order.registration_id)} AND package_id=${Number(order.package_id)} FOR UPDATE`))
    if (entitlementFactories.some((row) => Number(row.factoryId ?? 0) !== Number(order.factory_id))) throw new TRPCError({ code: 'CONFLICT', message: '同一 Agent 插件权益已归属其他企业，禁止跨企业覆盖或重置' })
    const eventId = `wechat:${args.transactionId}:${args.outTradeNo}`
    const inserted = await tx.execute(sql`INSERT INTO st_agent_plugin_payment_events (event_id, order_id, event_type, transaction_id, payload_sha256) VALUES (${eventId}, ${Number(order.id)}, ${args.eventType}, ${args.transactionId}, ${wechatPayloadSha256(JSON.stringify(args))}) ON DUPLICATE KEY UPDATE event_id=event_id`)
    const affected = affectedRowsOf(inserted)
    if (affected === 0) return { ok: true as const, already: true as const, orderNo: String(order.order_no) }
    await tx.execute(sql`UPDATE st_agent_plugin_payment_orders SET status='paid', transaction_id=${args.transactionId}, paid_at=${args.timeEnd ? new Date(args.timeEnd.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3T$4:$5:$6+08:00')) : new Date() } WHERE id=${Number(order.id)}`)
    await tx.execute(sql`INSERT INTO st_agent_plugin_entitlements (registration_id, package_id, factory_id, payment_order_no, status, expires_at)
      VALUES (${Number(order.registration_id)}, ${Number(order.package_id)}, ${Number(order.factory_id)}, ${String(order.order_no)}, 'active', DATE_ADD(${args.timeEnd ? new Date(args.timeEnd.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3T$4:$5:$6+08:00')) : new Date()}, INTERVAL ${Number(order.duration_days)} DAY))
      ON DUPLICATE KEY UPDATE payment_order_no=VALUES(payment_order_no), status='active', expires_at=VALUES(expires_at)`)
    return { ok: true as const, already: false as const, orderNo: String(order.order_no) }
  })
}

function existingOrderResponse(order: PluginOrderIdentity) {
  return { orderNo: String(order.order_no), outTradeNo: String(order.out_trade_no), codeUrl: order.code_url ? String(order.code_url) : null, status: String(order.status), already: true as const }
}
async function assertPayablePackage(db: Db, pkg: PluginOrderIdentity): Promise<void> {
  let trustedKeys: string[]
  try { trustedKeys = readTrustedAgentPluginPublicKeys() } catch { throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '插件独立信任锚未配置或配置无效，禁止订阅' }) }
  const trusted = trustedKeys.find((key) => key === String(pkg.signerPublicKey))
  if (!trusted) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '插件签名者不在独立信任公钥集合中，禁止订阅' })
  const expected = { signerPublicKey: trusted, signature: String(pkg.signature), artifactSha256: String(pkg.artifactSha256) }
  const cached = getCachedAgentPluginVerification(expected.artifactSha256, expected)
  if (cached) { assertVerifiedPackageIdentity(pkg, cached); return }
  const artifact = rawRows(await db.execute(sql`SELECT artifact_blob AS artifactBlob FROM st_agent_plugin_packages WHERE id=${Number(pkg.id)} AND status='active' AND artifact_sha256=${expected.artifactSha256} LIMIT 1`))[0]
  if (!artifact) throw new TRPCError({ code: 'NOT_FOUND', message: '插件制品不存在或已更换，禁止订阅' })
  try {
    const verification = await verifyAndCacheAgentPluginPackage(Buffer.from(artifact.artifactBlob as Buffer), expected)
    assertVerifiedPackageIdentity(pkg, verification)
  } catch (error) {
    if (error instanceof TRPCError) throw error
    throw new TRPCError({ code: 'FORBIDDEN', message: '插件制品验签失败，禁止订阅', cause: error })
  }
}

export const agentPluginPaymentsRouter = createRouter({
  create: publicQuery.input(z.object({ token: z.string().trim().min(1), registrationId: z.number().int().positive(), packageId: z.number().int().positive(), idempotencyKey: z.string().trim().min(8).max(128) })).mutation(async ({ input, ctx }) => {
    const session = await sessionMe(input.token)
    const db = getDb()
    const registration = rawRows(await db.execute(sql`SELECT owner_user_id AS ownerUserId, status FROM st_agent_registrations WHERE id=${input.registrationId} LIMIT 1`))[0]
    if (!registration || Number(registration.ownerUserId) !== Number(session.user.id) || registration.status !== 'qualified') throw new TRPCError({ code: 'FORBIDDEN', message: '仅本人训练达标 Agent 可订阅插件' })
    const pkg = rawRows(await db.execute(sql`SELECT id, package_key AS packageKey, name, version, price_cents AS priceCents, duration_days AS durationDays, artifact_sha256 AS artifactSha256, signature, signer_public_key AS signerPublicKey FROM st_agent_plugin_packages WHERE id=${input.packageId} AND status='active' LIMIT 1`))[0]
    if (!pkg || !Number.isSafeInteger(Number(pkg.priceCents)) || Number(pkg.priceCents) <= 0 || Number(pkg.durationDays) < 1 || Number(pkg.durationDays) > 365) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '插件订阅价格或期限未配置' })
    const factoryId = Number(session.factory.id)
    const existing = rawRows(await db.execute(sql`SELECT * FROM st_agent_plugin_payment_orders WHERE idempotency_key=${input.idempotencyKey} LIMIT 1`))[0]
    if (existing) {
      if (Number(existing.registration_id) !== input.registrationId || Number(existing.package_id) !== input.packageId || Number(existing.factory_id) !== factoryId) throw new TRPCError({ code: 'CONFLICT', message: '幂等键已绑定其他 Agent、插件或企业，禁止复用' })
      if (existing.code_url && ['pending', 'paid', 'refunded', 'refunding'].includes(String(existing.status))) return existingOrderResponse(existing)
      // creating/failed 或缺 code_url 的订单必须继续走复用/新下单恢复，不能按已完成返回。
    }
    await assertPayablePackage(db, pkg)
    const entitlements = rawRows(await db.execute(sql`SELECT status, factory_id AS factoryId, expires_at AS expiresAt FROM st_agent_plugin_entitlements WHERE registration_id=${input.registrationId} AND package_id=${input.packageId}`))
    if (entitlements.some((row) => Number(row.factoryId ?? 0) !== factoryId) || entitlements.some((row) => row.factoryId === null)) throw new TRPCError({ code: 'CONFLICT', message: '该 Agent 插件权益已归属其他企业或为历史无企业记录，禁止重复下单' })
    const entitlement = entitlements.find((row) => Number(row.factoryId) === factoryId)
    if (entitlement?.status === 'active' && (!entitlement.expiresAt || new Date(String(entitlement.expiresAt)).getTime() > Date.now())) throw new TRPCError({ code: 'CONFLICT', message: '当前插件权益仍有效，无需重复订阅' })
    const latest = rawRows(await db.execute(sql`SELECT * FROM st_agent_plugin_payment_orders WHERE registration_id=${input.registrationId} AND package_id=${input.packageId} AND factory_id=${factoryId} ORDER BY id DESC LIMIT 1`))[0]
    const notExpired = latest?.expires_at && new Date(String(latest.expires_at)).getTime() > Date.now()
    if (latest && latest.status === 'pending' && latest.code_url && notExpired) return { orderNo: String(latest.order_no), outTradeNo: String(latest.out_trade_no), codeUrl: String(latest.code_url), status: String(latest.status), already: true as const }
    let cycle = latest ? Number(latest.order_cycle ?? 1) + 1 : 1
    const sameCommercialTerms = latest && Number(latest.amount_cents) === Number(pkg.priceCents) && Number(latest.duration_days) === Number(pkg.durationDays)
    // 价格或期限变化必须换订单号，不能让微信旧单金额与当前价目不一致。
    const reuse = latest && notExpired && sameCommercialTerms && ['creating', 'failed'].includes(String(latest.status))
    if (reuse) cycle = Number(latest.order_cycle ?? 1)
    const orderNo = orderNumber(input.registrationId, input.packageId, factoryId, cycle)
    const outTradeNo = orderNo
    const now = reuse && latest?.created_at ? new Date(String(latest.created_at)) : new Date()
    const expires = reuse && latest?.expires_at ? new Date(String(latest.expires_at)) : new Date(now.getTime() + 30 * 60_000)
    if (!reuse) {
      try {
        await db.execute(sql`INSERT INTO st_agent_plugin_payment_orders (order_no, registration_id, package_id, factory_id, amount_cents, duration_days, order_cycle, status, out_trade_no, expires_at, idempotency_key) VALUES (${orderNo}, ${input.registrationId}, ${input.packageId}, ${factoryId}, ${Number(pkg.priceCents)}, ${Number(pkg.durationDays)}, ${cycle}, 'creating', ${outTradeNo}, ${expires}, ${input.idempotencyKey})`)
      } catch (error) {
        if (!isDupEntry(error)) throw error
        const duplicate = rawRows(await db.execute(sql`SELECT * FROM st_agent_plugin_payment_orders WHERE idempotency_key=${input.idempotencyKey} OR order_no=${orderNo} LIMIT 1`))[0]
        if (!duplicate) throw error
        if (Number(duplicate.registration_id) !== input.registrationId || Number(duplicate.package_id) !== input.packageId || Number(duplicate.factory_id) !== factoryId) throw new TRPCError({ code: 'CONFLICT', message: '订单号已被其他 Agent、插件或企业占用' })
        return existingOrderResponse(duplicate)
      }
    } else if (String(latest.status) === 'failed') {
      assertOrderTransition(await db.execute(sql`UPDATE st_agent_plugin_payment_orders SET status='creating' WHERE order_no=${orderNo} AND status='failed'`))
    }
    try {
      const clientIp = String((ctx as { clientIp?: string }).clientIp ?? '')
      if (!clientIp) throw new TRPCError({ code: 'BAD_REQUEST', message: '无法确认下单客户端 IP' })
      const result = await createWechatNativeOrder({ outTradeNo, totalFee: Number(pkg.priceCents), description: `${String(pkg.name)} 插件订阅 ${Number(pkg.durationDays)} 天`, clientIp, productId: String(pkg.id), timeStart: tradeTime(now), timeExpire: tradeTime(expires) })
      assertOrderTransition(await db.execute(sql`UPDATE st_agent_plugin_payment_orders SET status='pending', prepay_id=${result.prepayId}, code_url=${result.codeUrl} WHERE order_no=${orderNo} AND status='creating'`))
      return { orderNo, outTradeNo, codeUrl: result.codeUrl, status: 'pending' as const, already: false as const }
    } catch (error) {
      await db.execute(sql`UPDATE st_agent_plugin_payment_orders SET status='failed' WHERE order_no=${orderNo} AND status='creating'`)
      throw error
    }
  }),
  qr: publicQuery.input(z.object({ token: z.string().trim().min(1), orderNo: z.string().trim().min(8).max(64) })).query(async ({ input }) => {
    const session = await sessionMe(input.token)
    const order = await ownedOrder(getDb(), input.orderNo, Number(session.user.id), Number(session.factory.id))
    if (!order.code_url) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '订单尚未取得微信支付 code_url' })
    const png = await QRCode.toBuffer(String(order.code_url), { type: 'png', width: 512, margin: 1, errorCorrectionLevel: 'M' })
    return { orderNo: String(order.order_no), pngBase64: png.toString('base64'), codeUrl: String(order.code_url), binding: { orderNo: String(order.order_no), outTradeNo: String(order.out_trade_no), registrationId: Number(order.registration_id), packageId: Number(order.package_id), factoryId: Number(order.factory_id), amountCents: Number(order.amount_cents), durationDays: Number(order.duration_days) } }
  }),
  status: publicQuery.input(z.object({ token: z.string().trim().min(1), orderNo: z.string().trim().min(8).max(64) })).query(async ({ input }) => {
    const session = await sessionMe(input.token)
    const order = await ownedOrder(getDb(), input.orderNo, Number(session.user.id), Number(session.factory.id))
    const entitlement = rawRows(await getDb().execute(sql`SELECT status, expires_at AS expiresAt, payment_order_no AS paymentOrderNo FROM st_agent_plugin_entitlements WHERE registration_id=${Number(order.registration_id)} AND package_id=${Number(order.package_id)} AND factory_id=${Number(session.factory.id)} LIMIT 1`))[0]
    return { orderNo: String(order.order_no), status: String(order.status), amountCents: Number(order.amount_cents), durationDays: Number(order.duration_days), transactionId: order.transaction_id ? String(order.transaction_id) : null, paidAt: order.paid_at, entitlement: entitlement ?? null }
  }),
  reconcile: publicQuery.input(z.object({ token: z.string().trim().min(1), reviewToken: z.string().trim().min(1), orderNo: z.string().trim().min(8).max(64) })).mutation(async ({ input }) => {
    const sign = await requireDualSign(input.token, input.reviewToken, 'release')
    const db = getDb()
    const order = rawRows(await db.execute(sql`SELECT order_no AS orderNo, out_trade_no AS outTradeNo FROM st_agent_plugin_payment_orders WHERE order_no=${input.orderNo} AND status='pending' LIMIT 1`))[0]
    if (!order) throw new TRPCError({ code: 'NOT_FOUND', message: '待对账插件订单不存在' })
    const result = await queryWechatOrder(String(order.outTradeNo))
    const granted = await grantPluginOrder({ outTradeNo: String(order.outTradeNo), transactionId: String(result.transaction_id), totalFee: Number(result.total_fee), tradeState: String(result.trade_state), timeEnd: String(result.time_end ?? ''), eventType: 'reconciled' }, db)
    const auditOutcome = await writeAdminAuditResult(sign.operatorId, sign.operator, 'agentPluginPayments.reconcile', input.orderNo, { operator: sign.operator, reviewer: sign.reviewer, reviewerId: sign.reviewerId, outTradeNo: String(order.outTradeNo) })
    return { ...granted, auditWritten: auditOutcome === 'written', auditOutcome, warning: auditWarning(auditOutcome) }
  }),
  refund: publicQuery.input(z.object({ token: z.string().trim().min(1), reviewToken: z.string().trim().min(1), orderNo: z.string().trim().min(8).max(64) })).mutation(async ({ input }) => {
    const sign = await requireDualSign(input.token, input.reviewToken, 'release')
    const db = getDb()
    const order = rawRows(await db.execute(sql`SELECT * FROM st_agent_plugin_payment_orders WHERE order_no=${input.orderNo} AND status IN ('paid','refunding') LIMIT 1`))[0]
    if (!order) throw new TRPCError({ code: 'NOT_FOUND', message: '可退款插件订单不存在' })
    const outRefundNo = `pr_${sha(`${input.orderNo}|refund`).slice(0, 28)}`
    // 先落退款意图和 refunding 中间态；外部成功后的本地事务若失败，可据此重试/对账，不会回到 paid 盲区。
    await db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE st_agent_plugin_payment_orders SET status='refunding' WHERE order_no=${input.orderNo} AND status IN ('paid','refunding')`)
      await tx.execute(sql`INSERT INTO st_agent_plugin_payment_events (event_id, order_id, event_type, transaction_id, payload_sha256) VALUES (${`wechat-refund-intent:${outRefundNo}`}, ${Number(order.id)}, 'refunding', ${String(order.transaction_id)}, ${wechatPayloadSha256(JSON.stringify({ outRefundNo, outTradeNo: String(order.out_trade_no), amountCents: Number(order.amount_cents) }))}) ON DUPLICATE KEY UPDATE event_id=event_id`)
    })
    let result: Record<string, string>
    try {
      result = await createWechatRefund({ outTradeNo: String(order.out_trade_no), outRefundNo, totalFee: Number(order.amount_cents), refundFee: Number(order.amount_cents), transactionId: String(order.transaction_id) })
    } catch (error) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '微信退款未确认，订单已标记退款中，请人工对账后重试', cause: error })
    }
    await db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE st_agent_plugin_payment_orders SET status='refunded', refunded_at=NOW() WHERE order_no=${input.orderNo} AND status IN ('paid','refunding')`)
      await revokeCurrentPluginOrderEntitlement(tx, order)
      await tx.execute(sql`INSERT INTO st_agent_plugin_payment_events (event_id, order_id, event_type, transaction_id, payload_sha256) VALUES (${`wechat-refund:${outRefundNo}`}, ${Number(order.id)}, 'refunded', ${String(order.transaction_id)}, ${wechatPayloadSha256(JSON.stringify(result))}) ON DUPLICATE KEY UPDATE event_id=event_id`)
    })
    const auditOutcome = await writeAdminAuditResult(sign.operatorId, sign.operator, 'agentPluginPayments.refund', input.orderNo, { operator: sign.operator, reviewer: sign.reviewer, reviewerId: sign.reviewerId, outTradeNo: String(order.out_trade_no), outRefundNo })
    return { ok: true as const, orderNo: input.orderNo, refundId: result.refund_id ? String(result.refund_id) : null, auditWritten: auditOutcome === 'written', auditOutcome, warning: auditWarning(auditOutcome) }
  }),
})

export async function handleWechatPayCallback(c: { req: { text: () => Promise<string> }, text: (text: string, status?: number) => Response }) {
  let callbackOrderNo = ''
  try {
    const xml = await c.req.text()
    const verified = verifyWechatCallback(xml)
    callbackOrderNo = verified.outTradeNo
    if (verified.outTradeNo.startsWith('pp_')) await grantPluginOrder({ ...verified, eventType: 'paid' })
    else if (verified.outTradeNo.startsWith('AO')) await processWechatRegistrationCallback(verified)
    else {
      logQueryErrorThrottled('agentPluginPayments.callback.unrecognized', new Error('unrecognized_wechat_order_prefix'))
      throw new TRPCError({ code: 'NOT_FOUND', message: '支付订单不存在' })
    }
    return c.text(wechatXml({ return_code: 'SUCCESS', return_msg: 'OK' }), 200)
  } catch (error) {
    logQueryErrorThrottled(`agentPluginPayments.callback.${callbackOrderNo || 'unknown'}`, error)
    const permanent = error instanceof TRPCError
      ? ['CONFLICT', 'NOT_FOUND', 'PRECONDITION_FAILED', 'BAD_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN'].includes(error.code)
      : /signature|invalid|not_found|amount|mismatch|not_configured|precondition|订单不存在|金额|尚未成功|不可开通/i.test(error instanceof Error ? error.message : 'unknown')
    return c.text(wechatXml({ return_code: 'FAIL', return_msg: permanent ? 'invalid payment callback' : 'temporary failure' }), permanent ? 400 : 500)
  }
}

export type { WechatRequest }
