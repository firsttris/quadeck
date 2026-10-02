import { expect, test, type Page } from '@playwright/test'

// fixtures/demo/boot.json: systemd-boot with two kernels, loader on the ESP older than the package.
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

test('boot: entries, warnings, timeout, default, kernel parameters, one-time reboot', async ({ page }) => {
  await login(page)
  await page.goto('/system')
  await page.getByRole('tab', { name: 'Boot und Neustart' }).click()
  await expect(page).toHaveURL(/tab=boot/)
  await expect(page.getByRole('region', { name: 'Hinweise zum Start' })).toContainText('älter als das installierte systemd')
  await expect(page.getByTestId('boot-entry')).toHaveCount(3)
  await expect(page.getByTestId('boot-entry').first()).toContainText('Standard')
  await expect(page.getByTestId('boot-entry').first()).toContainText('läuft gerade')
  await expect(page.getByTestId('kernel-param').filter({ hasText: 'i915.enable_guc' })).toContainText('QuickSync')

  await page.getByLabel('Wartezeit im Bootmenü').selectOption('menu-hidden')
  await unlock(page)
  await expect(page.getByLabel('Wartezeit im Bootmenü')).toHaveValue('menu-hidden')
  await expect(page.getByRole('region', { name: 'Bootloader' })).toContainText('gesetzt per bootctl')

  await page.getByRole('button', { name: 'Bootloader aktualisieren' }).click()
  await expect(page.getByRole('region', { name: 'Hinweise zum Start' })).not.toContainText('älter als')
  await expect(page.getByRole('region', { name: 'Hinweise zum Start' })).toContainText('Nur ein Kernel')

  // Second kernel: install, add its entry, boot it once.
  const lts = page.getByTestId('kernel').filter({ hasText: 'linux-lts' })
  await expect(page.getByTestId('kernel').filter({ hasText: 'Aktuell' })).toContainText('läuft gerade')
  await expect(page.getByRole('button', { name: 'linux entfernen' })).toBeDisabled()
  await lts.getByRole('button', { name: 'Installieren' }).click()
  const job = page.getByRole('dialog', { name: /Kernel installieren: linux-lts/ })
  await expect(job).toContainText('erfolgreich')
  await job.getByRole('button', { name: 'Schließen' }).click()
  await expect(lts).toContainText('kein Boot-Eintrag')
  await lts.getByRole('button', { name: 'Boot-Eintrag anlegen …' }).click()
  const entry = page.getByRole('dialog', { name: 'Boot-Eintrag für linux-lts anlegen?' })
  await expect(entry.getByLabel('Neuer Eintrag')).toContainText('linux   /vmlinuz-linux-lts')
  await entry.getByRole('button', { name: 'Anlegen' }).click()
  await expect(page.getByTestId('boot-entry')).toHaveCount(4)
  await expect(page.getByRole('region', { name: 'Hinweise zum Start' })).toHaveCount(0)

  const ltsEntry = page.getByTestId('boot-entry').filter({ hasText: 'linux-lts' })
  await ltsEntry.getByRole('button', { name: 'Als Standard' }).click()
  await expect(ltsEntry).toContainText('Standard')
  await expect(lts.getByRole('button', { name: 'linux-lts entfernen' })).toBeDisabled() // it is the default now
  await page.getByTestId('boot-entry').first().getByRole('button', { name: 'Als Standard' }).click()
  await expect(page.getByTestId('boot-entry').first()).toContainText('Standard')

  // Remove it again: the entry then points to nothing and can go too.
  await lts.getByRole('button', { name: 'linux-lts entfernen' }).click()
  await page.getByRole('dialog', { name: 'linux-lts entfernen?' }).getByRole('button', { name: 'Entfernen' }).click()
  const removeJob = page.getByRole('dialog', { name: /Kernel entfernen: linux-lts/ })
  await expect(removeJob).toContainText('erfolgreich')
  await removeJob.getByRole('button', { name: 'Schließen' }).click()
  await expect(ltsEntry).toContainText('fehlt: /vmlinuz-linux-lts')
  await ltsEntry.getByRole('button', { name: /Eintrag .* entfernen/ }).click()
  await expect(page.getByTestId('boot-entry')).toHaveCount(3)

  const old = page.getByTestId('boot-entry').nth(1)
  await old.getByRole('button', { name: /Einmalig mit .* neu starten/ }).click()
  const confirm = page.getByRole('dialog', { name: 'Einmalig mit diesem Eintrag neu starten?' })
  await expect(confirm).toContainText('Fallback')
  await confirm.getByRole('button', { name: 'Jetzt neu starten' }).click()
  await expect(page.getByRole('region', { name: 'Neustart läuft' })).toContainText('Der Server startet neu')
})
