const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')

test('组织安装包剔除未使用 WB assets，org 本地入口不引用它们', () => {
  const config = fs.readFileSync(path.join(root, 'electron-builder.org.yml'), 'utf8')
  assert.match(config, /"!frontend\/assets\/\*\*"/)
  const build = fs.readFileSync(path.join(root, 'scripts/build-desktop-app.sh'), 'utf8')
  assert.match(build, /org 包混入未使用的 WB React assets/)
  const orgDir = path.join(root, 'src/plugins/numx-org/ui/org')
  for (const name of fs.readdirSync(orgDir)) {
    if (!/\.(html|js)$/.test(name)) continue
    const text = fs.readFileSync(path.join(orgDir, name), 'utf8')
    assert.doesNotMatch(text, /(?:src|href)=["'][^"']*assets\//, `${name} must not reference WB assets`)
  }
})
