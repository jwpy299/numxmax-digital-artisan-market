import { createHash, createHmac } from 'node:crypto'
import { request as httpsRequest } from 'node:https'

export interface WechatRequestArgs { path: string; body: string; clientCert?: { cert: string; key: string; ca?: string } }
export type WechatRequest = (args: WechatRequestArgs) => Promise<string>
const API_BASE = 'https://api.mch.weixin.qq.com'
const MAX_RESPONSE = 256 * 1024

function xmlEscape(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;') }
export function wechatXml(fields: Record<string, string | number>): string {
  return `<xml>${Object.entries(fields).map(([key, value]) => `<${key}>${xmlEscape(String(value))}</${key}>`).join('')}</xml>`
}
export function wechatFields(xml: string): Record<string, string> {
  if (xml.length > MAX_RESPONSE || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('wechat_xml_invalid')
  const fields: Record<string, string> = {}
  const body = xml.trim().replace(/^<xml>/, '').replace(/<\/xml>$/, '')
  for (const match of body.matchAll(/<([a-zA-Z_][\w]*)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/[a-zA-Z_][\w]*>/g)) fields[match[1]] = (match[2] ?? match[3] ?? '').trim()
  return fields
}
export function signWechatParams(fields: Record<string, string | number>, apiKey: string): string {
  const source = Object.entries(fields).filter(([key, value]) => key !== 'sign' && String(value).length > 0).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('&') + `&key=${apiKey}`
  return createHmac('sha256', apiKey).update(source).digest('hex').toUpperCase()
}
export function wechatPayloadSha256(xml: string): string { return createHash('sha256').update(xml).digest('hex') }

function config() {
  const appId = process.env.WECHAT_APP_ID?.trim() ?? ''
  const mchId = process.env.WECHAT_MCH_ID?.trim() ?? ''
  const apiKey = process.env.WECHAT_API_KEY?.trim() ?? ''
  const notifyUrl = process.env.WECHAT_NOTIFY_URL?.trim() ?? ''
  const apiBase = (process.env.WECHAT_API_BASE ?? API_BASE).replace(/\/+$/, '')
  if (!appId || !mchId || !apiKey || !notifyUrl.startsWith('https://') || apiBase !== API_BASE) throw new Error('wechat_not_configured')
  return { appId, mchId, apiKey, notifyUrl, apiBase }
}
async function defaultRequest(args: WechatRequestArgs): Promise<string> {
  const { apiBase } = config()
  if (!args.clientCert) {
    const response = await fetch(`${apiBase}${args.path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
      body: args.body,
      signal: AbortSignal.timeout(15_000),
    })
    const text = await response.text()
    if (text.length > MAX_RESPONSE) throw new Error('wechat_response_too_large')
    if (!response.ok) throw new Error(`wechat_http_${response.status}`)
    return text
  }
  return new Promise((resolve, reject) => {
    const req = httpsRequest(`${apiBase}${args.path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Length': Buffer.byteLength(args.body) },
      cert: args.clientCert!.cert,
      key: args.clientCert!.key,
      ...(args.clientCert!.ca ? { ca: args.clientCert!.ca } : {}),
      timeout: 15_000,
    }, (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_RESPONSE) { req.destroy(new Error('wechat_response_too_large')); return }
        chunks.push(chunk)
      })
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('wechat_timeout')))
    req.on('error', reject)
    req.end(args.body)
  })
}
async function call(args: WechatRequestArgs, requestImpl?: WechatRequest): Promise<Record<string, string>> {
  const fields = wechatFields(await (requestImpl ?? defaultRequest)(args))
  if (fields.return_code !== 'SUCCESS' || fields.result_code !== 'SUCCESS') throw new Error(`wechat_api_error_${fields.return_msg ?? fields.err_code ?? 'unknown'}`)
  return fields
}
function signedFields(fields: Record<string, string | number>, apiKey: string): Record<string, string | number> {
  const sign = signWechatParams(fields, apiKey)
  return { ...fields, sign }
}

export async function createWechatNativeOrder(args: { outTradeNo: string; totalFee: number; description: string; clientIp: string; productId: string; timeStart: string; timeExpire: string; requestImpl?: WechatRequest }): Promise<{ codeUrl: string; prepayId: string }> {
  const cfg = config()
  if (process.env.WECHAT_PAYMENTS_ENABLED !== '1') throw new Error('wechat_payments_disabled')
  if (!Number.isSafeInteger(args.totalFee) || args.totalFee <= 0) throw new Error('wechat_amount_invalid')
  const fields = signedFields({
    appid: cfg.appId, mch_id: cfg.mchId, nonce_str: createHash('sha256').update(`${args.outTradeNo}|${args.timeStart}`).digest('hex').slice(0, 32),
    sign_type: 'HMAC-SHA256', body: args.description, detail: args.description, out_trade_no: args.outTradeNo,
    total_fee: args.totalFee, spbill_create_ip: args.clientIp, time_start: args.timeStart, time_expire: args.timeExpire,
    notify_url: cfg.notifyUrl, trade_type: 'NATIVE', product_id: args.productId,
  }, cfg.apiKey)
  const result = await call({ path: '/pay/unifiedorder', body: wechatXml(fields) }, args.requestImpl)
  if (!result.code_url?.startsWith('weixin://wxpay/bizpayurl?pr=') || !result.prepay_id) throw new Error('wechat_code_url_invalid')
  return { codeUrl: result.code_url, prepayId: result.prepay_id }
}

export async function queryWechatOrder(outTradeNo: string, requestImpl?: WechatRequest): Promise<Record<string, string>> {
  const cfg = config()
  const fields = signedFields({ appid: cfg.appId, mch_id: cfg.mchId, out_trade_no: outTradeNo, nonce_str: createHash('sha256').update(outTradeNo).digest('hex').slice(0, 32), sign_type: 'HMAC-SHA256' }, cfg.apiKey)
  return call({ path: '/pay/orderquery', body: wechatXml(fields) }, requestImpl)
}

export async function createWechatRefund(args: { outTradeNo: string; outRefundNo: string; totalFee: number; refundFee: number; transactionId: string; requestImpl?: WechatRequest }): Promise<Record<string, string>> {
  const cfg = config()
  const cert = process.env.WECHAT_REFUND_CERT_PEM ?? ''
  const key = process.env.WECHAT_REFUND_KEY_PEM ?? ''
  if (!cert || !key) throw new Error('wechat_refund_cert_missing')
  const fields = signedFields({ appid: cfg.appId, mch_id: cfg.mchId, nonce_str: createHash('sha256').update(args.outRefundNo).digest('hex').slice(0, 32), sign_type: 'HMAC-SHA256', transaction_id: args.transactionId, out_trade_no: args.outTradeNo, out_refund_no: args.outRefundNo, total_fee: args.totalFee, refund_fee: args.refundFee }, cfg.apiKey)
  return call({ path: '/secapi/pay/refund', body: wechatXml(fields), clientCert: { cert, key, ...(process.env.WECHAT_REFUND_CA_PEM ? { ca: process.env.WECHAT_REFUND_CA_PEM } : {}) } }, args.requestImpl)
}

export function verifyWechatCallback(xml: string): { outTradeNo: string; transactionId: string; totalFee: number; tradeState: string; timeEnd: string } {
  const cfg = config()
  const fields = wechatFields(xml)
  const expected = signWechatParams(fields, cfg.apiKey)
  if (!fields.sign || fields.sign !== expected) throw new Error('wechat_callback_signature_invalid')
  if (fields.appid !== cfg.appId || fields.mch_id !== cfg.mchId || fields.return_code !== 'SUCCESS' || fields.result_code !== 'SUCCESS') throw new Error('wechat_callback_invalid')
  const totalFee = Number(fields.total_fee)
  if (!Number.isSafeInteger(totalFee) || totalFee <= 0 || !fields.out_trade_no || !fields.transaction_id) throw new Error('wechat_callback_invalid')
  return { outTradeNo: fields.out_trade_no, transactionId: fields.transaction_id, totalFee, tradeState: fields.trade_state ?? '', timeEnd: fields.time_end ?? '' }
}
