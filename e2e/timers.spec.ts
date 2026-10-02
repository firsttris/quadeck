import { expect, test, type Page } from '@playwright/test'

// Timers from fixtures/demo/units.json plus Quadeck's demo timer (in memory).
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

test.describe.serial('Timer', () => {
  test('list with schedule, last result and command', async ({ page }) => {
    await login(page)
    await page.goto('/units?filter=timer')
    const rows = page.getByTestId('timer-row')
    await expect(rows).toHaveCount(5)
    await expect(rows.filter({ hasText: 'restic-backup.timer' })).toContainText('täglich 03:30')
    await expect(rows.filter({ hasText: 'restic-backup.timer' })).toContainText('restic backup')
    await expect(rows.filter({ hasText: 'backup-offsite.timer' })).toContainText('Fehler (Exit 1)')
    await expect(rows.filter({ hasText: 'podman-aufraeumen.timer' })).toContainText('Quadeck')
  })

  test('create a timer with the builder, see next runs and the unit files', async ({ page }) => {
    await login(page)
    await page.goto('/units?filter=timer')
    await page.getByRole('button', { name: '+ Neuer Zeitplan' }).click()
    const dialog = page.getByRole('dialog', { name: 'Neuer Zeitplan' })
    await dialog.getByLabel('Name').fill('fotos-sichern')
    await dialog.getByLabel('Beschreibung').fill('Fotos sichern')
    await dialog.getByLabel(/Befehl/).fill('rsync -a /srv/fotos/ /mnt/backup/fotos/')
    await dialog.getByRole('button', { name: 'Wöchentlich' }).click()
    await dialog.getByRole('button', { name: 'Mi', exact: true }).click()
    await dialog.getByLabel('Uhrzeit').fill('04:15')
    await expect(dialog.getByTestId('calendar-expr')).toHaveText('OnCalendar=Mon,Wed *-*-* 04:15:00')
    await expect(dialog.getByTestId('next-runs')).toContainText(/(Mo|Mi) \d\d\.\d\d\. 04:15/)
    await dialog.getByRole('tab', { name: 'Unit-Dateien' }).click()
    await expect(dialog.getByTestId('timer-files')).toContainText('ExecStart=/bin/sh -c "rsync -a /srv/fotos/ /mnt/backup/fotos/"')
    await dialog.getByRole('button', { name: 'Speichern' }).click()
    await unlockIfAsked(page)
    await expect(dialog).toBeHidden()
    await expect(page.getByTestId('timer-row').filter({ hasText: 'fotos-sichern.timer' })).toContainText('Mo, Mi 04:15')
  })

  test('cron import, override a foreign schedule and reset it', async ({ page }) => {
    await login(page)
    await page.goto('/units?filter=timer')
    await page.getByRole('button', { name: 'Zeitplan von restic-backup.timer ändern' }).click()
    const dialog = page.getByRole('dialog', { name: 'Zeitplan von restic-backup.timer' })
    await dialog.getByRole('button', { name: 'Eigener' }).click()
    await dialog.getByText('Von cron übernehmen').click()
    await dialog.getByLabel('Cron-Ausdruck').fill('0 2 * * 1-5')
    await expect(dialog).toContainText('Mon..Fri *-*-* 02:00:00')
    await dialog.getByRole('button', { name: 'Übernehmen', exact: true }).first().click()
    await expect(dialog.getByTestId('calendar-expr')).toHaveText('OnCalendar=Mon..Fri *-*-* 02:00:00')
    await dialog.getByRole('button', { name: 'Übernehmen', exact: true }).last().click()
    await unlockIfAsked(page)
    await expect(dialog).toBeHidden()
    const row = page.getByTestId('timer-row').filter({ hasText: 'restic-backup.timer' })
    await expect(row).toContainText('Mo–Fr 02:00')
    await expect(row).toContainText('angepasst')

    await page.getByRole('button', { name: 'Zeitplan von restic-backup.timer ändern' }).click()
    await dialog.getByRole('button', { name: 'Standard wiederherstellen' }).click()
    await expect(row).toContainText('täglich 03:30')
    await expect(row).not.toContainText('angepasst')
  })

  test('run now, disable, edit and delete own timer', async ({ page }) => {
    await login(page)
    await page.goto('/units?filter=timer')
    const offsite = page.getByTestId('timer-row').filter({ hasText: 'backup-offsite.timer' })
    await page.getByRole('button', { name: 'backup-offsite.timer jetzt ausführen' }).click()
    await unlockIfAsked(page)
    await expect(offsite).toContainText('ok')
    await page.getByRole('switch', { name: 'fotos-sichern.timer aktiv' }).click()
    await expect(page.getByRole('switch', { name: 'fotos-sichern.timer aktiv' })).not.toBeChecked()

    await page.getByRole('button', { name: 'fotos-sichern.timer bearbeiten' }).click()
    const dialog = page.getByRole('dialog', { name: 'Zeitplan fotos-sichern bearbeiten' })
    await expect(dialog.getByLabel('Name')).toHaveValue('fotos-sichern')
    await expect(dialog.getByRole('button', { name: 'Wöchentlich' })).toHaveAttribute('aria-pressed', 'true')
    await dialog.getByRole('button', { name: 'Löschen' }).click()
    await page.getByRole('dialog', { name: 'fotos-sichern.timer löschen?' }).getByRole('button', { name: 'Löschen' }).click()
    await expect(page.getByTestId('timer-row').filter({ hasText: 'fotos-sichern.timer' })).toHaveCount(0)
  })
})
