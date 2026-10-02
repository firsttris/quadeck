import { expect, test, type Page } from '@playwright/test'

// fixtures/demo/fstab + blockdevices.json, kept in memory by the demo helper.
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

const entry = (page: Page, target: string) => page.getByTestId('fstab-entry').filter({ has: page.getByText(target, { exact: true }) })

test.describe.serial('Einhängen (fstab)', () => {
  test('list: own entries with state, system entries read-only, free devices', async ({ page }) => {
    await login(page)
    await page.goto('/disks')
    await page.getByRole('tab', { name: 'Einhängen' }).click()
    await expect(page).toHaveURL(/tab=mounts/)
    await expect(entry(page, '/mnt/disk1')).toContainText('eingehängt')
    await expect(entry(page, '/mnt/disk3')).toContainText('blockiert den Start, wenn sie fehlt')
    await expect(entry(page, '/mnt/archiv')).toContainText('Gerät fehlt')
    await expect(entry(page, '/mnt/storage')).toContainText('genutzt von SMB-Freigabe [Medien]')
    await expect(page.getByTestId('fstab-entry').filter({ hasText: '/boot' })).toHaveCount(0)
    await expect(page.getByTestId('system-entry')).toHaveCount(4)
    await expect(page.getByTestId('free-device')).toHaveCount(3)
  })

  test('add a disk: options explained, boot risk shown, checked, test mount, mounted', async ({ page }) => {
    await login(page)
    await page.goto('/disks?tab=mounts')
    await page.getByTestId('free-device').filter({ hasText: '/dev/sde1' }).getByRole('button', { name: /Einbinden/ }).click()
    const dialog = page.getByRole('dialog', { name: '/dev/sde1 einbinden' })
    await expect(dialog.getByLabel('Einhängepunkt')).toHaveValue('/mnt/backup')
    await expect(dialog.getByLabel('fstab-Zeile')).toContainText('UUID=d3e4f5a6-b7c8-4d9e-8f01-2a3b4c5d6e7f  /mnt/backup  ext4  nofail,x-systemd.device-timeout=10s,noatime  0  2')

    // Without nofail the dialog says what that means.
    await dialog.getByLabel(/Start auch ohne diese Platte/).uncheck()
    await expect(dialog).toContainText('Ohne nofail hält der Server beim Start im Notfallmodus an')
    await expect(dialog).toContainText('beim Speichern musst du das ausdrücklich bestätigen')
    await dialog.getByLabel(/Start auch ohne diese Platte/).check()

    await dialog.getByLabel('Einhängepunkt').fill('/etc')
    await expect(dialog).toContainText('Systemverzeichnis')
    await expect(dialog.getByRole('button', { name: /Weiter/ })).toBeDisabled()
    await dialog.getByLabel('Einhängepunkt').fill('/mnt/backup')
    await expect(dialog).toContainText('Geprüft')
    await dialog.getByRole('button', { name: /Weiter/ }).click()

    const confirm = page.getByRole('dialog', { name: '/dev/sde1 einbinden' })
    await expect(confirm.getByRole('list', { name: 'Schritte' })).toContainText('Probemount')
    await expect(confirm.getByLabel('Änderungen')).toContainText('# quadeck: Backup – WDC WD40EFRX-68N32N0')
    await confirm.getByRole('button', { name: 'Prüfen und speichern' }).click()
    await unlock(page)
    await expect(entry(page, '/mnt/backup')).toContainText('eingehängt')
    await expect(page.getByTestId('free-device')).toHaveCount(2)
    await expect(page.getByRole('button', { name: /Verlauf/ })).toBeVisible()
  })

  test('a failing test mount leaves fstab untouched', async ({ page }) => {
    await login(page)
    await page.goto('/disks?tab=mounts')
    await page.getByTestId('free-device').filter({ hasText: '/dev/sdf1' }).getByRole('button', { name: /Einbinden/ }).click()
    const dialog = page.getByRole('dialog', { name: '/dev/sdf1 einbinden' })
    await expect(dialog.getByLabel('Benutzer-ID (uid)')).toHaveValue('1000')
    await dialog.getByLabel(/Weitere Optionen/).fill('compress=zstd')
    await expect(dialog).toContainText('kennt Quadeck für exfat nicht')
    await dialog.getByRole('button', { name: /Weiter/ }).click()
    await page.getByRole('dialog', { name: '/dev/sdf1 einbinden' }).getByRole('button', { name: 'Prüfen und speichern' }).click()
    await unlock(page)
    await expect(page.getByRole('alert')).toContainText('Probemount fehlgeschlagen – fstab bleibt unverändert')
    await page.getByRole('dialog', { name: '/dev/sdf1 einbinden' }).getByRole('button', { name: 'Abbrechen' }).click()
    await expect(page.getByTestId('free-device').filter({ hasText: '/dev/sdf1' })).toBeVisible()
  })

  test('change options, unmount and mount, remove an old entry', async ({ page }) => {
    await login(page)
    await page.goto('/disks?tab=mounts')
    await page.getByRole('button', { name: '/mnt/disk3 bearbeiten' }).click()
    const edit = page.getByRole('dialog', { name: '/mnt/disk3 bearbeiten' })
    await edit.getByLabel(/Start auch ohne diese Platte/).check()
    await edit.getByRole('button', { name: /Weiter/ }).click()
    const confirm = page.getByRole('dialog', { name: '/mnt/disk3 ändern' })
    await expect(confirm.getByRole('list', { name: 'Schritte' })).toContainText('neu einhängen (remount)')
    await confirm.getByRole('button', { name: 'Prüfen und speichern' }).click()
    await unlock(page)
    await expect(entry(page, '/mnt/disk3')).toContainText('Start auch ohne sie')

    await entry(page, '/mnt/disk2').getByRole('button', { name: 'Aushängen' }).click()
    await expect(entry(page, '/mnt/disk2')).toContainText('nicht eingehängt')
    await entry(page, '/mnt/disk2').getByRole('button', { name: 'Einhängen' }).click()
    await expect(entry(page, '/mnt/disk2')).toContainText('eingehängt')

    await page.getByRole('button', { name: '/mnt/archiv entfernen' }).click()
    const remove = page.getByRole('dialog', { name: '/mnt/archiv entfernen' })
    await expect(remove.getByLabel('Änderungen')).toContainText('LABEL=Archiv')
    await remove.getByRole('button', { name: 'Entfernen' }).click()
    await expect(entry(page, '/mnt/archiv')).toHaveCount(0)
  })
})
