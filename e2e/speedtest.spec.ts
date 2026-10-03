import { expect, test } from '@playwright/test'

const PASSWORD = 'e2e-password-123'

test('speed test: this device ↔ server live in the browser, server ↔ internet with progress, both units, history', async ({ page }) => {
  test.setTimeout(90_000)
  await page.goto('/login')
  await page.getByLabel('Passwort').fill(PASSWORD)
  await page.getByRole('button', { name: 'Anmelden' }).click()
  await expect(page).toHaveURL('/')
  await page.goto('/network?tab=speed')

  const client = page.getByTestId('speed-client')
  await expect(client).toContainText('Noch nicht gemessen')
  await client.getByRole('button', { name: 'Test starten' }).click()
  await expect(client.getByRole('button', { name: 'Misst …' })).toBeDisabled()
  await expect(client.getByRole('list', { name: 'Ablauf' })).toContainText('✓ Ping', { timeout: 10_000 })
  await expect(client.getByTestId('speed-result')).toBeVisible({ timeout: 25_000 })
  await expect(client.getByTestId('speed-result')).toContainText(/Mbit\/s\s*= [\d.,]+ MB\/s/)

  const internet = page.getByTestId('speed-internet')
  await internet.getByRole('button', { name: 'Test starten' }).click()
  await expect(internet.getByTestId('speed-result')).toBeVisible({ timeout: 15_000 })
  await expect(internet).toContainText('FRA')
  await expect(page.getByTestId('speed-row')).toHaveCount(2)
  await expect(page.getByTestId('speed-row').first()).toContainText('Server ↔ Internet · FRA')

  // kept after a reload
  await page.reload()
  await expect(page.getByTestId('speed-row')).toHaveCount(2)

  // The graph over time (the demo has two months of daily measurements).
  const chart = page.getByTestId('speed-chart')
  await expect(chart).toContainText('Verlauf der Internetleitung')
  await chart.getByRole('button', { name: '90 Tage' }).click()
  await expect(chart.getByRole('button', { name: '90 Tage' })).toHaveAttribute('aria-pressed', 'true')
  await expect(chart.locator('svg').first()).toBeVisible()

  // Measuring automatically is off until switched on (after the unlock).
  const auto = page.getByTestId('speed-auto')
  await expect(auto.getByLabel('Wie oft')).toBeDisabled()
  await auto.getByRole('checkbox', { name: 'Automatisch messen' }).check()
  const unlock = page.getByRole('dialog', { name: 'Aktionen entsperren' })
  await unlock.getByLabel('Passwort').fill(PASSWORD)
  await unlock.getByRole('button', { name: 'Entsperren' }).click()
  await expect(auto).toContainText('Nächste Messung:')
  await auto.getByLabel('Wie oft').selectOption('6h')
  await page.reload()
  await expect(page.getByTestId('speed-auto').getByLabel('Wie oft')).toHaveValue('6h')

  // The notification rule: off by default, with a relative or fixed limit.
  await page
    .getByTestId('speed-auto')
    .getByRole('link', { name: /Benachrichtigung/ })
    .click()
  await expect(page).toHaveURL(/\/notifications/)
  const rule = page.getByRole('checkbox', { name: /Internet langsam oder weg/ })
  await expect(rule).not.toBeChecked()
  await expect(page.getByLabel('Grenze')).toHaveValue('relative')
  await page.getByLabel('Grenze').selectOption('fixed')
  await expect(page.getByLabel('Grenzwert')).toHaveValue('100')
})
