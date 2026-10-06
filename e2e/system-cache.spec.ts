import { expect, test, type Page } from '@playwright/test'

// Runs after dashboard.spec.ts (password set there). Demo caches: pacman packages and yay builds.
const PASSWORD = 'e2e-password-123'

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Passwort').fill(PASSWORD)
  await page.getByRole('button', { name: 'Anmelden' }).click()
  await expect(page).toHaveURL('/')
}

test('package cache: sizes, what stays, clean up as a job', async ({ page }) => {
  await login(page)
  await page.goto('/system')
  const panel = page.getByRole('region', { name: 'Paket-Cache' })
  await expect(panel.getByTestId('cache-row')).toHaveCount(2)
  await expect(panel.getByTestId('cache-row').first()).toContainText('Heruntergeladene Pakete')
  await expect(panel.getByTestId('cache-row').first()).toContainText('/var/cache/pacman/pkg')
  await expect(panel.getByTestId('cache-row').nth(1)).toContainText('AUR-Builds (yay, tristan)')
  await expect(panel).toContainText('7,1 GiB')

  await panel.getByRole('button', { name: 'Aufräumen …' }).click()
  const dialog = page.getByRole('dialog', { name: 'Paket-Cache aufräumen?' })
  await expect(dialog).toContainText('Die letzten zwei Versionen jedes installierten Pakets bleiben')
  await expect(dialog).toContainText('die Merkliste für -git-Pakete bleibt')
  // only the AUR builds this time
  await dialog.getByRole('checkbox', { name: /Heruntergeladene Pakete/ }).uncheck()
  await expect(dialog).toContainText('Höchstens 2,9 GiB werden frei')
  await dialog.getByRole('button', { name: 'Aufräumen', exact: true }).click()
  const unlock = page.getByRole('dialog', { name: 'Aktionen entsperren' })
  if (await unlock.isVisible().catch(() => false)) {
    await unlock.getByLabel('Passwort').fill(PASSWORD)
    await unlock.getByRole('button', { name: 'Entsperren' }).click()
  }
  const job = page.getByRole('dialog', { name: 'Paket-Cache aufräumen' })
  await expect(job.getByLabel('Ausgabe')).toContainText('find /home/tristan/.cache/yay -mindepth 1 -maxdepth 1 -type d')
  await expect(job.getByLabel('Ausgabe')).not.toContainText('paccache')
  await expect(job).toContainText('erfolgreich')
  await job.getByRole('button', { name: 'Schließen' }).click()
  await expect(panel.getByTestId('cache-row').nth(1)).toContainText('1 Datei40,0 KiB')
  await expect(panel.getByTestId('cache-row').first()).toContainText('4,2 GiB')
})
