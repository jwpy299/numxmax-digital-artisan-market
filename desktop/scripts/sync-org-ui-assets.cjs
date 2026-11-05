#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { walkFiles } = require('./lib/walk-files.cjs')

const DEFAULT_SOURCE = process.env.ORG_UI_SOURCE || (process.env.WB ? `${process.env.WB}/public/org` : '')
const DESTINATION = path.join(__dirname, '..', 'src', 'plugins', 'numx-org', 'ui')
const MANIFEST_PATH = path.join(DESTINATION, 'ui-manifest.json')
const SOURCE_FILES = ['index.html', 'cabin.html', 'station.html', 'org-boot.js']
const LOCAL_FILES = ['ui.js', 'ui.css']
const REQUIRED = [...SOURCE_FILES, ...LOCAL_FILES]

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function readManifest() {
  const value = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.sourceHead !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.sourceHead)
      || !value.files || typeof value.files !== 'object' || Array.isArray(value.files)) {
    throw new Error('org UI 清单结构无效')
  }
  for (const [relative, hash] of Object.entries(value.files)) {
    if (!/^[a-zA-Z0-9._-]+$/.test(relative) || relative.includes('..') || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error(`org UI 清单条目无效：${relative}`)
    }
  }
  return value
}

function destinationFile(relative) {
  return SOURCE_FILES.includes(relative) ? path.join(DESTINATION, 'org', relative) : path.join(DESTINATION, relative)
}

function validateFiles(root, files) {
  const actual = walkFiles(root).map((file) => path.relative(root, file).split(path.sep).join('/')).sort()
  const expected = [...files].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`org UI 文件清单不一致：${actual.join(',')} != ${expected.join(',')}`)
  }
}

function assertPlainDestination() {
  for (const directory of [DESTINATION, path.join(DESTINATION, 'org')]) {
    if (fs.existsSync(directory) && (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink())) {
      throw new Error(`org UI 目标目录不是普通目录：${directory}`)
    }
  }
  for (const relative of [...REQUIRED, 'ui-manifest.json']) {
    const file = relative === 'ui-manifest.json' ? MANIFEST_PATH : destinationFile(relative)
    if (fs.existsSync(file) && !fs.lstatSync(file).isFile()) throw new Error(`org UI 目标不是普通文件：${file}`)
  }
}

function validateLocalFiles() {
  for (const relative of LOCAL_FILES) {
    const file = destinationFile(relative)
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) throw new Error(`org UI 本地文件缺失：${relative}`)
  }
}

function assertSourceClean(source) {
  const { execFileSync } = require('node:child_process')
  let dirty
  try {
    dirty = execFileSync('git', ['-C', source, 'status', '--porcelain', '--', '.'], { encoding: 'utf8' }).trim()
  } catch (error) {
    if (/not a git repository/i.test(error.message)) throw new Error('org UI 源目录不是 git 工作树，禁止同步')
    throw error
  }
  if (dirty) throw new Error('org UI 源工作树有未提交改动，禁止同步')
}

function assertNoUnexpectedDestinationFiles() {
  if (!fs.existsSync(DESTINATION)) return
  const allowed = new Set(['ui-manifest.json', ...LOCAL_FILES, ...SOURCE_FILES.map((file) => `org/${file}`)])
  const unexpected = walkFiles(DESTINATION).filter((file) => !allowed.has(path.relative(DESTINATION, file).split(path.sep).join('/')))
  if (unexpected.length) throw new Error(`org UI 目标目录含未声明文件：${unexpected.map((file) => path.relative(DESTINATION, file)).join(',')}`)
}

function sourceHead(source) {
  const { execFileSync } = require('node:child_process')
  const head = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head)) throw new Error('org UI 源提交格式无效')
  return head
}

function rehashLocal() {
  assertPlainDestination()
  validateLocalFiles()
  const manifest = readManifest()
  for (const relative of SOURCE_FILES) {
    if (manifest.files?.[relative] !== sha256(destinationFile(relative))) {
      throw new Error(`org UI HTML 已漂移，须先从源仓同步：${relative}`)
    }
  }
  for (const relative of LOCAL_FILES) manifest.files[relative] = sha256(destinationFile(relative))
  manifest.files = Object.fromEntries(REQUIRED.map((relative) => [relative, manifest.files[relative]]))
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log('ORG_UI_LOCAL_HASHES_OK')
}

function sync(source, { checkOnly = false } = {}) {
  if (!source) throw new Error('org UI 源目录未配置：请设置 ORG_UI_SOURCE 或 WB')
  if (!fs.existsSync(source) || !fs.lstatSync(source).isDirectory()) throw new Error(`org UI 源目录不存在：${source}`)
  validateFiles(source, SOURCE_FILES)
  assertSourceClean(source)
  assertPlainDestination()
  validateLocalFiles()
  if (checkOnly) {
    assertNoUnexpectedDestinationFiles()
    const manifest = readManifest()
    const manifestKeys = Object.keys(manifest.files).sort()
    if (JSON.stringify(manifestKeys) !== JSON.stringify([...REQUIRED].sort())) {
      throw new Error(`org UI 清单文件集合无效：${manifestKeys.join(',')}`)
    }
    const head = sourceHead(source)
    if (manifest.sourceHead !== head) throw new Error(`org UI 源提交已漂移：${manifest.sourceHead} != ${head}`)
    validateFiles(path.join(DESTINATION, 'org'), SOURCE_FILES)
    for (const relative of REQUIRED) {
      const file = destinationFile(relative)
      const actual = sha256(file)
      if (manifest.files?.[relative] !== actual) throw new Error(`org UI 文件与清单不一致：${relative}`)
      if (SOURCE_FILES.includes(relative) && sha256(path.join(source, relative)) !== actual) {
        throw new Error(`org UI 源文件尚未同步：${relative}`)
      }
    }
    console.log('ORG_UI_ASSETS_OK')
    return
  }
  const head = sourceHead(source)
  assertNoUnexpectedDestinationFiles()
  fs.mkdirSync(path.join(DESTINATION, 'org'), { recursive: true })
  const files = {}
  for (const relative of SOURCE_FILES) {
    const content = fs.readFileSync(path.join(source, relative))
    const target = destinationFile(relative)
    fs.writeFileSync(target, content)
    files[relative] = sha256(target)
  }
  for (const relative of LOCAL_FILES) files[relative] = sha256(destinationFile(relative))
  validateFiles(path.join(DESTINATION, 'org'), SOURCE_FILES)
  const manifest = { sourceHead: head, files }
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`ORG_UI_ASSETS_SYNCED sourceHead=${manifest.sourceHead}`)
}

function main(args = process.argv.slice(2)) {
  let checkOnly = false
  let localOnly = false
  let source
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--check') checkOnly = true
    else if (arg === '--rehash-local') localOnly = true
    else if (arg === '--source') {
      index += 1
      if (!args[index]) throw new Error('--source 缺少源目录参数')
      source = args[index]
    } else throw new Error(`未知参数：${arg}`)
  }
  if (localOnly && (checkOnly || source)) throw new Error('--rehash-local 不得与 --check/--source 同用')
  if (localOnly) rehashLocal()
  else sync(source || DEFAULT_SOURCE, { checkOnly })
}

if (require.main === module) main()
module.exports = { sync, rehashLocal, main, destinationFile }
