import { expect, test, type Page } from '@playwright/test'

// Demo archives (FixtureFiles): /mnt/disk2/Archiv/fotos-2019.tar.gz and the crafted fremd.tar.gz.
const PASSWORD = 'e2e-password-123'
const SHOTS = process.env.QUADECK_SHOTS

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

async function finishJob(page: Page, title: RegExp) {
  const job = page.getByRole('dialog', { name: title })
  await expect(job).toContainText('erfolgreich')
  await job.getByRole('button', { name: 'Schließen' }).click()
}

test('archives: a crafted one is refused, unpack into a new folder, conflicts, pack again', async ({ page }) => {
  await login(page)
  await page.goto('/files?path=%2Fmnt%2Fdisk2%2FArchiv')
  const files = page.getByRole('region', { name: 'Ordnerinhalt' })

  // The crafted archive: shown, explained, not unpackable
  await files.getByRole('button', { name: 'Aktionen für fremd.tar.gz' }).click()
  await page.getByRole('menuitem', { name: 'Entpacken …' }).click()
  const evil = page.getByRole('dialog', { name: 'fremd.tar.gz entpacken' })
  const problems = evil.getByTestId('unpack-problems')
  await expect(problems).toContainText('../../etc/cron.d/backdoor')
  await expect(problems).toContainText('Verknüpfung nach /root')
  await expect(problems).toContainText('setuid')
  await expect(evil.getByRole('button', { name: 'Entpacken' })).toBeDisabled()
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/unpack-refused.png` })
  await evil.getByRole('button', { name: 'Abbrechen' }).click()

  // The photo archive: into a new folder named after it
  await files.getByRole('button', { name: 'Aktionen für fotos-2019.tar.gz' }).click()
  await page.getByRole('menuitem', { name: 'Entpacken …' }).click()
  const dialog = page.getByRole('dialog', { name: 'fotos-2019.tar.gz entpacken' })
  await expect(dialog.getByTestId('unpack-target')).toContainText('/mnt/disk2/Archiv/fotos-2019 (wird angelegt)')
  await expect(dialog.getByRole('list', { name: 'Prüfungen' })).toContainText('Passt auf die Platte')
  await expect(dialog.getByRole('list', { name: 'Inhalt' })).toContainText('fotos-2019/urlaub/IMG_2019_001.jpg')
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/unpack.png` })
  await dialog.getByRole('button', { name: 'Entpacken' }).click()
  await unlockIfAsked(page)
  await finishJob(page, /Entpacken: fotos-2019.tar.gz/)
  await expect(files.getByRole('checkbox', { name: 'fotos-2019 auswählen', exact: true })).toBeVisible()

  // Again, into the same folder ("Hierher" puts fotos-2019/ next to the existing one): asks before overwriting
  await files.getByRole('button', { name: 'Aktionen für fotos-2019.tar.gz' }).click()
  await page.getByRole('menuitem', { name: 'Entpacken …' }).click()
  await dialog.getByRole('button', { name: 'Hierher' }).click()
  await expect(dialog).toContainText('Gibt es im Ziel schon: fotos-2019')
  await expect(dialog.getByRole('button', { name: 'Entpacken' })).toBeDisabled()
  await dialog.getByRole('checkbox', { name: /Vorhandene Dateien überschreiben/ }).check()
  await expect(dialog.getByRole('button', { name: 'Entpacken' })).toBeEnabled()
  await dialog.getByRole('button', { name: 'Abbrechen' }).click()

  // Pack the new folder as .tar.gz
  await files.getByRole('checkbox', { name: 'fotos-2019 auswählen' }).check()
  await files.getByRole('button', { name: 'Packen …' }).click()
  const pack = page.getByRole('dialog', { name: 'fotos-2019 packen' })
  await pack.getByLabel('Format').selectOption('tar.gz')
  await pack.getByLabel('Name').fill('sicherung')
  await expect(pack).toContainText('/mnt/disk2/Archiv/sicherung.tar.gz')
  await pack.getByRole('button', { name: 'Packen' }).click()
  await finishJob(page, /Packen: sicherung/)
  await expect(files.getByTestId('file-row').filter({ hasText: 'sicherung.tar.gz' })).toBeVisible()

  // …and that one unpacks again (same checks)
  await files.getByRole('button', { name: 'Aktionen für sicherung.tar.gz' }).click()
  await page.getByRole('menuitem', { name: 'Entpacken …' }).click()
  await expect(page.getByRole('dialog', { name: 'sicherung.tar.gz entpacken' }).getByRole('list', { name: 'Inhalt' })).toContainText('fotos-2019/urlaub')
})
