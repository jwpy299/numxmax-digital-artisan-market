import { beforeAll, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { getDb } from '../queries/connection'
import { rawRows } from '../queries/rawRows'
import { AGENT_TEST_DATABASE_PREFIX } from '../lib/agentEconomy'
import { makeSignedAgentPluginPackage } from '../lib/agentPluginTestPackage'
import { verifyAgentPluginPackage } from '../lib/agentPluginManifest'
import { agentPluginPaymentsRouter, handleWechatPayCallback } from './agentPluginPayments'
import { signWechatParams, wechatXml } from '../lib/wechatPayV2'

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
  const artifact = makeSignedAgentPluginPackage({ id: packageKey, name: '订阅任务插件', version: '1.0.0', entryCode: 'export const pay = true', permissions: ['tasks:read'], privateKey: privateDer, publicKey: publicDer })
  const verified = verifyAgentPluginPackage(artifact)
  const insertedPackage = await db.execute(sql`INSERT INTO st_agent_plugin_packages (package_key, name, version, description, price_cents, duration_days, manifest_json, artifact_sha256, signature, signer_public_key, artifact_blob) VALUES (${packageKey}, '订阅任务插件', '1.0.0', '订阅支付测试', 9900, 30, ${JSON.stringify(verified.manifest)}, ${verified.artifactSha256}, ${verified.manifest.signature}, ${publicDer}, FROM_BASE64(${artifact.toString('base64')}))`)
  packageId = Number((Array.isArray(insertedPackage) ? insertedPackage[0] : insertedPackage as { insertId?: number })?.insertId ?? 0)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(wechatXml({ return_code: 'SUCCESS', result_code: 'SUCCESS', prepay_id: 'wx-prepay-test', code_url: 'weixin://wxpay/bizpayurl?pr=plugin-test' }), { status: 200 })))
})

describe('插件订阅微信支付', () => {
  it('订单与二维码绑定，回调开通权益，重放幂等，错金额拒绝', async () => {
    if (!enabled) return
    const created = await caller.create({ token: ownerToken, registrationId, packageId, idempotencyKey: idem })
    expect(created.codeUrl).toBe('weixin://wxpay/bizpayurl?pr=plugin-test')
    orderNo = created.orderNo
    outTradeNo = created.outTradeNo
    const replay = await caller.create({ token: ownerToken, registrationId, packageId, idempotencyKey: idem })
    expect(replay.already).toBe(true)
    const qr = await caller.qr({ token: ownerToken, orderNo })
    expect(qr.pngBase64.startsWith('iVBORw0KGgo')).toBe(true)
    expect(qr.binding).toMatchObject({ orderNo, outTradeNo, registrationId, packageId, factoryId, amountCents: 9900, durationDays: 30 })
    const fields = { appid: 'wx-test-app', mch_id: 'test-mch', return_code: 'SUCCESS', result_code: 'SUCCESS', trade_state: 'SUCCESS', out_trade_no: outTradeNo, transaction_id: 'wx-plugin-transaction', total_fee: 9900, time_end: '20261105120000' }
    const xml = wechatXml({ ...fields, sign: signWechatParams(fields, 'test-api-key-not-a-real-secret') })
    const response = await handleWechatPayCallback({ req: { text: async () => xml }, text: (body, status = 200) => new Response(body, { status }) })
    expect(response.status).toBe(200)
    const paid = await caller.status({ token: ownerToken, orderNo })
    expect(paid.status).toBe('paid')
    expect(paid.entitlement).toMatchObject({ status: 'active', paymentOrderNo: orderNo })
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
})
