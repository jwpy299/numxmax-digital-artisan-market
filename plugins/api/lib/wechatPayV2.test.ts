import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWechatNativeOrder, createWechatRefund, queryWechatOrder, signWechatParams, verifyWechatCallback, wechatFields, wechatXml, type WechatRequest, type WechatRequestArgs } from './wechatPayV2'

function signedResponse(fields: Record<string, string | number>): string {
  return wechatXml({ ...fields, sign: signWechatParams(fields, 'test-api-key-not-a-real-secret') })
}

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
      if (args.path === '/pay/unifiedorder') return signedResponse({ return_code: 'SUCCESS', result_code: 'SUCCESS', prepay_id: 'wx-prepay', code_url: 'weixin://wxpay/bizpayurl?pr=abc' })
      if (args.path === '/pay/orderquery') return signedResponse({ return_code: 'SUCCESS', result_code: 'SUCCESS', trade_state: 'SUCCESS', transaction_id: 'wx-transaction', total_fee: 99, time_end: '20261105120000' })
      return signedResponse({ return_code: 'SUCCESS', result_code: 'SUCCESS', refund_fee: 99, refund_id: 'wx-refund' })
    }
    const order = await createWechatNativeOrder({ outTradeNo: 'pp_test', totalFee: 99, description: '插件订阅', clientIp: '127.0.0.1', productId: '11', timeStart: '20261105110000', timeExpire: '20261105113000', requestImpl })
    expect(order).toEqual({ codeUrl: 'weixin://wxpay/bizpayurl?pr=abc', prepayId: 'wx-prepay' })
    expect((await queryWechatOrder('pp_test', requestImpl)).trade_state).toBe('SUCCESS')
    expect((await createWechatRefund({ outTradeNo: 'pp_test', outRefundNo: 'pr_test', totalFee: 99, refundFee: 99, transactionId: 'wx-transaction', requestImpl })).refund_id).toBe('wx-refund')
    expect(calls).toHaveLength(3)
    const nonces = calls.map((call) => /<nonce_str>([a-f0-9]{32})<\/nonce_str>/.exec(call.body)?.[1])
    expect(new Set(nonces).size).toBe(3)
    expect(calls[0].body).toContain('sign_type')
    expect(calls[0].body).toContain('<sign>')
    expect(calls[0].body).not.toContain('test-api-key-not-a-real-secret')
    expect(calls[2].clientCert).toMatchObject({ cert: 'test-cert', key: 'test-key' })
  })
  it('回调地址与注册路径不一致时启动配置 fail-closed，且不发下单请求', async () => {
    configure()
    vi.stubEnv('WECHAT_NOTIFY_URL', 'https://staging.example/api/wechat/pay-notify')
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await expect(createWechatNativeOrder({ outTradeNo: 'pp_path_mismatch', totalFee: 99, description: '插件订阅', clientIp: '127.0.0.1', productId: '11', timeStart: '20261105110000', timeExpire: '20261105113000' })).rejects.toThrow('wechat_notify_path_mismatch')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('回调验签通过，错签/错商户/非法金额全部拒绝', () => {
    configure()
    const fields = { appid: 'wx-test-app', mch_id: 'test-mch', return_code: 'SUCCESS', result_code: 'SUCCESS', out_trade_no: 'pp_test', transaction_id: 'wx-transaction', total_fee: 99, time_end: '20261105120000' }
    const xml = wechatXml({ ...fields, sign: signWechatParams(fields, 'test-api-key-not-a-real-secret') })
    expect(verifyWechatCallback(xml)).toMatchObject({ outTradeNo: 'pp_test', transactionId: 'wx-transaction', totalFee: 99, tradeState: 'SUCCESS' })
    expect(() => verifyWechatCallback(xml.replace('wx-transaction', 'wx-other'))).toThrow()
    expect(wechatFields(xml).out_trade_no).toBe('pp_test')
  })

  it('XML 实体解码与原文一致，特殊字符回调验签不被转义破坏', () => {
    configure()
    const fields = { appid: 'wx-test-app', mch_id: 'test-mch', return_code: 'SUCCESS', result_code: 'SUCCESS', out_trade_no: 'pp-entity', transaction_id: 'wx-&<>"\'', total_fee: 99, time_end: '20261105120000' }
    const xml = wechatXml({ ...fields, sign: signWechatParams(fields, 'test-api-key-not-a-real-secret') })
    expect(wechatFields(xml).transaction_id).toBe('wx-&<>"\'')
    expect(verifyWechatCallback(xml).transactionId).toBe('wx-&<>"\'')
  })

  it('CDATA 中实体样式文本保持原文，合法签名不被二次解码破坏', () => {
    configure()
    const fields = { appid: 'wx-test-app', mch_id: 'test-mch', return_code: 'SUCCESS', result_code: 'SUCCESS', out_trade_no: 'pp-cdata', transaction_id: 'wx-&amp;', total_fee: 99, time_end: '20261105120000' }
    const xml = wechatXml({ ...fields, sign: signWechatParams(fields, 'test-api-key-not-a-real-secret') }).replace('<transaction_id>wx-&amp;amp;</transaction_id>', '<transaction_id><![CDATA[wx-&amp;]]></transaction_id>')
    expect(verifyWechatCallback(xml).transactionId).toBe('wx-&amp;')
  })

  it('退款缺少受理号或金额不符都不得确认到账', async () => {
    configure()
    const makeRequest = (status: string, fee: number): WechatRequest => async () => signedResponse({ return_code: 'SUCCESS', result_code: 'SUCCESS', refund_fee: fee, refund_id: status === 'MISSING_ID' ? '' : 'wx-refund' })
    await expect(createWechatRefund({ outTradeNo: 'pp_test', outRefundNo: 'pr_processing', totalFee: 99, refundFee: 99, transactionId: 'wx-transaction', requestImpl: makeRequest('MISSING_ID', 99) })).rejects.toThrow('wechat_refund_not_accepted')
    await expect(createWechatRefund({ outTradeNo: 'pp_test', outRefundNo: 'pr_amount', totalFee: 99, refundFee: 99, transactionId: 'wx-transaction', requestImpl: makeRequest('SUCCESS', 1) })).rejects.toThrow('wechat_refund_amount_mismatch')
  })


  it('退款金额为非整数、零、负数或超额时在签名前拒绝且不发请求', async () => {
    configure()
    const requestImpl = vi.fn()
    for (const [totalFee, refundFee] of [[100, 0], [100, -1], [100, 101], [100, 1.5], [0, 1]] as const) {
      await expect(createWechatRefund({ outTradeNo: 'pp_amount', outRefundNo: 'pr_amount', totalFee, refundFee, transactionId: 'wx-transaction', requestImpl: requestImpl as never })).rejects.toThrow('wechat_amount_invalid')
    }
    expect(requestImpl).not.toHaveBeenCalled()
  })

  it('XML 解析保留 CDATA，未闭合、嵌套与重复标签均 fail-closed', () => {
    expect(wechatFields('<xml><body><![CDATA[插件 <订阅>]]></body></xml>').body).toBe('插件 <订阅>')
    expect(() => wechatFields(`<xml>${'<a>'.repeat(10_000)}</xml>`)).toThrow('wechat_xml_invalid')
    expect(() => wechatFields('<xml><a><b></b></a></xml>')).toThrow('wechat_xml_invalid')
    expect(() => wechatFields('<xml><a>1</a><a>2</a></xml>')).toThrow('wechat_xml_invalid')
  })
  it('默认 fetch 路径按字节限制响应，正常签名响应仍可下单', async () => {
    configure()
    const args = { outTradeNo: 'pp_stream', totalFee: 99, description: '插件订阅', clientIp: '127.0.0.1', productId: '11', timeStart: '20261105110000', timeExpire: '20261105113000' }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(256 * 1024 + 1), { status: 200 })))
    await expect(createWechatNativeOrder(args)).rejects.toThrow('wechat_response_too_large')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(signedResponse({ return_code: 'SUCCESS', result_code: 'SUCCESS', prepay_id: 'wx-stream', code_url: 'weixin://wxpay/bizpayurl?pr=stream' }), { status: 200 })))
    await expect(createWechatNativeOrder(args)).resolves.toEqual({ codeUrl: 'weixin://wxpay/bizpayurl?pr=stream', prepayId: 'wx-stream' })
  })
})
