import { createServer, type Server } from 'node:http'
import { expect, test, type Page } from '@playwright/test'

// A local webhook receiver stands in for ntfy/Discord & co.
const PASSWORD = 'e2e-password-123'
const HOOK_PORT = 8599
const received: { title: string; message: string; severity: string }[] = []
let server: Server

test.beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      received.push(JSON.parse(body))
      res.end('ok')
    })
  })
  await new Promise<void>((r) => server.listen(HOOK_PORT, '127.0.0.1', r))
})
test.afterAll(() => server.close())

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Passwort').fill(PASSWORD)
  await page.getByRole('button', { name: 'Anmelden' }).click()
  await expect(page).toHaveURL('/')
}

test.describe.serial('Benachrichtigungen', () => {
  test('add a webhook, send a test, current problems are reported once', async ({ page }) => {
    await login(page)
    await page.getByRole('link', { name: 'Benachrichtigungen' }).click()
    await expect(page.getByText('Noch kein Kanal')).toBeVisible()
    await page.getByRole('button', { name: '+ Kanal' }).click()
    const dialog = page.getByRole('dialog', { name: 'Neuer Kanal' })
    await dialog.getByRole('button', { name: 'Webhook' }).click()
    await dialog.getByLabel('Name').fill('Testhook')
    await dialog.getByLabel('Webhook-URL').fill(`http://127.0.0.1:${HOOK_PORT}/hook`)
    await dialog.getByRole('button', { name: 'Speichern' }).click()
    await expect(page.getByTestId('channel')).toContainText('Testhook')

    // The demo has failed units: reported right after the first channel exists.
    await expect.poll(() => received.map((r) => r.title).join('|')).toContain('Probleme')
    const problem = received.find((r) => r.title.includes('Probleme'))!
    expect(problem.message).toContain('backup-offsite.service ist fehlgeschlagen')
    expect(problem.severity).toBe('critical')
    await page.reload()
    await expect(page.getByTestId('active-alert').filter({ hasText: 'backup-offsite.service' })).toBeVisible()

    await page.getByRole('button', { name: 'Testnachricht an Testhook' }).click()
    await expect.poll(() => received.some((r) => r.title.endsWith('Testnachricht'))).toBe(true)
    await expect(page.getByTestId('sent').first()).toContainText('✓ Testhook')
    const count = received.length
    await page.reload()
    await page.waitForTimeout(6000) // a few hub rounds: nothing repeated
    // The daily update summary may arrive whenever the update check finishes; problems must not repeat.
    expect(received.slice(count).filter((r) => !r.title.includes('Updates verfügbar')).map((r) => `${r.title}: ${r.message}`)).toEqual([])
  })

  test('rules can be switched off', async ({ page }) => {
    await login(page)
    await page.goto('/notifications')
    const rules = page.getByRole('region', { name: 'Wann benachrichtigen' })
    await rules.getByRole('checkbox', { name: /Dienst oder Timer fehlgeschlagen/ }).uncheck()
    await rules.getByLabel('Schwellwert in Prozent').fill('80')
    await rules.getByRole('button', { name: 'Speichern' }).click()
    await expect(page.getByTestId('active-alert').filter({ hasText: 'backup-offsite.service' })).toHaveCount(0)
    await page.reload()
    await expect(page.getByLabel('Schwellwert in Prozent')).toHaveValue('80')
  })
})
