import { expect, test, type Page } from '@playwright/test'

// fixtures/demo/hardware.json: i5-12500, 2 of 4 slots, UHD 770 + Arc A380, Zigbee stick, sdc on 3 Gbps.
const PASSWORD = 'e2e-password-123'

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Passwort').fill(PASSWORD)
  await page.getByRole('button', { name: 'Anmelden' }).click()
  await expect(page).toHaveURL('/')
}

test('hardware: opened from the host card, spec sheet with slots, GPU line, USB path, warnings', async ({ page }) => {
  await login(page)
  await page.getByRole('link', { name: /Hardware dieses Rechners/ }).click()
  await expect(page).toHaveURL(/\/hardware/)
  await expect(page.getByRole('heading', { name: 'Hardware', level: 1 })).toBeVisible()
  const warnings = page.getByRole('region', { name: 'Hinweise zur Hardware' })
  await expect(warnings).toContainText('x1 statt x2')
  await expect(warnings).toContainText('sdc (TOSHIBA MG08ACA14TE) ist mit 3.0 Gbps statt 6.0 Gbps')
  await expect(page.getByTestId('hw-summary').filter({ hasText: 'Arbeitsspeicher' })).toContainText('32 GB')
  await expect(page.getByTestId('hw-summary').filter({ hasText: 'Grafik' })).toContainText('UHD Graphics 770, Arc A380')
  await expect(page.getByTestId('ram-slot')).toHaveCount(4)
  await expect(page.getByTestId('ram-slot').filter({ hasText: '16 GB' })).toHaveCount(2)
  await expect(page.getByTestId('gpu').filter({ hasText: 'Arc A380' })).toContainText('AddDevice=/dev/dri/renderD129')
  await expect(page.getByTestId('usb-device').filter({ hasText: 'Sonoff' })).toContainText('/dev/serial/by-id/usb-ITead_Sonoff')
  await expect(page.getByTestId('sensor').filter({ hasText: 'Gehäuse hinten' })).toContainText('steht')
  await expect(page.getByTestId('pci-device').filter({ hasText: 'ASM1166' })).toContainText('läuft mit x1 statt x2')
})
