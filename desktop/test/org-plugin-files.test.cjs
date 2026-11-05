const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const manifest = require('../scripts/org-plugin-files.cjs')

test('org 清单：文件、非 org 排除路径与当前依赖闭包均可执行校验', () => {
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0)
  for (const relative of manifest.files) {
    assert.equal(path.isAbsolute(relative), false)
    assert.equal(relative.includes('..'), false)
    assert.doesNotMatch(relative, /\s/)
  }
  for (const required of ['src/orgPluginHost.cjs', 'src/orgRuntimeIpc.cjs', 'src/org-transport', 'src/plugins/numx-org']) {
    assert.ok(manifest.orgOnlyPaths.includes(required), required)
  }
  const closure = manifest.dependencyClosure()
  assert.deepEqual(closure.missing, [])
  for (const required of ['numx-org', '@numx/org-transport', 'superjson', 'copy-anything']) {
    assert.ok(closure.packages.includes(required), required)
    assert.equal(closure.paths[required], `node_modules/${required}/package.json`)
  }
})

test('org 清单：递归闭包、缺失依赖与非法包名都有独立测试入口', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'numx-org-closure-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const writePackage = (name, dependencies) => {
    const directory = path.join(root, 'node_modules', ...name.split('/'))
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, dependencies }))
  }
  writePackage('a', { b: '1.0.0' })
  writePackage('b', { c: '1.0.0' })
  writePackage('c', {})
  const nestedDirectory = path.join(root, 'node_modules', 'a', 'node_modules', 'nested-child')
  fs.mkdirSync(nestedDirectory, { recursive: true })
  fs.writeFileSync(path.join(nestedDirectory, 'package.json'), JSON.stringify({ name: 'nested-child', dependencies: {} }))
  assert.deepEqual(manifest.dependencyClosure({ projectRoot: root, roots: ['a'] }).packages, ['a', 'b', 'c'])
  assert.deepEqual(manifest.dependencyClosure({ projectRoot: root, roots: ['a'] }).missing, [])
  writePackage('a', { 'nested-child': '1.0.0' })
  writePackage('optional-child', {})
  writePackage('peer-child', {})
  const edgeManifest = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'a', 'package.json'), 'utf8'))
  edgeManifest.optionalDependencies = { 'optional-child': '1.0.0' }
  edgeManifest.peerDependencies = { 'peer-child': '1.0.0' }
  fs.writeFileSync(path.join(root, 'node_modules', 'a', 'package.json'), JSON.stringify(edgeManifest))
  const nestedResult = manifest.dependencyClosure({ projectRoot: root, roots: ['a'] })
  assert.deepEqual(nestedResult.packages, ['a', 'nested-child', 'peer-child'])
  assert.deepEqual(nestedResult.missing, [])
  assert.ok(nestedResult.paths['nested-child'].endsWith('node_modules/a/node_modules/nested-child/package.json'))
  assert.ok(nestedResult.packages.includes('peer-child'), 'peer 依赖必须进入运行时闭包')
  assert.equal(nestedResult.packages.includes('optional-child'), false, '可选依赖未安装不得进入运行时闭包')

  assert.deepEqual(manifest.dependencyClosure({ projectRoot: root, roots: ['missing'] }).packages, ['missing'])
  assert.deepEqual(manifest.dependencyClosure({ projectRoot: root, roots: ['missing'] }).missing, ['missing'])
  assert.throws(() => manifest.dependencyClosure({ projectRoot: root, roots: ['../escape'] }), /非法包名/)
})

test('org 清单：CLI 模式有输出，未知模式明确失败', () => {
  const script = path.join(__dirname, '..', 'scripts', 'org-plugin-files.cjs')
  for (const mode of ['files', 'org-only-paths', 'runtime-packages', 'runtime-package-paths']) {
    const result = spawnSync(process.execPath, [script, mode], { encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, 0, `${mode}: ${result.stderr}`)
    assert.ok(result.stdout.trim().length > 0, mode)
  }
  const unknown = spawnSync(process.execPath, [script, 'unknown'], { encoding: 'utf8', timeout: 10000 })
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /未知 org 清单 CLI 模式/)
})


test('org 契约：main 全量校验通过并输出稳定成功标记', () => {
  const result = spawnSync(process.execPath, ['scripts/check-org-plugin-contract.cjs'], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 20000 })
  assert.equal(result.status, 0, `${result.stdout}
${result.stderr}`)
  assert.match(result.stdout, /ORG_PLUGIN_CONTRACT_OK/)
})
