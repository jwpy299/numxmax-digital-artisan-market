import fs from 'node:fs'

const roots = [new URL('../', import.meta.url).pathname, new URL('../../desktop', import.meta.url).pathname]
const allowed = new Set(['MIT','MIT-0','ISC','Apache-2.0','BSD-2-Clause','BSD-3-Clause','BSD','CC0-1.0','CC-BY-4.0','Python-2.0','BlueOak-1.0.0','0BSD','(MIT AND Zlib)','MIT AND ISC'])
const failures = []
for (const root of roots) {
  const file = `${root}package-lock.json`
  if (!fs.existsSync(file)) continue
  const lock = JSON.parse(fs.readFileSync(file, 'utf8'))
  for (const [path, info] of Object.entries(lock.packages ?? {})) {
    const name = path.split('node_modules/').at(-1)
    if (!name || name === '.package-lock.json') continue
    let license = info.license || 'UNKNOWN'
    if (name === 'webgl-constants') license = 'MIT'
    if (name === 'jszip') license = 'MIT'
    if (!allowed.has(license)) failures.push({ name, license })
  }
}
console.log(JSON.stringify({ failures }, null, 2))
if (failures.length) process.exit(1)
