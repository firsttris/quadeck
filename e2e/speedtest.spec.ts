import { expect, test } from '@playwright/test'

const PASSWORD = 'e2e-password-123'

test('speed test: this device ↔ server live in the browser, server ↔ internet with progress, both units, history', async ({ page }) => {
  test.setTimeout(60_000)
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
})
