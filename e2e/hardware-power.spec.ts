import { expect, test, type Page } from '@playwright/test'

// Demo: FixturePower samples (RAPL counter, four HDDs and an NVMe) and a seeded year of energy.
const PASSWORD = 'e2e-password-123'

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Passwort').fill(PASSWORD)
  await page.getByRole('button', { name: 'Anmelden' }).click()
  await expect(page).toHaveURL('/')
}

test('power: now per component, history, disks, settings and the overview card', async ({ page }) => {
  await login(page)

  // Overview card, its dialog leads to the details
  const card = page.getByTestId('metric-card-power')
  await expect(card).toContainText(/\d+ W/, { timeout: 40_000 })
  await expect(card).toContainText('kWh/Tag')
  await card.click()
  const dialog = page.getByRole('dialog', { name: /Strom/ })
  await dialog.getByRole('link', { name: /Aufteilung, Verbrauch und Kosten/ }).click()
  await expect(page).toHaveURL('/hardware?tab=power')

  const now = page.getByRole('region', { name: 'Jetzt' })
  await expect(page.getByTestId('energy-total')).toHaveText(/^\d+(,\d)? W$/)
  await expect(page.getByTestId('energy-cpu')).toContainText(/gemessen|geschätzt/)
  await expect(page.getByTestId('energy-gpu')).toContainText('vom Grafiktreiber gemeldet')
  await expect(page.getByTestId('energy-disks')).toContainText('geschätzt')
  await expect(page.getByTestId('energy-disks')).toContainText('im Standby')
  await expect(page.getByTestId('energy-rest')).toContainText('Grundwert 15 W + 10 % Netzteil-Verlust')
  await expect(now).toContainText('Aufs Jahr')

  // History: 30 days by default, 12 months on request
  const history = page.getByRole('region', { name: 'Verbrauch' })
  const bars = history.getByTestId('energy-bars').getByRole('listitem')
  expect(await bars.count()).toBeGreaterThanOrEqual(30)
  await history.getByRole('button', { name: '12 Monate' }).click()
  await expect(bars).toHaveCount(12)
  await expect(history).toContainText('Spitze:')
  await history.getByRole('button', { name: '24 h' }).click()
  expect(await bars.count()).toBeGreaterThanOrEqual(23)

  // Disks: estimated from type and state, standby savings
  const disks = page.getByRole('region', { name: 'Festplatten im Detail' })
  await expect(disks.getByTestId('energy-disk')).toHaveCount(5)
  await expect(disks.getByTestId('energy-disk').filter({ hasText: 'sdd' })).toContainText('0,8 W')
  await expect(disks.getByTestId('energy-disk').filter({ hasText: 'nvme0n1' })).toContainText('NVMe')
  await expect(disks).toContainText('Der Standby der Platten spart etwa')

  // Settings
  await now.getByRole('button', { name: 'Einstellungen …' }).click()
  const settings = page.getByRole('dialog', { name: 'Strom – Einstellungen' })
  await settings.getByLabel('Strompreis').fill('0,40')
  await settings.getByLabel('Grundwert für den Rest').fill('20')
  await settings.getByRole('button', { name: 'Speichern' }).click()
  await expect(page.getByRole('status')).toContainText('Einstellungen gespeichert')
  await expect(now).toContainText('0,40 €/kWh')
  await expect(page.getByTestId('energy-rest')).toContainText('Grundwert 20 W')
  await now.getByRole('button', { name: 'Einstellungen …' }).click()
  await settings.getByLabel('Netzteil-Verlust').fill('80')
  await settings.getByRole('button', { name: 'Speichern' }).click()
  await expect(page.getByRole('status')).toContainText('Verlust 0–50 %')
})
