const fs = require('node:fs')
const path = require('node:path')

/** 构建与测试共用的符号链接安全遍历；node_modules 永远不作为源文件计入。 */
function walkFiles(root) {
  const stat = fs.lstatSync(root, { throwIfNoEntry: false })
  if (!stat) {
    throw new Error(`目录不存在：${root}`)
  }
  if (stat.isSymbolicLink()) throw new Error(`目录不得包含符号链接：${root}`)
  if (!stat.isDirectory()) throw new Error(`路径不是目录：${root}`)
  return fs.readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(root, entry.name)
      if (entry.name === 'node_modules') return []
      if (entry.isSymbolicLink()) throw new Error(`目录不得包含符号链接：${full}`)
      if (entry.isDirectory()) return walkFiles(full)
      if (entry.isFile()) return [full]
      throw new Error(`目录含非普通文件：${full}`)
    })
    .sort()
}

module.exports = { walkFiles }
