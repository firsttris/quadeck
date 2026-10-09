// Takes the screenshots in docs/ from the demo data, in English.
//   bun run screenshots (scripts/screenshots.sh starts the demo server and runs this script), or by hand:
//   bun run build && rm -rf .shot-data && QUADECK_PORT=8686 QUADECK_HOST=127.0.0.1 QUADECK_DATA_DIR=.shot-data QUADECK_FIXTURES=fixtures/demo QUADECK_UNLOCK=quadeck bun scripts/start.ts
//   CHROMIUM_PATH=/path/to/chromium node scripts/screenshots.mjs [docs]
import { chromium } from '@playwright/test'
import { readFileSync, rmSync } from 'node:fs'
const OUT = process.argv[2] ?? 'docs'
const base = 'http://127.0.0.1:8686'
const PW = process.env.QUADECK_SHOT_PASSWORD ?? 'shot-password-123'
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, locale: 'en-GB' })
await ctx.addCookies([{ name: 'qd_lang', value: 'en', url: base }])
const p = await ctx.newPage()
const wait = (ms) => p.waitForTimeout(ms)
await p.goto(base + '/setup')
await wait(800)
if (p.url().includes('setup')) {
  await p.getByLabel('Setup token').fill(readFileSync('.shot-data/setup-token', 'utf8').trim())
  await p.getByLabel(/New password/).fill(PW)
  await p.getByLabel('Repeat password').fill(PW)
  await p.getByRole('button', { name: /Set password/ }).click()
  await wait(1200)
}
if (p.url().includes('login')) {
  await p.getByLabel('Password').fill(PW)
  await p.getByRole('button', { name: 'Sign in' }).click()
  await wait(1200)
}
const unlockIfAsked = async () => {
  const d = p.getByRole('dialog', { name: 'Unlock actions' })
  if (await d.isVisible().catch(() => false)) {
    await d.getByLabel('Password').fill(PW)
    await d.getByRole('button', { name: 'Unlock' }).click()
    await wait(800)
  }
}
// A healthy server for the pictures: restart the two failed demo units.
await p.goto(base + '/')
await wait(2000)
for (const unit of ['immich-ml.service', 'backup-offsite.service']) {
  const alarm = p.getByRole('region', { name: `Failed: ${unit}` })
  if (!(await alarm.isVisible().catch(() => false))) {
    console.log('no alarm', unit)
    continue
  }
  await alarm.getByRole('button', { name: 'Restart' }).click()
  await wait(600)
  await unlockIfAsked()
  await p.getByRole('dialog').getByRole('button', { name: 'Restart' }).click()
  await wait(1500)
}
// Locked again, so the sidebar shows the normal state.
await p
  .getByRole('button', { name: 'Lock' })
  .click()
  .catch(() => {})
await wait(500)
const shot = async (name, opts = {}) => {
  await wait(opts.wait ?? 1500)
  await p.screenshot({ path: `${OUT}/screenshot-${name}.png`, fullPage: !!opts.full, clip: opts.clip })
  console.log('shot', name)
}
await p.goto(base + '/')
await shot('dashboard', { wait: 4000 })
// The widget catalog in edit mode (a fresh install has Updates and Backups already).
await p.getByRole('button', { name: 'Edit', exact: true }).click()
await wait(500)
await p.getByRole('button', { name: 'Add widget' }).first().click()
await shot('widgets', { wait: 800 })
await p.keyboard.press('Escape')
await p.getByRole('button', { name: 'Done' }).click()
await p.goto(base + '/quadlets?file=jellyfin.container')
await shot('quadlets')
await p.goto(base + '/system')
await shot('system')
await p.goto(base + '/system?tab=boot')
await shot('boot')
await p.goto(base + '/backups')
await shot('backups', { full: true })
// The backup wizard on "When": the schedule and, apart from it, how long to keep.
await p.getByRole('button', { name: 'Edit plan …' }).click()
const wizard = p.getByRole('dialog', { name: 'Edit backup plan' })
await wizard.getByRole('button', { name: 'Change When' }).click()
await wizard.getByRole('radio', { name: '1 year (recommended)' }).click() // not saved: closed with Escape
await wait(800)
await wizard.screenshot({ path: `${OUT}/screenshot-backup-wizard.png` })
console.log('shot', 'backup-wizard')
await p.keyboard.press('Escape')
// The client wizard's first step: the device, what to back up and own exclusions.
await p.goto(base + '/backups?tab=clients')
await wait(1500)
await p.setViewportSize({ width: 1440, height: 1400 }) // the whole first step in one picture
await p.getByRole('button', { name: '+ Add client' }).click()
const client = p.getByRole('dialog', { name: 'Add client' })
await client.getByLabel('Name of the device').fill('tablet')
await client.getByRole('group', { name: 'Quick choice' }).getByRole('button', { name: 'Desktop', exact: true }).click()
await client.getByLabel('Add an exclusion', { exact: true }).fill('~/Videos/Recordings')
await client.getByLabel('Add an exclusion', { exact: true }).press('Enter')
await client.getByRole('button', { name: 'Add *.mkv as an exclusion' }).click()
await wait(600)
await client.screenshot({ path: `${OUT}/screenshot-client-wizard.png` })
console.log('shot', 'client-wizard')
await p.keyboard.press('Escape')
await p.setViewportSize({ width: 1440, height: 900 })
await p.goto(base + '/network?tab=proxy')
await shot('proxy')
// Speed test: one internet run (the demo answers in a few seconds), the seeded graph below.
await p.goto(base + '/network?tab=speed')
await p.waitForTimeout(1000)
await p.getByTestId('speed-internet').getByRole('button', { name: 'Start test' }).click()
await p.getByTestId('speed-internet').getByTestId('speed-result').waitFor({ timeout: 20000 })
await shot('speedtest', { full: true })
await p.goto(base + '/units?filter=timer')
await shot('timers')
await p.goto(base + '/disks')
await shot('disks')
await p.goto(base + '/network?tab=ports')
await shot('network')
await p.goto(base + '/ssh')
await shot('ssh')
await p.goto(base + '/notifications')
await shot('notifications')
await p.goto(base + '/systemd?unit=smb.service')
await wait(1200)
await p
  .getByRole('button', { name: 'Form' })
  .click()
  .catch(() => console.log('no form button'))
await shot('unit-editor')
// The color themes: the overview in each, side by side (Quadeck last, so the browser keeps the default).
const THEMES = { quadeck: 'Quadeck', nord: 'Nord', ocean: 'Ocean', amethyst: 'Amethyst', copper: 'Copper' }
const tiles = []
for (const t of [...Object.keys(THEMES).slice(1), 'quadeck']) {
  await p.evaluate((t) => localStorage.setItem('quadeck-theme', t), t)
  await p.goto(base + '/')
  await wait(3000)
  await p.screenshot({ path: `${OUT}/.theme-${t}.png` })
  tiles[Object.keys(THEMES).indexOf(t)] = `<figure><img src="data:image/png;base64,${readFileSync(`${OUT}/.theme-${t}.png`).toString('base64')}"><figcaption>${THEMES[t]}</figcaption></figure>`
  rmSync(`${OUT}/.theme-${t}.png`)
}
const sheet = await b.newPage({ viewport: { width: 1800, height: 900 } })
await sheet.setContent(`<style>body{margin:0;padding:24px;background:#05070a;font:600 22px 'IBM Plex Sans',system-ui;color:#e6e8eb;display:grid;grid-template-columns:repeat(3,1fr);gap:22px}figure{margin:0}img{width:100%;border-radius:10px;border:1px solid #2a323d;display:block}figcaption{margin-top:8px}</style>${tiles.join('')}`)
await sheet.screenshot({ path: `${OUT}/screenshot-themes.png`, fullPage: true })
await sheet.close()
console.log('shot', 'themes')
// The repository's social preview (upload it under Settings → Social preview): 1280×640, built from
// scripts/social-preview.html with the dashboard picture taken above.
const og = await b.newPage({ viewport: { width: 1280, height: 640 } })
await og.goto(new URL('social-preview.html', import.meta.url).href)
await og.waitForTimeout(500)
await og.screenshot({ path: `${OUT}/social-preview.png` })
await og.close()
console.log('shot', 'social-preview')
await b.close()
