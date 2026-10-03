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

const allFiles = (await walk(dist))
  .filter(file => !file.endsWith('/sw.js'))
  .filter(file => !file.endsWith('.map'))
  .filter(file => !file.startsWith('/stickers/'))

const indexHtml = await fs.readFile(path.join(dist, 'index.html'), 'utf8')
const entryAssets = [...indexHtml.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g)].map(match => match[1])

const staticEssentials = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icons/icon-180.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
]

const precacheUrls = [...new Set([
  ...staticEssentials.filter(file => allFiles.includes(file) || file === '/'),
  ...entryAssets,
])].sort()

const iconInputs = await Promise.all([
  '/favicon.svg',
  '/manifest.webmanifest',
].map(async file => {
  const content = await fs.readFile(path.join(dist, file.slice(1)))
  return [file, crypto.createHash('sha256').update(content).digest('hex')]
}))
const hash = crypto.createHash('sha256').update(JSON.stringify({ precacheUrls, iconInputs })).digest('hex').slice(0, 12)
const source = await fs.readFile(swPath, 'utf8')
const output = source
  .replace('__TANDAAN_CACHE_VERSION__', `tandaan-cache-${hash}`)
  .replace('__TANDAAN_PRECACHE_URLS__', JSON.stringify(precacheUrls, null, 2))

await fs.writeFile(swPath, output)
console.log(`PWA precache generated: ${precacheUrls.length} shell URLs (cache ${hash}); lazy chunks and stickers are runtime-cached.`)
