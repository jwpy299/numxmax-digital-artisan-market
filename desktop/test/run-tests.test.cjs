const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function projectFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'numx-test-runner-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true })
  fs.mkdirSync(path.join(root, 'test'))
  fs.mkdirSync(path.join(root, 'src'))
  fs.cpSync(path.join(__dirname, '..', 'scripts'), path.join(root, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(root, 'explicit.test.mjs'), "import assert from 'node:assert/strict'; assert.equal(1, 1); console.log('EXPLICIT_TEST_RAN');\n")
  return root
}

function runRunner(root, args = []) {
  const childEnv = { ...process.env }
  delete childEnv.NODE_TEST_CONTEXT
  delete childEnv.NODE_OPTIONS
  delete childEnv.NODE_V8_COVERAGE
  delete childEnv.NODE_EXTRA_CA_CERTS
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'run-tests.cjs'), ...args], { cwd: root, encoding: 'utf8', timeout: 10000, env: childEnv })
}

const output = (result) => `${result.stdout}\n${result.stderr}`

test('测试入口：test/ 下的 .test.mjs 会自动发现并执行', (t) => {
  const root = projectFixture(t)
  fs.writeFileSync(path.join(root, 'test', 'auto.test.mjs'), "console.log('AUTO_DISCOVERY_RAN');\n")
  fs.writeFileSync(path.join(root, 'test', 'auto-cjs.test.cjs'), "console.log('AUTO_CJS_DISCOVERY_RAN');\n")
  fs.writeFileSync(path.join(root, 'test', 'auto-js.test.js'), "console.log('AUTO_JS_DISCOVERY_RAN');\n")
  const result = runRunner(root)
  assert.equal(result.status, 0, output(result))
  assert.match(output(result), /AUTO_DISCOVERY_RAN/)
  assert.match(output(result), /AUTO_CJS_DISCOVERY_RAN/)
  assert.match(output(result), /AUTO_JS_DISCOVERY_RAN/)
  assert.doesNotMatch(output(result), /EXPLICIT_TEST_RAN/, '精选文件列表不得执行仓根下的非列表文件')
})

test('测试入口：不存在入口显式失败，选项值不被误认为入口', (t) => {
  const root = projectFixture(t)
  fs.writeFileSync(path.join(root, 'test', 'auto.test.mjs'), "console.log('AUTO_DISCOVERY_RAN');\n")
  const missing = runRunner(root, ['definitely-missing.test.mjs'])
  assert.equal(missing.status, 1)
  assert.match(output(missing), /测试入口不存在/)
  const withOption = runRunner(root, ['--test-reporter', 'spec'])
  const withNameOption = runRunner(root, ['--test-name-pattern', 'auto'])
  assert.equal(withOption.status, 0, output(withOption))
  assert.match(output(withOption), /AUTO_DISCOVERY_RAN/)
  assert.equal(withNameOption.status, 0, output(withNameOption))
  assert.match(output(withNameOption), /AUTO_DISCOVERY_RAN/)
})

test('测试入口：自动发现为空时显式文件仍可运行，空参数才拒绝', (t) => {
  const root = projectFixture(t)
  const explicit = runRunner(root, ['explicit.test.mjs'])
  assert.equal(explicit.status, 0, output(explicit))
  assert.match(output(explicit), /EXPLICIT_TEST_RAN/)
  const empty = runRunner(root)
  assert.equal(empty.status, 1)
  assert.match(output(empty), /拒绝以空测试集通过/)
})

test('测试入口：src/ 下存在测试文件时拒绝运行', (t) => {
  for (const suffix of ['.test.mjs', '.test.cjs', '.test.js']) {
    const root = projectFixture(t)
    fs.writeFileSync(path.join(root, 'src', `stray${suffix}`), "console.log('SHOULD_NOT_RUN');\n")
    const result = runRunner(root)
    assert.equal(result.status, 1, suffix)
    assert.match(output(result), /src\/ 下发现测试文件/)
    assert.doesNotMatch(output(result), /SHOULD_NOT_RUN/)
  }
})

test('测试入口：失败测试会透传非零状态', (t) => {
  const root = projectFixture(t)
  fs.writeFileSync(path.join(root, 'test', 'fail.test.mjs'), "throw new Error('expected_failure');\n")
  const result = runRunner(root)
  assert.equal(result.status, 1)
  assert.match(output(result), /expected_failure/)
})

test('测试入口：内联 coverage、reporter 输出和 glob 均保持 Node 原语义', (t) => {
  const root = projectFixture(t)
  fs.writeFileSync(path.join(root, 'test', 'auto.test.mjs'), "console.log('AUTO_DISCOVERY_RAN');\n")
  const inlineCoverage = runRunner(root, ['--test-coverage-lines=80', 'explicit.test.mjs'])
  const separateCoverage = runRunner(root, ['--test-coverage-lines', '80', 'explicit.test.mjs'])
  assert.equal(inlineCoverage.status, 0, output(inlineCoverage))
  assert.match(output(inlineCoverage), /EXPLICIT_TEST_RAN/)
  assert.doesNotMatch(output(inlineCoverage), /AUTO_DISCOVERY_RAN/, '内联选项不得吞掉显式入口')
  assert.equal(separateCoverage.status, 0, output(separateCoverage))
  assert.match(output(separateCoverage), /EXPLICIT_TEST_RAN/)
  assert.doesNotMatch(output(separateCoverage), /AUTO_DISCOVERY_RAN/, '分体 coverage 选项不得吞掉显式入口')

  fs.mkdirSync(path.join(root, 'nested'), { recursive: true })
  const reporter = runRunner(root, ['--test-reporter', 'tap', '--test-reporter-destination', 'nested/report.tap'])
  assert.equal(reporter.status, 0, output(reporter))
  assert.match(fs.readFileSync(path.join(root, 'nested', 'report.tap'), 'utf8'), /ok 1/, 'reporter destination 的值不得被误判为测试入口')

  const glob = runRunner(root, ['test/**/*.test.mjs'])
  assert.equal(glob.status, 0, output(glob))
  assert.match(output(glob), /AUTO_DISCOVERY_RAN/)
  assert.doesNotMatch(output(glob), /EXPLICIT_TEST_RAN/)

  for (const args of [['--conditions', 'production'], ['--title', 'main'], ['--experimental-test-isolation', 'process'], ['--experimental-default-type', 'module']]) {
    const unknownValue = runRunner(root, args)
    assert.equal(unknownValue.status, 0, output(unknownValue))
    assert.match(output(unknownValue), /AUTO_DISCOVERY_RAN/, `${args[0]} 的选项值不得被误判为测试入口`)
  }
  const emptyGlob = runRunner(root, ['test/**/*.test.ts'])
  assert.equal(emptyGlob.status, 1)
  assert.match(output(emptyGlob), /测试入口无匹配/)
})

test('测试入口：src/node_modules 与符号链接跳过而不误报、误跑', (t) => {
  const root = projectFixture(t)
  fs.mkdirSync(path.join(root, 'src', 'node_modules'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'node_modules', 'ignored.test.js'), "console.log('IGNORED_TEST_RAN');\n")
  if (process.platform !== 'win32') fs.symlinkSync(path.join(root, 'explicit.test.mjs'), path.join(root, 'src', 'linked.test.mjs'))
  fs.writeFileSync(path.join(root, 'test', 'auto.test.mjs'), "console.log('AUTO_DISCOVERY_RAN');\n")
  const result = runRunner(root)
  assert.equal(result.status, 0, output(result))
  assert.match(output(result), /AUTO_DISCOVERY_RAN/)
  assert.doesNotMatch(output(result), /IGNORED_TEST_RAN/)
  assert.doesNotMatch(output(result), /EXPLICIT_TEST_RAN/)
})
