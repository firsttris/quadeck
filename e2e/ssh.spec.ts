import { expect, test, type Page } from '@playwright/test'

// Runs after dashboard.spec.ts. Users, keys and logins from fixtures/demo/ssh.json (in memory).
const PASSWORD = 'e2e-password-123'
const NEW_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDuMWY4/ti4M2/5Ewxc3Zo833yT9xGNBGdGjKUTeKFPv tristan@desktop'

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Passwort').fill(PASSWORD)
  await page.getByRole('button', { name: 'Anmelden' }).click()
  await expect(page).toHaveURL('/')
  await expect(page.getByRole('img', { name: 'live verbunden' })).toBeVisible()
}

async function unlock(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Aktionen entsperren' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Passwort').fill(PASSWORD)
  await dialog.getByRole('button', { name: 'Entsperren' }).click()
  await expect(dialog).toBeHidden()
}

test.describe.serial('SSH', () => {
  test('status, host fingerprints, keys with last use, logins and failed attempts', async ({ page }) => {
    await login(page)
    await page.getByRole('link', { name: 'SSH' }).click()
    await expect(page.getByRole('region', { name: 'Zugang' })).toContainText('sshd.service läuft')
    await expect(page.getByTestId('host-key')).toHaveCount(2)
    const keys = page.getByRole('region', { name: 'Schlüssel' })
    await expect(keys.getByTestId('ssh-key')).toHaveCount(2)
    await expect(keys.getByTestId('ssh-key').filter({ hasText: 'tristan@laptop' })).toContainText('zuletzt vor')
    await expect(keys.getByTestId('ssh-key').filter({ hasText: 'tristan@altes-handy' })).toContainText('RSA mit 2048 Bit')
    await expect(page.getByTestId('ssh-login').first()).toContainText('Schlüssel tristan@laptop')
    await expect(page.getByTestId('ssh-failed').first()).toContainText('45.155.205.233')
    await expect(page.getByRole('region', { name: 'Absicherung' }).getByTestId('ssh-check').first()).toContainText('erlaubt')
  })

  test('add a key, turn off passwords; removing the last working key is blocked', async ({ page }) => {
    await login(page)
    await page.goto('/ssh')
    const keys = page.getByRole('region', { name: 'Schlüssel' })
    await keys.getByLabel(/Öffentlichen Schlüssel hinzufügen/).fill(NEW_KEY)
    await keys.getByRole('button', { name: /Prüfen und eintragen/ }).click()
    const add = page.getByRole('dialog', { name: 'Schlüssel für tristan eintragen?' })
    await expect(add.getByLabel('Änderungen')).toContainText('tristan@desktop')
    await add.getByRole('button', { name: 'Eintragen' }).click()
    await unlock(page)
    await expect(keys.getByTestId('ssh-key')).toHaveCount(3)

    const hard = page.getByRole('region', { name: 'Absicherung' })
    await hard.getByRole('switch', { name: 'Passwort-Login erlauben' }).uncheck()
    await hard.getByLabel('root-Login').selectOption('no')
    await hard.getByRole('button', { name: /Übernehmen/ }).click()
    const set = page.getByRole('dialog', { name: 'SSH-Einstellungen ändern?' })
    await expect(set.getByLabel('Änderungen')).toContainText('+ PasswordAuthentication no')
    await expect(set).toContainText('zweiten')
    await set.getByRole('button', { name: 'Übernehmen' }).click()
    await expect(hard.getByTestId('ssh-check').first()).toContainText('aus – nur Schlüssel')

    // tristan is the only user with keys: remove them down to the last one.
    for (const name of ['tristan@altes-handy', 'tristan@desktop']) {
      await keys.getByRole('button', { name: `Schlüssel ${name} entfernen` }).click()
      await page.getByRole('dialog', { name: /entfernen\?/ }).getByRole('button', { name: 'Entfernen' }).click()
      await expect(keys.getByTestId('ssh-key').filter({ hasText: name })).toHaveCount(0)
    }
    await keys.getByRole('button', { name: 'Schlüssel tristan@laptop entfernen' }).click()
    const last = page.getByRole('dialog', { name: /tristan@laptop.*entfernen\?/ })
    await expect(last.getByRole('alert')).toContainText('letzte funktionierende Schlüssel')
    await expect(last.getByRole('button', { name: 'Entfernen' })).toBeDisabled()
    await last.getByRole('button', { name: 'Abbrechen' }).click()
    await expect(keys.getByTestId('ssh-key')).toHaveCount(1)
  })
})
