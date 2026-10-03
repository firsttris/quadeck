import { expect, test, type Page } from '@playwright/test'

const PASSWORD = 'e2e-password-123'

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Passwort').fill(PASSWORD)
  await page.getByRole('button', { name: 'Anmelden' }).click()
  await expect(page).toHaveURL('/')
}

async function save(page: Page) {
  await page.getByRole('button', { name: 'Speichern und neu laden' }).click()
  const unlock = page.getByRole('dialog', { name: 'Aktionen entsperren' })
  if (await unlock.isVisible().catch(() => false)) {
    await unlock.getByLabel('Passwort').fill(PASSWORD)
    await unlock.getByRole('button', { name: 'Entsperren' }).click()
  }
}

test('reverse proxy: find the Caddyfile, add, edit and delete domains, refuse a broken file', async ({ page }) => {
  await login(page)
  await page.goto('/network?tab=proxy')
  const tab = page.getByRole('region', { name: 'Reverse Proxy' })
  await expect(tab.getByTestId('caddy-source')).toContainText('/etc/caddy/Caddyfile')
  await expect(tab.getByTestId('caddy-source')).toContainText('aus caddy.container (im Container /etc/caddy/Caddyfile)')
  await expect(tab.getByText('Caddy läuft – Änderungen über die Admin-API')).toBeVisible()
  const rows = page.getByTestId('caddy-site')
  await expect(rows).toHaveCount(7)
  await expect(rows.filter({ hasText: 'ha.home.example' })).toContainText('eigene Einstellungen · Zeile 27')
  await expect(page.getByText('Außerdem im Caddyfile: globale Optionen – nur im Text bearbeitbar.')).toBeVisible()

  // New domain: form → diff → save
  await page.getByRole('button', { name: '+ Neue Domain …' }).click()
  let dialog = page.getByRole('dialog', { name: 'Neue Domain' })
  await dialog.getByLabel('Domain(s)').fill('jellyfin.home.example')
  await dialog.getByLabel('Ziel').fill('localhost:9000')
  await dialog.getByRole('button', { name: 'Weiter …' }).click()
  await expect(dialog.getByRole('alert')).toContainText('jellyfin.home.example gibt es schon (Zeile 6)')
  await dialog.getByLabel('Domain(s)').fill('neu.home.example')
  await dialog.getByRole('button', { name: 'Weiter …' }).click()
  const confirm = page.getByRole('dialog', { name: 'Neue Domain' }).last()
  await expect(confirm.getByText('neu.home.example {')).toBeVisible()
  await expect(confirm.getByText(/Caddy prüft die neue Fassung, dann wird \/etc\/caddy\/Caddyfile gespeichert/)).toBeVisible()
  await save(page)
  await expect(page.getByRole('status')).toContainText('Gespeichert – Caddy hat die neue Konfiguration geladen')
  await expect(rows).toHaveCount(8)
  await expect(rows.filter({ hasText: 'neu.home.example' })).toContainText('localhost:9000')

  // Edit a simple block in place
  await page.getByRole('button', { name: 'Bearbeiten … jellyfin.home.example' }).click()
  dialog = page.getByRole('dialog', { name: 'jellyfin.home.example bearbeiten' })
  await expect(dialog.getByLabel('Ziel')).toHaveValue('jellyfin:8096')
  await dialog.getByLabel('Ziel').fill('localhost:8096')
  await dialog.getByRole('button', { name: 'Weiter …' }).click()
  await save(page)
  await expect(rows.filter({ hasText: 'jellyfin.home.example' })).toContainText('localhost:8096')

  // Custom block: only as text, the editor jumps to it; a broken file is refused and nothing changes
  await page.getByRole('button', { name: 'Im Text bearbeiten … ha.home.example' }).click()
  const editor = page.getByRole('dialog', { name: 'Caddyfile bearbeiten' })
  const area = editor.getByLabel('Caddyfile bearbeiten')
  await area.fill(`${await area.inputValue()}\nbroken.home.example {\n\treverse_proxy localhost:1\n`)
  await editor.getByRole('button', { name: 'Weiter …' }).click()
  await save(page)
  await expect(page.getByRole('dialog', { name: 'Caddyfile bearbeiten' }).last().getByRole('alert')).toContainText('Caddy lehnt die Datei ab – nichts geändert')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(rows).toHaveCount(8)

  // Delete
  await page.getByRole('button', { name: 'Löschen … neu.home.example' }).click()
  await expect(page.getByRole('dialog', { name: 'neu.home.example löschen?' })).toBeVisible()
  await save(page)
  await expect(rows).toHaveCount(7)
  await expect(page.getByText('Verlauf (4)')).toBeVisible()
})
