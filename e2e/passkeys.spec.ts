import { expect, test, type Page } from '@playwright/test'

// Passkeys need a secure context with a host name: this spec runs on http://localhost instead of
// 127.0.0.1, with Chromium's virtual authenticator (fingerprint always accepted).
const PASSWORD = 'e2e-password-123'
const BASE = 'http://localhost:8585'

async function virtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  })
}

test('add a passkey, log in with it, rename and delete it', async ({ page }) => {
  await virtualAuthenticator(page)
  await page.goto(`${BASE}/login`)
  // No passkey yet: only the password
  await expect(page.getByRole('button', { name: 'Mit Passkey anmelden' })).toBeHidden()
  await page.getByLabel('Passwort').fill(PASSWORD)
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click()
  await expect(page).toHaveURL(`${BASE}/`)

  await page.getByRole('button', { name: 'Passkeys' }).click()
  const dialog = page.getByRole('dialog', { name: 'Passkeys' })
  await expect(dialog).toContainText('Noch kein Passkey eingerichtet.')
  await dialog.getByRole('button', { name: 'Passkey hinzufügen' }).click()
  await dialog.getByLabel('Name').fill('Laptop')
  // A wrong password stops it before the browser asks for the passkey
  await dialog.getByLabel('Admin-Passwort zur Bestätigung').fill('wrong-password')
  await dialog.getByRole('button', { name: 'Passkey erstellen' }).click()
  await expect(dialog.getByRole('alert')).toContainText('Passwort ist falsch')
  await dialog.getByLabel('Admin-Passwort zur Bestätigung').fill(PASSWORD)
  await dialog.getByRole('button', { name: 'Passkey erstellen' }).click()
  await expect(dialog.getByRole('listitem')).toHaveCount(1)
  await expect(dialog.getByRole('listitem')).toContainText('Laptop')
  await expect(dialog.getByRole('listitem')).toContainText('für localhost')
  await expect(dialog.getByRole('listitem')).toContainText('noch nicht benutzt')
  await dialog.getByRole('button', { name: 'Schließen' }).click()

  await page.getByRole('button', { name: 'Abmelden' }).click()
  await expect(page).toHaveURL(`${BASE}/login`)
  await page.getByRole('button', { name: 'Mit Passkey anmelden' }).click()
  await expect(page).toHaveURL(`${BASE}/`)

  await page.getByRole('button', { name: 'Passkeys' }).click()
  await expect(dialog.getByRole('listitem')).toContainText('zuletzt benutzt')
  await dialog.getByRole('button', { name: 'Umbenennen' }).click()
  const rename = page.getByRole('dialog', { name: 'Umbenennen' })
  await rename.getByLabel('Name').fill('Arbeitslaptop')
  await rename.getByRole('button', { name: 'Speichern' }).click()
  await expect(dialog.getByRole('listitem')).toContainText('Arbeitslaptop')

  await dialog.getByRole('button', { name: 'Löschen' }).click()
  const confirm = page.getByRole('dialog', { name: 'Passkey löschen?' })
  await confirm.getByRole('button', { name: 'Löschen' }).click()
  await expect(dialog).toContainText('Noch kein Passkey eingerichtet.')
})

test('on an IP address the dialog explains why passkeys are off', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Passwort').fill(PASSWORD)
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click()
  await page.getByRole('button', { name: 'Passkeys' }).click()
  const dialog = page.getByRole('dialog', { name: 'Passkeys' })
  await expect(dialog).toContainText('nicht über http:// oder eine IP-Adresse')
  await expect(dialog.getByRole('button', { name: 'Passkey hinzufügen' })).toBeDisabled()
})
