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

  test('text files open in the editor; keys only after the unlock; binaries are refused', async ({ page }) => {
    await login(page)
    await page.goto('/files?path=%2Fsrv%2Fscripts')
    const files = page.getByRole('region', { name: 'Ordnerinhalt' })
    await expect(files.getByTestId('file-row')).toHaveCount(5) // .env hidden

    // Read without unlocking, save after it, with the diff first.
    await files.getByRole('button', { name: 'backup.sh öffnen' }).click()
    const editor = page.getByRole('dialog', { name: 'backup.sh' })
    await expect(editor).toContainText('tristan · 664')
    const text = editor.getByLabel('Inhalt von backup.sh')
    await expect(text).toHaveValue(/^#!\/bin\/sh\n# Nightly backup/)
    await expect(editor.getByRole('button', { name: 'Weiter' })).toBeDisabled()
    await text.fill((await text.inputValue()) + 'sync\n')
    await editor.getByRole('button', { name: 'Weiter' }).click()
    const confirm = page.getByRole('dialog', { name: 'Änderungen an backup.sh speichern?' })
    await expect(confirm.getByLabel('Änderungen')).toContainText('+ sync')
    await confirm.getByRole('button', { name: 'Speichern' }).click()
    await unlock(page)
    await expect(page.getByRole('status')).toContainText('backup.sh gespeichert')
    await expect(text).toHaveValue(/sync\n$/)
    await editor.getByRole('button', { name: 'Abbrechen' }).click()
    await page.getByRole('button', { name: 'Sperren' }).click()

    // A file without a known ending is sniffed: binary content is not opened.
    await files.getByRole('button', { name: 'firmware öffnen' }).click()
    await expect(page.getByRole('dialog', { name: 'firmware' })).toContainText('keine Textdatei')
    await page.getByRole('dialog', { name: 'firmware' }).getByRole('button', { name: 'Schließen' }).click()

    // Credentials: only after unlocking.
    await page.getByLabel('versteckte').check()
    await files.getByRole('button', { name: '.env öffnen' }).click()
    await unlock(page)
    await expect(page.getByRole('dialog', { name: '.env' }).getByLabel('Inhalt von .env')).toHaveValue('RESTIC_PASSWORD=demo-secret\n')

    // Unsaved changes are not lost by accident.
    await page.getByRole('dialog', { name: '.env' }).getByLabel('Inhalt von .env').fill('X=1\n')
    await page.getByRole('dialog', { name: '.env' }).getByRole('button', { name: 'Abbrechen' }).click()
    await expect(page.getByRole('dialog', { name: 'Ungespeicherte Änderungen verwerfen?' })).toBeVisible()
  })

  test('photos and PDFs open in a new tab, the rest downloads; videos can jump (Range)', async ({ page, context }) => {
    await login(page)
    await page.goto('/files?path=%2Fmnt%2Fdisk2%2FFotos%2F2024')
    const files = page.getByRole('region', { name: 'Ordnerinhalt' })
    const [tab] = await Promise.all([context.waitForEvent('page'), files.getByRole('button', { name: 'IMG_0001.jpg im neuen Tab öffnen' }).click()])
    await tab.waitForLoadState()
    expect(tab.url()).toContain('raw=%2Fmnt%2Fdisk2%2FFotos%2F2024%2FIMG_0001.jpg')
    await tab.close()

    // The same request the browser makes for a video seek.
    const part = await page.request.get('/api/files?raw=%2Fmnt%2Fdisk2%2FFotos%2F2024%2FIMG_0001.jpg', { headers: { range: 'bytes=0-1' } })
    expect(part.status()).toBe(206)
    expect(part.headers()['content-type']).toBe('image/jpeg')
    expect([...(await part.body())]).toEqual([0xff, 0xd8])
    expect((await page.request.get('/api/files?raw=%2Fetc%2Fpasswd')).status()).toBe(403)

    // Download from the row menu; a secret asks for the unlock first.
    await page.goto('/files?path=%2Fsrv%2Fscripts')
    await files.getByRole('button', { name: 'Aktionen für NOTES.txt' }).click()
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Herunterladen' }).click()])
    expect(download.suggestedFilename()).toBe('NOTES.txt')
    expect((await page.request.get('/api/files?raw=%2Fsrv%2Fscripts%2F.env')).status()).toBe(423)
    await page.getByLabel('versteckte').check()
    await files.getByRole('button', { name: 'Aktionen für .env' }).click()
    await page.getByRole('menuitem', { name: 'Herunterladen' }).click()
    const [secret] = await Promise.all([page.waitForEvent('download'), unlock(page)])
    expect(secret.suggestedFilename()).toMatch(/env$/) // Chromium drops the leading dot
  })
})
