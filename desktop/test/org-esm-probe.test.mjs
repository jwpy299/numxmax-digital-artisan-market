import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'numx-esm-probe-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const packageDir = path.join(root, 'node_modules', 'test-plugin')
  fs.mkdirSync(packageDir, { recursive: true })
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
  fs.copyFileSync(fileURLToPath(new URL('../scripts/verify-org-esm.mjs', import.meta.url)), path.join(root, 'scripts', 'verify-org-esm.mjs'))
  const manifest = { name: 'test-plugin', type: 'module', exports: { '.': { import: './esm.mjs', require: './cjs.cjs' } } }
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify(manifest))
  fs.writeFileSync(path.join(packageDir, 'esm.mjs'), 'export function apply() {}\n')
  return { root, packageDir, manifest }
}

test('ESM 探针：exports.import 可用且不要求 require 条件', async (t) => {
  const { root, packageDir, manifest } = fixture(t)
  const previousAsarRoot = process.env.RUN_TMP_ASAR
  t.after(() => {
    if (previousAsarRoot === undefined) delete process.env.RUN_TMP_ASAR
    else process.env.RUN_TMP_ASAR = previousAsarRoot
  })
  const { importPlugin, resolveEsmEntry } = await import(pathToFileURL(path.join(root, 'scripts', 'verify-org-esm.mjs')).href)
  process.env.RUN_TMP_ASAR = root
  const plugin = await importPlugin(packageDir, 'test-plugin')
  assert.equal(typeof plugin.apply, 'function')
  manifest.exports = { '.': { node: './esm.mjs' } }
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify(manifest))
  assert.equal(resolveEsmEntry(packageDir, 'test-plugin'), fs.realpathSync(path.join(packageDir, 'esm.mjs')))
  delete manifest.exports
  manifest.main = './esm.mjs'
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify(manifest))
  assert.equal(resolveEsmEntry(packageDir, 'test-plugin'), fs.realpathSync(path.join(packageDir, 'esm.mjs')))
  await assert.rejects(importPlugin(path.join(root, 'missing-package'), 'missing-package'), /包目录缺失/)
  manifest.exports = { '.': { require: './cjs.cjs' } }
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify(manifest))
  assert.throws(() => resolveEsmEntry(packageDir, 'test-plugin'), /test-plugin ESM 入口缺失/)
})

test('ESM 探针：相对路径直接执行也能完成真实 ESM 校验', async (t) => {
  const { root } = fixture(t)
  const orgDir = path.join(root, 'node_modules', 'numx-org', 'lib')
  fs.mkdirSync(orgDir, { recursive: true })
  fs.writeFileSync(path.join(orgDir, 'index.js'), 'export function apply() {}\n')
  fs.writeFileSync(path.join(orgDir, '..', 'package.json'), JSON.stringify({ name: 'numx-org', type: 'module', main: 'lib/index.js' }))
  const childEnv = { ...process.env, RUN_TMP_ASAR: root }
  delete childEnv.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, ['scripts/verify-org-esm.mjs'], { cwd: root, encoding: 'utf8', timeout: 10000, env: childEnv })
  assert.equal(result.status, 0, `${result.stdout}
${result.stderr}`)
  assert.match(result.stdout, /ORG_ESM_OK/)
})

test('ESM 探针：入口越出包目录与直接执行缺根目录均 fail-closed', async (t) => {
  const { root, packageDir, manifest } = fixture(t)
  const previousAsarRoot = process.env.RUN_TMP_ASAR
  t.after(() => {
    if (previousAsarRoot === undefined) delete process.env.RUN_TMP_ASAR
    else process.env.RUN_TMP_ASAR = previousAsarRoot
  })
  manifest.exports = '../outside.mjs'
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify(manifest))
  fs.writeFileSync(path.join(root, 'node_modules', 'outside.mjs'), 'export function apply() {}\n')
  process.env.RUN_TMP_ASAR = root
  const { importPlugin } = await import(pathToFileURL(path.join(root, 'scripts', 'verify-org-esm.mjs')).href)
  await assert.rejects(importPlugin(packageDir, 'test-plugin'), /ESM 入口越界/)
  const childEnv = { ...process.env }
  delete childEnv.RUN_TMP_ASAR
  delete childEnv.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/verify-org-esm.mjs', import.meta.url))], { encoding: 'utf8', timeout: 10000, env: childEnv })
  assert.equal(result.status, 1)
  assert.match(`${result.stdout}
${result.stderr}`, /org_asar_root_required/)
})

test('ESM 探针：包目录 realpath 跳出 asar 时 fail-closed', async (t) => {
  if (process.platform === 'win32') { t.skip('Windows 符号链接权限由打包主机单独验证'); return }
  const { root, packageDir, manifest } = fixture(t)
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'numx-esm-external-'))
  t.after(() => fs.rmSync(external, { recursive: true, force: true }))
  fs.renameSync(packageDir, external)
  fs.mkdirSync(path.dirname(packageDir), { recursive: true })
  fs.symlinkSync(external, packageDir, 'dir')
  fs.writeFileSync(path.join(external, 'package.json'), JSON.stringify(manifest))
  const previousAsarRoot = process.env.RUN_TMP_ASAR
  t.after(() => {
    if (previousAsarRoot === undefined) delete process.env.RUN_TMP_ASAR
    else process.env.RUN_TMP_ASAR = previousAsarRoot
  })
  process.env.RUN_TMP_ASAR = root
  const { importPlugin } = await import(pathToFileURL(path.join(root, 'scripts', 'verify-org-esm.mjs')).href)
  await assert.rejects(importPlugin(packageDir, 'test-plugin'), /包目录解析到 asar 之外/)
})
