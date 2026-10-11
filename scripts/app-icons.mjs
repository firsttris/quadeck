// The app icons for "add to home screen" (manifest and iOS) from the logo in public/favicon.svg.
//   CHROMIUM_PATH=/path/to/chromium node scripts/app-icons.mjs
// Writes public/icons/*.png. Run again after a change to the logo.
import { mkdirSync } from 'node:fs'
import { chromium } from '@playwright/test'

const GRADIENT = '<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7cc4b8"/><stop offset="1" stop-color="#4f8fbf"/></linearGradient>'
const SHIP = '<path d="M3 14h18l-2.5 5h-13z"/><path d="M6 14V9h4v5"/><path d="M12 14V6h5v8"/>'

/** inset: share of the side the ship may use; round: corner radius (0 = full square for masks and iOS). */
const icon = (round, inset) => {
  const s = 24 / inset
  const o = (s - 24) / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-o} ${-o} ${s} ${s}"><defs>${GRADIENT}</defs><rect x="${-o}" y="${-o}" width="${s}" height="${s}" rx="${round * s}" fill="url(#g)"/><g fill="none" stroke="#0b0f14" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${SHIP}</g></svg>`
}

const ICONS = [
  // rounded like the favicon, the ship as large as in the logo
  { file: 'icon-192.png', size: 192, svg: icon(0.28, 0.75) },
  { file: 'icon-512.png', size: 512, svg: icon(0.28, 0.75) },
  // maskable: full square, the ship inside the safe circle (80 %) that every mask keeps
  { file: 'icon-maskable-512.png', size: 512, svg: icon(0, 0.55) },
  // iOS rounds the corners itself and shows transparency as black
  { file: 'apple-touch-icon.png', size: 180, svg: icon(0, 0.62) },
]

mkdirSync('public/icons', { recursive: true })
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
const p = await b.newPage()
for (const { file, size, svg } of ICONS) {
  await p.setViewportSize({ width: size, height: size })
  await p.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`)
  await p.screenshot({ path: `public/icons/${file}`, omitBackground: true })
  console.log(`public/icons/${file}`)
}
await b.close()
