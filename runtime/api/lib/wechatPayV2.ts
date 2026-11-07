import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { request as httpsRequest } from 'node:https'

export const WECHAT_CALLBACK_PATH = '/api/payments/wechat/callback'
export function wechatPaymentsEnabled(): boolean { return process.env.WECHAT_PAYMENTS_ENABLED === '1' }
function wechatSignMatches(actual: string | undefined, expected: string): boolean {
  if (typeof actual !== 'string') return false
  const left = Buffer.from(actual, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

export interface WechatRequestArgs { path: string; body: string; clientCert?: { cert: string; key: string; ca?: string } }
export class WechatApiError extends Error {
  readonly errCode: string
  readonly returnMsg: string
  constructor(errCode: string, returnMsg: string) {
    super(`wechat_api_error_${errCode}:${returnMsg}`)
    this.name = 'WechatApiError'
    this.errCode = errCode
    this.returnMsg = returnMsg
  }
}
export type WechatRequest = (args: WechatRequestArgs) => Promise<string>
const API_BASE = 'https://api.mch.weixin.qq.com'
const MAX_RESPONSE = 256 * 1024

function xmlDecode(value: string): string { return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') }
function xmlEscape(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;') }
export function wechatXml(fields: Record<string, string | number>): string {
  return `<xml>${Object.entries(fields).map(([key, value]) => `<${key}>${xmlEscape(String(value))}</${key}>`).join('')}</xml>`
}
export function wechatFields(xml: string): Record<string, string> {
  if (Buffer.byteLength(xml, 'utf8') > MAX_RESPONSE || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('wechat_xml_invalid')
  const body = xml.trim()
  if (!body.startsWith('<xml>') || !body.endsWith('</xml>')) throw new Error('wechat_xml_invalid')
  const inner = body.slice(5, -6)
  const fields: Record<string, string> = Object.create(null)
  let offset = 0
  while (offset < inner.length) {
    const open = inner.indexOf('<', offset)
    if (open < 0) {
      if (inner.slice(offset).trim()) throw new Error('wechat_xml_invalid')
      break
    }
    if (inner.slice(offset, open).trim()) throw new Error('wechat_xml_invalid')
    const openEnd = inner.indexOf('>', open + 1)
    if (openEnd < 0) throw new Error('wechat_xml_invalid')
    const tag = inner.slice(open + 1, openEnd)
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tag) || Object.prototype.hasOwnProperty.call(fields, tag)) throw new Error('wechat_xml_invalid')
    const close = `</${tag}>`
    let value: string
    let fromCdata = false
    if (inner.startsWith('<![CDATA[', openEnd + 1)) {
      const cdataEnd = inner.indexOf(']]>', openEnd + 10)
      if (cdataEnd < 0 || inner.slice(cdataEnd + 3, cdataEnd + 3 + close.length) !== close) throw new Error('wechat_xml_invalid')
      value = inner.slice(openEnd + 10, cdataEnd)
      fromCdata = true
      offset = cdataEnd + 3 + close.length
    } else {
      const closeAt = inner.indexOf(close, openEnd + 1)
      if (closeAt < 0) throw new Error('wechat_xml_invalid')
      value = inner.slice(openEnd + 1, closeAt)
      if (value.includes('<')) throw new Error('wechat_xml_invalid')
      offset = closeAt + close.length
    }
    fields[tag] = fromCdata ? value : xmlDecode(value.trim())
  }
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
  const parsedNotifyUrl = new URL(notifyUrl)
  if (parsedNotifyUrl.pathname !== WECHAT_CALLBACK_PATH) throw new Error('wechat_notify_path_mismatch')
  return { appId, mchId, apiKey, notifyUrl, apiBase }
}
async function readBoundedResponseText(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE) {
        try { await reader.cancel() } catch { /* 保留超限主错误 */ }
        throw new Error('wechat_response_too_large')
      }
      chunks.push(Buffer.from(value))
    }
  } finally { reader.releaseLock() }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) }
  catch { throw new Error('wechat_response_encoding_invalid') }
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
    const text = await readBoundedResponseText(response)
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
  if (fields.return_code === 'SUCCESS') {
    const expectedSign = signWechatParams(fields, config().apiKey)
    if (!wechatSignMatches(fields.sign, expectedSign)) throw new Error('wechat_response_signature_invalid')
  }
  if (fields.return_code !== 'SUCCESS' || fields.result_code !== 'SUCCESS') {
    throw new WechatApiError(String(fields.err_code ?? 'unknown'), String(fields.err_code_des || fields.return_msg || 'unknown'))
  }
  return fields
}
function signedFields(fields: Record<string, string | number>, apiKey: string): Record<string, string | number> {
  const sign = signWechatParams(fields, apiKey)
  return { ...fields, sign }
}

export function assertWechatPaymentBootConfig(): void { config() }

export async function createWechatNativeOrder(args: { outTradeNo: string; totalFee: number; description: string; clientIp: string; productId: string; timeStart: string; timeExpire: string; requestImpl?: WechatRequest }): Promise<{ codeUrl: string; prepayId: string }> {
  const cfg = config()
  if (!wechatPaymentsEnabled()) throw new Error('wechat_payments_disabled')
  if (!Number.isSafeInteger(args.totalFee) || args.totalFee <= 0) throw new Error('wechat_amount_invalid')
  const fields = signedFields({
    appid: cfg.appId, mch_id: cfg.mchId, nonce_str: randomBytes(16).toString('hex'),
    sign_type: 'HMAC-SHA256', body: args.description, out_trade_no: args.outTradeNo,
    total_fee: args.totalFee, spbill_create_ip: args.clientIp, time_start: args.timeStart, time_expire: args.timeExpire,
    notify_url: cfg.notifyUrl, trade_type: 'NATIVE', product_id: args.productId,
  }, cfg.apiKey)
  const result = await call({ path: '/pay/unifiedorder', body: wechatXml(fields) }, args.requestImpl)
  if (!result.code_url?.startsWith('weixin://wxpay/bizpayurl?pr=') || !result.prepay_id) throw new Error('wechat_code_url_invalid')
  return { codeUrl: result.code_url, prepayId: result.prepay_id }
}

export async function queryWechatOrder(outTradeNo: string, requestImpl?: WechatRequest): Promise<Record<string, string>> {
  const cfg = config()
  const fields = signedFields({ appid: cfg.appId, mch_id: cfg.mchId, out_trade_no: outTradeNo, nonce_str: randomBytes(16).toString('hex'), sign_type: 'HMAC-SHA256' }, cfg.apiKey)
  return call({ path: '/pay/orderquery', body: wechatXml(fields) }, requestImpl)
}

export async function createWechatRefund(args: { outTradeNo: string; outRefundNo: string; totalFee: number; refundFee: number; transactionId: string; requestImpl?: WechatRequest }): Promise<Record<string, string>> {
  if (!Number.isSafeInteger(args.totalFee) || !Number.isSafeInteger(args.refundFee) || args.totalFee <= 0 || args.refundFee <= 0 || args.refundFee > args.totalFee) throw new Error('wechat_amount_invalid')
  const cfg = config()
  const cert = process.env.WECHAT_REFUND_CERT_PEM ?? ''
  const key = process.env.WECHAT_REFUND_KEY_PEM ?? ''
  if (!cert || !key) throw new Error('wechat_refund_cert_missing')
  const fields = signedFields({ appid: cfg.appId, mch_id: cfg.mchId, nonce_str: randomBytes(16).toString('hex'), sign_type: 'HMAC-SHA256', transaction_id: args.transactionId, out_trade_no: args.outTradeNo, out_refund_no: args.outRefundNo, total_fee: args.totalFee, refund_fee: args.refundFee }, cfg.apiKey)
  const result = await call({ path: '/secapi/pay/refund', body: wechatXml(fields), clientCert: { cert, key, ...(process.env.WECHAT_REFUND_CA_PEM ? { ca: process.env.WECHAT_REFUND_CA_PEM } : {}) } }, args.requestImpl)
  if (!result.refund_id) throw new Error('wechat_refund_not_accepted')
  if (Number(result.refund_fee) !== args.refundFee) throw new Error('wechat_refund_amount_mismatch')
  return result
}

export async function queryWechatRefund(outRefundNo: string, requestImpl?: WechatRequest): Promise<Record<string, string>> {
  const cfg = config()
  const fields = signedFields({ appid: cfg.appId, mch_id: cfg.mchId, out_refund_no: outRefundNo, nonce_str: randomBytes(16).toString('hex'), sign_type: 'HMAC-SHA256' }, cfg.apiKey)
  return call({ path: '/pay/refundquery', body: wechatXml(fields) }, requestImpl)
}

export function verifyWechatCallback(xml: string): { outTradeNo: string; transactionId: string; totalFee: number; tradeState: string; timeEnd: string } {
  const cfg = config()
  const fields = wechatFields(xml)
  const expected = signWechatParams(fields, cfg.apiKey)
  if (!wechatSignMatches(fields.sign, expected)) throw new Error('wechat_callback_signature_invalid')
  if (fields.appid !== cfg.appId || fields.mch_id !== cfg.mchId || fields.return_code !== 'SUCCESS' || fields.result_code !== 'SUCCESS') throw new Error('wechat_callback_invalid')
  const totalFee = Number(fields.total_fee)
  if (!Number.isSafeInteger(totalFee) || totalFee <= 0 || !fields.out_trade_no || !fields.transaction_id) throw new Error('wechat_callback_invalid')
  return { outTradeNo: fields.out_trade_no, transactionId: fields.transaction_id, totalFee, tradeState: 'SUCCESS', timeEnd: fields.time_end ?? '' }
}
