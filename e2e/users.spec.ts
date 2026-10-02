import { expect, test, type Page } from '@playwright/test'

// fixtures/demo/users.json: root locked, tristan the only admin with a password, anna a normal user.
const PASSWORD = 'e2e-password-123'

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Passwort').fill(PASSWORD)
  await page.getByRole('button', { name: 'Anmelden' }).click()
  await expect(page).toHaveURL('/')
}

async function unlock(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Aktionen entsperren' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Passwort').fill(PASSWORD)
  await dialog.getByRole('button', { name: 'Entsperren' }).click()
  await expect(dialog).toBeHidden()
}

test.describe.serial('Benutzer', () => {
  test('list, details with keys and history, lock-out guard', async ({ page }) => {
    await login(page)
    await page.getByRole('navigation', { name: 'Bereiche' }).getByRole('link', { name: 'Benutzer' }).click()
    await expect(page.getByTestId('account')).toHaveCount(3)
    await expect(page.getByTestId('account').filter({ hasText: 'root' })).toContainText('gesperrt')
    const tristan = page.getByTestId('account').filter({ hasText: 'tristan' })
    await expect(tristan).toContainText('Admin')
    await tristan.click()
    await expect(page.getByRole('region', { name: 'SSH-Schlüssel' })).toContainText('tristan@laptop')
    await expect(page.getByTestId('login-record').first()).toContainText('angemeldet')

    await page.getByRole('button', { name: 'Sperren …' }).click()
    const dialog = page.getByRole('dialog', { name: 'tristan sperren?' })
    await expect(dialog.getByRole('alert')).toContainText('niemand mehr als Administrator')
    await expect(dialog.getByRole('button', { name: 'Sperren' })).toBeDisabled()
    await dialog.getByRole('button', { name: 'Abbrechen' }).click()
  })

  test('create a key-only user, set a password, groups, Samba, delete', async ({ page }) => {
    await login(page)
    await page.goto('/users')
    await page.getByRole('button', { name: 'Neuer Benutzer' }).click()
    const create = page.getByRole('dialog', { name: 'Neuer Benutzer' })
    await create.getByLabel('Benutzername').fill('Tristan')
    await expect(create).toContainText('gibt es schon')
    await create.getByLabel('Benutzername').fill('max')
    await create.getByLabel('Voller Name (optional)').fill('Max Muster')
    await create.getByRole('radio', { name: 'Nur SSH-Schlüssel' }).click()
    await create.getByLabel(/^video/).check()
    await expect(create).toContainText('ohne Passwort – Anmeldung nur mit SSH-Schlüssel')
    await create.getByRole('button', { name: 'Anlegen' }).click()
    await unlock(page)
    await expect(page).toHaveURL(/user=max/)
    const login_ = page.getByRole('region', { name: 'Anmeldung' })
    await expect(login_).toContainText('kein Passwort')
    await expect(login_).toContainText('Weder Passwort noch Schlüssel')

    await login_.getByRole('button', { name: 'Passwort setzen …', exact: true }).click()
    const pw = page.getByRole('dialog', { name: 'Passwort für max' })
    await pw.getByLabel('Neues Passwort').fill('kurz')
    await expect(pw).toContainText('mindestens 8 Zeichen')
    await pw.getByLabel('Neues Passwort').fill('ein langes Passwort')
    await pw.getByLabel('Wiederholen').fill('ein langes Passwort')
    await pw.getByRole('button', { name: 'Setzen' }).click()
    await expect(login_).toContainText('Passwort gesetzt')

    const account = page.getByRole('region', { name: 'Konto max' })
    await account.getByLabel(/^render/).check()
    await account.getByLabel(/Administrator/).check()
    await account.getByRole('button', { name: 'Speichern …' }).click()
    await page.getByRole('dialog', { name: 'max ändern?' }).getByRole('button', { name: 'Speichern' }).click()
    await expect(page.getByTestId('account').filter({ hasText: 'max' })).toContainText('Admin')

    await login_.getByRole('button', { name: 'Samba-Passwort setzen …' }).click()
    const smb = page.getByRole('dialog', { name: 'Samba-Passwort für max' })
    await smb.getByLabel('Neues Passwort').fill('samba-passwort')
    await smb.getByLabel('Wiederholen').fill('samba-passwort')
    await smb.getByRole('button', { name: 'Setzen' }).click()
    await expect(login_).toContainText('Samba-Passwort gesetzt')

    await page.getByRole('button', { name: 'Konto löschen …' }).click()
    await page.getByRole('dialog', { name: 'max löschen?' }).getByRole('button', { name: 'Endgültig löschen' }).click()
    await expect(page.getByTestId('account')).toHaveCount(3)
  })
})
