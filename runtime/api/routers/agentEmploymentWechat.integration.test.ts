import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const createRefundMock = vi.hoisted(() => vi.fn())
const queryRefundMock = vi.hoisted(() => vi.fn())
vi.mock('../lib/wechatPayV2', async (importOriginal) => ({ ...await importOriginal(), createWechatRefund: createRefundMock, queryWechatRefund: queryRefundMock }))
import { randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { getDb } from '../queries/connection'
import { rawRows } from '../queries/rawRows'
import { AGENT_TEST_DATABASE_PREFIX } from '../lib/agentEconomy'
import { agentTrainingRouter, queueRegistrationRefund, settleWechatRefunds } from './agentEmployment'
import { handleWechatPayCallback } from './agentPluginPayments'
import { signWechatParams, wechatXml } from '../lib/wechatPayV2'
import { authTokenHash } from '../auth/revocation'

const API_KEY = 'test-api-key-not-a-real-secret'
const enabled = process.env.AGENT_EMPLOYMENT_MYSQL_TEST === '1'
const db = enabled ? getDb() : (undefined as unknown as ReturnType<typeof getDb>)
const caller = agentTrainingRouter.createCaller({ clientIp: '127.0.0.1' } as never)
const ownerToken = `nt_training_wechat_${randomBytes(12).toString('hex')}`
let registrationId = 0
let nativeCalls = 0
let orderQueryError = false

function signedResponse(fields: Record<string, string | number>): string {
  return wechatXml({ ...fields, sign: signWechatParams(fields, API_KEY) })
}
function callback(orderNo: string, transactionId: string, totalFee: number): string {
  const fields = { appid: 'wx-test-app', mch_id: 'test-mch', return_code: 'SUCCESS', result_code: 'SUCCESS', out_trade_no: orderNo, transaction_id: transactionId, total_fee: totalFee, time_end: '20261105120000' }
  return signedResponse(fields)
}
async function invoke(xml: string): Promise<Response> {
  return handleWechatPayCallback({ req: { text: async () => xml }, text: (body, status = 200) => new Response(body, { status }) })
}

beforeAll(async () => {
  if (!enabled) return
  const database = rawRows(await db.execute(sql`SELECT DATABASE() AS name`))[0]
  if (!String(database?.name ?? '').startsWith(AGENT_TEST_DATABASE_PREFIX)) throw new Error('AGENT_TRAINING_WECHAT_TEST_DATABASE_REQUIRED')
  vi.stubEnv('ECONOMY_MODE', 'production')
  vi.stubEnv('WECHAT_APP_ID', 'wx-test-app')
  vi.stubEnv('WECHAT_MCH_ID', 'test-mch')
  vi.stubEnv('WECHAT_API_KEY', API_KEY)
  vi.stubEnv('WECHAT_NOTIFY_URL', 'https://staging.example/api/payments/wechat/callback')
  vi.stubEnv('WECHAT_PAYMENTS_ENABLED', '1')
  const username = `wechat_${randomBytes(6).toString('hex')}`
  const inserted = await db.execute(sql`INSERT INTO wb_users (username, passwordHash, displayName, role, factoryId, departmentId, kind, authToken)
    SELECT ${username}, passwordHash, '微信支付验证用户', role, factoryId, departmentId, kind, ${authTokenHash(ownerToken)} FROM wb_users WHERE id=1`)
  const owner = rawRows(await db.execute(sql`SELECT id FROM wb_users WHERE username=${username} LIMIT 1`))[0]
  expect(Number(owner.id)).toBeGreaterThan(1)
  createRefundMock.mockImplementation(async () => ({ refund_id: 'wx-refund-id', refund_fee: '9900' }))
  queryRefundMock.mockImplementation(async () => ({ refund_status_0: 'SUCCESS', refund_id_0: 'wx-refund-id' }))
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (String(url).includes('/pay/orderquery')) {
      if (orderQueryError) return new Response(signedResponse({ return_code: 'FAIL', result_code: 'FAIL', err_code: 'ORDERNOTEXIST', return_msg: 'OK' }), { status: 200 })
      return new Response(signedResponse({ return_code: 'SUCCESS', result_code: 'SUCCESS', trade_state: 'NOTPAY' }), { status: 200 })
    }
    nativeCalls += 1
    return new Response(signedResponse({ return_code: 'SUCCESS', result_code: 'SUCCESS', prepay_id: `wx-prepay-${nativeCalls}`, code_url: `weixin://wxpay/bizpayurl?pr=training-${nativeCalls}` }), { status: 200 })
  }))
})
afterAll(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('个人 Agent 报名与补考微信支付', () => {
  it('报名二维码、签名回调与训练开启绑定，重放和错金额均受控', async () => {
    if (!enabled) return
    const registrationKey = `register-${randomBytes(8).toString('hex')}`
    let created = await caller.register({ token: ownerToken, agentName: '微信支付报名 Agent', idempotencyKey: registrationKey })
    if (!created.realPayment) throw new Error('EXPECTED_PRODUCTION_REGISTRATION_ORDER')
    let outTradeNo = created.outTradeNo ?? created.orderNo
    expect(outTradeNo).toBe(created.orderNo)
    registrationId = created.registrationId
    expect(created).toMatchObject({ environment: 'production', realPayment: true, amountCents: 9900, amountJobTokens: 0, orderStatus: 'pending' })
    expect(created.codeUrl).toContain('weixin://wxpay/bizpayurl')
    await db.execute(sql`UPDATE st_agent_payment_orders SET status='failed', code_url=NULL WHERE order_no=${created.orderNo}`)
    created = await caller.register({ token: ownerToken, agentName: '微信支付报名 Agent', idempotencyKey: registrationKey })
    outTradeNo = created.outTradeNo ?? created.orderNo
    expect(outTradeNo).toBe(`${created.orderNo}_r2`)
    expect(created.orderStatus).toBe('pending')
    const recoveredRow = rawRows(await db.execute(sql`SELECT order_cycle AS orderCycle, out_trade_no AS outTradeNo, status FROM st_agent_payment_orders WHERE order_no=${created.orderNo}`))[0]
    expect(recoveredRow).toMatchObject({ orderCycle: 2, outTradeNo: created.outTradeNo, status: 'pending' })
    await db.execute(sql`UPDATE st_agent_payment_orders SET status='pending', expires_at=DATE_SUB(NOW(), INTERVAL 1 HOUR) WHERE order_no=${created.orderNo}`)
    created = await caller.register({ token: ownerToken, agentName: '微信支付报名 Agent', idempotencyKey: registrationKey })
    outTradeNo = created.outTradeNo ?? created.orderNo
    expect(outTradeNo).toBe(`${created.orderNo}_r3`)
    const renewedRow = rawRows(await db.execute(sql`SELECT order_cycle AS orderCycle, out_trade_no AS outTradeNo, status, expires_at AS expiresAt FROM st_agent_payment_orders WHERE order_no=${created.orderNo}`))[0]
    expect(renewedRow).toMatchObject({ orderCycle: 3, outTradeNo: created.outTradeNo, status: 'pending' })
    expect(new Date(String(renewedRow.expiresAt)).getTime()).toBeGreaterThan(Date.now())
    await db.execute(sql`UPDATE st_agent_payment_orders SET status='failed', code_url=NULL WHERE order_no=${created.orderNo}`)
    orderQueryError = true
    created = await caller.register({ token: ownerToken, agentName: '微信支付报名 Agent', idempotencyKey: registrationKey })
    orderQueryError = false
    outTradeNo = created.outTradeNo ?? created.orderNo
    expect(outTradeNo).toBe(`${created.orderNo}_r3`)
    expect(created.orderStatus).toBe('pending')
    const qr = await caller.paymentQr({ token: ownerToken, orderNo: created.orderNo })
    expect(qr.pngBase64.startsWith('iVBORw0KGgo')).toBe(true)
    expect(qr.binding).toMatchObject({ orderNo: created.orderNo, outTradeNo, registrationId, kind: 'registration', attemptNo: 1, amountCents: 9900 })

    const xml = callback(outTradeNo, 'wx-registration-transaction', 9900)
    expect((await invoke(xml)).status).toBe(200)
    expect((await invoke(xml)).status).toBe(200)
    const paid = await caller.paymentStatus({ token: ownerToken, orderNo: created.orderNo })
    expect(paid).toMatchObject({ status: 'paid', registrationStatus: 'training', transactionId: 'wx-registration-transaction', realPayment: true })
    const cycles = rawRows(await db.execute(sql`SELECT attempt_no AS attemptNo FROM st_agent_training_cycles WHERE registration_id=${registrationId}`))
    expect(cycles.map((row) => Number(row.attemptNo))).toEqual([1])
    const events = rawRows(await db.execute(sql`SELECT id FROM st_agent_payment_events WHERE order_id=(SELECT id FROM st_agent_payment_orders WHERE order_no=${created.orderNo})`))
    expect(events).toHaveLength(1)
    expect((await invoke(callback(outTradeNo, 'wx-registration-transaction', 10000))).status).toBe(400)
  })

  it('补考二维码绑定 1 元与第 2 次周期，生产订单不创建测试钱包', async () => {
    if (!enabled) return
    expect(registrationId).toBeGreaterThan(0)
    await db.execute(sql`UPDATE st_agent_training_cycles SET status='failed' WHERE registration_id=${registrationId} AND attempt_no=1`)
    const created = await caller.createRetakeOrder({ token: ownerToken, registrationId, idempotencyKey: `retake-${randomBytes(8).toString('hex')}` })
    if (!created.realPayment) throw new Error('EXPECTED_PRODUCTION_RETAKE_ORDER')
    const outTradeNo = 'outTradeNo' in created && created.outTradeNo ? created.outTradeNo : created.orderNo
    expect(outTradeNo).toBe(created.orderNo)
    expect(created).toMatchObject({ environment: 'production', realPayment: true, amountCents: 100, amountJobTokens: 0, attemptNo: 2, status: 'pending' })
    const qr = await caller.paymentQr({ token: ownerToken, orderNo: created.orderNo })
    expect(qr.binding).toMatchObject({ orderNo: created.orderNo, outTradeNo, registrationId, kind: 'retake', attemptNo: 2, amountCents: 100 })

    const xml = callback(outTradeNo, 'wx-retake-transaction', 100)
    expect((await invoke(xml)).status).toBe(200)
    expect((await invoke(xml)).status).toBe(200)
    const paid = await caller.paymentStatus({ token: ownerToken, orderNo: created.orderNo })
    expect(paid).toMatchObject({ status: 'paid', registrationStatus: 'training', transactionId: 'wx-retake-transaction', realPayment: true })
    const cycles = rawRows(await db.execute(sql`SELECT attempt_no AS attemptNo FROM st_agent_training_cycles WHERE registration_id=${registrationId} ORDER BY attempt_no`))
    expect(cycles.map((row) => Number(row.attemptNo))).toEqual([1, 2])
    const wallets = rawRows(await db.execute(sql`SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN ('st_agent_token_wallets','st_agent_token_exchanges')`))
    expect(wallets).toHaveLength(0)
  })
  it('报名费原路退款先受理后查单成功，重复结算不重复退款', async () => {
    if (!enabled) return
    const original = rawRows(await db.execute(sql`SELECT order_no AS orderNo, out_trade_no AS outTradeNo FROM st_agent_payment_orders WHERE registration_id=${registrationId} AND kind='registration' AND attempt_no=1`))[0]
    await db.execute(sql`UPDATE st_agent_registrations SET status='qualified', fee_status='paid' WHERE id=${registrationId}`)
    await queueRegistrationRefund(db, registrationId, 'qualified')
    const queued = rawRows(await db.execute(sql`SELECT refund_no AS refundNo, environment, status, amount_cents AS amountCents FROM st_agent_payment_refunds WHERE registration_id=${registrationId}`))[0]
    expect(queued).toMatchObject({ environment: 'production', status: 'pending', amountCents: 9900 })
    await settleWechatRefunds(registrationId)
    const settled = rawRows(await db.execute(sql`SELECT status, provider_ref AS providerRef, failure_code AS failureCode FROM st_agent_payment_refunds WHERE refund_no=${queued.refundNo}`))[0]
    expect(settled).toMatchObject({ status: 'succeeded', providerRef: 'wx-refund-id', failureCode: null })
    const order = rawRows(await db.execute(sql`SELECT status FROM st_agent_payment_orders WHERE order_no=${original.orderNo}`))[0]
    expect(order.status).toBe('refunded')
    const registration = rawRows(await db.execute(sql`SELECT status, fee_status AS feeStatus FROM st_agent_registrations WHERE id=${registrationId}`))[0]
    expect(registration).toMatchObject({ status: 'qualified', feeStatus: 'refunded' })
    expect(createRefundMock).toHaveBeenCalledTimes(1)
    expect(createRefundMock).toHaveBeenCalledWith(expect.objectContaining({ outTradeNo: original.outTradeNo, outRefundNo: queued.refundNo, totalFee: 9900, refundFee: 9900, transactionId: 'wx-registration-transaction' }))
    expect(queryRefundMock).toHaveBeenCalledWith(queued.refundNo)
    const retake = rawRows(await db.execute(sql`SELECT status FROM st_agent_payment_orders WHERE registration_id=${registrationId} AND kind='retake' AND attempt_no=2`))[0]
    expect(retake.status).toBe('paid')
    await settleWechatRefunds(registrationId)
    expect(createRefundMock).toHaveBeenCalledTimes(1)
    expect((await invoke(callback('ZZ-not-an-order', 'wx-unrecognized', 9900))).status).toBe(400)
  })

})
