import { expect, test, type Page } from '@playwright/test'

// Demo: fixtures/demo/disks.json (mounted file systems) with 60 days of seeded fill-level history.
const PASSWORD = 'e2e-password-123'
const SHOTS = process.env.QUADECK_SHOTS

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Passwort').fill(PASSWORD)
  await page.getByRole('button', { name: 'Anmelden' }).click()
  await expect(page).toHaveURL('/')
}

test('disk cards show what is mounted, how full it is and when it will be full', async ({ page }) => {
  await login(page)
  await page.goto('/disks')

  // the system disk: steady
  const nvme = page.getByRole('region', { name: 'Platte nvme0n1' }).getByRole('group', { name: 'Belegung' })
  await expect(nvme).toContainText('nvme0n1p3 → / · btrfs')
  await expect(nvme).toContainText('312 GB von 1,0 TB · 31 %')
  await expect(nvme).toContainText('gleichbleibend')

  // a data disk that keeps filling up: pace and forecast
  const sda = page.getByRole('region', { name: 'Platte sda' }).getByRole('group', { name: 'Belegung' })
  await expect(sda).toContainText('sda1 → /mnt/disk1 · xfs')
  await expect(sda).toContainText('84 %')
  await expect(sda.getByTestId('usage-trend')).toContainText(/\+[\d,]+ (TB|GB) im Monat · voll in etwa \d+ (Wochen|Monaten)/)
  await expect(sda.getByRole('meter', { name: '/mnt/disk1' })).toHaveAttribute('aria-valuenow', '84')

  // 90 % full: red, with the way to the files
  const sdc = page.getByRole('region', { name: 'Platte sdc' }).getByRole('group', { name: 'Belegung' })
  await expect(sdc).toContainText('90 %')
  await sdc.getByRole('link', { name: /Was belegt den Platz/ }).click()
  await expect(page).toHaveURL(/\/files\?path=%2Fmnt%2Fdisk3/)
  if (SHOTS) {
    await page.goto('/disks')
    await page.getByRole('region', { name: 'Platte sda' }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${SHOTS}/disk-usage.png`, fullPage: true })
  }

  // the setting for the forecast warning
  await page.goto('/notifications')
  await expect(page.getByLabel('Tage, bis die Platte voll ist')).toHaveValue('14')
})
