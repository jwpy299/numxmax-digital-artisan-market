import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWechatNativeOrder, createWechatRefund, queryWechatOrder, signWechatParams, verifyWechatCallback, wechatFields, wechatXml, type WechatRequestArgs } from './wechatPayV2'

function configure() {
  vi.stubEnv('WECHAT_APP_ID', 'wx-test-app')
  vi.stubEnv('WECHAT_MCH_ID', 'test-mch')
  vi.stubEnv('WECHAT_API_KEY', 'test-api-key-not-a-real-secret')
  vi.stubEnv('WECHAT_NOTIFY_URL', 'https://staging.example/api/payments/wechat/callback')
  vi.stubEnv('WECHAT_PAYMENTS_ENABLED', '1')
  vi.stubEnv('WECHAT_REFUND_CERT_PEM', 'test-cert')
  vi.stubEnv('WECHAT_REFUND_KEY_PEM', 'test-key')
}
afterEach(() => vi.unstubAllEnvs())

describe('微信支付 v2 契约', () => {
  it('Native 下单、查询、退款均带签名且不泄漏密钥', async () => {
    configure()
    const calls: WechatRequestArgs[] = []
    const requestImpl = async (args: WechatRequestArgs) => {
      calls.push(args)
      if (args.path === '/pay/unifiedorder') return wechatXml({ return_code: 'SUCCESS', result_code: 'SUCCESS', prepay_id: 'wx-prepay', code_url: 'weixin://wxpay/bizpayurl?pr=abc' })
      if (args.path === '/pay/orderquery') return wechatXml({ return_code: 'SUCCESS', result_code: 'SUCCESS', trade_state: 'SUCCESS', transaction_id: 'wx-transaction', total_fee: 99, time_end: '20261105120000' })
      return wechatXml({ return_code: 'SUCCESS', result_code: 'SUCCESS', refund_id: 'wx-refund' })
    }
    const order = await createWechatNativeOrder({ outTradeNo: 'pp_test', totalFee: 99, description: '插件订阅', clientIp: '127.0.0.1', productId: '11', timeStart: '20261105110000', timeExpire: '20261105113000', requestImpl })
    expect(order).toEqual({ codeUrl: 'weixin://wxpay/bizpayurl?pr=abc', prepayId: 'wx-prepay' })
    expect((await queryWechatOrder('pp_test', requestImpl)).trade_state).toBe('SUCCESS')
    expect((await createWechatRefund({ outTradeNo: 'pp_test', outRefundNo: 'pr_test', totalFee: 99, refundFee: 99, transactionId: 'wx-transaction', requestImpl })).refund_id).toBe('wx-refund')
    expect(calls).toHaveLength(3)
    expect(calls[0].body).toContain('sign_type')
    expect(calls[0].body).toContain('<sign>')
    expect(calls[0].body).not.toContain('test-api-key-not-a-real-secret')
    expect(calls[2].clientCert).toMatchObject({ cert: 'test-cert', key: 'test-key' })
  })
  it('回调验签通过，错签/错商户/非法金额全部拒绝', () => {
    configure()
    const fields = { appid: 'wx-test-app', mch_id: 'test-mch', return_code: 'SUCCESS', result_code: 'SUCCESS', trade_state: 'SUCCESS', out_trade_no: 'pp_test', transaction_id: 'wx-transaction', total_fee: 99, time_end: '20261105120000' }
    const xml = wechatXml({ ...fields, sign: signWechatParams(fields, 'test-api-key-not-a-real-secret') })
    expect(verifyWechatCallback(xml)).toMatchObject({ outTradeNo: 'pp_test', transactionId: 'wx-transaction', totalFee: 99, tradeState: 'SUCCESS' })
    expect(() => verifyWechatCallback(xml.replace('wx-transaction', 'wx-other'))).toThrow()
    expect(wechatFields(xml).out_trade_no).toBe('pp_test')
  })
})
