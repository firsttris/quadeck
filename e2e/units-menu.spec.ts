import { expect, test, type Page } from '@playwright/test'

const PASSWORD = 'e2e-password-123'

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Passwort').fill(PASSWORD)
  await page.getByRole('button', { name: 'Anmelden' }).click()
  await expect(page).toHaveURL('/')
}

async function unlock(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Aktionen entsperren' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Passwort').fill(PASSWORD)
  await dialog.getByRole('button', { name: 'Entsperren' }).click()
  await expect(dialog).toBeHidden()
}

test('sockets filter and the row menu: one button, the rest in "⋯", keyboard, start at boot', async ({ page }) => {
  await login(page)
  await page.goto('/units')
  await page
    .getByRole('group', { name: 'Filter' })
    .getByRole('link', { name: /Sockets/ })
    .click()
  const rows = page.getByTestId('unit-row')
  await expect(rows).toHaveCount(2)
  const podman = rows.filter({ hasText: 'podman.socket' })
  await expect(podman).toContainText('lauscht auf /run/podman/podman.sock → podman.service')
  await expect(podman).toContainText('listening')

  // Running: "Neu starten" as the button, "Stoppen" only in the menu.
  await expect(podman.getByRole('button', { name: 'podman.socket neu starten' })).toBeVisible()
  await expect(podman.getByRole('button', { name: /stoppen/ })).toHaveCount(0)
  await podman.getByRole('button', { name: 'Aktionen für podman.socket' }).click()
  const menu = page.getByRole('menu', { name: 'Aktionen für podman.socket' })
  await expect(menu.getByRole('menuitem')).toHaveText(['Journal', 'Unit bearbeiten', 'Stoppen …'])
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Beim Booten starten' })).toHaveAttribute('aria-checked', 'true')
  await expect(menu.getByRole('menuitem', { name: 'Journal' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(menu.getByRole('menuitem', { name: 'Unit bearbeiten' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)

  // Stopped: "Starten"; switch start at boot on.
  const avahi = rows.filter({ hasText: 'avahi-daemon.socket' })
  await expect(avahi.getByRole('button', { name: 'avahi-daemon.socket starten' })).toBeVisible()
  await avahi.getByRole('button', { name: 'Aktionen für avahi-daemon.socket' }).click()
  await page.getByRole('menuitemcheckbox', { name: 'Beim Booten starten' }).click()
  await unlock(page)
  await expect(page.getByRole('status')).toContainText('avahi-daemon.socket startet beim Booten')

  // The name opens the journal.
  await podman.getByRole('link', { name: 'podman.socket' }).click()
  await expect(page).toHaveURL(/\/journal\?unit=podman\.socket/)
})

test('a Quadlet container is deleted from its row, the image and volumes only when ticked', async ({ page }) => {
  await login(page)
  await page.goto('/units')
  const caddy = page.getByTestId('unit-row').filter({ hasText: 'caddy.service' })
  await caddy.getByRole('button', { name: 'Aktionen für caddy.service' }).click()
  await page.getByRole('menuitem', { name: 'Quadlet löschen …' }).click()
  const dialog = page.getByRole('dialog', { name: 'caddy.container löschen?' })
  await expect(dialog).toContainText('caddy.service wird gestoppt')
  await expect(dialog.getByRole('checkbox', { name: /Image auch entfernen/ })).not.toBeChecked()
  await expect(dialog).toContainText('caddy-data')
  await expect(dialog).toContainText('/etc/caddy') // host folders stay
  await dialog.getByRole('checkbox', { name: /Volumes auch löschen/ }).check()
  await expect(dialog).toContainText('Die Daten in den Volumes sind danach weg')
  await dialog.getByRole('button', { name: 'Abbrechen' }).click()
  await expect(dialog).toBeHidden()

  const ml = page.getByTestId('unit-row').filter({ hasText: 'immich-ml.service' })
  await ml.getByRole('button', { name: 'Aktionen für immich-ml.service' }).click()
  await page.getByRole('menuitem', { name: 'Quadlet löschen …' }).click()
  const d2 = page.getByRole('dialog', { name: 'immich-ml.container löschen?' })
  await expect(d2).toContainText('/srv/immich/model-cache')
  await d2.getByRole('checkbox', { name: /Image auch entfernen/ }).check()
  await d2.getByRole('button', { name: 'Löschen' }).click()
  await unlock(page)
  await expect(page.getByRole('status')).toContainText('immich-ml.container gelöscht')
  await page.goto('/quadlets')
  await expect(page.getByTestId('quadlet-file').filter({ hasText: 'immich-ml.container' })).toHaveCount(0)
})
