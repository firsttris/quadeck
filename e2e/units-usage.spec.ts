import { expect, test, type Page } from '@playwright/test'

// Demo: 30 seeded days for the fixture containers (the stopped ones ran until three days ago).
const PASSWORD = 'e2e-password-123'

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Passwort').fill(PASSWORD)
  await page.getByRole('button', { name: 'Anmelden' }).click()
  await expect(page).toHaveURL('/')
}

test('container usage over days: ranking, ranges, sorting, history dialog', async ({ page }) => {
  await login(page)
  await page.goto('/units')
  await page.getByRole('link', { name: 'Verbrauch über Zeit' }).click()
  await expect(page).toHaveURL('/units?view=usage')
  const view = page.getByRole('region', { name: 'CPU und RAM pro Container' })
  const rows = view.getByTestId('usage-row')
  await expect(rows).toHaveCount(6) // running in the last 24 hours
  await expect(rows.first()).toContainText('jellyfin') // the busiest by CPU
  await view.getByRole('button', { name: '7 Tage' }).click()
  await expect(rows).toHaveCount(8) // the stopped ones ran within the week
  await expect(rows.filter({ hasText: 'qbittorrent' })).toContainText('qbittorrent.service')
  await view.getByRole('button', { name: 'nach RAM' }).click()
  const firstByRam = await rows.first().locator('td').first().innerText()
  expect(firstByRam).toMatch(/immich-server|jellyfin/)

  await view.getByRole('button', { name: 'Verlauf von jellyfin' }).click()
  const dialog = page.getByRole('dialog', { name: 'Verbrauch: jellyfin' })
  await expect(dialog.getByRole('region', { name: 'CPU' })).toContainText(/Ø .* %/)
  await expect(dialog.getByRole('region', { name: 'RAM' })).toContainText(/MiB|GiB/)
  await dialog.getByRole('button', { name: '30 Tage' }).click()
  await expect(dialog.getByRole('button', { name: '30 Tage' })).toHaveAttribute('aria-pressed', 'true')
  await dialog.getByRole('button', { name: 'Schließen' }).click()
  await expect(page).toHaveURL('/units?view=usage')

  // from a row's menu in the list
  await page.goto('/units?filter=container')
  await page.getByRole('button', { name: 'Aktionen für caddy.service' }).click()
  await page.getByRole('menuitem', { name: 'Verbrauch über Zeit' }).click()
  await expect(page.getByRole('dialog', { name: 'Verbrauch: caddy' })).toBeVisible()
})
