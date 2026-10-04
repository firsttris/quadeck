import { expect, test, type Page } from '@playwright/test'

// Demo: immich.container has DB_PASSWORD in plain text, Podman knows one secret already.
const PASSWORD = 'e2e-password-123'

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Passwort').fill(PASSWORD)
  await page.getByRole('button', { name: 'Anmelden' }).click()
  await expect(page).toHaveURL('/')
}

async function unlockIfAsked(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Aktionen entsperren' })
  if (await dialog.isVisible({ timeout: 2000 }).catch(() => false)) {
    await dialog.getByLabel('Passwort').fill(PASSWORD)
    await dialog.getByRole('button', { name: 'Entsperren' }).click()
    await expect(dialog).toBeHidden()
  }
}

test('podman secrets: create, move a plain-text password out of a Quadlet, delete', async ({ page }) => {
  await login(page)
  await page.goto('/system?tab=podman')
  const card = page.getByRole('region', { name: 'Secrets' })
  const rows = card.getByTestId('secret-row')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('paperless-db-password')
  await expect(rows.first()).toContainText('keiner Quadlet-Datei')
  const plain = card.getByTestId('secrets-plain')
  await expect(plain).toContainText('immich.container')
  await expect(plain).toContainText('DB_PASSWORD=••••••')
  await expect(card).not.toContainText('immich-demo-1234') // the value never reaches the page

  // a new secret
  await card.getByRole('button', { name: 'Neues Secret …' }).click()
  const create = page.getByRole('dialog', { name: 'Neues Secret' })
  await create.getByLabel('Name').fill('smtp-pass')
  await create.getByLabel('Wert').fill('very secret')
  await expect(create.getByLabel('Wert')).toHaveAttribute('type', 'password')
  await create.getByRole('button', { name: 'Speichern' }).click()
  await unlockIfAsked(page)
  await expect(page.getByRole('status')).toContainText('Secret smtp-pass angelegt')
  await expect(rows).toHaveCount(2)

  // move the plain password out of immich.container
  await card.getByRole('button', { name: 'DB_PASSWORD aus immich.container in ein Secret verschieben' }).click()
  const move = page.getByRole('dialog', { name: 'DB_PASSWORD in ein Secret verschieben' })
  await expect(move.getByLabel('Name')).toHaveValue('immich-db-password')
  await expect(move).toContainText('+ Secret=immich-db-password,type=env,target=DB_PASSWORD')
  await move.getByRole('button', { name: 'Verschieben' }).click()
  await unlockIfAsked(page)
  await expect(page.getByRole('status')).toContainText('DB_PASSWORD liegt jetzt im Secret immich-db-password')
  await expect(plain).toHaveCount(0)
  await expect(rows.filter({ hasText: 'immich-db-password' })).toContainText('immich.container')
  await expect(rows.filter({ hasText: 'immich-db-password' }).getByRole('button', { name: 'immich-db-password löschen' })).toBeDisabled()

  // delete the unused one
  await card.getByRole('button', { name: 'smtp-pass löschen' }).click()
  const confirm = page.getByRole('dialog', { name: 'smtp-pass löschen?' })
  await confirm.getByRole('button', { name: 'Löschen' }).click()
  await expect(page.getByRole('status')).toContainText('Secret smtp-pass gelöscht')
  await expect(rows).toHaveCount(2)

  // the Quadlet file now names the secret instead of the password
  await page.goto('/quadlets?file=immich.container')
  await page.getByRole('button', { name: 'Text' }).click()
  const text = page.getByRole('textbox', { name: 'Quadlet-Datei' })
  await expect(text).toHaveValue(/Secret=immich-db-password,type=env,target=DB_PASSWORD/)
  await expect(text).toHaveValue(/Environment=DB_USERNAME=immich\n/)
  await expect(text).not.toHaveValue(/immich-demo-1234/)
})
