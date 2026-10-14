import { expect, type Page, test } from '@playwright/test'

// Runs after dashboard.spec.ts (password set there). Every page on a phone: nothing may make the page
// wider than the screen (wide tables scroll inside their card instead).
const PASSWORD = 'e2e-password-123'

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Passwort').fill(PASSWORD)
  await page.getByRole('button', { name: 'Anmelden' }).click()
  await expect(page).toHaveURL('/')
}

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

const PAGES = ['/', '/services', '/units', '/journal', '/disks', '/files', '/shares', '/backups', '/network', '/users', '/ssh', '/notifications', '/hardware', '/terminal']
const SYSTEM_TABS = ['', 'packages', 'podman', 'boot']

test('phone: no page is wider than the screen', async ({ page }) => {
  test.setTimeout(120_000)
  await login(page)
  for (const path of PAGES) {
    await page.goto(path)
    await page.locator('main h1, main [aria-label]').first().waitFor()
    await page.waitForTimeout(1500) // live data and tables fill in; the event stream never goes idle
    expect(await overflow(page), path).toBeLessThanOrEqual(0)
  }
  // the system page renders a wide table per tab
  for (const tab of SYSTEM_TABS) {
    await page.goto(tab ? `/system?tab=${tab}` : '/system')
    await expect(page.getByRole('tablist')).toBeVisible()
    await page.waitForTimeout(1500)
    expect(await overflow(page), `/system ${tab || 'updates'}`).toBeLessThanOrEqual(0)
  }
})
