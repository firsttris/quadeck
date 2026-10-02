import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'

const PASSWORD = 'e2e-password-123'

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Passwort').fill(PASSWORD)
  await page.getByRole('button', { name: 'Anmelden' }).click()
  await expect(page).toHaveURL('/')
}

/** Actions ask for the unlock first (in E2E: the Quadeck password). */
async function unlock(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Aktionen entsperren' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Passwort').fill(PASSWORD)
  await dialog.getByRole('button', { name: 'Entsperren' }).click()
  await expect(dialog).toBeHidden()
}

test.describe.serial('Quadeck', () => {
  test('first start: setup with token, then the dashboard is filled', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveURL(/\/setup/)
    await page.getByLabel('Setup-Token').fill('wrong-token')
    await page.getByLabel('Neues Passwort (mind. 10 Zeichen)').fill(PASSWORD)
    await page.getByLabel('Passwort wiederholen').fill(PASSWORD)
    await page.getByRole('button', { name: 'Passwort festlegen' }).click()
    await expect(page.getByRole('alert')).toHaveText('Setup-Token ist falsch')

    const token = readFileSync('.e2e-data/setup-token', 'utf8').trim()
    await page.getByLabel('Setup-Token').fill(token)
    await page.getByRole('button', { name: 'Passwort festlegen' }).click()
    await expect(page).toHaveURL('/')

    await expect(page.getByRole('heading', { name: 'Übersicht' })).toBeVisible()
    // Alarm card for the OOM-killed Quadlet
    const alarm = page.getByRole('region', { name: 'Fehlgeschlagen: immich-ml.service' })
    await expect(alarm).toContainText('OOM-Kill: Speicherlimit MemoryMax=2G erreicht')
    // Services discovered from Caddy and matched to containers
    const tiles = page.getByTestId('service-tile')
    await expect(tiles.filter({ hasText: 'Jellyfin' })).toHaveAttribute('href', 'https://jellyfin.home.example')
    await expect(tiles.filter({ hasText: 'Home Assistant' })).toBeVisible()
    await expect(tiles.filter({ hasText: 'qBittorrent' })).toContainText('qbt.home.example')
    // Disks, gauges; the container table is gone (containers live on the units page)
    await expect(page.getByRole('region', { name: 'Container' })).toHaveCount(0)
    await expect(page.getByTestId('disk')).toHaveCount(5)
    // Shares from smb.conf (printers/homes skipped) and /etc/exports
    await expect(page.getByTestId('share')).toHaveCount(4)
    await expect(page.getByTestId('share').filter({ hasText: 'Fotos' })).toContainText('lesen/schreiben')
    await expect(page.getByTestId('gauge-cpu')).toBeVisible()
    await expect(page.getByRole('region', { name: 'Nächste Timer' })).toContainText('podman-auto-update.timer')
  })

  test('the setup page is closed once a password exists', async ({ page }) => {
    await page.goto('/setup')
    await expect(page).toHaveURL('/login')
  })

  test('a click before the page is interactive never submits the password natively', async ({ page }) => {
    // Slow client bundle (busy CI runner): the button must wait for React, otherwise the
    // browser submits the form itself and the password ends up in the URL.
    await page.route('**/*.js', async (r) => {
      await new Promise((res) => setTimeout(res, 1500))
      await r.continue()
    })
    await page.goto('/login', { waitUntil: 'commit' })
    await page.getByLabel('Passwort').fill(PASSWORD)
    await page.getByRole('button', { name: 'Anmelden' }).click()
    await expect(page).toHaveURL('/')
    expect(page.url()).not.toContain('password')
  })

  test('wrong password is rejected; logout ends the session', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Passwort').fill('nope-nope-nope')
    await page.getByRole('button', { name: 'Anmelden' }).click()
    await expect(page.getByRole('alert')).toHaveText('Passwort ist falsch')
    await login(page)
    await page.getByRole('button', { name: 'Abmelden' }).click()
    await expect(page).toHaveURL('/login')
    await page.goto('/units')
    await expect(page).toHaveURL('/login')
  })

  test('privileged actions are locked until unlocked with the password; the lock runs out and can be set again', async ({ page }) => {
    await login(page)
    await page.getByRole('img', { name: 'live verbunden' }).waitFor()
    const state = await page.evaluate(() => fetch('/api/unlock').then((r) => r.json()))
    expect(state).toMatchObject({ mode: 'quadeck', until: null })
    await page.getByRole('button', { name: /Gesperrt/ }).click()
    const dialog = page.getByRole('dialog', { name: 'Aktionen entsperren' })
    await dialog.getByLabel('Passwort').fill('falsch-falsch')
    await dialog.getByRole('button', { name: 'Entsperren' }).click()
    await expect(dialog.getByRole('alert')).toHaveText('Passwort ist falsch')
    await dialog.getByLabel('Passwort').fill(PASSWORD)
    await dialog.getByRole('button', { name: 'Entsperren' }).click()
    await expect(page.getByRole('button', { name: /Entsperrt · 1[45]:/ })).toBeVisible()
    // Lock again
    await page.getByRole('button', { name: /Entsperrt/ }).click()
    await expect(page.getByRole('button', { name: /Gesperrt/ })).toBeVisible()
  })

  test('cancelling the unlock leaves everything as it is', async ({ page }) => {
    await login(page)
    await page.goto('/units')
    await page.getByRole('button', { name: 'caddy.service stoppen' }).click()
    const dialog = page.getByRole('dialog', { name: 'Aktionen entsperren' })
    await dialog.getByRole('button', { name: 'Abbrechen' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('dialog')).toHaveCount(0) // no confirmation, no action
    await expect(page.getByTestId('unit-row').filter({ hasText: 'caddy.service' })).toContainText('running')
  })

  test('restart a failed unit from the alarm card goes through systemd after confirmation', async ({ page }) => {
    await login(page)
    const alarm = page.getByRole('region', { name: 'Fehlgeschlagen: immich-ml.service' })
    await alarm.getByRole('button', { name: 'Neu starten' }).click()
    await unlock(page)
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('systemctl restart immich-ml.service')
    await dialog.getByRole('button', { name: 'Neu starten' }).click()
    await expect(page.getByRole('status')).toContainText('immich-ml.service neu gestartet (systemctl restart)')
    await expect(alarm).toHaveCount(0) // pushed via SSE
  })

  test('container with Quadlet unit is stopped via systemd, container without unit via Podman', async ({ page }) => {
    await login(page)
    await page.getByRole('link', { name: /Units/ }).click()
    // Containers are the default filter; the Quadlet row carries the container's health and CPU
    await expect(page.getByRole('link', { name: /Container/ })).toHaveAttribute('aria-current', 'true')
    const jf = page.getByTestId('unit-row').filter({ hasText: 'jellyfin.service' })
    await expect(jf).toContainText('healthy')
    await expect(jf).toContainText('12 %')
    await expect(page.getByTestId('unit-row').filter({ hasText: 'scratch' })).toContainText('podman · container')
    await page.getByRole('button', { name: 'scratch stoppen' }).click()
    await unlock(page)
    await expect(page.getByRole('dialog')).toContainText('Podman-API: stop scratch')
    await page.getByRole('dialog').getByRole('button', { name: 'Stoppen' }).click()
    await expect(page.getByRole('status')).toContainText('scratch gestoppt (Podman-API)')
    await expect(page.getByRole('button', { name: 'scratch starten' })).toBeVisible()

    await page.getByRole('button', { name: 'jellyfin.service stoppen' }).click()
    await expect(page.getByRole('dialog')).toContainText('systemctl stop jellyfin.service')
    await page.getByRole('dialog').getByRole('button', { name: 'Abbrechen' }).click()
    await expect(page.getByRole('dialog')).toBeHidden()
  })

  test('phone: slim bar instead of the sidebar, grouped menu opens and closes on navigation', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await login(page)
    const nav = page.getByRole('navigation', { name: 'Bereiche' })
    await expect(nav).toBeHidden()
    await expect(page.getByRole('heading', { level: 1 })).toBeInViewport()
    await page.getByRole('button', { name: 'Menü öffnen' }).click()
    await expect(nav).toBeVisible()
    await expect(nav.getByRole('group', { name: 'Speicher' })).toContainText('Festplatten')
    await expect(nav.getByRole('group', { name: 'Speicher' })).toContainText('Dateien')
    await nav.getByRole('link', { name: 'Dateien' }).click()
    await expect(page).toHaveURL(/\/files/)
    await expect(nav).toBeHidden()
    await expect(page.getByRole('heading', { name: 'Dateien', level: 1 })).toBeInViewport()
    await page.getByRole('button', { name: 'Menü öffnen' }).click()
    await page.keyboard.press('Escape')
    await expect(nav).toBeHidden()
  })

  test('add and remove a manual link', async ({ page }) => {
    await login(page)
    await page.getByRole('button', { name: 'Link hinzufügen' }).click()
    const dialog = page.getByRole('dialog', { name: 'Link hinzufügen' })
    await dialog.getByLabel('Name').fill('Router')
    await dialog.getByLabel('URL').fill('http://192.168.1.1')
    await dialog.getByLabel('Erreichbarkeit alle 60 s prüfen').uncheck()
    await dialog.getByRole('button', { name: 'Hinzufügen' }).click()
    const tile = page.getByTestId('service-tile').filter({ hasText: 'Router' })
    await expect(tile).toHaveAttribute('href', 'http://192.168.1.1/')
    await expect(page.getByText('manuell angelegt')).toBeVisible()

    await tile.focus() // the remove button shows on hover and on keyboard focus
    await page.getByRole('button', { name: 'Link Router entfernen' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Entfernen' }).click()
    await expect(tile).toHaveCount(0)
  })

  test('edit the layout: resize a tile, hide and restore a card, persists across reloads, reset', async ({ page }) => {
    await login(page)
    await page.getByRole('img', { name: 'live verbunden' }).waitFor() // hydrated, grid measured
    const tile = page.getByTestId('grid-item-ct:jellyfin')
    await expect(tile.locator('.react-resizable-handle')).toBeHidden() // not editable outside edit mode

    await page.keyboard.press('e')
    await expect(page.getByRole('button', { name: 'Fertig' })).toBeVisible()
    // Resize the Jellyfin tile to 2×2 (scrolled into view, so the mouse reaches the handle)
    await tile.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await page.waitForTimeout(300) // let the grid finish its transition
    const before = (await tile.boundingBox())!
    const handle = (await tile.locator('.react-resizable-handle').boundingBox())!
    await page.mouse.move(handle.x + 4, handle.y + 4)
    await page.mouse.down()
    await page.mouse.move(handle.x + before.width + 20, handle.y + before.height + 20, { steps: 12 })
    await page.mouse.up()
    // Hide the timers card
    await page.getByRole('button', { name: 'Nächste Timer ausblenden' }).click()
    await expect(page.getByRole('region', { name: 'Nächste Timer' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Fertig' }).click()

    await page.reload()
    await page.getByRole('img', { name: 'live verbunden' }).waitFor()
    // Compare with a 1×1 neighbour in the same render (column width depends on the window)
    const ratio = async (dim: 'width' | 'height') =>
      (await page.getByTestId('grid-item-ct:jellyfin').boundingBox())![dim] / (await page.getByTestId('grid-item-ct:immich-server').boundingBox())![dim]
    await expect.poll(() => ratio('width')).toBeGreaterThan(1.8) // the grid animates into place
    await expect.poll(() => ratio('height')).toBeGreaterThan(1.8)
    await expect(page.getByRole('region', { name: 'Nächste Timer' })).toHaveCount(0)
    // In view mode tiles are links again
    await expect(page.getByTestId('service-tile').filter({ hasText: 'Jellyfin' })).toHaveAttribute('href', 'https://jellyfin.home.example')

    await page.getByRole('button', { name: 'Bearbeiten' }).click()
    await page.getByRole('button', { name: 'Nächste Timer einblenden' }).click()
    await expect(page.getByRole('region', { name: 'Nächste Timer' })).toBeVisible()
    await page.getByRole('button', { name: 'Auf Auto-Layout zurücksetzen' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Auto-Layout wiederhergestellt' })).toBeVisible()
    await expect
      .poll(async () => Math.abs((await page.getByTestId('grid-item-ct:jellyfin').boundingBox())!.width - (await page.getByTestId('grid-item-ct:immich-server').boundingBox())!.width))
      .toBeLessThan(2)
  })

  test('edit a service: rename, hide and restore, back to automatic', async ({ page }) => {
    await login(page)
    await page.getByRole('img', { name: 'live verbunden' }).waitFor()
    await page.getByRole('button', { name: 'Bearbeiten' }).click()
    await page.getByRole('button', { name: 'Jellyfin bearbeiten' }).click()
    const dialog = page.getByRole('dialog', { name: 'Jellyfin bearbeiten' })
    await dialog.getByLabel('Name').fill('Kino')
    await dialog.getByRole('button', { name: 'Speichern' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('button', { name: 'Kino bearbeiten' })).toBeVisible()

    // Hide via the dialog, bring it back from the edit bar
    await page.getByRole('button', { name: 'Kino bearbeiten' }).click()
    await page.getByRole('dialog').getByLabel('Ausblenden').check()
    await page.getByRole('dialog').getByRole('button', { name: 'Speichern' }).click()
    await expect(page.getByRole('button', { name: 'Kino bearbeiten' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Kino wieder anzeigen' }).click()
    await expect(page.getByRole('button', { name: 'Kino bearbeiten' })).toBeVisible()

    // Reset the override
    await page.getByRole('button', { name: 'Kino bearbeiten' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Auf automatisch zurücksetzen' }).click()
    await expect(page.getByRole('button', { name: 'Jellyfin bearbeiten' })).toBeVisible()
    await page.getByRole('button', { name: 'Fertig' }).click()
    await expect(page.getByTestId('service-tile').filter({ hasText: 'Jellyfin' })).toHaveAttribute('href', 'https://jellyfin.home.example')
  })

  test('command palette: Ctrl+K, search, navigate and unit actions', async ({ page }) => {
    await login(page)
    await page.getByRole('img', { name: 'live verbunden' }).waitFor()
    await page.keyboard.press('Control+k')
    const input = page.getByRole('combobox', { name: 'Suchen' })
    await input.fill('qbit')
    await expect(page.getByRole('option').first()).toContainText('qBittorrent')
    await input.fill('fehlgeschlagene')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/units\?filter=failed/)
    // Unit action from the palette goes through the usual confirmation
    await page.getByRole('button', { name: /Suchen/ }).click()
    await page.getByRole('combobox', { name: 'Suchen' }).fill('caddy neu')
    await page.keyboard.press('Enter')
    await unlock(page)
    await expect(page.getByRole('dialog')).toContainText('systemctl restart caddy.service')
    await page.getByRole('dialog').getByRole('button', { name: 'Abbrechen' }).click()
  })

  test('units filter and journal', async ({ page }) => {
    await login(page)
    await page.getByRole('link', { name: /Units/ }).click()
    await expect(page.getByTestId('unit-row')).toHaveCount(8) // default filter: containers
    await page.getByRole('link', { name: /^Alle/ }).click()
    await expect(page.getByTestId('unit-row')).toHaveCount(17) // 16 units + 1 container without unit
    await page.getByRole('link', { name: /Fehlgeschlagen/ }).click()
    await expect(page).toHaveURL(/filter=failed/)
    await expect(page.getByTestId('unit-row')).toHaveCount(1) // immich-ml was restarted above
    await expect(page.getByTestId('unit-row')).toContainText('Prozess endete mit Exit 1')

    await page.getByTestId('unit-row').getByRole('link', { name: 'Journal' }).click()
    await expect(page).toHaveURL(/\/journal\?unit=backup-offsite.service/)
    await page.getByRole('button', { name: 'Alle Units' }).click()
    await expect(page.getByTestId('journal')).toContainText("Failed with result 'oom-kill'")
    await page.getByRole('button', { name: 'Fehler' }).click()
    await expect(page.getByTestId('journal')).not.toContainText('Playback started')
  })

  test('API refuses anonymous and cross-site requests', async ({ request, page }) => {
    expect((await request.get('/api/events')).status()).toBe(401)
    expect((await request.post('/api/units', { data: { name: 'jellyfin.service', action: 'stop' } })).status()).toBe(401)
    await login(page)
    const res = await page.request.post('/api/units', { data: { name: 'jellyfin.service', action: 'stop' }, headers: { origin: 'http://evil.example' } })
    expect(res.status()).toBe(403)
    const noCsrf = await page.request.post('/api/units', { data: { name: 'jellyfin.service', action: 'stop' } })
    expect(noCsrf.status()).toBe(403)
    expect(await noCsrf.json()).toEqual({ error: 'CSRF-Token fehlt oder ist ungültig' })
  })
})
