import { expect, test, type Page } from '@playwright/test'

// English UI: switch the language and walk through every page and tab looking
// for German that was left behind. Host data from the fixtures (unit
// descriptions, file names, package descriptions …) may be German – those lines
// are listed in DATA.

const PASSWORD = 'e2e-password-123'

const GERMAN = /[äöüÄÖÜß]|\b(der|die|das|den|dem|und|oder|nicht|wird|werden|keine?n?|mit|für|auf|von|ein|eine|ist|sind|zum|zur|neu|alle|Datei|Dateien|bitte|noch|nur|schon|Benutzer|Speichern|Abbrechen|Schließen|Löschen|Bearbeiten|Starten|Stoppen|Hinzufügen|Übersicht|Einstellungen|Fehler|läuft|gestoppt|Aktionen|Neue?r?|Freigaben?|Festplatten?|Netzwerk|Benachrichtigungen|Zeitplan|jetzt|vor|seit|Sekunden|Minuten|Stunden|Tage)\b/

/** Fixture data that is German on purpose (it is "the server's" data, not UI text). */
const DATA: RegExp[] = [/^$/]

async function scan(page: Page, where: string): Promise<string[]> {
  await page.waitForTimeout(300)
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
  return [...new Set(texts)].filter((t) => GERMAN.test(t) && !DATA.some((d) => d.test(t.replace(/^@[a-z-]+: /, '')))).map((t) => `${where}: ${t}`)
}

async function tabs(page: Page, where: string, hits: string[]) {
  const list = page.getByRole('tab')
  const n = await list.count()
  for (let i = 0; i < n; i++) {
    const tab = list.nth(i)
    if (!(await tab.isVisible())) continue
    const name = (await tab.innerText()).trim()
    await tab.click()
    hits.push(...(await scan(page, `${where} [${name}]`)))
  }
}

test.describe('English', () => {
  test.use({ locale: 'en-US' })

  test('login page follows the browser language', async ({ page }) => {
    await page.goto('/login')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    expect(await scan(page, '/login')).toEqual([])
  })

  test('every page and tab is English', async ({ page }) => {
    test.setTimeout(180_000)
    await page.goto('/login')
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: /sign in|log in/i }).click()
    await expect(page).toHaveURL('/')
    const hits: string[] = []
    const pages = ['/', '/units', '/units?filter=timer', '/units?filter=socket', '/journal', '/disks', '/files', '/shares', '/ssh', '/network', '/system', '/notifications', '/users', '/hardware', '/quadlets', '/systemd']
    for (const p of pages) {
      await page.goto(p)
      await page.waitForLoadState('networkidle').catch(() => {})
      hits.push(...(await scan(page, p)))
      await tabs(page, p, hits)
    }
    console.log(hits.join('\n'))
    expect(hits).toEqual([])
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
