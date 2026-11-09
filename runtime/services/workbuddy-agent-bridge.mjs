import { createServer } from 'node:http'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto'

const ENV_FILE = process.env.WORKBUDDY_ENV_FILE || '/opt/rebuild/workbuddy-agent-bridge.env'
const env = Object.fromEntries(readFileSync(ENV_FILE, 'utf8').split('\n').filter(line => line.includes('=')).map(line => {
  const index = line.indexOf('=')
  return [line.slice(0, index).trim(), line.slice(index + 1).trim()]
}))
const DSH_TOKEN = env.DSH_SERVICE_TOKEN || ''
const WB_TOKEN = env.WORKBUDDY_API_KEY || ''
const DSH_URL = new URL(env.DSH_RUNTIME_URL || 'http://127.0.0.1:18795')
const PORT = Number(env.WORKBUDDY_PORT || 18797)
const TICKET_DIR = env.WORKBUDDY_TICKET_DIR || '/opt/rebuild/workbuddy-agent-bridge/tickets'
if (DSH_TOKEN.length < 16 || WB_TOKEN.length < 16) throw new Error('workbuddy credentials missing')
mkdirSync(TICKET_DIR, { recursive: true, mode: 0o700 })
const tickets = new Map()
const active = new Map()
const sha256 = value => createHash('sha256').update(value).digest('hex')
const now = () => new Date().toISOString()
const pathFor = ticket => `${TICKET_DIR}/${ticket.ticketId}.json`

for (const file of readdirSync(TICKET_DIR).filter(name => name.endsWith('.json'))) {
  try {
    const ticket = JSON.parse(readFileSync(`${TICKET_DIR}/${file}`, 'utf8'))
    if (ticket?.ticketId) {
      if (ticket.status === 'running') {
        ticket.status = 'outcome_unknown'
        ticket.events.push({ type: 'runtime.outcome_unknown', at: now(), reason: 'bridge_restarted' })
        saveTicket(ticket)
      }
      tickets.set(ticket.ticketId, ticket)
    }
  } catch { /* ignore malformed evidence file */ }
}

function saveTicket(ticket) {
  const temporary = `${pathFor(ticket)}.tmp-${process.pid}`
  writeFileSync(temporary, JSON.stringify(ticket, null, 2), { mode: 0o600 })
  renameSync(temporary, pathFor(ticket))
}
function send(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}
function authorized(req) {
  const actual = String(req.headers.authorization || '')
  const expected = `Bearer ${WB_TOKEN}`
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
function event(ticket, type, extra = {}) {
  ticket.events.push({ type, at: now(), ...extra })
  saveTicket(ticket)
}
function publicTicket(ticket) {
  return {
    ok: ticket.status === 'delivered',
    ticketId: ticket.ticketId,
    stationKey: ticket.stationKey,
    sessionId: ticket.sessionId,
    status: ticket.status,
    answer: ticket.answer ?? null,
    resultSha256: ticket.resultSha256 ?? null,
    error: ticket.error ?? null,
    eventsUrl: `/events?ticketId=${encodeURIComponent(ticket.ticketId)}`,
    resultUrl: `/result?ticketId=${encodeURIComponent(ticket.ticketId)}`,
    cancelUrl: '/cancel',
  }
}
function finish(ticket, payload, networkError = null) {
  active.delete(ticket.stationKey)
  if (ticket.cancelRequested) {
    ticket.status = 'cancelled'
    ticket.answer = null
    ticket.error = 'agent_cancelled'
    event(ticket, 'ticket.cancelled')
  } else if (networkError) {
    ticket.status = 'failed'
    ticket.error = 'agent_network_error'
    event(ticket, 'runtime.failed', { message: networkError.message.slice(0, 160) })
  } else if (payload?.ok && typeof payload.answer === 'string' && payload.answer.trim()) {
    ticket.status = 'delivered'
    ticket.answer = payload.answer.trim()
    ticket.resultSha256 = sha256(ticket.answer)
    event(ticket, 'runtime.completed')
  } else {
    ticket.status = 'failed'
    ticket.error = payload?.error || 'agent_empty_deliverable'
    event(ticket, 'runtime.failed', { code: ticket.error })
  }
  saveTicket(ticket)
  return publicTicket(ticket)
}
function runDsh(ticket, task, timeoutSec, factoryId) {
  const controller = new AbortController()
  active.set(ticket.stationKey, { ticket, controller })
  event(ticket, 'runtime.started')
  const body = JSON.stringify({ task, timeoutSec, factoryId, stationKey: ticket.stationKey })
  const request = fetch(`${DSH_URL.origin}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${DSH_TOKEN}` },
    body,
    signal: controller.signal,
  }).then(async response => response.json().catch(() => null))
  return Promise.race([
    request,
    new Promise(resolve => setTimeout(() => {
      controller.abort()
      resolve(null)
    }, Math.min(Math.max(timeoutSec + 5, 15), 150) * 1000)),
  ]).catch(() => null).then(payload => finish(ticket, payload, payload ? null : new Error('dsh_request_aborted')))
}
async function bodyOf(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 65536) throw new Error('body_too_large')
    chunks.push(chunk)
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}
function findTicket(input) {
  if (input.ticketId) return tickets.get(String(input.ticketId))
  if (input.stationKey) return [...tickets.values()].find(ticket => ticket.stationKey === String(input.stationKey))
  return null
}

const server = createServer(async (req, res) => {
  try {
    if (!authorized(req)) return send(res, 401, { ok: false, error: 'unauthorized' })
    const url = new URL(req.url, 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true, service: 'workbuddy-agent-bridge', protocol: 'arp-v1', agentNotModel: true, operations: ['createTicket', 'getEvents', 'getResult', 'cancelTicket'], activeTickets: active.size })
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      const ticket = findTicket(Object.fromEntries(url.searchParams))
      if (!ticket) return send(res, 404, { ok: false, error: 'ticket_not_found' })
      return send(res, 200, { ok: true, ticketId: ticket.ticketId, status: ticket.status, events: ticket.events })
    }
    if (req.method === 'GET' && url.pathname === '/result') {
      const ticket = findTicket(Object.fromEntries(url.searchParams))
      if (!ticket) return send(res, 404, { ok: false, error: 'ticket_not_found' })
      return send(res, 200, publicTicket(ticket))
    }
    if (req.method === 'POST' && url.pathname === '/run') {
      const input = await bodyOf(req)
      const task = String(input.task || '').trim()
      const stationKey = String(input.stationKey || '').trim()
      const factoryId = Number(input.factoryId)
      const timeoutSec = Number(input.timeoutSec || 120)
      if (!task || !/^[a-z0-9][a-z0-9-_]{0,63}$/i.test(stationKey) || !Number.isInteger(factoryId) || factoryId <= 0) return send(res, 400, { ok: false, error: 'invalid_task' })
      if (active.has(stationKey)) return send(res, 409, { ok: false, error: 'duplicate_station_task' })
      const ticket = { ticketId: `wb_${randomUUID()}`, stationKey, sessionId: stationKey, status: 'running', answer: null, resultSha256: null, error: null, cancelRequested: false, events: [{ type: 'ticket.created', at: now(), factoryId }] }
      tickets.set(ticket.ticketId, ticket)
      saveTicket(ticket)
      const result = await runDsh(ticket, task, timeoutSec, factoryId)
      return send(res, result.ok ? 200 : 502, result)
    }
    if (req.method === 'POST' && url.pathname === '/cancel') {
      const input = await bodyOf(req)
      const ticket = findTicket(input)
      if (!ticket) return send(res, 404, { ok: false, error: 'ticket_not_found' })
      ticket.cancelRequested = true
      event(ticket, 'cancel.requested')
      const running = active.get(ticket.stationKey)
      if (running) {
        running.controller.abort()
        active.delete(ticket.stationKey)
        ticket.status = 'cancelled'
        ticket.answer = null
        ticket.error = 'agent_cancelled'
        event(ticket, 'ticket.cancelled')
        return send(res, 200, { ok: true, cancelled: true, ticketId: ticket.ticketId, status: ticket.status })
      }
      if (ticket.status === 'cancelled') return send(res, 200, { ok: true, cancelled: true, idempotent: true, ticketId: ticket.ticketId, status: ticket.status })
      event(ticket, 'cancel.late_result', { previousStatus: ticket.status })
      return send(res, 200, { ok: true, cancelled: false, lateResult: true, ticketId: ticket.ticketId, status: ticket.status })
    }
    return send(res, 404, { ok: false, error: 'not_found' })
  } catch (error) {
    return send(res, 500, { ok: false, error: 'bridge_internal_error', detail: String(error?.message || error).slice(0, 160) })
  }
})
server.listen(PORT, '127.0.0.1', () => console.log(`workbuddy-agent-bridge on 127.0.0.1:${PORT}`))
