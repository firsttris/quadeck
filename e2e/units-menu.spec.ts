import { expect, type Page, test } from '@playwright/test'

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

test('sockets filter and the row menu: one button, the rest in "⋯", keyboard; autostart as a switch in the row', async ({ page }) => {
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
  await expect(menu.getByRole('menuitemcheckbox')).toHaveCount(0) // autostart is a switch in its own column
  await expect(podman.getByRole('switch', { name: 'Autostart für podman.socket' })).toBeChecked()
  await expect(podman).toContainText('An')
  await expect(menu.getByRole('menuitem', { name: 'Journal' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(menu.getByRole('menuitem', { name: 'Unit bearbeiten' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)

  // Stopped: "Starten"; switch autostart on.
  const avahi = rows.filter({ hasText: 'avahi-daemon.socket' })
  await expect(avahi.getByRole('button', { name: 'avahi-daemon.socket starten' })).toBeVisible()
  const avahiBoot = avahi.getByRole('switch', { name: 'Autostart für avahi-daemon.socket' })
  await expect(avahiBoot).not.toBeChecked()
  await avahiBoot.click()
  await unlock(page)
  await expect(page.getByRole('status')).toContainText('avahi-daemon.socket startet beim Booten')
  await expect(avahiBoot).toBeChecked()

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

test('Quadlet autostart: a switch in the row writes [Install] in the file; a stopped Quadlet without autostart keeps its row', async ({ page, request }) => {
  expect((await request.post('/api/quadlets/file', { data: { name: 'jellyfin.container', boot: false } })).status()).toBe(401)
  await login(page)
  await page.goto('/units')
  const row = page.getByTestId('unit-row').filter({ hasText: 'jellyfin.service' })
  const toggle = row.getByRole('switch', { name: 'Autostart für jellyfin.service' })
  await expect(toggle).toBeChecked()
  await toggle.click()
  await unlock(page)
  await expect(page.getByRole('status')).toContainText('jellyfin.service startet nicht mehr beim Booten')
  await expect(toggle).not.toBeChecked()
  await expect(row).toContainText('Aus')

  // Stopped without autostart, systemd unloads the unit (nothing wants it): the row stays, from its
  // file, so it can be started or get its autostart back.
  await row.getByRole('button', { name: 'Aktionen für jellyfin.service' }).click()
  await page.getByRole('menuitem', { name: 'Stoppen …' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Stoppen' }).click()
  await expect(row.getByRole('button', { name: 'jellyfin.service starten' })).toBeVisible()
  await page.reload()
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('inactive')
  await expect(toggle).not.toBeChecked()

  await page.goto('/quadlets?file=jellyfin.container')
  const editor = page.getByRole('region', { name: 'Editor jellyfin.container' })
  await editor.getByRole('button', { name: 'Text' }).click()
  await expect(editor.getByLabel('Quadlet-Datei')).toHaveValue(/Image=/)
  await expect(editor.getByLabel('Quadlet-Datei')).not.toHaveValue(/\[Install\]/)

  // And back on: the stopped/running state is not touched, only the file.
  await page.goto('/units')
  await toggle.click()
  await expect(page.getByRole('status')).toContainText('jellyfin.service startet beim Booten')
  await expect(toggle).toBeChecked()
  await expect(row).toContainText('inactive')
  await page.goto('/quadlets')
  await expect(page.getByTestId('quadlet-file').filter({ hasText: 'jellyfin.container' })).toContainText('Autostart')
  await page.goto('/quadlets?file=jellyfin.container')
  await editor.getByRole('button', { name: 'Text' }).click()
  await expect(editor.getByLabel('Quadlet-Datei')).toHaveValue(/\[Install\]\nWantedBy=multi-user\.target/)
})

test('a deleted Quadlet leaves the dashboard at once: its Caddy route no longer shows a dead tile', async ({ page }) => {
  await login(page)
  await page.getByRole('img', { name: 'live verbunden' }).waitFor()
  await expect(page.getByTestId('service-tile').filter({ hasText: 'fotos.home.example' })).toHaveCount(1)
  await page.goto('/units')
  const row = page.getByTestId('unit-row').filter({ hasText: 'immich.service' })
  await row.getByRole('button', { name: 'Aktionen für immich.service' }).click()
  await page.getByRole('menuitem', { name: 'Quadlet löschen …' }).click()
  await page.getByRole('dialog', { name: 'immich.container löschen?' }).getByRole('button', { name: 'Löschen' }).click()
  await unlock(page)
  await expect(page.getByRole('status')).toContainText('immich.container gelöscht')
  await expect(row).toHaveCount(0)
  await page.goto('/')
  await page.getByRole('img', { name: 'live verbunden' }).waitFor()
  // The route to immich-server is still in the Caddyfile, but the container and its unit are gone.
  await expect(page.getByTestId('service-tile').filter({ hasText: 'fotos.home.example' })).toHaveCount(0)
  await expect(page.getByTestId('service-tile').filter({ hasText: 'jellyfin.home.example' })).toHaveCount(1)
})
