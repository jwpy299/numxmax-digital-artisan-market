const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const TEST_SUFFIXES = ['.test.cjs', '.test.mjs', '.test.js']
const { execFileSync } = require('node:child_process')
// 以当前 Node 的 CLI 文档为准识别分体值选项，避免把 option value 误收为测试入口。
const OPTIONS_WITH_VALUES = new Set([...execFileSync(process.execPath, ['--help'], { encoding: 'utf8' })
  .matchAll(/^\s*(--[\w-]+)=\.\.\.\s*$/gm)].map((match) => match[1]))
const isGlob = (arg) => /[*?[\]{}]/.test(arg)
function looksLikeTestEntry(root, arg) {
  if (isGlob(arg)) return true
  if (fs.existsSync(path.resolve(root, arg))) return true
  return TEST_SUFFIXES.some((suffix) => arg.endsWith(suffix))
}
function positionalArgs(args, root) {
  const output = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--') {
      output.push(...args.slice(index + 1))
      break
    }
    if (arg.startsWith('-')) {
      if (OPTIONS_WITH_VALUES.has(arg)) index += 1
      else if (arg.startsWith('--test-coverage') && !arg.includes('=')) index += 1
      continue
    }
    if (looksLikeTestEntry(root, arg) || /[\/]/.test(arg) || path.extname(arg) !== '') output.push(arg)
  }
  return output
}

// 测试收集允许工作区/联调链接存在；构建清单使用另一套严格 walkFiles，不在这里混用。
function testFiles(root) {
  const stat = fs.lstatSync(root, { throwIfNoEntry: false })
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return []
  return fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const full = path.join(root, entry.name)
    if (entry.name === 'node_modules' || entry.isSymbolicLink()) return []
    if (entry.isDirectory()) return testFiles(full)
    if (entry.isFile() && TEST_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) return [full]
    return []
  })
}

function main() {
  const projectRoot = path.join(__dirname, '..')
  const files = testFiles(path.join(projectRoot, 'test'))
  const misplaced = testFiles(path.join(projectRoot, 'src'))
  if (misplaced.length) throw new Error(`src/ 下发现测试文件：请先移到 test/，防止测试文件进入安装包\n${misplaced.join('\n')}`)
  const extraArgs = process.argv.slice(2)
  const positional = positionalArgs(extraArgs, projectRoot)
  const hasPositional = positional.length > 0
  const missingPositional = positional.find((arg) => !isGlob(arg) && !fs.existsSync(path.resolve(projectRoot, arg)))
  if (missingPositional) throw new Error(`测试入口不存在：${missingPositional}`)
  for (const pattern of positional.filter(isGlob)) {
    const matches = fs.globSync(pattern, { cwd: projectRoot })
    if (!matches.length) throw new Error(`测试入口无匹配：${pattern}`)
  }
  if (!files.length && !hasPositional) throw new Error(`未发现任何 ${TEST_SUFFIXES.join('/')} 测试文件——拒绝以空测试集通过`)
  const selectedArgs = hasPositional ? extraArgs : [...extraArgs, ...files]
  const result = spawnSync(process.execPath, ['--test', ...selectedArgs], {
    cwd: projectRoot,
    stdio: 'inherit',
  })
  if (result.error || result.signal) throw new Error(`测试运行器异常：${result.error ? result.error.message : `signal=${result.signal}`}`)
  process.exitCode = result.status ?? 1
}

try { main() } catch (error) {
  console.error(error?.stack || error)
  process.exitCode = 1
}
