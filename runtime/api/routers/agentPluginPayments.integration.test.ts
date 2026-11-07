import { beforeAll, describe, expect, it, vi } from 'vitest'

const dualSign = vi.hoisted(() => vi.fn())
const auditResult = vi.hoisted(() => vi.fn())
const refundWechat = vi.hoisted(() => vi.fn())
vi.mock('../auth/adminDualSign', () => ({ requireDualSign: dualSign }))
vi.mock('./adminAnalytics', async (importOriginal) => ({ ...await importOriginal(), writeAdminAuditResult: auditResult }))
vi.mock('../lib/wechatPayV2', async (importOriginal) => ({ ...await importOriginal(), createWechatRefund: refundWechat }))
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { sql } from 'drizzle-orm'
import { getDb } from '../queries/connection'
import { rawRows } from '../queries/rawRows'
import { AGENT_TEST_DATABASE_PREFIX } from '../lib/agentEconomy'
import { makeSignedAgentPluginPackage } from '../lib/agentPluginTestPackage'
import { verifyAgentPluginPackage } from '../lib/agentPluginManifest'
import { agentPluginPaymentsRouter, grantPluginOrder, handleWechatPayCallback, revokeCurrentPluginOrderEntitlement } from './agentPluginPayments'
import { signWechatParams, wechatXml } from '../lib/wechatPayV2'

function wechatSignedResponse(fields: Record<string, string | number>): string {
  return wechatXml({ ...fields, sign: signWechatParams(fields, 'test-api-key-not-a-real-secret') })
}

const enabled = process.env.AGENT_EMPLOYMENT_MYSQL_TEST === '1'
const db = enabled ? getDb() : (undefined as unknown as ReturnType<typeof getDb>)
const caller = agentPluginPaymentsRouter.createCaller({ clientIp: '127.0.0.1' } as never)
const ownerToken = `nt_plugin_pay_${randomBytes(12).toString('hex')}`
const packageKey = `agent.pay.${randomBytes(4).toString('hex')}`
const idem = `pay-${randomBytes(8).toString('hex')}`
let registrationId = 0
let packageId = 0
let factoryId = 1
let orderNo = ''
let outTradeNo = ''

beforeAll(async () => {
  if (!enabled) return
  const database = rawRows(await db.execute(sql`SELECT DATABASE() AS name`))[0]
  if (!String(database?.name ?? '').startsWith(AGENT_TEST_DATABASE_PREFIX)) throw new Error('AGENT_PLUGIN_PAYMENTS_TEST_DATABASE_REQUIRED')
  vi.stubEnv('WECHAT_APP_ID', 'wx-test-app')
  vi.stubEnv('WECHAT_MCH_ID', 'test-mch')
  vi.stubEnv('WECHAT_API_KEY', 'test-api-key-not-a-real-secret')
  vi.stubEnv('WECHAT_NOTIFY_URL', 'https://staging.example/api/payments/wechat/callback')
  vi.stubEnv('WECHAT_PAYMENTS_ENABLED', '1')
  vi.stubEnv('WECHAT_REFUND_CERT_PEM', 'test-cert')
  vi.stubEnv('WECHAT_REFUND_KEY_PEM', 'test-key')
  const owner = rawRows(await db.execute(sql`SELECT id, factoryId FROM wb_users WHERE id=1 LIMIT 1`))[0]
  factoryId = Number(owner.factoryId)
  await db.execute(sql`UPDATE wb_users SET authToken=${(await import('../auth/revocation')).authTokenHash(ownerToken)} WHERE id=${Number(owner.id)}`)
  const registrationNo = `AR_pay_${randomBytes(5).toString('hex')}`
  const inserted = await db.execute(sql`INSERT INTO st_agent_registrations (registration_no, agent_key, owner_user_id, agent_name, status, fee_status, current_attempt_no, idempotency_key, qualified_at) VALUES (${registrationNo}, ${`agent_pay_${randomBytes(5).toString('hex')}`}, ${Number(owner.id)}, '订阅Agent', 'qualified', 'refunded', 1, ${`reg-${randomBytes(5).toString('hex')}`}, NOW())`)
  registrationId = Number((Array.isArray(inserted) ? inserted[0] : inserted as { insertId?: number })?.insertId ?? 0)
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privateDer = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
  const publicDer = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  process.env.AGENT_PLUGIN_TRUSTED_PUBLIC_KEYS = JSON.stringify([publicDer])
  const artifact = makeSignedAgentPluginPackage({ id: packageKey, name: '订阅任务插件', version: '1.0.0', entryCode: 'export const pay = true', permissions: ['tasks:read'], privateKey: privateDer, publicKey: publicDer })
  const verified = verifyAgentPluginPackage(artifact)
  const insertedPackage = await db.execute(sql`INSERT INTO st_agent_plugin_packages (package_key, name, version, description, price_cents, duration_days, manifest_json, artifact_sha256, signature, signer_public_key, artifact_blob) VALUES (${packageKey}, '订阅任务插件', '1.0.0', '订阅支付测试', 9900, 30, ${JSON.stringify(verified.manifest)}, ${verified.artifactSha256}, ${verified.manifest.signature}, ${publicDer}, FROM_BASE64(${artifact.toString('base64')}))`)
  packageId = Number((Array.isArray(insertedPackage) ? insertedPackage[0] : insertedPackage as { insertId?: number })?.insertId ?? 0)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(wechatSignedResponse({ return_code: 'SUCCESS', result_code: 'SUCCESS', prepay_id: 'wx-prepay-test', code_url: 'weixin://wxpay/bizpayurl?pr=plugin-test' }), { status: 200 })))
})

describe('插件订阅微信支付', () => {
  it('订单与二维码绑定，回调开通权益，重放幂等，错金额拒绝', async () => {
    if (!enabled) return
    const created = await caller.create({ token: ownerToken, registrationId, packageId, idempotencyKey: idem })
    expect(created.codeUrl).toBe('weixin://wxpay/bizpayurl?pr=plugin-test')
    expect(created.orderNo.length).toBeLessThanOrEqual(32)
    expect(created.outTradeNo.length).toBeLessThanOrEqual(32)
    orderNo = created.orderNo
    outTradeNo = created.outTradeNo
    const samePending = await caller.create({ token: ownerToken, registrationId, packageId, idempotencyKey: idem })
    expect(samePending).toMatchObject({ orderNo, outTradeNo, status: 'pending', already: true })
    const replay = await caller.create({ token: ownerToken, registrationId, packageId, idempotencyKey: `different-${randomBytes(5).toString('hex')}` })
    expect(replay.already).toBe(true)
    const qr = await caller.qr({ token: ownerToken, orderNo })
    expect(qr.pngBase64.startsWith('iVBORw0KGgo')).toBe(true)
    expect(qr.binding).toMatchObject({ orderNo, outTradeNo, registrationId, packageId, factoryId, amountCents: 9900, durationDays: 30 })
    const fields = { appid: 'wx-test-app', mch_id: 'test-mch', return_code: 'SUCCESS', result_code: 'SUCCESS', out_trade_no: outTradeNo, transaction_id: 'wx-plugin-transaction', total_fee: 9900, time_end: '20261105120000' }
    const xml = wechatXml({ ...fields, sign: signWechatParams(fields, 'test-api-key-not-a-real-secret') })
    const response = await handleWechatPayCallback({ req: { text: async () => xml }, text: (body, status = 200) => new Response(body, { status }) })
    expect(response.status).toBe(200)
    const paid = await caller.status({ token: ownerToken, orderNo })
    expect(paid.status).toBe('paid')
    expect(paid.entitlement).toMatchObject({ status: 'active', paymentOrderNo: orderNo })
    const samePaid = await caller.create({ token: ownerToken, registrationId, packageId, idempotencyKey: idem })
    expect(samePaid).toMatchObject({ orderNo, outTradeNo, status: 'paid', already: true })
    const replayCallback = await handleWechatPayCallback({ req: { text: async () => xml }, text: (body, status = 200) => new Response(body, { status }) })
    expect(replayCallback.status).toBe(200)
    const events = rawRows(await db.execute(sql`SELECT id FROM st_agent_plugin_payment_events WHERE order_id=(SELECT id FROM st_agent_plugin_payment_orders WHERE order_no=${orderNo})`))
    expect(events).toHaveLength(1)
    const bad = wechatXml({ ...fields, total_fee: 10000, sign: signWechatParams({ ...fields, total_fee: 10000 }, 'test-api-key-not-a-real-secret') })
    const rejected = await handleWechatPayCallback({ req: { text: async () => bad }, text: (body, status = 200) => new Response(body, { status }) })
    expect(rejected.status).toBe(400)
    const entitlements = rawRows(await db.execute(sql`SELECT id FROM st_agent_plugin_entitlements WHERE registration_id=${registrationId} AND package_id=${packageId} AND factory_id=${factoryId}`))
    expect(entitlements).toHaveLength(1)
  })

  it('旧订单退款只撤销旧权益，后续订单的有效权益不受影响', async () => {
    if (!enabled) return
    const makeOrder = async (label: string) => {
      const currentOrderNo = `po_${label}_${randomBytes(8).toString('hex')}`
      const currentOutTradeNo = `pp_${randomBytes(14).toString('hex')}`
      await db.execute(sql`INSERT INTO st_agent_plugin_payment_orders (order_no, registration_id, package_id, factory_id, amount_cents, duration_days, status, out_trade_no, expires_at, idempotency_key) VALUES (${currentOrderNo}, ${registrationId}, ${packageId}, ${factoryId}, 9900, 30, 'pending', ${currentOutTradeNo}, DATE_ADD(NOW(), INTERVAL 10 MINUTE), ${`idem-${label}-${randomBytes(8).toString('hex')}`})`)
      const order = rawRows(await db.execute(sql`SELECT * FROM st_agent_plugin_payment_orders WHERE order_no=${currentOrderNo} LIMIT 1`))[0]
      await grantPluginOrder({ outTradeNo: currentOutTradeNo, transactionId: `wx_${label}_${randomBytes(8).toString('hex')}`, totalFee: 9900, tradeState: 'SUCCESS', timeEnd: '', eventType: 'paid' }, db)
      return order
    }
    const oldOrder = await makeOrder('old')
    const currentOrder = await makeOrder('current')
    let entitlement = rawRows(await db.execute(sql`SELECT status, payment_order_no AS paymentOrderNo FROM st_agent_plugin_entitlements WHERE registration_id=${registrationId} AND package_id=${packageId} AND factory_id=${factoryId}`))[0]
    expect(entitlement).toMatchObject({ status: 'active', paymentOrderNo: String(currentOrder.order_no) })
    await db.transaction(async (tx) => { await revokeCurrentPluginOrderEntitlement(tx, oldOrder) })
    entitlement = rawRows(await db.execute(sql`SELECT status, payment_order_no AS paymentOrderNo FROM st_agent_plugin_entitlements WHERE registration_id=${registrationId} AND package_id=${packageId} AND factory_id=${factoryId}`))[0]
    expect(entitlement).toMatchObject({ status: 'active', paymentOrderNo: String(currentOrder.order_no) })
    await db.transaction(async (tx) => { await revokeCurrentPluginOrderEntitlement(tx, currentOrder) })
    entitlement = rawRows(await db.execute(sql`SELECT status, payment_order_no AS paymentOrderNo FROM st_agent_plugin_entitlements WHERE registration_id=${registrationId} AND package_id=${packageId} AND factory_id=${factoryId}`))[0]
    expect(entitlement).toMatchObject({ status: 'revoked', paymentOrderNo: String(currentOrder.order_no) })
  })


  it('对账与退款均写入双签审计并返回 auditOutcome', async () => {
    if (!enabled) return
    dualSign.mockReturnValue({ operator: 'owner-test', reviewer: 'c-reviewer', operatorId: 1, reviewerId: 2 })
    auditResult.mockResolvedValue('written')
    auditResult.mockClear()
    refundWechat.mockResolvedValue({ refund_id: 'refund-audit-1' })
    const auditOrderNo = `pp_${randomBytes(14).toString('hex')}`
    await db.execute(sql`INSERT INTO st_agent_plugin_payment_orders (order_no, registration_id, package_id, factory_id, amount_cents, duration_days, status, out_trade_no, expires_at, idempotency_key) VALUES (${auditOrderNo}, ${registrationId}, ${packageId}, ${factoryId}, 9900, 30, 'pending', ${auditOrderNo}, DATE_ADD(NOW(), INTERVAL 10 MINUTE), ${`idem-audit-${randomBytes(6).toString('hex')}`})`)
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(wechatSignedResponse({ return_code: 'SUCCESS', result_code: 'SUCCESS', trade_state: 'SUCCESS', out_trade_no: auditOrderNo, transaction_id: 'wx-audit-reconcile', total_fee: 9900, time_end: '20261105120000' }), { status: 200 }))
    const reconciled = await caller.reconcile({ token: ownerToken, reviewToken: 'c-review', orderNo: auditOrderNo })
    expect(reconciled).toMatchObject({ auditWritten: true, auditOutcome: 'written', warning: null })
    const refunded = await caller.refund({ token: ownerToken, reviewToken: 'c-review', orderNo: auditOrderNo })
    expect(refunded).toMatchObject({ auditWritten: true, auditOutcome: 'written', warning: null, refundId: 'refund-audit-1' })
    expect(dualSign).toHaveBeenCalledTimes(2)
    expect(auditResult).toHaveBeenCalledTimes(2)
    expect(auditResult.mock.calls.map((call) => call[2])).toEqual(['agentPluginPayments.reconcile', 'agentPluginPayments.refund'])
    for (const call of auditResult.mock.calls) expect(call[4]).toMatchObject({ operator: 'owner-test', reviewer: 'c-reviewer', reviewerId: 2 })
    const final = rawRows(await db.execute(sql`SELECT status FROM st_agent_plugin_payment_orders WHERE order_no=${auditOrderNo}`))[0]
    expect(final.status).toBe('refunded')
  })

  it('create 成功返回前订单已被支付时，pending/failed 均不得覆盖 paid', async () => {
    if (!enabled) return
    await db.execute(sql`UPDATE st_agent_plugin_entitlements SET status='revoked' WHERE registration_id=${registrationId} AND package_id=${packageId} AND factory_id=${factoryId}`)
    vi.mocked(fetch).mockReset()
    const cycle = 2
    const casOrderNo = `pp_${createHash('sha256').update(`${registrationId}|${packageId}|${factoryId}|${cycle}`).digest('hex').slice(0, 28)}`
    await db.execute(sql`INSERT INTO st_agent_plugin_payment_orders (order_no, registration_id, package_id, factory_id, amount_cents, duration_days, order_cycle, status, out_trade_no, expires_at, idempotency_key) VALUES (${casOrderNo}, ${registrationId}, ${packageId}, ${factoryId}, 9900, 30, ${cycle}, 'creating', ${casOrderNo}, DATE_ADD(NOW(), INTERVAL 10 MINUTE), ${`idem-cas-${randomBytes(6).toString('hex')}`})`)
    vi.mocked(fetch).mockImplementationOnce(async () => {
      await db.execute(sql`UPDATE st_agent_plugin_payment_orders SET status='paid' WHERE order_no=${casOrderNo}`)
      return new Response(wechatSignedResponse({ return_code: 'SUCCESS', result_code: 'SUCCESS', prepay_id: 'wx-cas', code_url: 'weixin://wxpay/bizpayurl?pr=cas' }), { status: 200 })
    })
    await expect(caller.create({ token: ownerToken, registrationId, packageId, idempotencyKey: `cas-${randomBytes(6).toString('hex')}` })).rejects.toThrow('订单状态已被其他流程推进')
    const current = rawRows(await db.execute(sql`SELECT status FROM st_agent_plugin_payment_orders WHERE order_no=${casOrderNo}`))[0]
    expect(current.status).toBe('paid')
  })

  it('create 外部失败且订单已被支付时，catch 不得回写 failed', async () => {
    if (!enabled) return
    await db.execute(sql`UPDATE st_agent_plugin_entitlements SET status='revoked' WHERE registration_id=${registrationId} AND package_id=${packageId} AND factory_id=${factoryId}`)
    vi.mocked(fetch).mockReset()
    const cycle = 3
    const casOrderNo = `pp_${createHash('sha256').update(`${registrationId}|${packageId}|${factoryId}|${cycle}`).digest('hex').slice(0, 28)}`
    await db.execute(sql`INSERT INTO st_agent_plugin_payment_orders (order_no, registration_id, package_id, factory_id, amount_cents, duration_days, order_cycle, status, out_trade_no, expires_at, idempotency_key) VALUES (${casOrderNo}, ${registrationId}, ${packageId}, ${factoryId}, 9900, 30, ${cycle}, 'creating', ${casOrderNo}, DATE_ADD(NOW(), INTERVAL 10 MINUTE), ${`idem-cas-${randomBytes(6).toString('hex')}`})`)
    vi.mocked(fetch).mockImplementationOnce(async () => {
      await db.execute(sql`UPDATE st_agent_plugin_payment_orders SET status='paid' WHERE order_no=${casOrderNo}`)
      throw new Error('OUT_TRADE_NO_USED')
    })
    await expect(caller.create({ token: ownerToken, registrationId, packageId, idempotencyKey: `cas-${randomBytes(6).toString('hex')}` })).rejects.toThrow('OUT_TRADE_NO_USED')
    const current = rawRows(await db.execute(sql`SELECT status FROM st_agent_plugin_payment_orders WHERE order_no=${casOrderNo}`))[0]
    expect(current.status).toBe('paid')
  })


  it('失败重试保留原始下单时间与到期时间，不续期死订单', async () => {
    if (!enabled) return
    await db.execute(sql`UPDATE st_agent_plugin_entitlements SET status='revoked' WHERE registration_id=${registrationId} AND package_id=${packageId} AND factory_id=${factoryId}`)
    const cycle = 80
    const retryOrderNo = `pp_${createHash('sha256').update(`${registrationId}|${packageId}|${factoryId}|${cycle}`).digest('hex').slice(0, 28)}`
    await db.execute(sql`INSERT INTO st_agent_plugin_payment_orders (order_no, registration_id, package_id, factory_id, amount_cents, duration_days, order_cycle, status, out_trade_no, created_at, expires_at, idempotency_key) VALUES (${retryOrderNo}, ${registrationId}, ${packageId}, ${factoryId}, 9900, 30, ${cycle}, 'failed', ${retryOrderNo}, DATE_SUB(NOW(), INTERVAL 10 MINUTE), DATE_ADD(NOW(), INTERVAL 10 MINUTE), ${`idem-retry-${randomBytes(6).toString('hex')}`})`)
    const before = rawRows(await db.execute(sql`SELECT created_at AS createdAt, expires_at AS expiresAt FROM st_agent_plugin_payment_orders WHERE order_no=${retryOrderNo}`))[0]
    vi.mocked(fetch).mockReset()
    vi.mocked(fetch).mockResolvedValue(new Response(wechatSignedResponse({ return_code: 'SUCCESS', result_code: 'SUCCESS', prepay_id: 'wx-retry-time', code_url: 'weixin://wxpay/bizpayurl?pr=retry-time' }), { status: 200 }))
    const created = await caller.create({ token: ownerToken, registrationId, packageId, idempotencyKey: `retry-time-${randomBytes(6).toString('hex')}` })
    expect(created.orderNo).toBe(retryOrderNo)
    const after = rawRows(await db.execute(sql`SELECT created_at AS createdAt, expires_at AS expiresAt FROM st_agent_plugin_payment_orders WHERE order_no=${retryOrderNo}`))[0]
    expect(new Date(String(after.createdAt)).getTime()).toBe(new Date(String(before.createdAt)).getTime())
    expect(new Date(String(after.expiresAt)).getTime()).toBe(new Date(String(before.expiresAt)).getTime())
    const requestXml = String(vi.mocked(fetch).mock.calls[0]?.[1]?.body)
    const wechatTime = (value: string) => new Date(new Date(value).getTime() + 8 * 60 * 60 * 1000).toISOString().replace(/[-:TZ]/g, '').slice(0, 14)
    expect(requestXml).toContain(`<time_start>${wechatTime(String(before.createdAt))}</time_start>`)
    expect(requestXml).toContain(`<time_expire>${wechatTime(String(before.expiresAt))}</time_expire>`)
  })

  it('制品验签失败不得创建新订单', async () => {
    if (!enabled) return
    await db.execute(sql`UPDATE st_agent_plugin_entitlements SET status='revoked' WHERE registration_id=${registrationId} AND package_id=${packageId} AND factory_id=${factoryId}`)
    const original = rawRows(await db.execute(sql`SELECT artifact_sha256 AS artifactSha256, artifact_blob AS artifactBlob FROM st_agent_plugin_packages WHERE id=${packageId}`))[0]
    const before = rawRows(await db.execute(sql`SELECT COUNT(*) AS count FROM st_agent_plugin_payment_orders`))[0]
    try {
      await db.execute(sql`UPDATE st_agent_plugin_packages SET artifact_sha256=SHA2('broken-artifact', 256), artifact_blob=FROM_BASE64('YnJva2Vu') WHERE id=${packageId}`)
      await expect(caller.create({ token: ownerToken, registrationId, packageId, idempotencyKey: `broken-${randomBytes(6).toString('hex')}` })).rejects.toThrow('插件制品验签失败，禁止订阅')
      const after = rawRows(await db.execute(sql`SELECT COUNT(*) AS count FROM st_agent_plugin_payment_orders`))[0]
      expect(Number(after.count)).toBe(Number(before.count))
    } finally {
      await db.execute(sql`UPDATE st_agent_plugin_packages SET artifact_sha256=${String(original.artifactSha256)}, artifact_blob=FROM_BASE64(${Buffer.from(original.artifactBlob as Buffer).toString('base64')}) WHERE id=${packageId}`)
    }
  })

  it('价格或期限变化不复用旧订单，按当前价目创建新周期', async () => {
    if (!enabled) return
    const cycle = 90
    const oldOrderNo = `pp_${createHash('sha256').update(`${registrationId}|${packageId}|${factoryId}|${cycle}`).digest('hex').slice(0, 28)}`
    await db.execute(sql`INSERT INTO st_agent_plugin_payment_orders (order_no, registration_id, package_id, factory_id, amount_cents, duration_days, order_cycle, status, out_trade_no, expires_at, idempotency_key) VALUES (${oldOrderNo}, ${registrationId}, ${packageId}, ${factoryId}, 9900, 30, ${cycle}, 'failed', ${oldOrderNo}, DATE_ADD(NOW(), INTERVAL 10 MINUTE), ${`idem-price-${randomBytes(6).toString('hex')}`})`)
    await db.execute(sql`UPDATE st_agent_plugin_packages SET price_cents=12000, duration_days=60 WHERE id=${packageId}`)
    vi.mocked(fetch).mockReset()
    vi.mocked(fetch).mockResolvedValue(new Response(wechatSignedResponse({ return_code: 'SUCCESS', result_code: 'SUCCESS', prepay_id: 'wx-price-change', code_url: 'weixin://wxpay/bizpayurl?pr=price-change' }), { status: 200 }))
    try {
      const created = await caller.create({ token: ownerToken, registrationId, packageId, idempotencyKey: `price-${randomBytes(6).toString('hex')}` })
      expect(created.orderNo).not.toBe(oldOrderNo)
      expect(created.status).toBe('pending')
      const latest = rawRows(await db.execute(sql`SELECT order_no AS orderNo, amount_cents AS amountCents, duration_days AS durationDays, order_cycle AS orderCycle FROM st_agent_plugin_payment_orders WHERE order_no=${created.orderNo}`))[0]
      expect(latest).toMatchObject({ amountCents: 12000, durationDays: 60, orderCycle: 91 })
    } finally {
      await db.execute(sql`UPDATE st_agent_plugin_packages SET price_cents=9900, duration_days=30 WHERE id=${packageId}`)
    }
  })


  it('外部退款成功后本地事务失败保留 refunding，可去重恢复', async () => {
    if (!enabled) return
    dualSign.mockReturnValue({ operator: 'owner-test', reviewer: 'c-reviewer', operatorId: 1, reviewerId: 2 })
    auditResult.mockResolvedValue('written')
    auditResult.mockClear()
    refundWechat.mockImplementationOnce(async () => { await db.execute(sql`DROP TABLE IF EXISTS st_agent_plugin_payment_events`); return { refund_id: 'refund-recovery-1' } }).mockResolvedValue({ refund_id: 'refund-recovery-1' })
    const recoveryOrderNo = `pp_${randomBytes(14).toString('hex')}`
    await db.execute(sql`INSERT INTO st_agent_plugin_payment_orders (order_no, registration_id, package_id, factory_id, amount_cents, duration_days, status, out_trade_no, expires_at, idempotency_key) VALUES (${recoveryOrderNo}, ${registrationId}, ${packageId}, ${factoryId}, 9900, 30, 'pending', ${recoveryOrderNo}, DATE_ADD(NOW(), INTERVAL 10 MINUTE), ${`idem-recovery-${randomBytes(6).toString('hex')}`})`)
    await grantPluginOrder({ outTradeNo: recoveryOrderNo, transactionId: 'wx-recovery-paid', totalFee: 9900, tradeState: 'SUCCESS', timeEnd: '', eventType: 'paid' }, db)
    await expect(caller.refund({ token: ownerToken, reviewToken: 'c-review', orderNo: recoveryOrderNo })).rejects.toThrow()
    const order = rawRows(await db.execute(sql`SELECT id FROM st_agent_plugin_payment_orders WHERE order_no=${recoveryOrderNo}`))[0]
    const intermediate = rawRows(await db.execute(sql`SELECT status FROM st_agent_plugin_payment_orders WHERE order_no=${recoveryOrderNo}`))[0]
    expect(intermediate.status).toBe('refunding')
    execFileSync('/usr/local/bin/node', ['--import', 'tsx', 'db/sync-agent-plugin-payments.mts'], { cwd: process.cwd(), stdio: 'pipe' })
    const recovered = await caller.refund({ token: ownerToken, reviewToken: 'c-review', orderNo: recoveryOrderNo })
    expect(recovered).toMatchObject({ orderNo: recoveryOrderNo, auditOutcome: 'written' })
    const final = rawRows(await db.execute(sql`SELECT status FROM st_agent_plugin_payment_orders WHERE order_no=${recoveryOrderNo}`))[0]
    expect(final.status).toBe('refunded')
  })

  it('跨企业开通显式拒绝且不覆盖原权益', async () => {
    if (!enabled) return
    const otherFactoryId = factoryId + 1000
    const makeOrder = async (targetFactory: number, label: string) => {
      const currentOrderNo = `pp_${randomBytes(14).toString('hex')}`
      await db.execute(sql`INSERT INTO st_agent_plugin_payment_orders (order_no, registration_id, package_id, factory_id, amount_cents, duration_days, status, out_trade_no, expires_at, idempotency_key) VALUES (${currentOrderNo}, ${registrationId}, ${packageId}, ${targetFactory}, 9900, 30, 'pending', ${currentOrderNo}, DATE_ADD(NOW(), INTERVAL 10 MINUTE), ${`idem-${label}-${randomBytes(5).toString('hex')}`})`)
      await grantPluginOrder({ outTradeNo: currentOrderNo, transactionId: `wx-${label}`, totalFee: 9900, tradeState: 'SUCCESS', timeEnd: '', eventType: 'paid' }, db)
      return currentOrderNo
    }
    const firstOrder = await makeOrder(factoryId, 'factory-a')
    await expect(makeOrder(otherFactoryId, 'factory-b')).rejects.toThrow('禁止跨企业覆盖')
    const entitlements = rawRows(await db.execute(sql`SELECT factory_id AS factoryId, payment_order_no AS paymentOrderNo, status FROM st_agent_plugin_entitlements WHERE registration_id=${registrationId} AND package_id=${packageId} ORDER BY factory_id`))
    expect(entitlements).toHaveLength(1)
    expect(entitlements).toEqual(expect.arrayContaining([
      expect.objectContaining({ factoryId, paymentOrderNo: firstOrder, status: 'active' }),
    ]))
  })


  it('跨企业与历史无企业权益在下单前拒绝，未知前缀回调按永久失败返回 400', async () => {
    if (!enabled) return
    const otherFactoryId = factoryId + 1000
    await db.execute(sql`DELETE FROM st_agent_plugin_entitlements WHERE registration_id=${registrationId} AND package_id=${packageId}`)
    await db.execute(sql`INSERT INTO st_agent_plugin_entitlements (registration_id, package_id, factory_id, payment_order_no, status) VALUES (${registrationId}, ${packageId}, ${otherFactoryId}, 'other-order', 'active')`)
    const before = rawRows(await db.execute(sql`SELECT COUNT(*) AS count FROM st_agent_plugin_payment_orders`))[0]
    await expect(caller.create({ token: ownerToken, registrationId, packageId, idempotencyKey: `other-${randomBytes(6).toString('hex')}` })).rejects.toThrow('禁止重复下单')
    const after = rawRows(await db.execute(sql`SELECT COUNT(*) AS count FROM st_agent_plugin_payment_orders`))[0]
    expect(Number(after.count)).toBe(Number(before.count))
    const fields = { appid: 'wx-test-app', mch_id: 'test-mch', return_code: 'SUCCESS', result_code: 'SUCCESS', out_trade_no: 'other-order', transaction_id: 'wx-other-order', total_fee: 9900, time_end: '20261105120000' }
    const xml = wechatXml({ ...fields, sign: signWechatParams(fields, 'test-api-key-not-a-real-secret') })
    const response = await handleWechatPayCallback({ req: { text: async () => xml }, text: (body, status = 200) => new Response(body, { status }) })
    expect(response.status).toBe(400)
    const untouched = rawRows(await db.execute(sql`SELECT factory_id AS factoryId, status FROM st_agent_plugin_entitlements WHERE registration_id=${registrationId} AND package_id=${packageId} LIMIT 1`))[0]
    expect(untouched).toMatchObject({ factoryId: otherFactoryId, status: 'active' })
    await db.execute(sql`UPDATE st_agent_plugin_entitlements SET factory_id=NULL WHERE registration_id=${registrationId} AND package_id=${packageId}`)
    await expect(caller.create({ token: ownerToken, registrationId, packageId, idempotencyKey: `legacy-${randomBytes(6).toString('hex')}` })).rejects.toThrow('禁止重复下单')
  })


  it('creating 订单可直接复用并推进 pending，不因 no-op affectedRows=0 冲突', async () => {
    if (!enabled) return
    await db.execute(sql`DELETE FROM st_agent_plugin_entitlements WHERE registration_id=${registrationId} AND package_id=${packageId}`)
    await db.execute(sql`INSERT INTO st_agent_plugin_entitlements (registration_id, package_id, factory_id, status) VALUES (${registrationId}, ${packageId}, ${factoryId}, 'revoked')`)
    vi.mocked(fetch).mockReset()
    const nativeSuccess = wechatSignedResponse({ return_code: 'SUCCESS', result_code: 'SUCCESS', prepay_id: 'wx-new-test', code_url: 'weixin://wxpay/bizpayurl?pr=new-test' })
    vi.mocked(fetch).mockResolvedValue(new Response(nativeSuccess, { status: 200 }))
    const cycle = 190
    const creatingOrderNo = `pp_${createHash('sha256').update(`${registrationId}|${packageId}|${factoryId}|${cycle}`).digest('hex').slice(0, 28)}`
    await db.execute(sql`INSERT INTO st_agent_plugin_payment_orders (order_no, registration_id, package_id, factory_id, amount_cents, duration_days, order_cycle, status, out_trade_no, created_at, expires_at, idempotency_key) VALUES (${creatingOrderNo}, ${registrationId}, ${packageId}, ${factoryId}, 9900, 30, ${cycle}, 'creating', ${creatingOrderNo}, DATE_SUB(NOW(), INTERVAL 5 MINUTE), DATE_ADD(NOW(), INTERVAL 10 MINUTE), ${`idem-creating-${randomBytes(6).toString('hex')}`})`)
    const created = await caller.create({ token: ownerToken, registrationId, packageId, idempotencyKey: `creating-reuse-${randomBytes(6).toString('hex')}` })
    expect(created).toMatchObject({ orderNo: creatingOrderNo, status: 'pending', already: false })
    expect(rawRows(await db.execute(sql`SELECT id FROM st_agent_plugin_payment_orders WHERE order_no=${creatingOrderNo}`))).toHaveLength(1)
  })

  it('同幂等键并发创建只落一单，dup key 回读原订单而非 500', async () => {
    if (!enabled) return
    await db.execute(sql`DELETE FROM st_agent_plugin_entitlements WHERE registration_id=${registrationId} AND package_id=${packageId}`)
    await db.execute(sql`INSERT INTO st_agent_plugin_entitlements (registration_id, package_id, factory_id, status) VALUES (${registrationId}, ${packageId}, ${factoryId}, 'revoked')`)
    vi.mocked(fetch).mockReset()
    const nativeSuccess = wechatSignedResponse({ return_code: 'SUCCESS', result_code: 'SUCCESS', prepay_id: 'wx-new-test', code_url: 'weixin://wxpay/bizpayurl?pr=new-test' })
    vi.mocked(fetch).mockResolvedValue(new Response(nativeSuccess, { status: 200 }))
    const cycle = 191
    const failedOrderNo = `pp_${createHash('sha256').update(`${registrationId}|${packageId}|${factoryId}|${cycle}`).digest('hex').slice(0, 28)}`
    await db.execute(sql`INSERT INTO st_agent_plugin_payment_orders (order_no, registration_id, package_id, factory_id, amount_cents, duration_days, order_cycle, status, out_trade_no, expires_at, idempotency_key) VALUES (${failedOrderNo}, ${registrationId}, ${packageId}, ${factoryId}, 9900, 30, ${cycle}, 'failed', ${failedOrderNo}, DATE_SUB(NOW(), INTERVAL 1 HOUR), ${`idem-failed-${randomBytes(6).toString('hex')}`})`)
    const key = `concurrent-${randomBytes(6).toString('hex')}`
    const results = await Promise.all([
      caller.create({ token: ownerToken, registrationId, packageId, idempotencyKey: key }),
      caller.create({ token: ownerToken, registrationId, packageId, idempotencyKey: key }),
    ])
    expect(results.map((result) => result.orderNo)).toHaveLength(2)
    expect(new Set(results.map((result) => result.orderNo)).size).toBe(1)
    expect(rawRows(await db.execute(sql`SELECT id FROM st_agent_plugin_payment_orders WHERE idempotency_key=${key}`))).toHaveLength(1)
  })

  it('支付前签名 manifest 与目录版本不一致时禁止创建订单', async () => {
    if (!enabled) return
    const before = Number(rawRows(await db.execute(sql`SELECT COUNT(*) AS n FROM st_agent_plugin_payment_orders`))[0].n)
    try {
      await db.execute(sql`UPDATE st_agent_plugin_packages SET version='9.9.9' WHERE id=${packageId}`)
      await expect(caller.create({ token: ownerToken, registrationId, packageId, idempotencyKey: `identity-${randomBytes(6).toString('hex')}` })).rejects.toMatchObject({ code: 'FORBIDDEN' })
      const after = Number(rawRows(await db.execute(sql`SELECT COUNT(*) AS n FROM st_agent_plugin_payment_orders`))[0].n)
      expect(after).toBe(before)
    } finally {
      await db.execute(sql`UPDATE st_agent_plugin_packages SET version='1.0.0' WHERE id=${packageId}`)
    }
  })


  it('失败且缺 code_url 的订单重试可重新取得支付码，不返回假 already', async () => {
    if (!enabled) return
    await db.execute(sql`DELETE FROM st_agent_plugin_entitlements WHERE registration_id=${registrationId} AND package_id=${packageId}`)
    await db.execute(sql`INSERT INTO st_agent_plugin_entitlements (registration_id, package_id, factory_id, status) VALUES (${registrationId}, ${packageId}, ${factoryId}, 'revoked')`)
    vi.mocked(fetch).mockReset()
    const nativeSuccess = wechatSignedResponse({ return_code: 'SUCCESS', result_code: 'SUCCESS', prepay_id: 'wx-retry-no-url', code_url: 'weixin://wxpay/bizpayurl?pr=retry-no-url' })
    vi.mocked(fetch).mockResolvedValue(new Response(nativeSuccess, { status: 200 }))
    const cycle = 200
    const retryOrderNo = `pp_${createHash('sha256').update(`${registrationId}|${packageId}|${factoryId}|${cycle}`).digest('hex').slice(0, 28)}`
    const retryKey = `retry-no-url-${randomBytes(5).toString('hex')}`
    await db.execute(sql`INSERT INTO st_agent_plugin_payment_orders (order_no, registration_id, package_id, factory_id, amount_cents, duration_days, order_cycle, status, out_trade_no, expires_at, idempotency_key) VALUES (${retryOrderNo}, ${registrationId}, ${packageId}, ${factoryId}, 9900, 30, ${cycle}, 'failed', ${retryOrderNo}, DATE_ADD(NOW(), INTERVAL 10 MINUTE), ${retryKey})`)
    const created = await caller.create({ token: ownerToken, registrationId, packageId, idempotencyKey: retryKey })
    expect(created).toMatchObject({ orderNo: retryOrderNo, status: 'pending', codeUrl: 'weixin://wxpay/bizpayurl?pr=retry-no-url', already: false })
  })

})
