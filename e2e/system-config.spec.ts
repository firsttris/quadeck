import { expect, test, type Page } from '@playwright/test'

// fixtures/demo/packages.json: .pacnew/.pacsave files with contents in configContents.
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

test('config files: diff, keep, replace with initramfs job, merge with sshd check, passwd protected', async ({ page }) => {
  await login(page)
  await page.goto('/system')
  const panel = page.getByRole('region', { name: 'Konfigurationsdateien' })
  await expect(panel.getByTestId('config-file')).toHaveCount(6)

  // passwd: only "keep".
  await panel.getByTestId('config-file').filter({ hasText: '/etc/passwd.pacnew' }).click()
  let dialog = page.getByRole('dialog', { name: '/etc/passwd' })
  await expect(dialog.getByRole('alert')).toContainText('kennt deine Benutzer nicht')
  await expect(dialog.getByRole('button', { name: 'Neue Fassung übernehmen …' })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Meine behalten …' }).click()
  await dialog.getByRole('button', { name: 'Bestätigen' }).click()
  await unlock(page)
  await expect(panel.getByTestId('config-file')).toHaveCount(5)

  // mkinitcpio.conf: the new one would drop sd-encrypt – only merging; then the initramfs is rebuilt.
  await panel.getByTestId('config-file').filter({ hasText: 'mkinitcpio.conf.pacnew' }).click()
  dialog = page.getByRole('dialog', { name: '/etc/mkinitcpio.conf' })
  await expect(dialog.getByLabel('Änderungen')).toContainText('MODULES=(i915 btrfs)')
  await expect(dialog.getByRole('alert')).toContainText('MODULES, HOOKS weichen von der neuen Fassung ab')
  await expect(dialog.getByRole('button', { name: 'Neue Fassung übernehmen …' })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Zusammenführen …' }).click()
  await dialog.getByRole('button', { name: 'Speichern …' }).click()
  await expect(dialog).toContainText('Danach wird das initramfs neu gebaut')
  await dialog.getByRole('button', { name: 'Bestätigen' }).click()
  const job = page.getByRole('dialog', { name: /initramfs neu bauen/ })
  await expect(job).toContainText('erfolgreich')
  await job.getByRole('button', { name: 'Schließen' }).click()
  await expect(panel.getByTestId('config-file')).toHaveCount(4)

  // sshd_config: merge by hand – sshd -t refuses a broken file.
  await panel.getByTestId('config-file').filter({ hasText: 'sshd_config.pacnew' }).click()
  dialog = page.getByRole('dialog', { name: '/etc/ssh/sshd_config' })
  await dialog.getByRole('button', { name: 'Zusammenführen …' }).click()
  const text = dialog.getByLabel('Zusammengeführte Fassung')
  await expect(text).toHaveValue(/^Include/)
  await text.fill('Include /etc/ssh/sshd_config.d/*.conf\nPort zweiundzwanzig\n')
  await dialog.getByRole('button', { name: 'Speichern …' }).click()
  await dialog.getByRole('button', { name: 'Bestätigen' }).click()
  await expect(dialog.getByRole('alert')).toContainText('sshd -t lehnt die Datei ab – nichts geändert')
  await text.fill('Include /etc/ssh/sshd_config.d/*.conf\nPort 22\nUsePAM yes\n')
  await dialog.getByRole('button', { name: 'Speichern …' }).click()
  await dialog.getByRole('button', { name: 'Bestätigen' }).click()
  await expect(panel.getByTestId('config-file')).toHaveCount(3)

  // mirrorlist: take over the new one as it is.
  await panel.getByTestId('config-file').filter({ hasText: 'mirrorlist.pacnew' }).click()
  dialog = page.getByRole('dialog', { name: '/etc/pacman.d/mirrorlist' })
  await dialog.getByRole('button', { name: 'Neue Fassung übernehmen …' }).click()
  await dialog.getByRole('button', { name: 'Bestätigen' }).click()
  await expect(panel.getByTestId('config-file')).toHaveCount(2)

  // A leftover of a removed package: show and delete.
  await panel.getByTestId('config-file').filter({ hasText: 'kde.pacsave' }).click()
  dialog = page.getByRole('dialog', { name: '/etc/pam.d/kde' })
  await expect(dialog.getByLabel('Inhalt')).toContainText('system-local-login')
  await dialog.getByRole('button', { name: 'Löschen …' }).click()
  await dialog.getByRole('button', { name: 'Bestätigen' }).click()
  await expect(panel.getByTestId('config-file')).toHaveCount(1)

  // smb.conf: the new one would lose the shares.
  await panel.getByTestId('config-file').filter({ hasText: 'smb.conf.pacnew' }).click()
  dialog = page.getByRole('dialog', { name: '/etc/samba/smb.conf' })
  await expect(dialog.getByRole('alert')).toContainText('deine Freigaben (Medien, Fotos)')
  await expect(dialog.getByRole('button', { name: 'Neue Fassung übernehmen …' })).toHaveCount(0)
})
