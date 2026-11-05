const fs = require('node:fs')
const path = require('node:path')

const files = [
  'scripts/lib/walk-files.cjs',
  'scripts/org-plugin-files.cjs',
  'scripts/check-org-plugin-contract.cjs',
  'scripts/sync-org-ui-assets.cjs',
  'scripts/verify-org-esm.mjs',
  'src/apiAllowlist.cjs',
  'src/orgPluginHost.cjs',
  'src/orgRuntimeIpc.cjs',
  'src/plugins/numx-org-runtime/manifest.json',
  'src/plugins/numx-org-runtime/index.cjs',
  'src/plugins/numx-org/package.json',
  'src/plugins/numx-org/cordis.patch.yml',
  'src/plugins/numx-org/cordis.desktop.patch.yml',
  'src/plugins/numx-org/contracts/orgPlugin.v1.json',
  'src/plugins/numx-org/lib/index.js',
  'src/plugins/numx-org/lib/approval.js',
  'src/plugins/numx-org/lib/lifecycle.js',
  'src/plugins/numx-org/lib/tools.js',
  'src/plugins/numx-org/lib/client.js',
  'src/plugins/numx-org/lib/contract.js',
  'src/plugins/numx-org/lib/session.js',
  'src/plugins/numx-org/lib/transport-loader.js',
  'src/plugins/numx-org/lib/ui-routes.js',
  'src/plugins/numx-org/ui/ui.js',
  'src/plugins/numx-org/ui/ui.css',
  'src/plugins/numx-org/ui/org/index.html',
  'src/plugins/numx-org/ui/org/cabin.html',
  'src/plugins/numx-org/ui/org/station.html',
  'src/plugins/numx-org/ui/org/org-boot.js',
  'src/plugins/numx-org/ui/ui-manifest.json',
  'src/org-transport/package.json',
  'src/org-transport/index.cjs',
]

// 部门插件可选安装；一旦源目录存在，就必须完整声明并接受 src/plugins 全量反漂移核对。
const financeRoot = path.join(__dirname, '..', 'src/plugins/dept-finance')
const hasFinancePlugin = fs.existsSync(financeRoot) && fs.lstatSync(financeRoot).isDirectory() && !fs.lstatSync(financeRoot).isSymbolicLink()
const financeFiles = [
  'src/plugins/dept-finance/package.json',
  'src/plugins/dept-finance/cordis.patch.yml',
  'src/plugins/dept-finance/manifest.json',
  'src/plugins/dept-finance/lib/index.js',
  'src/plugins/dept-finance/lib/manifest.js',
  'src/plugins/dept-finance/lib/tools.js',
]
if (hasFinancePlugin) files.push(...financeFiles)


const runtimeRoots = ['numx-org', '@numx/org-transport']
if (hasFinancePlugin) runtimeRoots.push('dept-finance')

const orgOnlyPaths = [...new Set(files.map((relative) => {
  if (relative.startsWith('src/plugins/')) return relative.split('/').slice(0, 3).join('/')
  if (relative.startsWith('src/org-transport/')) return 'src/org-transport'
  if (/^src\/org[^/]*$/.test(relative)) return relative
  return null
}).filter(Boolean))].sort()

const PACKAGE_NAME = /^(?:@[a-zA-Z0-9][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/
function dependencyClosure({ projectRoot = path.join(__dirname, '..'), roots = runtimeRoots } = {}) {
  const packages = new Set()
  const missing = new Set()
  const paths = {}
  function directManifest(name, parentManifest) {
    const candidates = []
    if (parentManifest) candidates.push(path.join(path.dirname(parentManifest), 'node_modules', ...name.split('/'), 'package.json'))
    candidates.push(path.join(projectRoot, 'node_modules', ...name.split('/'), 'package.json'))
    return candidates.find((candidate) => fs.existsSync(candidate)) || null
  }

  function resolveManifest(name, parentManifest) {
    const direct = directManifest(name, parentManifest)
    if (direct) return direct
    const resolvePaths = parentManifest ? [path.dirname(parentManifest), projectRoot] : [projectRoot]
    try { return require.resolve(`${name}/package.json`, { paths: resolvePaths }) } catch {}
    const entry = require.resolve(name, { paths: resolvePaths })
    let directory = path.dirname(entry)
    while (directory !== path.dirname(directory)) {
      const candidate = path.join(directory, 'package.json')
      if (fs.existsSync(candidate)) {
        const value = JSON.parse(fs.readFileSync(candidate, 'utf8'))
        if (value.name === name) return candidate
      }
      directory = path.dirname(directory)
    }
    throw new Error(`org 运行依赖 package.json 未找到：${name}`)
  }
  function visit(name, parentManifest) {
    if (!PACKAGE_NAME.test(name)) throw new Error(`org 运行依赖包含非法包名：${name}`)
    if (packages.has(name)) return
    packages.add(name)
    let manifest
    try { manifest = resolveManifest(name, parentManifest) } catch { missing.add(name); return }
    const relative = path.relative(projectRoot, manifest)
    paths[name] = (relative.startsWith('..') ? `node_modules/${name}/package.json` : relative).split(path.sep).join('/')
    const value = JSON.parse(fs.readFileSync(manifest, 'utf8'))
    const runtimeDependencies = {
      ...(value.dependencies || {}),
      ...(value.peerDependencies || {}),
    }
    for (const dependency of Object.keys(runtimeDependencies).sort()) visit(dependency, manifest)
  }
  for (const root of roots) visit(root)
  return { packages: [...packages].sort(), missing: [...missing].sort(), paths }
}

function emit(values) {
  if (!Array.isArray(values) || !values.length || values.some((value) => typeof value !== 'string' || !value || value.startsWith('/') || value.includes('..') || /\s/.test(value))) {
    throw new Error('org 清单 CLI 输出为空或含非法路径')
  }
  process.stdout.write(values.join(' '))
}

module.exports = Object.freeze({ files, runtimeRoots, orgOnlyPaths, dependencyClosure })

if (require.main === module) {
  const mode = process.argv[2]
  if (mode === 'files') emit(files)
  else if (mode === 'org-only-paths') emit(orgOnlyPaths)
  else if (mode === 'runtime-packages') emit(dependencyClosure().packages)
  else if (mode === 'runtime-package-paths') emit(Object.values(dependencyClosure().paths))
  else throw new Error(`未知 org 清单 CLI 模式：${mode}`)
}
