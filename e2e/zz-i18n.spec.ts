import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'

// Runs last (zz-): it opens dialogs and menus on every page.
// English UI: switch the language and walk through every page and tab looking
// for German that was left behind. Host data from the fixtures (unit
// descriptions, file names, package descriptions …) may be German – those lines
// are listed in DATA.

const PASSWORD = 'e2e-password-123'

const GERMAN =
  /[äöüÄÖÜß]|\b(der|die|das|den|dem|und|oder|nicht|wird|werden|keine?n?|mit|für|auf|von|ein|eine|ist|sind|zum|zur|neu|alle|Datei|Dateien|bitte|noch|nur|schon|Benutzer|Speichern|Abbrechen|Schließen|Löschen|Bearbeiten|Starten|Stoppen|Hinzufügen|Übersicht|Einstellungen|Fehler|läuft|gestoppt|Aktionen|Neue?r?|Freigaben?|Festplatten?|Netzwerk|Benachrichtigungen|Zeitplan|jetzt|vor|seit|Sekunden|Minuten|Stunden|Tage)\b/

/**
 * Words that only occur in the German texts (messages/de.json) and never in
 * the English ones: if one shows up in the English UI, a text was left behind.
 */
function germanOnlyWords(): Set<string> {
  const words = (v: unknown) =>
    (
      JSON.stringify(v)
        .replace(/\{\w+\}/g, ' ')
        .match(/[A-Za-zÄÖÜäöüß]{4,}/g) ?? []
    ).map((w) => w.toLowerCase())
  const de = new Set(words(Object.values(JSON.parse(readFileSync('messages/de.json', 'utf8')))))
  const en = new Set(words(Object.values(JSON.parse(readFileSync('messages/en.json', 'utf8')))))
  // German words that are English too (or names), and appear in host data
  const english = ['pods', 'fast', 'controller', 'asmedia', 'mainboard', 'manual']
  return new Set([...de].filter((w) => !en.has(w) && !english.includes(w)))
}
const GERMAN_ONLY = germanOnlyWords()
const isGerman = (t: string) => GERMAN.test(t) || (t.match(/[A-Za-zÄÖÜäöüß]{4,}/g) ?? []).some((w) => GERMAN_ONLY.has(w.toLowerCase()))

/** Fixture data that is German on purpose (it is "the server's" data, not UI text). */
const DATA: RegExp[] = [
  // Fan names the admin gave in the sensor config
  /^(CPU-Lüfter|Gehäuse vorne|Gehäuse hinten|Temperatur 1|Leistung 1)$/,
  // Share names, app group label and host names of the demo server
  /\b(Medien|Fotos)\b|fotos\.home\.example/i,
  // The demo's archive disk (/mnt/archiv, LABEL=Archiv) and archive folder (/mnt/disk2/Archiv)
  /\barchiv\b/i,
  // An SSH key comment, a demo timer description, a demo /etc/passwd line
  /altes-handy|^- anna:x:|macbook-anna/,
  // A bcrypt hash in the Caddyfile (random letters)
  /\$2[aby]\$\d\d\$/,
  // A bcrypt hash in the Caddyfile (random letters)
  /\$2[aby]\$\d\d\$/,
]

async function scan(page: Page, where: string): Promise<string[]> {
  await page.waitForTimeout(150)
  const texts = await page.evaluate(() => {
    const out: string[] = []
    const root = document.body
    for (const line of root.innerText.split('\n')) out.push(line.trim())
    for (const el of root.querySelectorAll<HTMLElement>('[aria-label],[title],[placeholder],[alt]')) {
      for (const a of ['aria-label', 'title', 'placeholder', 'alt']) {
        const v = el.getAttribute(a)
        if (v) out.push(`@${a}: ${v}`)
      }
    }
    return out
  })
  const found = [...new Set(texts)].filter((t) => isGerman(t) && !DATA.some((d) => d.test(t.replace(/^@[a-z-]+: /, '')))).map((t) => `${where}: ${t}`)
  if (found.length) console.log(found.join('\n'))
  return found
}

/** Opens what only shows on click – dialogs ("… …" buttons) and row menus – scans it, closes it again. */
async function openers(page: Page, where: string, hits: string[]) {
  const buttons = page.locator('main button:visible').filter({ hasText: /…\s*$/ }).or(page.locator('main button[aria-haspopup="menu"]:visible'))
  const n = Math.min(await buttons.count(), 30)
  for (let i = 0; i < n; i++) {
    const b = buttons.nth(i)
    if (!(await b.isVisible().catch(() => false)) || (await b.isDisabled().catch(() => true))) continue
    const name = ((await b.getAttribute('aria-label')) ?? (await b.innerText())).trim()
    await b.click({ timeout: 2000 }).catch(() => {})
    await page.waitForTimeout(150)
    hits.push(...(await scan(page, `${where} {${name}}`)))
    for (let k = 0; k < 3 && (await page.locator('dialog[open], [role=dialog]:visible, [role=menu]:visible').count()) > 0; k++) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(150)
    }
  }
}

async function tabs(page: Page, where: string, hits: string[]) {
  const list = page.getByRole('tab')
  const n = await list.count()
  for (let i = 0; i < n; i++) {
    const tab = list.nth(i)
    if (!(await tab.isVisible())) continue
    const name = (await tab.innerText()).trim()
    await tab.click({ timeout: 3000 }).catch(() => {})
    hits.push(...(await scan(page, `${where} [${name}]`)))
    await openers(page, `${where} [${name}]`, hits)
  }
}

test.describe('English', () => {
  test.use({ locale: 'en-US' })

  test('login page follows the browser language', async ({ page }) => {
    expect(GERMAN_ONLY.size).toBeGreaterThan(500)
    await page.goto('/login')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    expect(await scan(page, '/login')).toEqual([])
  })

  test('every page and tab is English', async ({ page }) => {
    test.setTimeout(600_000)
    await page.goto('/login')
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: /sign in|log in/i }).click()
    await expect(page).toHaveURL('/')
    const hits: string[] = []
    // Server render and browser must agree on the language: no hydration mismatches.
    const mismatches: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error' && /hydrat/i.test(m.text())) mismatches.push(m.text().slice(0, 300))
    })
    const pages = ['/', '/units', '/units?filter=timer', '/units?filter=socket', '/journal', '/disks', '/files', '/shares', '/backups', '/backups?tab=clients', '/ssh', '/network', '/system', '/notifications', '/users', '/hardware', '/quadlets', '/systemd']
    for (const p of pages) {
      await page.goto(p)
      await page.waitForLoadState('networkidle').catch(() => {})
      hits.push(...(await scan(page, p)))
      await openers(page, p, hits)
      await page.goto(p)
      await tabs(page, p, hits)
    }
    expect(hits).toEqual([])
    expect(mismatches).toEqual([])
  })
})

test('the language switch is remembered and German stays the default here', async ({ page }) => {
  await page.goto('/login')
  await expect(page.locator('html')).toHaveAttribute('lang', 'de')
  await page.getByLabel('Sprache').selectOption('en')
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.getByLabel('Language')).toHaveValue('en')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await page.getByLabel('Language').selectOption('de')
  await expect(page.locator('html')).toHaveAttribute('lang', 'de')
})
