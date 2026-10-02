import { expect, test, type Page } from '@playwright/test'

// Runs after dashboard.spec.ts. In fixture mode the hub seeds a week of demo
// history and reports the GPU from fixtures/demo/gpus.json.
const PASSWORD = 'e2e-password-123'

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Passwort').fill(PASSWORD)
  await page.getByRole('button', { name: 'Anmelden' }).click()
  await expect(page).toHaveURL('/')
  await expect(page.getByRole('img', { name: 'live verbunden' })).toBeVisible()
}

test.describe.serial('Verlauf', () => {
  test('cards show the last hour; a click opens the history with ranges and min/avg/max', async ({ page }) => {
    await login(page)
    for (const id of ['cpu', 'ram', 'temp', 'net', 'gpu']) await expect(page.getByTestId(`metric-card-${id}`)).toBeVisible()
    await expect(page.getByTestId('metric-card-gpu')).toContainText('Intel Arc A380')
    // The mini chart has drawn a line.
    await expect(page.getByRole('img', { name: 'CPU, letzte Stunde' }).locator('path.chart-line')).toHaveAttribute('d', /C/)

    await page.getByRole('button', { name: 'CPU: Verlauf öffnen' }).click()
    const dialog = page.getByRole('dialog', { name: 'CPU-Verlauf' })
    await expect(dialog.getByTestId('stats-cpu')).toContainText(/min .* · Ø .* · max /)
    await dialog.getByRole('button', { name: '7 Tage' }).click()
    await expect(dialog.getByRole('button', { name: '7 Tage' })).toHaveAttribute('aria-pressed', 'true')
    const chart = dialog.getByRole('img', { name: 'CPU Auslastung, 7 Tage' })
    await expect(chart.locator('path.chart-line')).toHaveAttribute('d', /C/)
    const box = (await chart.boundingBox())!
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2)
    await expect(dialog.getByRole('tooltip')).toContainText('CPU:')
    await dialog.getByRole('button', { name: 'Schließen' }).click()

    await page.getByRole('button', { name: 'Netz: Verlauf öffnen' }).click()
    const net = page.getByRole('dialog', { name: 'Netz-Verlauf' })
    await expect(net.getByTestId('stats-net_rx')).toContainText('Empfangen')
    await expect(net.getByTestId('stats-net_tx')).toContainText('Gesendet')
    await net.getByRole('button', { name: 'Schließen' }).click()

    await page.getByRole('button', { name: 'GPU: Verlauf öffnen' }).click()
    const gpu = page.getByRole('dialog', { name: 'GPU · Intel Arc A380' })
    await expect(gpu.getByRole('region', { name: 'Takt (Anteil am Maximum)' })).toBeVisible()
    await expect(gpu.getByRole('region', { name: 'Temperatur' })).toBeVisible()
    await expect(gpu.getByRole('region', { name: 'Grafikspeicher' })).toBeVisible()
    await expect(gpu).toContainText('Intel-iGPUs melden ohne Root-Rechte keine Auslastung')
  })

  test('history API needs a session and validates the range', async ({ request, page }) => {
    expect((await request.get('/api/metrics/history?range=24h')).status()).toBe(401)
    await login(page)
    const r = await page.request.get('/api/metrics/history?range=nonsense')
    const body = (await r.json()) as { range: string; series: Record<string, unknown[]> }
    expect(body.range).toBe('1h')
    expect(body.series.cpu!.length).toBeGreaterThan(10)
  })
})
