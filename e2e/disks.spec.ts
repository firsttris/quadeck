import { expect, test, type Page } from '@playwright/test'

// Runs after dashboard.spec.ts. smartctl output from fixtures/demo/smart; trends are seeded.
const PASSWORD = 'e2e-password-123'

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

test.describe.serial('Festplatten', () => {
  test('SMART on the overview, verdicts, advice, details with trends, self-test', async ({ page }) => {
    await login(page)
    // Storage card: dot per disk, nav badge for the two disks with findings.
    const storage = page.getByRole('region', { name: 'Speicher' })
    await expect(storage.getByRole('img', { name: 'SMART: Warnung' })).toHaveCount(2)
    await expect(page.getByRole('link', { name: /Festplatten\s*2/ })).toBeVisible()

    await storage.getByRole('link', { name: 'SMART' }).click()
    await expect(page.getByTestId('smart-disk')).toHaveCount(5)
    const sdb = page.getByRole('region', { name: 'Platte sdb' })
    await expect(sdb).toContainText('Warnung')
    await expect(sdb.getByRole('list', { name: 'Befund' })).toContainText('8 Sektoren wurden ersetzt')
    await expect(page.getByRole('region', { name: 'Platte sdd' })).toContainText('schläft')
    await expect(page.getByRole('region', { name: 'Platte nvme0n1' })).toContainText('7 %')
    const advice = page.getByRole('region', { name: 'Handlungsbedarf' })
    await expect(advice).toContainText('Ersatz besorgen')
    await expect(advice).toContainText('SATA-Kabel')
    // CRC errors count for life; the demo history shows them still growing this week.
    await expect(page.getByRole('region', { name: 'Platte sdc' }).getByRole('list', { name: 'Befund' })).toContainText(/neue Übertragungsfehler \(CRC\) seit .* insgesamt 14/)

    await sdb.getByRole('button', { name: 'Details zu sdb' }).click()
    const dialog = page.getByRole('dialog', { name: /sdb · WDC/ })
    await expect(dialog.getByRole('region', { name: 'Fehlerzähler' }).locator('path.chart-line').first()).toHaveAttribute('d', /C/)
    await expect(dialog.getByRole('table', { name: 'SMART-Attribute' })).toContainText('Current_Pending_Sector')
    await dialog.getByRole('button', { name: '1 Jahr' }).click()
    await expect(dialog.getByRole('button', { name: '1 Jahr' })).toHaveAttribute('aria-pressed', 'true')
    await dialog.getByRole('button', { name: 'Schließen' }).click()

    const sda = page.getByRole('region', { name: 'Platte sda' })
    await sda.getByRole('button', { name: 'Kurztest' }).click()
    await unlock(page)
    await expect(sda).toContainText('Selbsttest läuft')
  })
})

test.describe.serial('Dateien', () => {
  test('browse, new folder, copy and paste, rename, delete', async ({ page }) => {
    await login(page)
    await page.goto('/files')
    await expect(page.getByRole('region', { name: 'Bereiche' })).toContainText('/mnt/disk1')
    const files = page.getByRole('region', { name: 'Ordnerinhalt' })
    await expect(files.getByTestId('file-row')).toHaveCount(3) // Downloads, Filme, Serien
    await files.getByRole('button', { name: 'Downloads' }).click()
    await expect(page).toHaveURL(/path=%2Fmnt%2Fdisk1%2FDownloads/)
    await expect(files.getByTestId('file-row')).toHaveCount(2)

    // Copy alt.zip, paste into a new folder.
    await files.getByRole('checkbox', { name: 'alt.zip auswählen' }).check()
    await files.getByRole('button', { name: 'Kopieren' }).click()
    await expect(files.getByTestId('clipboard')).toContainText('Kopiert: alt.zip')
    await files.getByRole('button', { name: 'Neuer Ordner' }).click()
    const name = page.getByRole('dialog', { name: 'Neuer Ordner' })
    await name.getByLabel('Name').fill('Archiv')
    await name.getByRole('button', { name: 'Speichern' }).click()
    await unlock(page)
    await expect(files.getByTestId('file-row').filter({ hasText: 'Archiv' })).toBeVisible()
    await files.getByRole('button', { name: 'Archiv' }).click()
    await files.getByRole('button', { name: /Einfügen/ }).click()
    const job = page.getByRole('dialog', { name: /Kopieren: alt.zip/ })
    await expect(job).toContainText('erfolgreich')
    await job.getByRole('button', { name: 'Schließen' }).click()
    await expect(files.getByTestId('file-row').filter({ hasText: 'alt.zip' })).toBeVisible()

    // Pasting again asks before overwriting.
    await files.getByRole('button', { name: /Einfügen/ }).click()
    await expect(page.getByRole('dialog', { name: 'Im Ziel schon vorhanden' })).toContainText('alt.zip')
    await page.getByRole('dialog', { name: 'Im Ziel schon vorhanden' }).getByRole('button', { name: 'Abbrechen' }).click()

    // Rename, then delete.
    await files.getByRole('checkbox', { name: 'alt.zip auswählen' }).check()
    await files.getByRole('button', { name: 'Umbenennen' }).click()
    const rename = page.getByRole('dialog', { name: '„alt.zip“ umbenennen' })
    await rename.getByLabel('Name').fill('../etc')
    await expect(rename).toContainText('kein „/“')
    await rename.getByLabel('Name').fill('alt-2019.zip')
    await rename.getByRole('button', { name: 'Speichern' }).click()
    await expect(files.getByTestId('file-row').filter({ hasText: 'alt-2019.zip' })).toBeVisible()
    await files.getByRole('checkbox', { name: 'alt-2019.zip auswählen' }).check()
    await files.getByRole('button', { name: 'Löschen' }).click()
    await page.getByRole('dialog', { name: '„alt-2019.zip“ löschen?' }).getByRole('button', { name: 'Endgültig löschen' }).click()
    const del = page.getByRole('dialog', { name: /Löschen: alt-2019.zip/ })
    await expect(del).toContainText('erfolgreich')
    await del.getByRole('button', { name: 'Schließen' }).click()
    await expect(files.getByTestId('file-row')).toHaveCount(0)

    // Outside the data areas: refused.
    await page.goto('/disks?tab=files&path=/etc') // old link redirects
    await expect(page).toHaveURL(/\/files\?path=%2Fetc/)
    await expect(page.getByRole('region', { name: 'Ordnerinhalt' })).toContainText('außerhalb der freigegebenen Bereiche')
  })
})
