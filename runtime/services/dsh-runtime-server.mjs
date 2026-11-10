/**
 * dsh-runtime —— DSH 服务化封装（默认 127.0.0.1:18795 / 10.66.0.4:18796）
 * POST /run {task, timeoutSec?, factoryId, stationKey?, mode?} → Authorization: Bearer <DSH_SERVICE_TOKEN>
 * factoryId 与 mode 必须成对一致：work>0、life=0；缺省 work+0 仅返回 invalid_mode_scope，不做隐式企业授权。
 * 生产路径/端口保持原默认值；DSH_RUNTIME_* 仅用于隔离测试与受控运维覆盖。
 * 纪律：服务 token 与数据库密钥不进入 DSH 子进程；任务正文与密钥不写日志。
 */
import { createServer } from 'node:http'
import { requestBearer } from '../http-policy.mjs'
import { timingSafeStringEqual } from '../timing-safe.mjs'
import { mkdirSync, rmSync, writeFileSync, symlinkSync, existsSync, readFileSync, readdirSync, statSync, utimesSync, lchownSync, lstatSync, cpSync, copyFileSync, realpathSync, renameSync, chmodSync, openSync, fstatSync, fchmodSync, closeSync, constants } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseFactoryId } from '../factory-id.mjs'
import { clipGraphemes } from '../answer-policy.mjs'
import { MAX_TASK_CHARS } from './task-provider/limits.mjs'
import { delimiter, dirname } from 'node:path'

function positiveInt(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}
function nonNegativeInt(value, fallback) {
  const text = String(value ?? '').trim()
  if (!text) return fallback
  const number = Number(text)
  return Number.isInteger(number) && number >= 0 ? number : fallback
}

const ENV_FILE = process.env.DSH_RUNTIME_ENV_FILE || '/opt/dsh-sandbox/app.env'
const env = Object.fromEntries(
  readFileSync(ENV_FILE, 'utf8').split('\n').filter((line) => line.includes('=')).map((line) => {
    const index = line.indexOf('=')
    return [line.slice(0, index).trim(), line.slice(index + 1).trim()]
  }),
)
const TOKEN = env.DSH_SERVICE_TOKEN
if (!TOKEN) { console.error('DSH_SERVICE_TOKEN missing'); process.exit(1) }

const NODE = process.env.DSH_RUNTIME_NODE || '/opt/node22/bin/node'
const SETPRIV = process.env.DSH_RUNTIME_SETPRIV || '/usr/bin/setpriv'
const CLI = process.env.DSH_RUNTIME_CLI || '/opt/dsh-sandbox/repo/apps/cli/lib/bin.js'
const WORK = process.env.DSH_RUNTIME_WORK || '/opt/dsh-sandbox/work'
const DSH_HOME = process.env.DSH_RUNTIME_DSH_HOME || '/root/.dsh'
const SETTINGS_FILE = process.env.DSH_RUNTIME_SETTINGS_FILE || `${DSH_HOME}/settings.yaml`
const LIFE_PATCH = process.env.DSH_RUNTIME_LIFE_PATCH || fileURLToPath(new URL('./headless-life.patch.yml', import.meta.url))
const TASK_PROVIDER_DIR = fileURLToPath(new URL('./task-provider', import.meta.url))
const BASE_PATCH = process.env.DSH_RUNTIME_BASE_PATCH || '/opt/dsh-sandbox/repo/packages/bundle/base/cordis.patch.yml'
const LIFE_SAFE_TOOL_IDS = new Set(['tool-web'])
const LIFE_SAFE_PLUGIN_IDS = new Set([
  'agent', 'agent-default-model', 'agent-instructions', 'agent-loop', 'approval', 'headless-startup',
  'command-compact', 'command-feedback', 'commands', 'compaction-basic', 'credentials',
  'deepseek-llm-api-extensions', 'hmr', 'llm', 'llm-deepseek', 'llm-pi-ai', 'llm-retry',
  'plan-mode', 'repeat-tool-reminder', 'sandbox-policy', 'session',
  'session-checkpoint-policy', 'session-log-deepseek', 'session-persistence-jsonl',
  'session-projection', 'session-projection-cache', 'session-query-sqlite',
  'session-telemetry-otel', 'session-title', 'session-title-llm', 'settings', 'shell-env',
  'skill-badge', 'storage', 'storage-domain', 'storage-json', 'system-prompt',
  'timeout-policy', 'timer', 'token-meter', 'tools', 'user-questions', 'web',
  'web-fetch-http', 'web-search-deepseek',
])
const LOOPBACK_PORT = positiveInt(process.env.DSH_RUNTIME_PORT, 18795)
const SANDBOX_PORT = positiveInt(process.env.DSH_RUNTIME_SANDBOX_PORT, 18796)
const SANDBOX_HOST = process.env.DSH_RUNTIME_SANDBOX_HOST || '10.66.0.4'
const SANDBOX_LISTENER_DISABLED = process.env.DSH_RUNTIME_DISABLE_SANDBOX_LISTENER === '1'
const MAX_CONC = positiveInt(process.env.DSH_RUNTIME_MAX_CONC, 6)
const PER_FACTORY = positiveInt(process.env.DSH_RUNTIME_PER_FACTORY, 2)
const MAX_QUEUE = nonNegativeInt(process.env.DSH_RUNTIME_MAX_QUEUE, 30)
const MAX_BODY_BYTES = positiveInt(process.env.DSH_RUNTIME_MAX_BODY_BYTES, 32768)
const READ_TIMEOUT_MS = positiveInt(process.env.DSH_RUNTIME_READ_TIMEOUT_MS, 30000)
const QUEUE_TTL_MS = positiveInt(process.env.DSH_RUNTIME_QUEUE_TTL_MS, 60000)
const MIN_TIMEOUT_SEC = positiveInt(process.env.DSH_RUNTIME_MIN_TIMEOUT_SEC, 10)
const KILL_GRACE_MS = positiveInt(process.env.DSH_RUNTIME_KILL_GRACE_MS, 3000)
const CAN_DROP_PRIVILEGES = process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0
if (CAN_DROP_PRIVILEGES && !existsSync(SETPRIV)) throw new Error('station_privilege_helper_unavailable')
const STATION_UID_MIN = 100000
const STATION_UID_MAX = 2000000
const TASK_PROVIDER_PATCH = `${TASK_PROVIDER_DIR}/cordis.patch.yml`
const STATION_RETENTION_MS = positiveInt(process.env.DSH_RUNTIME_STATION_RETENTION_MS, 7 * 24 * 60 * 60 * 1000)
const STATION_SWEEP_INTERVAL_MS = positiveInt(process.env.DSH_RUNTIME_STATION_SWEEP_INTERVAL_MS, 6 * 60 * 60 * 1000)
const MAX_TIMEOUT_SEC = 600
const MAX_OUTPUT_CHARS = 65536
const MAX_OUTPUT_BUFFER_CHARS = MAX_OUTPUT_CHARS * 4 // 仅内部内存硬上限；最终用户字符预算统一按 grapheme。
const MAX_ERROR_CHARS = 16384
const CHILD_ENV_KEYS = [
  'LANG', 'LC_ALL', 'TZ', 'NODE_ENV', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'NUMX_TEST_SERVICE_ENV_FILE',
  'DEEPSEEK_SEARCH_BASE_URL', 'SCNET_API_KEY', 'SCNET_BASE_URL', 'SCNET_MODEL',
  'KIMI_API_KEY',
]

const PATCH_ID_LINE = /^\s*- id:\s+(?:'([^']+)'|"([^"]+)"|([^\s#'"]+))\s*$/
function patchIdFromLine(line) {
  if (!/^\s*- id:/.test(line)) return null
  const match = PATCH_ID_LINE.exec(line)
  if (!match) throw new Error('life_patch_invalid_id')
  return match[1] || match[2] || match[3]
}
function readPatchEntryIdsFromSource(source, disabledOnly = false) {
  const ids = new Set()
  let current = null
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const id = patchIdFromLine(line)
    if (id) {
      current = id
      if (!disabledOnly) ids.add(current)
      continue
    }
    if (current && /^\s*disabled:\s+true\s*$/.test(line)) {
      if (disabledOnly) ids.add(current)
      current = null
      continue
    }
    if (current && /^\s*disabled:\s+false\s*$/.test(line)) { current = null; continue }
    if (/^\s*- insert:/.test(line)) current = null
  }
  return ids
}
function readPatchIdListFromSource(source) {
  const ids = []
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const id = patchIdFromLine(line)
    if (id) ids.push(id)
  }
  return ids
}
function assertNoDuplicatePatchIds(source, label) {
  const ids = readPatchIdListFromSource(source)
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index)
  if (duplicate) throw new Error(`${label}${duplicate}`)
}

function readInsertedPatchIdsFromSource(source) {
  const inserted = new Set()
  let insertIndent = null
  let pendingSequenceIndent = null
  function readId(line) {
    const match = /(?:^|[{,\s])["']?id["']?\s*:\s*(?:'([^']+)'|"([^"]+)"|([^\s,}'"]+))/.exec(line)
    if (/(?:^|[{,\s])["']?id["']?\s*:/.test(line) && !match) throw new Error('life_patch_invalid_id')
    return match?.[1] || match?.[2] || match?.[3] || null
  }
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (/^\s*-\s*$/.test(line)) {
      if (insertIndent !== null && indent <= insertIndent) insertIndent = null
      if (insertIndent === null) pendingSequenceIndent = indent
    }
    if (/^\s*(?:-\s*)?(?:\{\s*)?insert\s*:/.test(line)) {
      insertIndent = /^\s*-\s*(?:\{\s*)?insert\s*:/.test(line) ? indent : (pendingSequenceIndent ?? indent)
      pendingSequenceIndent = null
      const inlineId = readId(line)
      if (inlineId) inserted.add(inlineId)
      continue
    }
    if (insertIndent !== null && indent <= insertIndent && /^\s*-\s/.test(line)) insertIndent = null
    if (insertIndent !== null && indent > insertIndent) {
      const id = readId(line)
      if (id) inserted.add(id)
    }
  }
  return inserted
}

function sameIds(left, right) {
  return left.size === right.size && [...left].every((id) => right.has(id))
}
function readReenabledPatchIdsFromSource(source) {
  const ids = new Set()
  let current = null
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const id = patchIdFromLine(line)
    if (id) { current = id; continue }
    if (current && /^\s*disabled:\s+false\s*$/.test(line)) { ids.add(current); current = null }
    if (/^\s*- insert:/.test(line)) current = null
  }
  return ids
}

function validateLifeToolPatch(installedPatch, taskPatch) {
  const registry = readPatchEntryIdsFromSource(readFileSync(BASE_PATCH, 'utf8'))
  const lifeSource = readFileSync(LIFE_PATCH, 'utf8')
  assertNoDuplicatePatchIds(lifeSource, 'life_patch_invalid:duplicate_')
  const lifeInserts = readInsertedPatchIdsFromSource(lifeSource)
  if (lifeInserts.size) throw new Error(`life_patch_invalid:insert_forbidden_${[...lifeInserts][0]}`)
  const disabled = readPatchEntryIdsFromSource(lifeSource, true)
  if (!registry.size || !disabled.size) throw new Error('life_patch_invalid:empty_registry_or_patch')
  for (const id of disabled) {
    if (!registry.has(id)) throw new Error(`life_patch_invalid:unknown_${id}`)
  }
  for (const id of registry) {
    if (id.startsWith('tool-') && !LIFE_SAFE_TOOL_IDS.has(id) && !disabled.has(id)) throw new Error(`life_patch_invalid:unreviewed_${id}`)
    if (!id.startsWith('tool-') && !LIFE_SAFE_PLUGIN_IDS.has(id) && !disabled.has(id)) throw new Error(`life_patch_invalid:unreviewed_plugin_${id}`)
  }
  if (!registry.has('tool-web') || disabled.has('tool-web')) throw new Error('life_patch_invalid:missing_tool_web')

  const sourceProfilePatch = `${DSH_HOME}/profiles/headless/cordis.patch.yml`
  const profileSource = installedPatch ?? (existsSync(sourceProfilePatch) ? readFileSync(sourceProfilePatch, 'utf8') : '')
  const profileIds = readPatchIdListFromSource(profileSource)
  for (const id of profileIds) {
    if (!registry.has(id)) throw new Error(`life_patch_invalid:unknown_${id}`)
  }
  for (const id of readReenabledPatchIdsFromSource(profileSource)) {
    if (!LIFE_SAFE_TOOL_IDS.has(id) && !LIFE_SAFE_PLUGIN_IDS.has(id)) throw new Error(`life_patch_invalid:reenabled_${id}`)
  }
  assertNoDuplicatePatchIds(profileSource, 'life_patch_invalid:duplicate_')
  const profileInserts = readInsertedPatchIdsFromSource(profileSource)
  if (profileInserts.size) throw new Error(`life_patch_invalid:unreviewed_insert_${[...profileInserts][0]}`)
  const taskSource = taskPatch ?? readFileSync(TASK_PROVIDER_PATCH, 'utf8')
  assertNoDuplicatePatchIds(taskSource, 'life_patch_invalid:duplicate_')
  const taskIds = readPatchEntryIdsFromSource(taskSource)
  const taskDisabled = readPatchEntryIdsFromSource(taskSource, true)
  const taskInserts = readInsertedPatchIdsFromSource(taskSource)
  if (!sameIds(taskIds, new Set(['headless-startup', 'numx-task-provider']))
      || !sameIds(taskDisabled, new Set(['headless-startup']))
      || !sameIds(taskInserts, new Set(['numx-task-provider']))) {
    throw new Error('life_patch_invalid:task_provider_drift')
  }
}
validateLifeToolPatch()
let running = 0
const queue = []
const runningByFactory = new Map()
const busyStations = new Set()
const activeJobs = new Set()
const activeStations = new Set()
let shuttingDown = false
let sandboxHealthy = SANDBOX_LISTENER_DISABLED ? null : false
let server2 = null

function rmStation(dir) {
  if (!dir) return
  activeStations.delete(dir)
  try {
    rmSync(dir, { recursive: true, force: true })
    if (CAN_DROP_PRIVILEGES) releaseStationIdentity(dir)
  } catch { /* 清理失败不致命；映射随成功删除才释放 */ }
}
function touchStation(dir) {
  if (dir) try { const now = new Date(); utimesSync(dir, now, now) } catch { /* 触活失败不阻塞任务 */ }
}
function sweepStations() {
  const root = `${WORK}/stations`
  if (!existsSync(root)) return
  const now = Date.now()
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const full = `${root}/${entry.name}`
    if (activeStations.has(full)) continue
    try {
      if (now - statSync(full).mtimeMs >= STATION_RETENTION_MS) rmStation(full)
    } catch { /* 单目录失败不影响其他回收 */ }
  }
}

function factoryRunning(factoryId) { return runningByFactory.get(factoryId) || 0 }
function stationLockKey(job) { return job.stationKey ? `${job.factoryId}-${job.stationKey}` : '' }
function hasValidServiceToken(req) {
  return timingSafeStringEqual(requestBearer(req), String(TOKEN))
}

function sendJson(res, status, payload) {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}
function canStart(job) {
  if (shuttingDown || job.cancelled || running >= MAX_CONC) return false
  if (job.factoryId > 0 && factoryRunning(job.factoryId) >= PER_FACTORY) return false
  const lock = stationLockKey(job)
  return !lock || !busyStations.has(lock)
}
function reserve(job) {
  job.reserved = true
  activeJobs.add(job)
  running += 1
  if (job.factoryId > 0) runningByFactory.set(job.factoryId, factoryRunning(job.factoryId) + 1)
  const lock = stationLockKey(job)
  if (lock) busyStations.add(lock)
}
function release(job) {
  if (!job.reserved) return
  job.reserved = false
  activeJobs.delete(job)
  running = Math.max(0, running - 1)
  if (job.factoryId > 0) {
    const next = Math.max(0, factoryRunning(job.factoryId) - 1)
    if (next) runningByFactory.set(job.factoryId, next)
    else runningByFactory.delete(job.factoryId)
  }
  const lock = stationLockKey(job)
  if (lock) busyStations.delete(lock)
}
function signalProcessGroup(child, signal) {
  if (!child?.pid) return
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch {
    try { child.kill(signal) } catch { /* 已退出 */ }
  }
}
function terminate(job, timedOut) {
  if (!job.child || job.terminating) return
  job.terminating = true
  if (timedOut) job.timedOut = true
  signalProcessGroup(job.child, 'SIGTERM')
  job.killTimer = setTimeout(() => signalProcessGroup(job.child, 'SIGKILL'), KILL_GRACE_MS)
  job.killTimer.unref()
}
function childEnvironment(factoryId, stationHome) {
  const output = {}
  for (const key of CHILD_ENV_KEYS) {
    const value = env[key] ?? process.env[key]
    if (value !== undefined) output[key] = value
  }
  output.PATH = `${dirname(NODE)}${delimiter}${process.env.PATH || ''}`
  output.HOME = stationHome || process.env.HOME || '/root'
  output.LINGSHU_FACTORY_ID = String(factoryId || '')
  output.NUMX_TASK_FILE = `${stationHome}/task.txt`
  return output
}

function tryStart(job) {
  if (!canStart(job)) return false
  clearTimeout(job.queueTimer)
  job.queueTimer = null
  reserve(job)
  try {
    runTask(job)
  } catch (error) {
    console.error(`dsh-runtime setup_failed: ${String(error?.message || 'unknown')}`)
    release(job)
    activeStations.delete(job.station)
    if (!job.stationKey) rmStation(job.station)
    try { job.json(200, { ok: false, error: 'setup_failed', durationMs: 0, queueWaitMs: job.queuedAt ? Date.now() - job.queuedAt : 0 }) }
    finally { queueMicrotask(drainQueue) }
  }
  return true
}

function drainQueue() {
  for (let index = 0; index < queue.length;) {
    const job = queue[index]
    if (job.cancelled) {
      clearTimeout(job.queueTimer)
      queue.splice(index, 1)
      continue
    }
    if (job.queuedAt && Date.now() - job.queuedAt >= QUEUE_TTL_MS) {
      clearTimeout(job.queueTimer)
      queue.splice(index, 1)
      job.json(200, { ok: false, error: 'queue_timeout', durationMs: 0, queueWaitMs: Date.now() - job.queuedAt })
      continue
    }
    if (running >= MAX_CONC) break
    if (tryStart(job)) queue.splice(index, 1)
    else index += 1
  }
}

function enqueue(job) {
  job.queuedAt = Date.now()
  job.queueTimer = setTimeout(() => {
    const index = queue.indexOf(job)
    if (index < 0) return
    queue.splice(index, 1)
    job.json(200, { ok: false, error: 'queue_timeout', durationMs: 0, queueWaitMs: Date.now() - job.queuedAt })
  }, QUEUE_TTL_MS)
  job.queueTimer.unref()
  queue.push(job)
}

const settingsCache = { mtimeMs: null, text: '' }
function readSettingsTemplate() {
  const stat = statSync(SETTINGS_FILE)
  if (settingsCache.mtimeMs !== stat.mtimeMs) {
    settingsCache.text = readFileSync(SETTINGS_FILE, 'utf8')
    settingsCache.mtimeMs = stat.mtimeMs
  }
  return settingsCache.text
}
function writeFileIfChanged(file, content) {
  let current = null
  try {
    const stat = lstatSync(file)
    if (stat.isSymbolicLink()) rmSync(file, { force: true })
    else if (stat.isFile() && stat.size <= MAX_TASK_CHARS * 4) current = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (current === content) return
  rmSync(file, { recursive: true, force: true })
  writeFileSync(file, content, { flag: 'wx', mode: 0o600 })
}

function removeUntrustedLink(path) {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isDirectory()) rmSync(path, { recursive: true, force: true })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

function readStationIdentityState(create = false) {
  const directory = `${WORK}/.runtime-security`
  const registry = `${directory}/station-uids.json`
  if (create) {
    removeUntrustedLink(directory)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
  }
  let state = { nextUid: STATION_UID_MIN, stations: {} }
  try {
    if (lstatSync(registry).isSymbolicLink()) throw new Error('station_identity_registry_invalid')
    const parsed = JSON.parse(readFileSync(registry, 'utf8'))
    if (!parsed || !Number.isSafeInteger(parsed.nextUid) || parsed.nextUid < STATION_UID_MIN
        || !parsed.stations || typeof parsed.stations !== 'object' || Array.isArray(parsed.stations)
        || Object.values(parsed.stations).some((uid) => !Number.isSafeInteger(uid) || uid < STATION_UID_MIN || uid > STATION_UID_MAX)) {
      throw new Error('station_identity_registry_invalid')
    }
    state = parsed
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    if (!create) return null
  }
  return { state, registry }
}
function writeStationIdentityState(state, registry) {
  const temporary = `${registry}.tmp`
  writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: 'w' })
  renameSync(temporary, registry)
}
function allocateStationIdentity(station) {
  const bundle = readStationIdentityState(true)
  const { state, registry } = bundle
  const existing = Number(state.stations[station])
  if (Number.isSafeInteger(existing) && existing >= STATION_UID_MIN) return { uid: existing, gid: existing }
  const used = new Set(Object.values(state.stations))
  let uid = Number(state.nextUid)
  while (used.has(uid) && uid <= STATION_UID_MAX) uid += 1
  if (!Number.isSafeInteger(uid) || uid < STATION_UID_MIN || uid > STATION_UID_MAX) throw new Error('station_identity_exhausted')
  state.stations[station] = uid
  let nextUid = uid + 1
  while (used.has(nextUid) && nextUid <= STATION_UID_MAX) nextUid += 1
  state.nextUid = nextUid
  writeStationIdentityState(state, registry)
  return { uid, gid: uid }
}
function releaseStationIdentity(station) {
  const bundle = readStationIdentityState(false)
  if (!bundle) return
  const { state, registry } = bundle
  const existing = Number(state.stations[station])
  if (!Number.isSafeInteger(existing) || existing < STATION_UID_MIN || existing > STATION_UID_MAX) return
  delete state.stations[station]
  state.nextUid = Math.min(state.nextUid, existing)
  writeStationIdentityState(state, registry)
}
function copyMaterializedTree(source, destination) {
  const allowedRoot = realpathSync(DSH_HOME)
  const ancestors = new Set()
  function assertAllowed(real) {
    if (real !== allowedRoot && !real.startsWith(`${allowedRoot}/`)) throw new Error('shared_modules_link_escape')
  }
  function copyDirectory(current, target) {
    const realCurrent = realpathSync(current)
    assertAllowed(realCurrent)
    if (ancestors.has(realCurrent)) throw new Error('shared_modules_link_cycle')
    ancestors.add(realCurrent)
    mkdirSync(target, { recursive: true })
    for (const entry of readdirSync(realCurrent, { withFileTypes: true })) {
      const sourceEntry = `${realCurrent}/${entry.name}`
      const targetEntry = `${target}/${entry.name}`
      const realEntry = realpathSync(sourceEntry)
      assertAllowed(realEntry)
      const stat = statSync(realEntry)
      if (stat.isDirectory()) copyDirectory(realEntry, targetEntry)
      else if (stat.isFile()) copyFileSync(realEntry, targetEntry)
      else throw new Error('shared_modules_non_regular')
    }
    ancestors.delete(realCurrent)
  }
  copyDirectory(source, destination)
}

let sharedModulesReady = ''
function chmodDirectoryNoFollow(directory, mode) {
  const before = lstatSync(directory)
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('station_directory_invalid')
  const fd = openSync(directory, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_DIRECTORY || 0))
  try {
    const stat = fstatSync(fd)
    if (!stat.isDirectory() || stat.dev !== before.dev || stat.ino !== before.ino) throw new Error('station_directory_changed')
    fchmodSync(fd, mode)
  } finally { closeSync(fd) }
}
function hardenSharedTreeReadOnly(root) {
  const stat = lstatSync(root)
  if (stat.isSymbolicLink()) throw new Error('shared_modules_link_escape')
  if (stat.isDirectory()) {
    for (const entry of readdirSync(root)) hardenSharedTreeReadOnly(`${root}/${entry}`)
    lchownSync(root, 0, 0)
    chmodSync(root, 0o555)
  } else if (stat.isFile()) {
    lchownSync(root, 0, 0)
    chmodSync(root, 0o444)
  } else throw new Error('shared_modules_not_regular')
}

function sharedHeadlessModules() {
  if (sharedModulesReady) return sharedModulesReady
  const source = `${DSH_HOME}/profiles/headless/node_modules`
  if (!existsSync(source)) return ''
  const target = `${WORK}/.runtime-shared/headless-node_modules`
  if (existsSync(`${target}/numx-task-provider/cordis.patch.yml`)) {
    sharedModulesReady = target
    return target
  }
  const temporary = `${target}.tmp-${process.pid}`
  rmSync(temporary, { recursive: true, force: true })
  removeUntrustedLink(`${WORK}/.runtime-shared`)
  mkdirSync(`${WORK}/.runtime-shared`, { recursive: true })
  try {
    copyMaterializedTree(source, temporary)
    cpSync(TASK_PROVIDER_DIR, `${temporary}/numx-task-provider`, { recursive: true })
    hardenSharedTreeReadOnly(temporary)
    rmSync(target, { recursive: true, force: true })
    renameSync(temporary, target)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
  sharedModulesReady = target
  return target
}

sharedHeadlessModules() // 启动期预热，避免首个任务同步复制依赖而阻塞健康检查与队列。

function prepareStationProfile(stationHome, mode) {
  if (CAN_DROP_PRIVILEGES) removeUntrustedLink(`${stationHome}/.dsh/storages`)
  mkdirSync(`${stationHome}/.dsh/storages`, { recursive: true })
  const sourceProfile = `${DSH_HOME}/profiles/headless`
  const profilesRoot = `${stationHome}/.dsh/profiles`
  const targetProfile = `${profilesRoot}/headless`
  if (CAN_DROP_PRIVILEGES) rmSync(profilesRoot, { recursive: true, force: true })
  else {
    // 非 root 无降权边界：仅复用本工位独立副本，绝不跨工位共享可写模块。
    removeUntrustedLink(profilesRoot)
    removeUntrustedLink(targetProfile)
  }
  mkdirSync(targetProfile, { recursive: true })
  for (const file of ['cordis.yml', 'package.json', 'pnpm-workspace.yaml']) {
    const source = `${sourceProfile}/${file}`
    const target = `${targetProfile}/${file}`
    if (existsSync(source)) writeFileIfChanged(target, readFileSync(source, 'utf8'))
  }
  const installedPatch = existsSync(`${sourceProfile}/cordis.patch.yml`) ? readFileSync(`${sourceProfile}/cordis.patch.yml`, 'utf8') : '# NumX profile patch\n'
  const taskPatch = readFileSync(TASK_PROVIDER_PATCH, 'utf8')
  if (mode === 'life') validateLifeToolPatch(installedPatch, taskPatch)
  writeFileIfChanged(`${targetProfile}/cordis.patch.yml`, `${installedPatch}\n${taskPatch}`)
  // 共享缓存只作复制源；root 子进程用只读链接，非 root 每工位仅首次复制自己的独立副本。
  const sourceModules = sharedHeadlessModules()
  const targetModules = `${targetProfile}/node_modules`
  if (!CAN_DROP_PRIVILEGES) removeUntrustedLink(targetModules)
  if (sourceModules && existsSync(sourceModules) && !existsSync(targetModules)) {
    if (CAN_DROP_PRIVILEGES) symlinkSync(sourceModules, targetModules, 'dir')
    else cpSync(sourceModules, targetModules, { recursive: true })
  }
}
function chownStationTree(root, identity) {
  const stat = lstatSync(root)
  if (stat.isSymbolicLink()) return
  lchownSync(root, identity.uid, identity.gid)
  if (!stat.isDirectory()) return
  for (const entry of readdirSync(root)) chownStationTree(`${root}/${entry}`, identity)
}

function runTask(job) {
  const { task, timeoutSec, factoryId, modelOverride, stationKey, mode } = job
  const startedAt = Date.now()
  const station = stationKey
    ? `${WORK}/stations/persist-${factoryId}-${stationKey}`
    : `${WORK}/stations/${startedAt}-${Math.random().toString(36).slice(2, 8)}`
  job.station = station
  activeStations.add(station)
  const stationIdentity = CAN_DROP_PRIVILEGES ? allocateStationIdentity(station) : null
  if (CAN_DROP_PRIVILEGES) {
    removeUntrustedLink(`${WORK}/stations`)
    mkdirSync(`${WORK}/stations`, { recursive: true })
    chmodDirectoryNoFollow(`${WORK}/stations`, 0o711)
  }
  mkdirSync(station, { recursive: true })
  touchStation(station)

  const stationHome = `${station}/.home`
  if (CAN_DROP_PRIVILEGES) {
    removeUntrustedLink(stationHome)
    removeUntrustedLink(`${stationHome}/.dsh`)
    removeUntrustedLink(`${stationHome}/.dsh/sessions`)
  }
  mkdirSync(`${stationHome}/.dsh/sessions`, { recursive: true })
  const source = readSettingsTemplate()
  const modelPattern = /(agent-default-model:\n  provider: [^\n]+\n  model: )[^\n]+/
  if (modelOverride && !modelPattern.test(source)) throw new Error('model_override_unavailable')
  const providerPattern = /(agent-default-model:\n  provider: )[^\n]+/
  let patched = source
  if (modelOverride === 'kimi-k3') {
    if (!providerPattern.test(source)) throw new Error('model_override_unavailable')
    patched = patched.replace(providerPattern, '$1moonshotai-cn')
  }
  patched = modelOverride ? patched.replace(modelPattern, `$1${modelOverride}`) : patched
  writeFileIfChanged(`${stationHome}/.dsh/settings.yaml`, patched)
  writeFileIfChanged(`${stationHome}/task.txt`, task)
  prepareStationProfile(stationHome, mode)
  if (CAN_DROP_PRIVILEGES) {
    chownStationTree(station, stationIdentity)
    chmodDirectoryNoFollow(station, 0o700)
  }

  const args = CAN_DROP_PRIVILEGES
    ? ['--clear-groups', '--reuid', String(stationIdentity.uid), '--regid', String(stationIdentity.gid), '--', NODE, CLI, '--profile', 'headless']
    : [CLI, '--profile', 'headless']
  if (mode === 'life') args.push('--patch', LIFE_PATCH)
  const child = spawn(CAN_DROP_PRIVILEGES ? SETPRIV : NODE, args, {
    cwd: station,
    env: childEnvironment(factoryId, stationHome),
    detached: process.platform !== 'win32',
  })
  job.child = child
  let out = ''
  let err = ''
  let outputTruncated = false
  let settled = false
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (data) => {
    if (out.length < MAX_OUTPUT_BUFFER_CHARS) {
      out += data
      if (out.length > MAX_OUTPUT_BUFFER_CHARS) {
        outputTruncated = true
        out = out.slice(0, MAX_OUTPUT_BUFFER_CHARS)
      }
    } else outputTruncated = true
  })
  child.stderr?.on('data', (data) => { err += data; if (err.length > MAX_ERROR_CHARS) err = err.slice(-MAX_ERROR_CHARS) })
  job.timeoutTimer = setTimeout(() => terminate(job, true), timeoutSec * 1000)
  job.timeoutTimer.unref()

  const done = (code, spawnFailed = false, signal = null) => {
    if (settled) return
    settled = true
    clearTimeout(job.timeoutTimer)
    clearTimeout(job.killTimer)
    release(job)
    activeStations.delete(station)
    if (!stationKey) rmStation(station)
    else touchStation(station)
    const durationMs = Date.now() - startedAt
    const queueWaitMs = job.queuedAt ? startedAt - job.queuedAt : 0
    const answer = clipGraphemes(out.trim(), MAX_OUTPUT_CHARS)
    let payload
    if (job.timedOut) payload = { ok: false, error: 'timeout', durationMs, queueWaitMs }
    else if (spawnFailed) payload = { ok: false, error: 'spawn_failed', durationMs, queueWaitMs }
    else if (code === 0) payload = { ok: true, answer: answer.text, truncated: outputTruncated || answer.truncated, durationMs, queueWaitMs }
    else payload = { ok: false, error: `exit_${code ?? signal ?? 'unknown'}`, durationMs, queueWaitMs }
    try { job.json(200, payload) } finally { queueMicrotask(drainQueue) }
  }
  child.once('error', (error) => {
    const code = String(error?.code || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'unknown'
    console.error(`dsh-runtime spawn_error: ${code}`)
    done(null, true)
  })
  child.once('close', (code, signal) => done(code, false, signal))
}

async function readRequestBody(req, res) {
  const socket = req.socket
  const timer = setTimeout(() => socket.destroy(), READ_TIMEOUT_MS)
  const chunks = []
  let size = 0
  let oversized = false
  function rejectBody() {
    res.setHeader('connection', 'close')
    sendJson(res, 413, { ok: false, error: 'body_too_large', maxBytes: MAX_BODY_BYTES })
    socket.end()
    setTimeout(() => { if (!socket.destroyed) socket.destroy() }, 2000).unref()
    return null
  }
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    clearTimeout(timer)
    return rejectBody()
  }
  try {
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) { oversized = true; continue }
      chunks.push(chunk)
    }
  } finally { clearTimeout(timer) }
  if (!oversized) return Buffer.concat(chunks)
  return rejectBody()
}

async function handleRequest(req, res) {
  const json = (status, payload) => sendJson(res, status, payload)
  if (shuttingDown) return json(503, { ok: false, error: 'shutting_down' })
  if (req.url === '/healthz') {
    const payload = { ok: true }
    if (hasValidServiceToken(req)) Object.assign(payload, { running, queued: queue.length })
    if (sandboxHealthy !== null) payload.sandbox = sandboxHealthy ? 'listening' : 'degraded'
    return json(200, payload)
  }
  if (req.method !== 'POST' || req.url !== '/run') return json(404, { ok: false, error: 'not_found' })
  if (!hasValidServiceToken(req)) return json(401, { ok: false, error: 'unauthorized' })
  const body = await readRequestBody(req, res)
  if (body === null) return
  if (shuttingDown) return json(503, { ok: false, error: 'shutting_down' })

  let task = ''
  let timeoutSec = 240
  let factoryId = 0
  let modelOverride = ''
  let stationKey = ''
  let mode = 'work'
  try {
    const input = JSON.parse(body.toString('utf8'))
    task = String(input.task ?? '')
    if (task.length > MAX_TASK_CHARS) return json(413, { ok: false, error: 'task_too_long', maxChars: MAX_TASK_CHARS })
    timeoutSec = Math.min(Math.max(Number(input.timeoutSec) || 240, MIN_TIMEOUT_SEC), MAX_TIMEOUT_SEC)
    factoryId = parseFactoryId(input.factoryId ?? 0, { allowZero: true })
    if (factoryId === null) return json(400, { ok: false, error: 'invalid_factory_id' })
    const override = String(input.modelOverride ?? '').trim()
    if (override && !/^[a-z0-9][a-z0-9.:\-_]{1,63}$/i.test(override)) return json(400, { ok: false, error: 'invalid_model_override' })
    if (override) modelOverride = override
    const station = String(input.stationKey ?? '').trim()
    if (station && !/^[a-z0-9][a-z0-9\-_]{0,63}$/i.test(station)) return json(400, { ok: false, error: 'invalid_station_key' })
    if (station) stationKey = station
    if (input.mode !== undefined && input.mode !== 'work' && input.mode !== 'life') return json(400, { ok: false, error: 'invalid_mode' })
    mode = input.mode || 'work'
    if ((mode === 'life') !== (factoryId === 0)) return json(400, { ok: false, error: 'invalid_mode_scope' })
  } catch { return json(400, { ok: false, error: 'bad_json' }) }
  if (!task.trim()) return json(400, { ok: false, error: 'empty_task' })

  const job = { task, timeoutSec, factoryId, modelOverride, stationKey, mode, json, queuedAt: 0, cancelled: false }
  res.on('close', () => {
    if (res.writableEnded) return
    job.cancelled = true
    clearTimeout(job.queueTimer)
    terminate(job, false)
    const index = queue.indexOf(job)
    if (index >= 0) queue.splice(index, 1)
  })
  if (!tryStart(job)) {
    if (job.cancelled) return
    if (queue.length >= MAX_QUEUE) return json(429, { ok: false, error: 'busy_queued', queued: queue.length })
    enqueue(job)
  }
}

const stationSweepTimer = setInterval(sweepStations, STATION_SWEEP_INTERVAL_MS)
stationSweepTimer.unref()
sweepStations()

function createRuntimeHandler() {
  return (req, res) => {
    res.on('error', () => { /* 客户端断连不拖垮常驻服务 */ })
    handleRequest(req, res).catch((error) => {
      console.error(`dsh-runtime handler_error: ${String(error?.code || 'unknown')}`)
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'runtime_error' })
      else if (!res.writableEnded) res.end()
    })
  }
}

const server = createServer(createRuntimeHandler())
server.on('error', (error) => { console.error(`dsh-runtime loopback listen error: ${String(error?.code || 'unknown')}`); process.exit(1) })
server.listen(LOOPBACK_PORT, '127.0.0.1', () => console.log(`dsh-runtime on 127.0.0.1:${LOOPBACK_PORT}`))

if (!SANDBOX_LISTENER_DISABLED) {
  server2 = createServer(createRuntimeHandler())
  server2.on('error', (error) => {
    sandboxHealthy = false
    console.error(`dsh-runtime sandbox listen error: ${String(error?.code || 'unknown')}`)
  })
  server2.listen(SANDBOX_PORT, SANDBOX_HOST, () => {
    sandboxHealthy = true
    console.log(`dsh-runtime sandbox on ${SANDBOX_HOST}:${SANDBOX_PORT}`)
  })
}

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  clearInterval(stationSweepTimer)
  while (queue.length) {
    const job = queue.shift()
    clearTimeout(job.queueTimer)
    job.json(503, { ok: false, error: 'shutting_down' })
  }
  for (const job of activeJobs) terminate(job, false)
  server.close()
  server2?.close()
  setTimeout(() => {
    for (const job of activeJobs) signalProcessGroup(job.child, 'SIGKILL')
  }, KILL_GRACE_MS)
  setTimeout(() => process.exit(0), activeJobs.size ? KILL_GRACE_MS + 200 : 50)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
