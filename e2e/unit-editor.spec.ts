import { expect, test, type Page } from '@playwright/test'

// Unit files from fixtures/demo/units.json (in memory, see FixtureUnitEditor).
const PASSWORD = 'e2e-password-123'

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Passwort').fill(PASSWORD)
  await page.getByRole('button', { name: 'Anmelden' }).click()
  await expect(page).toHaveURL('/')
}

async function unlockIfAsked(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Aktionen entsperren' })
  await dialog.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {})
  if (await dialog.isVisible()) {
    await dialog.getByLabel('Passwort').fill(PASSWORD)
    await dialog.getByRole('button', { name: 'Entsperren' }).click()
    await expect(dialog).toBeHidden()
  }
}

test.describe.serial('Unit-Editor', () => {
  test('vendor unit: read-only file, edit the override in the form, diff, history, remove', async ({ page }) => {
    await login(page)
    await page.goto('/units?filter=service')
    await page.getByRole('link', { name: 'smb.service bearbeiten' }).click()
    await expect(page).toHaveURL(/\/systemd\?unit=smb\.service/)
    const files = page.getByRole('region', { name: 'Dateien' })
    await files.getByRole('button', { name: /\/usr\/lib\/systemd\/system\/smb\.service/ }).click()
    await expect(page.getByLabel('Inhalt von /usr/lib/systemd/system/smb.service')).toHaveJSProperty('readOnly', true)
    await expect(page.getByText('Diese Datei gehört zu einem Paket')).toBeVisible()

    await files.getByRole('button', { name: /override\.conf/ }).click()
    const editor = page.getByRole('region', { name: 'Editor /etc/systemd/system/smb.service.d/override.conf' })
    await editor.getByRole('button', { name: 'Formular' }).click()
    await expect(editor.getByLabel('Restart', { exact: true })).toBeVisible()
    await editor.getByLabel('Restart', { exact: true }).selectOption('on-failure')
    await expect(editor.getByText(/bisher: notify/)).toBeVisible()
    await editor.getByLabel('MemoryMax').fill('2G')
    await editor.getByRole('button', { name: 'Speichern …' }).click()
    const review = page.getByRole('dialog', { name: /override\.conf speichern\?/ })
    await expect(review.getByLabel('Änderungen')).toContainText('+ Restart=on-failure')
    await expect(review.getByLabel('Änderungen')).toContainText('+ MemoryMax=2G')
    await review.getByRole('button', { name: /Speichern/ }).click()
    await unlockIfAsked(page)
    await expect(review).toBeHidden()
    await expect(editor.getByRole('button', { name: 'Verlauf (2)' })).toBeVisible()

    await editor.getByRole('button', { name: 'Override entfernen' }).click()
    await page.getByRole('dialog', { name: 'Override entfernen?' }).getByRole('button', { name: 'Entfernen' }).click()
    await expect(files.getByRole('button', { name: /override\.conf/ })).toHaveCount(0)
    await expect(files.getByRole('button', { name: '+ Override anlegen' })).toBeVisible()
  })

  test('problems from the check are shown with line numbers and block saving', async ({ page }) => {
    await login(page)
    await page.goto('/systemd?unit=restic-backup.service')
    const editor = page.getByRole('region', { name: 'Editor /etc/systemd/system/restic-backup.service' })
    const text = editor.getByLabel('Inhalt von /etc/systemd/system/restic-backup.service')
    await text.fill('Nice=5\n[Service]\nExecStart=/usr/bin/restic backup /srv\n')
    await expect(editor.getByLabel('Hinweise')).toContainText('steht vor dem ersten [Abschnitt]')
    await expect(editor.getByRole('button', { name: 'Speichern …' })).toBeDisabled()
    await editor.getByRole('button', { name: 'Verwerfen' }).click()
    await expect(text).toHaveValue(/Description=Restic Backup/)
  })

  test('create a new unit from a template', async ({ page }) => {
    await login(page)
    await page.goto('/units')
    await page.getByRole('link', { name: '+ Neue Unit' }).click()
    await page.getByLabel('Name').fill('hallo-welt')
    await page.getByRole('button', { name: 'Dauerhafter Dienst' }).click()
    await expect(page.getByLabel('Inhalt der neuen Unit')).toHaveValue(/ExecStart=\/usr\/local\/bin\/hallo-welt/)
    await page.getByLabel('Inhalt der neuen Unit').fill('[Unit]\nDescription=Hallo Welt\n\n[Service]\nExecStart=/bin/sleep infinity\n\n[Install]\nWantedBy=multi-user.target\n')
    await page.getByRole('button', { name: 'Anlegen' }).click()
    await unlockIfAsked(page)
    await expect(page).toHaveURL(/\/systemd\?unit=hallo-welt\.service/)
    await expect(page.getByRole('heading', { level: 1, name: 'hallo-welt.service' })).toBeVisible()
    await expect(page.getByText('Hallo Welt').first()).toBeVisible()
  })
})
