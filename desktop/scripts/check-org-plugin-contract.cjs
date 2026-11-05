const fs = require('node:fs')
const crypto = require('node:crypto')
const path = require('node:path')
const { walkFiles } = require('./lib/walk-files.cjs')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
function sameArray(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  const left = [...a].sort()
  const right = [...b].sort()
  return left.every((value, index) => value === right[index])
}
function arrayDifference(a, b) {
  const right = new Set(b)
  return a.filter((value) => !right.has(value))
}
function escapeRegExp(value) {
  return String(value).replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
}
function cordisEntries(source) {
  const lines = source.split(/\r?\n/)
  const entries = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([ \t]*)- id:[ \t]+([^\s#]+)[ \t]*(?:#[^\n]*)?$/.exec(lines[index])
    if (!match) continue
    const indent = match[1].length
    let end = lines.length
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next]
      if (!line.trim()) continue
      const lineIndent = line.length - line.trimStart().length
      if (lineIndent <= indent) { end = next; break }
    }
    entries.push({ id: match[2], block: lines.slice(index, end).join('\n') })
  }
  return entries
}

function assertCordisPlugin(source, id, extraInject = '') {
  const escaped = escapeRegExp(id)
  const entries = cordisEntries(source)
  const selected = entries.filter((entry) => entry.id === id)
  assert(selected.length === 1, `${id} cordis id 声明数量必须为 1`)
  for (const [label, pattern] of [
    ['name', String.raw`^\s+name:\s+${escaped}(?:\s+#.*)?\s*$`],
    ['inject', String.raw`^\s+inject:\s*\[tools, credentials${extraInject ? `, ${escapeRegExp(extraInject)}` : ''}\](?:\s+#.*)?\s*$`],
  ]) assert(new RegExp(pattern, 'm').test(selected[0].block), `${id} cordis 有效声明缺失：${label}`)
}

async function main() {
  const manifest = require('../src/plugins/numx-org-runtime/manifest.json')
  const { files: requiredFiles, orgOnlyPaths, dependencyClosure } = require('./org-plugin-files.cjs')
  const { SHELL_API_BASE } = require('../src/apiAllowlist.cjs')
  // 直接校验运行时实际加载的契约对象，不从另一个路径常量重新推导版本文件。
  const { default: contract } = await import('../src/plugins/numx-org/lib/contract.js')
  assert(contract && contract.limits && contract.network && contract.procedures, '契约结构缺失')
  assert(Array.isArray(manifest.allowedProcedures) && manifest.allowedProcedures.length > 0, 'manifest.allowedProcedures 缺失或为空')
  assert(Array.isArray(contract.procedures.read) && contract.procedures.read.length > 0, '契约读过程缺失或为空')
  assert(Array.isArray(contract.procedures.write) && contract.procedures.write.length > 0, '契约写过程缺失或为空')
  assert(Array.isArray(contract.confirmProcedures) && contract.confirmProcedures.length > 0, 'contract.confirmProcedures 缺失或为空')
  for (const [key, value] of Object.entries(contract.limits)) {
    assert(Number.isInteger(value) && value > 0, `contract.limits.${key} 非正整数`)
  }
  assert(manifest.permissions && typeof manifest.permissions === 'object' && !Array.isArray(manifest.permissions), 'manifest.permissions 缺失或非对象')
  const sharedLimits = ['maxPayloadBytes', 'maxResponseBytes', 'maxIpcEnvelopeBytes', 'timeoutMs', 'maxConcurrentRequests']
  for (const key of sharedLimits) {
    assert(Object.hasOwn(manifest.permissions, key) && manifest.permissions[key] === contract.limits[key], `${key} 缺失或不一致：manifest=${manifest.permissions[key]} contract=${contract.limits[key]}`)
  }
  for (const [key, value] of Object.entries(manifest.permissions)) {
    if (key === 'network' || key === 'allowInsecureLoopback') continue
    assert(Object.hasOwn(contract.limits, key), `manifest.permissions 含未在契约声明的限制：${key}`)
    assert(value === contract.limits[key], `${key} 不一致：manifest=${value} contract=${contract.limits[key]}`)
  }
  assert(sameArray(manifest.permissions.network, contract.network.allowedOrigins), `网络白名单不一致：manifest=${manifest.permissions.network} contract=${contract.network.allowedOrigins}`)
  assert(typeof manifest.permissions.allowInsecureLoopback === 'boolean' && typeof contract.network.allowInsecureLoopback === 'boolean', 'allowInsecureLoopback 必须为布尔值')
  assert(manifest.permissions.allowInsecureLoopback === contract.network.allowInsecureLoopback, 'allowInsecureLoopback 不一致')
  assert(contract.network.endpoint === SHELL_API_BASE.org, `endpoint 与 org 壳 API 不一致：${contract.network.endpoint} != ${SHELL_API_BASE.org}`)
  const untrustedOrigins = contract.network.allowedOrigins.filter((origin) => origin !== SHELL_API_BASE.org)
  assert(untrustedOrigins.length === 0, `allowedOrigins 含非 org 信任域：${untrustedOrigins.join(',')}`)

  const read = contract.procedures.read
  const write = contract.procedures.write
  const readWriteProcedures = [...read, ...write]
  assert(new Set(readWriteProcedures).size === readWriteProcedures.length, '契约过程存在重复或读写重叠')
  const contractProcedures = [...new Set([...readWriteProcedures, ...contract.procedures.public])].sort()
  assert(new Set(manifest.allowedProcedures).size === manifest.allowedProcedures.length, 'manifest.allowedProcedures 存在重复')
  assert(new Set(contract.confirmProcedures).size === contract.confirmProcedures.length, 'confirmProcedures 存在重复')
  const writeProcedures = new Set(write)
  for (const procedure of contract.confirmProcedures) {
    assert(writeProcedures.has(procedure), `confirmProcedures 未在 procedures.write 中声明：${procedure}`)
  }
  for (const procedure of write) {
    assert(contract.confirmProcedures.includes(procedure), `写过程未要求确认：${procedure}`)
  }
  const missing = arrayDifference(contractProcedures, manifest.allowedProcedures)
  const extra = arrayDifference(manifest.allowedProcedures, contractProcedures)
  assert(sameArray(manifest.allowedProcedures, contractProcedures), `allowedProcedures 不一致 missing=${missing.join(',') || '-'} extra=${extra.join(',') || '-'}`)
  assert(manifest.entry === 'index.cjs', `worker entry 非预期：${manifest.entry}`)

  const root = path.join(__dirname, '..')
  const orgPackage = require('../src/plugins/numx-org/package.json')
  assert(orgPackage.name === 'numx-org' && orgPackage.type === 'module' && orgPackage.main === 'lib/index.js', 'numx-org 包名/type/main 不一致')
  assert(orgPackage.dsh?.bundle?.patch === './cordis.patch.yml', 'numx-org dsh.bundle.patch 不一致')
  const orgCordis = fs.readFileSync(path.join(root, 'src/plugins/numx-org/cordis.patch.yml'), 'utf8')
  assertCordisPlugin(orgCordis, 'numx-org', 'connection')
  const desktopCordis = fs.readFileSync(path.join(root, 'src/plugins/numx-org/cordis.desktop.patch.yml'), 'utf8')
  const desktopRows = cordisEntries(desktopCordis).filter((entry) => entry.id === 'webserver')
  assert(desktopRows.length === 1, 'DSH 桌面 webserver 声明数量必须为 1')
  const desktopRow = desktopRows[0].block
  assert(/^\s+inject:\s*\[\]\s*$/m.test(desktopRow), 'DSH 桌面 webserver 不得依赖 webStartup')
  assert(/^\s+host:\s*["']127\.0\.0\.1["']\s*$/m.test(desktopRow), 'DSH 桌面 webserver 仅允许回环地址')
  assert(/^\s+port:\s*0\s*$/m.test(desktopRow), 'DSH 桌面 webserver 仅允许随机空闲端口')
  const financeRoot = path.join(root, 'src/plugins/dept-finance')
  if (fs.existsSync(financeRoot)) {
    const financePackage = require('../src/plugins/dept-finance/package.json')
    const financeManifest = require('../src/plugins/dept-finance/manifest.json')
    assert(financePackage.name === 'dept-finance' && financePackage.type === 'module' && financePackage.main === 'lib/index.js', 'dept-finance 包名/type/main 不一致')
    assert(financePackage.dsh?.bundle?.patch === './cordis.patch.yml', 'dept-finance dsh.bundle.patch 不一致')
    assert(financeManifest.id === financePackage.name && financeManifest.entry === financePackage.main && financeManifest.version === financePackage.version, 'dept-finance manifest 与 package.json 不一致')
    const financeCordis = fs.readFileSync(path.join(financeRoot, 'cordis.patch.yml'), 'utf8')
    assertCordisPlugin(financeCordis, 'dept-finance')
    const { createTools, FINANCE_POLICIES } = await import('../src/plugins/dept-finance/lib/tools.js')
    const { assertFinanceManifest } = await import('../src/plugins/dept-finance/lib/manifest.js')
    assertFinanceManifest(createTools({ credentials: {} }), FINANCE_POLICIES)
  }
  for (const relative of requiredFiles) {
    const full = path.join(root, relative)
    assert(fs.existsSync(full) && fs.lstatSync(full).isFile(), `插件入口或依赖文件缺失/非普通文件：${relative}`)
  }
  function assertInventory(relativeRoot) {
    const actual = walkFiles(path.join(root, relativeRoot)).map((file) => path.relative(root, file).split(path.sep).join('/')).sort()
    const declared = requiredFiles.filter((file) => file.startsWith(`${relativeRoot}/`)).sort()
    const undeclared = arrayDifference(actual, declared)
    const missingFiles = arrayDifference(declared, actual)
    assert(sameArray(actual, declared), `插件文件清单漂移 undeclared=${undeclared.join(',') || '-'} missingFiles=${missingFiles.join(',') || '-'}`)
  }
  assertInventory('src/plugins')
  assertInventory('src/org-transport')
  const srcRoot = path.join(root, 'src')
  const actualOrgRootFiles = fs.readdirSync(srcRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^org/i.test(entry.name))
    .map((entry) => `src/${entry.name}`).sort()
  const declaredOrgRootFiles = requiredFiles.filter((file) => /^src\/org[^/]*$/.test(file)).sort()
  assert(sameArray(actualOrgRootFiles, declaredOrgRootFiles), `src 根 org 文件清单漂移 actual=${actualOrgRootFiles.join(',')} declared=${declaredOrgRootFiles.join(',')}`)
  for (const required of ['src/orgPluginHost.cjs', 'src/orgRuntimeIpc.cjs', 'src/org-transport', 'src/plugins/numx-org']) {
    assert(orgOnlyPaths.includes(required), `非 org 排除清单缺少：${required}`)
  }
  const closure = dependencyClosure()
  assert(closure.missing.length === 0, `org 运行依赖未安装：${closure.missing.join(',')}`)
  const builderLines = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8').split(/\r?\n/)
  const filesStart = builderLines.findIndex((line) => /^files:\s*$/.test(line))
  assert(filesStart >= 0, 'electron-builder.yml 缺少顶层 files 块')
  const filesLines = []
  for (let index = filesStart + 1; index < builderLines.length; index += 1) {
    const line = builderLines[index]
    if (/^[A-Za-z][^:]*:/.test(line)) break
    filesLines.push(line)
  }
  const nonOrgExclusions = new Set(filesLines
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim().replace(/^['"]|['"]$/g, '')))
  for (const relative of orgOnlyPaths) {
    const full = path.join(root, relative)
    const pattern = fs.existsSync(full) && fs.lstatSync(full).isFile() ? `!${relative}` : `!${relative}/**`
    assert(nonOrgExclusions.has(pattern), `electron-builder.yml 非 org 排除项缺失：${pattern}`)
  }
  for (const packagePath of Object.values(closure.paths)) {
    const pattern = `!${path.posix.dirname(packagePath)}/**`
    assert(nonOrgExclusions.has(pattern), `electron-builder.yml 非 org 依赖排除项缺失：${pattern}`)
  }
  const uiManifest = require('../src/plugins/numx-org/ui/ui-manifest.json')
  assert(uiManifest.files && typeof uiManifest.files === 'object' && !Array.isArray(uiManifest.files), 'org UI 清单 files 必须为对象')
  const uiPrefix = 'src/plugins/numx-org/ui/'
  const expectedUiEntries = requiredFiles.map((relative) => {
    if (!relative.startsWith(uiPrefix) || relative.endsWith('ui-manifest.json')) return null
    const key = relative.slice(uiPrefix.length)
    return [key.startsWith('org/') ? key.slice('org/'.length) : key, relative]
  }).filter(Boolean)
  assert(sameArray(Object.keys(uiManifest.files), expectedUiEntries.map(([key]) => key)), 'org UI 清单文件集合漂移')
  const uiPaths = new Map(expectedUiEntries)
  for (const [relative, expected] of Object.entries(uiManifest.files)) {
    assert(/^[a-zA-Z0-9._-]+$/.test(relative) && !relative.includes('..') && /^[a-f0-9]{64}$/.test(expected), `org UI 清单条目无效：${relative}`)
    const content = fs.readFileSync(path.join(root, uiPaths.get(relative)))
    const actual = crypto.createHash('sha256').update(content).digest('hex')
    assert(actual === expected, `org UI 文件哈希漂移：${relative}`)
  }
  console.log('ORG_PLUGIN_CONTRACT_OK')
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.message || error)
    process.exitCode = 1
  })
}

module.exports = { main, walkFiles, assertCordisPlugin }
