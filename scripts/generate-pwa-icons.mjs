import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const root = process.cwd()
const sourceDir = path.join(root, 'public', 'icons')
const dogs = ['d1', 'd2', 'd3', 'd4']
const positions = [
  { left: 8, top: 8 },
  { left: 258, top: 8 },
  { left: 8, top: 258 },
  { left: 258, top: 258 },
]

async function buildMaster() {
  const composites = await Promise.all(dogs.map(async (dog, index) => ({
    input: await sharp(path.join(sourceDir, `logo-${dog}.png`))
      .resize(246, 246, { fit: 'cover', position: 'centre' })
      .png()
      .toBuffer(),
    ...positions[index],
  })))

  const base = await sharp({
    create: {
      width: 512,
      height: 512,
      channels: 4,
      background: '#0b0715',
    },
  }).composite(composites).png().toBuffer()

  return sharp(base)
    .composite([
      {
        input: Buffer.from(
          '<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg"><rect width="512" height="512" rx="56" fill="white"/></svg>',
        ),
        blend: 'dest-in',
      },
      {
        input: Buffer.from(
          '<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="2" width="508" height="508" rx="54" fill="none" stroke="#67e8f9" stroke-width="4"/></svg>',
        ),
        blend: 'over',
      },
    ])
    .png()
    .toBuffer()
}

const master = await buildMaster()
for (const size of [180, 192, 512]) {
  const out = path.join(sourceDir, `icon-${size}.png`)
  await sharp(master).resize(size, size).png({ compressionLevel: 9 }).toFile(out)
  console.log(`Generated ${out}`)
}
