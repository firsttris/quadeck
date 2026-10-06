import { expect, test, type Page } from '@playwright/test'

// Runs after dashboard.spec.ts (password set there). The demo's first AUR update fails like a
// broken PKGBUILD; the job dialog explains it and the second run succeeds.
const PASSWORD = 'e2e-password-123'

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Passwort').fill(PASSWORD)
  await page.getByRole('button', { name: 'Anmelden' }).click()
  await expect(page).toHaveURL('/')
}

async function unlockIfAsked(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Aktionen entsperren' })
  if (await dialog.isVisible().catch(() => false)) {
    await dialog.getByLabel('Passwort').fill(PASSWORD)
    await dialog.getByRole('button', { name: 'Entsperren' }).click()
    await expect(dialog).toBeHidden()
  }
}

test('a failed AUR update explains itself: package, marked lines, AUR page, try again', async ({ page }) => {
  await login(page)
  await page.goto('/system')
  const aur = page.getByRole('region', { name: 'AUR' })
  await aur.getByRole('button', { name: 'AUR aktualisieren (1)' }).click()
  await page.getByRole('dialog', { name: 'AUR-Pakete aktualisieren?' }).getByRole('button', { name: 'Aktualisieren' }).click()
  await page.waitForTimeout(300)
  await unlockIfAsked(page)

  const job = page.getByRole('dialog', { name: 'AUR-Update' })
  await expect(job).toContainText('fehlgeschlagen')
  const hint = job.getByRole('region', { name: 'Hinweis zum Fehler' })
  await expect(hint.getByRole('heading')).toHaveText('visual-studio-code-bin ließ sich nicht bauen')
  await expect(hint).toContainText('das System läuft weiter')
  await expect(hint.getByRole('link', { name: 'AUR-Seite von visual-studio-code-bin' })).toHaveAttribute('href', 'https://aur.archlinux.org/packages/visual-studio-code-bin')
  await expect(hint.getByRole('link', { name: 'Im Terminal öffnen' })).toBeVisible()
  // the lines the hint is about are marked in the output
  await expect(job.getByLabel('Ausgabe').locator('.hl').first()).toHaveText('==> ERROR: A failure occurred in package().')

  await job.getByRole('button', { name: 'Schließen' }).click()
  await aur.getByRole('button', { name: 'AUR aktualisieren (1)' }).click()
  await page.getByRole('dialog', { name: 'AUR-Pakete aktualisieren?' }).getByRole('button', { name: 'Aktualisieren' }).click()
  const again = page.getByRole('dialog', { name: 'AUR-Update' })
  await expect(again).toContainText('erfolgreich')
  await expect(again.getByRole('region', { name: 'Hinweis zum Fehler' })).toHaveCount(0)
})
