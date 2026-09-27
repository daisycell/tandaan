import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

const root = process.cwd()
const dist = path.join(root, 'dist')
const swPath = path.join(dist, 'sw.js')

async function walk(dir, prefix = '') {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const rel = path.posix.join(prefix, entry.name)
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await walk(full, rel))
    else files.push('/' + rel)
  }
  return files
}

const allFiles = (await walk(dist)).filter(file => !file.endsWith('/sw.js'))
  .filter(file => !file.endsWith('.map'))
  .sort()

const hash = crypto.createHash('sha256').update(JSON.stringify(allFiles)).digest('hex').slice(0, 12)
const source = await fs.readFile(swPath, 'utf8')
const output = source
  .replace('__TANDAAN_CACHE_VERSION__', `tandaan-cache-${hash}`)
  .replace('__TANDAAN_PRECACHE_URLS__', JSON.stringify(allFiles, null, 2))

await fs.writeFile(swPath, output)
console.log(`PWA precache generated: ${allFiles.length} files (cache ${hash})`)
