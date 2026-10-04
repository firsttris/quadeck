import { expect, test, type Page } from '@playwright/test'

// Demo: a pretend shell (no process is started), so this runs the whole path –
// unlock, helper session, output stream, input – without handing out a real shell.
const PASSWORD = 'e2e-password-123'

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Passwort').fill(PASSWORD)
  await page.getByRole('button', { name: 'Anmelden' }).click()
  await expect(page).toHaveURL('/')
}

async function unlockIfAsked(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Aktionen entsperren' })
  if (await dialog.isVisible({ timeout: 2000 }).catch(() => false)) {
    await dialog.getByLabel('Passwort').fill(PASSWORD)
    await dialog.getByRole('button', { name: 'Entsperren' }).click()
    await expect(dialog).toBeHidden()
  }
}

test('terminal: off by default, switch on, shell and container shell in tabs, switch off', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('link', { name: 'Terminal' }).click()
  await expect(page).toHaveURL('/terminal')
  const card = page.getByRole('region', { name: 'Terminal im Browser' })
  await expect(card).toContainText('standardmäßig aus')
  await card.getByLabel('Terminal einschalten').check()
  await expect(card.getByLabel('Nur aus dem Heimnetz')).toBeChecked()
  await card.getByRole('button', { name: 'Speichern' }).click()
  await unlockIfAsked(page)
  await expect(page.getByRole('status')).toContainText('Terminal eingeschaltet')

  await page.getByRole('button', { name: 'Shell öffnen' }).click()
  await unlockIfAsked(page)
  const screen = page.getByTestId('terminal-view').locator('.xterm-rows')
  await expect(screen).toContainText('Quadeck demo')
  await page.getByTestId('terminal-view').locator('.xterm').click()
  await page.keyboard.type('help')
  await page.keyboard.press('Enter')
  await expect(screen).toContainText('Try: ls, uptime')
  await page.keyboard.type('podman ps')
  await page.keyboard.press('Enter')
  await expect(screen).toContainText('jellyfin')

  // a container shell from the Units page
  await page.goto('/units?filter=container')
  await page.getByRole('button', { name: 'Aktionen für caddy.service' }).click()
  await page.getByRole('menuitem', { name: 'Shell im Container' }).click()
  await expect(page).toHaveURL('/terminal')
  const tabs = page.getByRole('tablist', { name: 'Sitzungen' })
  await expect(tabs.getByRole('tab', { name: /caddy/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('terminal-view').filter({ visible: true }).locator('.xterm-rows')).toContainText('container caddy')
  // the shell from before is still there after navigating away (reattached with its screen)
  await tabs.getByRole('tab', { name: /@/ }).click()
  await expect(page.getByTestId('terminal-view').filter({ visible: true }).locator('.xterm-rows')).toContainText('jellyfin')

  // exit ends a session, × closes one
  await page.getByTestId('terminal-view').filter({ visible: true }).locator('.xterm').click()
  await page.keyboard.type('exit')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('terminal-view').filter({ visible: true }).locator('.xterm-rows')).toContainText('[Sitzung beendet]')
  await tabs.getByRole('button', { name: 'caddy schließen' }).click()
  await expect(tabs.getByRole('tab', { name: /caddy/ })).toHaveCount(0)

  // switched off again: open sessions end
  await page.getByRole('button', { name: 'Einstellungen …' }).click()
  const dialog = page.getByRole('dialog', { name: 'Terminal im Browser' })
  await dialog.getByLabel('Terminal einschalten').uncheck()
  await dialog.getByRole('button', { name: 'Speichern' }).click()
  await expect(page.getByRole('status')).toContainText('Terminal ausgeschaltet')
  await expect(page.getByRole('region', { name: 'Terminal im Browser' })).toBeVisible()
})
