import { readFileSync } from 'node:fs'
import { expect, type Page, test } from '@playwright/test'

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

test.describe
  .serial('Quadeck', () => {
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

      // no visible title: the page starts with the widgets (the heading is there for screen readers)
      await expect(page.getByRole('heading', { name: 'Übersicht', level: 1 })).toHaveCount(1)
      await expect(page.getByText('live über Podman-Socket und D-Bus')).toBeHidden() // desktop: the sidebar has the host
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

    test('login scene: a container ship is loaded, a wrong password shakes; still and fully loaded with reduced motion', async ({ page, browser }) => {
      await page.goto('/login')
      const ship = page.locator('svg.auth-ship')
      await expect(ship).toHaveAttribute('aria-hidden', 'true') // decoration only
      await expect(ship.locator('.auth-box')).toHaveCount(11)
      expect(
        await ship
          .locator('.auth-box')
          .last()
          .evaluate((el) => getComputedStyle(el).animationName),
      ).toBe('auth-load')
      expect(await page.locator('.auth-card').evaluate((el) => getComputedStyle(el).animationName)).toBe('auth-card-in')
      for (const attempt of [1, 2]) {
        await page.getByLabel('Passwort').fill(`wrong-${attempt}`)
        await page.getByRole('button', { name: 'Anmelden' }).click()
        const alert = page.getByRole('alert')
        await expect(alert).toHaveText('Passwort ist falsch')
        expect(await alert.evaluate((el) => getComputedStyle(el).animationName)).toBe('auth-shake')
      }

      const ctx = await browser.newContext({ reducedMotion: 'reduce' })
      const still = await ctx.newPage()
      await still.goto('/login')
      const boxes = still.locator('svg.auth-ship .auth-box')
      await expect(boxes).toHaveCount(11)
      for (const el of await boxes.all()) {
        expect(await el.evaluate((b) => [getComputedStyle(b).animationName, getComputedStyle(b).opacity])).toEqual(['none', '1'])
      }
      expect(await still.locator('.auth-hull').evaluate((el) => getComputedStyle(el).animationName)).toBe('none')
      await ctx.close()
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
      await page.getByRole('button', { name: 'Aktionen für caddy.service' }).click()
      await page.getByRole('menuitem', { name: 'Stoppen …' }).click()
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
      await expect(page.getByRole('group', { name: 'Filter' }).getByRole('link', { name: /Container/ })).toHaveAttribute('aria-current', 'true')
      const jf = page.getByTestId('unit-row').filter({ hasText: 'jellyfin.service' })
      await expect(jf).toContainText('healthy')
      await expect(jf).toContainText('12 %')
      await expect(page.getByTestId('unit-row').filter({ hasText: 'scratch' })).toContainText('podman')
      await page.getByRole('button', { name: 'Aktionen für scratch' }).click()
      await page.getByRole('menuitem', { name: 'Stoppen …' }).click()
      await unlock(page)
      await expect(page.getByRole('dialog')).toContainText('Podman-API: stop scratch')
      await page.getByRole('dialog').getByRole('button', { name: 'Stoppen' }).click()
      await expect(page.getByRole('status')).toContainText('scratch gestoppt (Podman-API)')
      await expect(page.getByRole('button', { name: 'scratch starten' })).toBeVisible()

      await page.getByRole('button', { name: 'Aktionen für jellyfin.service' }).click()
      await page.getByRole('menuitem', { name: 'Stoppen …' }).click()
      await expect(page.getByRole('dialog')).toContainText('systemctl stop jellyfin.service')
      await page.getByRole('dialog').getByRole('button', { name: 'Abbrechen' }).click()
      await expect(page.getByRole('dialog')).toBeHidden()
    })

    test('phone: slim bar instead of the sidebar, grouped menu opens and closes on navigation', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await login(page)
      const nav = page.getByRole('navigation', { name: 'Bereiche' })
      await expect(nav).toBeHidden()
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
      // phones have no sidebar: the host name stays in the small strip above the widgets
      await expect(page.getByText('nas-01 · live über Podman-Socket und D-Bus')).toBeInViewport()
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
      await page.getByRole('img', { name: 'live verbunden' }).waitFor() // hydrated: a click before that opens nothing
      await page.getByRole('button', { name: 'Link hinzufügen' }).click()
      const dialog = page.getByRole('dialog', { name: 'Link hinzufügen' })
      await dialog.getByLabel('Name').fill('Router')
      await dialog.getByLabel('URL').fill('http://192.168.1.1')
      await dialog.getByLabel('Icon suchen').fill('openwrt') // the icon can be chosen right away, not only when editing
      await dialog.getByLabel('Erreichbarkeit alle 60 s prüfen').uncheck()
      await dialog.getByRole('button', { name: 'Hinzufügen' }).click()
      const tile = page.getByTestId('service-tile').filter({ hasText: 'Router' })
      await expect(tile).toHaveAttribute('href', 'http://192.168.1.1/')
      await expect(tile.locator('[data-icon]')).toHaveAttribute('data-icon', 'openwrt') // offline the image itself falls back to a glyph
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
      // Remove the timers card
      await page.getByRole('button', { name: 'Nächste Timer entfernen' }).click()
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
      // back from the catalog
      await page.getByRole('button', { name: 'Widget hinzufügen' }).first().click()
      const catalog = page.getByRole('dialog', { name: 'Widget hinzufügen' })
      await catalog.getByRole('button', { name: 'Nächste Timer hinzufügen' }).click()
      await expect(catalog).toBeHidden()
      await expect(page.getByRole('region', { name: 'Nächste Timer' })).toBeVisible()
      await page.getByRole('button', { name: 'Auf Auto-Layout zurücksetzen' }).click()
      await expect(page.getByRole('status').filter({ hasText: 'Auto-Layout wiederhergestellt' })).toBeVisible()
      await expect
        .poll(async () => Math.abs((await page.getByTestId('grid-item-ct:jellyfin').boundingBox())!.width - (await page.getByTestId('grid-item-ct:immich-server').boundingBox())!.width))
        .toBeLessThan(2)
    })

    test('widget catalog: what is there, add a note, write, edit, remove; it stays across reloads', async ({ page }) => {
      await login(page)
      await page.getByRole('img', { name: 'live verbunden' }).waitFor()
      await page.getByRole('button', { name: 'Bearbeiten', exact: true }).click()
      await page.getByRole('button', { name: 'Widget hinzufügen' }).first().click()
      const catalog = page.getByRole('dialog', { name: 'Widget hinzufügen' })
      // built-in cards that are shown can't be added twice
      await expect(catalog.getByRole('button', { name: 'CPU hinzufügen' })).toBeDisabled()
      await expect(catalog.getByTestId('catalog-entry').filter({ has: page.getByText('CPU', { exact: true }) })).toContainText('auf dem Dashboard')
      // categories and search
      await catalog.getByRole('button', { name: 'Sonstiges' }).click()
      await expect(catalog.getByTestId('catalog-entry')).toHaveCount(3) // note, notifications, link group
      await catalog.getByRole('button', { name: 'Alle' }).click()
      await catalog.getByRole('searchbox', { name: 'Suchen …' }).fill('wartung')
      await expect(catalog.getByTestId('catalog-entry')).toHaveCount(1)
      await expect(catalog.getByTestId('catalog-entry')).toContainText('MEHRFACH')

      await catalog.getByRole('button', { name: 'Notiz hinzufügen' }).click()
      const dialog = page.getByRole('dialog', { name: 'Notiz bearbeiten' })
      await dialog.getByLabel('Überschrift (optional)').fill('Gäste-WLAN')
      await dialog.getByLabel('Text').fill('Passwort steht im Vaultwarden\nhttps://vault.home.example')
      await dialog.getByRole('button', { name: 'Speichern' }).click()
      await expect(dialog).toBeHidden()
      const note = page.getByRole('region', { name: 'Gäste-WLAN' })
      await expect(note).toContainText('Passwort steht im Vaultwarden')
      await expect(note.getByRole('link', { name: 'https://vault.home.example' })).toHaveAttribute('href', 'https://vault.home.example')
      await page.getByRole('button', { name: 'Fertig' }).click()

      await page.reload()
      await page.getByRole('img', { name: 'live verbunden' }).waitFor()
      await expect(page.getByRole('region', { name: 'Gäste-WLAN' })).toContainText('Vaultwarden')
      // edit from view mode with the pencil
      await page.getByRole('button', { name: 'Gäste-WLAN bearbeiten' }).click()
      await page.getByRole('dialog', { name: 'Notiz bearbeiten' }).getByLabel('Text').fill('Neues Passwort ab Montag')
      await page.getByRole('dialog', { name: 'Notiz bearbeiten' }).getByRole('button', { name: 'Speichern' }).click()
      await expect(page.getByRole('region', { name: 'Gäste-WLAN' })).toContainText('Neues Passwort ab Montag')

      // removing a note with text asks first
      await page.getByRole('button', { name: 'Bearbeiten', exact: true }).click()
      await page.getByRole('button', { name: 'Gäste-WLAN entfernen' }).click()
      const confirm = page.getByRole('dialog', { name: 'Gäste-WLAN entfernen?' })
      await expect(confirm.getByRole('button', { name: 'Abbrechen' })).toBeFocused()
      await confirm.getByRole('button', { name: 'Entfernen' }).click()
      await expect(page.getByRole('region', { name: 'Gäste-WLAN' })).toHaveCount(0)
      await page.getByRole('button', { name: 'Fertig' }).click()
      await page.reload()
      await page.getByRole('img', { name: 'live verbunden' }).waitFor()
      await expect(page.getByTestId('note-widget')).toHaveCount(0)
    })

    test('widgets from Quadeck data: starter widgets of a fresh install, a disk, the busiest containers, notifications', async ({ page }) => {
      await login(page)
      await page.getByRole('img', { name: 'live verbunden' }).waitFor()
      // the demo database is new: Updates and Backups are there from the start
      const updates = page.getByTestId('updates-widget')
      await expect(updates).toContainText('Systempakete')
      await expect(updates.getByRole('link', { name: 'Zur System-Seite' })).toHaveAttribute('href', '/system')
      await expect(page.getByTestId('backups-widget')).toContainText('Server-Backup')

      await page.getByRole('button', { name: 'Bearbeiten', exact: true }).click()
      const open = async () => {
        await page.getByRole('button', { name: 'Widget hinzufügen' }).first().click()
        return page.getByRole('dialog', { name: 'Widget hinzufügen' })
      }
      // single widgets that are there can't be added again
      let catalog = await open()
      await expect(catalog.getByRole('button', { name: 'Updates hinzufügen' })).toBeDisabled()

      // a disk asks which one
      await catalog.getByRole('button', { name: 'Festplatte hinzufügen' }).click()
      const settings = page.getByRole('dialog', { name: 'Festplatte einstellen' })
      await settings.getByLabel('Einhängepunkt').selectOption('/mnt/disk1')
      await settings.getByRole('button', { name: 'Speichern' }).click()
      const disk = page.getByRole('region', { name: 'Festplatte · /mnt/disk1' })
      await expect(disk).toContainText('xfs')
      await expect(disk.getByRole('meter', { name: '/mnt/disk1' })).toBeVisible()

      // the busiest containers, switched to CPU with ⚙
      catalog = await open()
      await catalog.getByRole('button', { name: 'Container-Top hinzufügen' }).click()
      await expect(page.getByRole('region', { name: 'Container-Top · RAM' })).toBeVisible()
      await page.getByRole('button', { name: 'Container-Top · RAM einstellen' }).click()
      await page.getByRole('dialog', { name: 'Container-Top einstellen' }).getByRole('radio', { name: 'CPU' }).check()
      await page.getByRole('dialog', { name: 'Container-Top einstellen' }).getByRole('button', { name: 'Speichern' }).click()
      const top = page.getByRole('region', { name: 'Container-Top · CPU' })
      await expect(top).toBeVisible()
      await expect.poll(async () => top.locator('.font-mono').count()).toBeGreaterThan(0)

      catalog = await open()
      await catalog.getByRole('button', { name: 'Meldungen hinzufügen', exact: true }).click()
      await expect(page.getByTestId('alerts-widget')).toBeVisible()

      // gone again (empty widgets go without asking)
      for (const name of ['Festplatte · /mnt/disk1', 'Container-Top · CPU', 'Meldungen']) await page.getByRole('button', { name: `${name} entfernen`, exact: true }).click()
      await expect(page.getByTestId('disk-widget')).toHaveCount(0)
      await expect(page.getByTestId('containers-widget')).toHaveCount(0)
      await expect(page.getByTestId('alerts-widget')).toHaveCount(0)
      await page.getByRole('button', { name: 'Fertig' }).click()
    })

    test('more widgets: one service with its buttons, a link group, network devices, speed test, logins', async ({ page }) => {
      await login(page)
      await page.getByRole('img', { name: 'live verbunden' }).waitFor()
      await page.getByRole('button', { name: 'Bearbeiten', exact: true }).click()
      const add = async (name: string) => {
        await page.getByRole('button', { name: 'Widget hinzufügen' }).first().click()
        await page
          .getByRole('dialog', { name: 'Widget hinzufügen' })
          .getByRole('button', { name: `${name} hinzufügen`, exact: true })
          .click()
      }

      // a service: which unit is asked right away
      await add('Dienst')
      const svc = page.getByRole('dialog', { name: 'Dienst einstellen' })
      await svc.getByLabel('Unit').selectOption('jellyfin.service')
      await svc.getByRole('button', { name: 'Speichern' }).click()
      const jelly = page.getByRole('region', { name: 'jellyfin' })
      await expect(jelly).toContainText('active')
      await expect(jelly.getByRole('button', { name: 'Neu starten' })).toBeVisible()
      await expect(jelly.getByRole('link', { name: 'Journal' })).toHaveAttribute('href', '/journal?unit=jellyfin.service')

      // a link group: only http(s), an empty row is fine
      await add('Linkgruppe')
      const links = page.getByRole('dialog', { name: 'Linkgruppe einstellen' })
      await links.getByLabel('Überschrift (optional)').fill('Heimnetz')
      await links.getByLabel('Name 1').fill('Fritzbox')
      await links.getByLabel('Adresse 1').fill('javascript:alert(1)')
      await expect(links).toContainText('Link 1: Name und eine http(s)-Adresse angeben.')
      await expect(links.getByRole('button', { name: 'Speichern' })).toBeDisabled()
      await links.getByLabel('Adresse 1').fill('http://192.168.1.1')
      await links.getByRole('button', { name: 'Link hinzufügen' }).click()
      await links.getByRole('button', { name: 'Speichern' }).click()
      const group = page.getByRole('region', { name: 'Heimnetz' })
      await expect(group.getByRole('link', { name: /Fritzbox/ })).toHaveAttribute('href', 'http://192.168.1.1')

      await add('Netzwerkgeräte')
      await expect(page.getByTestId('devices-widget')).toContainText('Geräten online')
      await add('Speedtest')
      await expect(page.getByTestId('speed-widget')).toBeVisible()
      await add('Anmeldungen')
      await expect(page.getByTestId('logins-widget').getByRole('link', { name: 'Zu SSH' })).toBeVisible()

      for (const name of ['jellyfin', 'Netzwerkgeräte', 'Speedtest', 'Anmeldungen']) await page.getByRole('button', { name: `${name} entfernen`, exact: true }).click()
      // the link group has content: it asks
      await page.getByRole('button', { name: 'Heimnetz entfernen' }).click()
      await page.getByRole('dialog', { name: 'Heimnetz entfernen?' }).getByRole('button', { name: 'Entfernen' }).click()
      await expect(page.getByTestId('links-widget')).toHaveCount(0)
      await expect(page.getByTestId('service-widget')).toHaveCount(0)
      await page.getByRole('button', { name: 'Fertig' }).click()
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

    test('edit mode: a tile is dragged into another group; outside edit mode nothing moves', async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 1400 }) // both groups on screen: the page does not scroll while dragging
      await login(page)
      await page.getByRole('img', { name: 'live verbunden' }).waitFor()
      const groupOf = (testId: string) => page.getByTestId('tile-group').filter({ has: page.getByTestId(testId) })
      const from = await groupOf('grid-item-ct:jellyfin').getAttribute('aria-label')
      // Any tile of another group is the drop spot.
      const other = page
        .getByTestId('tile-group')
        .filter({ hasNot: page.getByTestId('grid-item-ct:jellyfin') })
        .first()
      const to = await other.getAttribute('aria-label')
      const spot = other.locator('[data-testid^="grid-item-"]').first()
      const drag = async () => {
        const tile = page.getByTestId('grid-item-ct:jellyfin')
        await tile.evaluate((el) => el.scrollIntoView({ block: 'center' }))
        await page.waitForTimeout(300)
        const a = (await tile.boundingBox())!
        await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
        await page.mouse.down()
        await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + 20, { steps: 4 })
        const b = (await spot.boundingBox())! // the groups below may shift once the drag starts
        await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 20 })
      }
      // View mode: tiles are links, dragging does nothing.
      await drag()
      await page.mouse.up()
      await expect(groupOf('grid-item-ct:jellyfin')).toHaveAttribute('aria-label', from!)

      await page.getByRole('button', { name: 'Bearbeiten' }).click()
      await expect(page.getByText('Kachel auf eine andere Gruppe ziehen')).toBeVisible()
      await drag()
      await expect(page.getByRole('group', { name: to!, exact: true })).toHaveClass(/outline-dashed/) // drop target shown
      await page.mouse.up()
      await expect(page.getByRole('status').filter({ hasText: `Jellyfin nach ${to} verschoben` })).toBeVisible()
      await expect(groupOf('grid-item-ct:jellyfin')).toHaveAttribute('aria-label', to!)
      await expect(page.getByTestId('tile-group').filter({ has: page.locator('.outline-dashed') })).toHaveCount(0)

      // Back to automatic: the detected group again (the click right after a drag is ignored on purpose).
      await expect(async () => {
        await page.getByRole('button', { name: 'Jellyfin bearbeiten' }).click()
        await expect(page.getByRole('dialog', { name: 'Jellyfin bearbeiten' })).toBeVisible({ timeout: 1000 })
      }).toPass()
      await page.getByRole('dialog').getByRole('button', { name: 'Auf automatisch zurücksetzen' }).click()
      await expect(groupOf('grid-item-ct:jellyfin')).toHaveAttribute('aria-label', from!)
      await page.getByRole('button', { name: 'Fertig' }).click()
    })

    test('the services card is as tall as its tiles: one scrollbar for the page, only the width can be resized', async ({ page }) => {
      await login(page)
      await page.getByRole('img', { name: 'live verbunden' }).waitFor()
      const card = page.getByTestId('grid-item-services')
      const innerOverflow = () => card.locator('.grid-item-scroll').evaluate((el) => el.scrollHeight - el.clientHeight)
      await expect.poll(innerOverflow).toBeLessThanOrEqual(1)
      await page.getByRole('button', { name: 'Bearbeiten' }).click()
      // the card's own handles (the tiles inside have their own corner handles)
      await expect(card.locator(':scope > .react-resizable-handle-e')).toHaveCount(1)
      await expect(card.locator(':scope > .react-resizable-handle-se')).toHaveCount(0)
      // Bigger icons make taller tiles: the card grows along.
      await page.getByRole('radio', { name: 'Groß' }).click()
      await expect.poll(innerOverflow).toBeLessThanOrEqual(1)
      await page.getByRole('radio', { name: 'Mittel' }).click()
      await page.getByRole('button', { name: 'Fertig' }).click()
    })

    test('a newly picked icon shows right away, even after the old one failed to load', async ({ page }) => {
      // Only "plex" exists; every other icon (the automatic one included) fails and falls back to a glyph.
      await page.route('**/api/icons/*', (r) =>
        r.request().url().endsWith('/api/icons/plex')
          ? r.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#e5a00d"/></svg>' })
          : r.fulfill({ status: 404, body: 'not found' }),
      )
      await page.route('**/api/favicon/*', (r) => r.fulfill({ status: 404, body: 'not found' }))
      await login(page)
      await page.getByRole('img', { name: 'live verbunden' }).waitFor()
      const icon = page.getByTestId('service-tile').filter({ hasText: 'Jellyfin' }).locator('[data-size]')
      await expect(icon.locator('svg')).toBeVisible() // the fallback glyph
      await page.getByRole('button', { name: 'Bearbeiten' }).click()
      await page.getByRole('button', { name: 'Jellyfin bearbeiten' }).click()
      let dialog = page.getByRole('dialog', { name: 'Jellyfin bearbeiten' })
      await dialog.getByLabel('Icon suchen').fill('plex')
      await dialog.getByRole('button', { name: 'Speichern' }).click()
      await expect(dialog).toBeHidden()
      await expect(icon).toHaveAttribute('data-icon', 'plex')
      await expect(icon.locator('img')).toHaveAttribute('src', '/api/icons/plex') // without a reload
      await expect.poll(() => icon.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)

      // Opened again, the dialog shows this icon (not the one of the service edited before)
      await page.getByRole('button', { name: 'Jellyfin bearbeiten' }).click()
      dialog = page.getByRole('dialog', { name: 'Jellyfin bearbeiten' })
      await expect(dialog.getByLabel('Icon suchen')).toHaveValue('plex')
      await dialog.getByRole('button', { name: 'Auf automatisch zurücksetzen' }).click()
      await expect(icon).not.toHaveAttribute('data-icon', 'plex')
      await expect(icon.locator('svg')).toBeVisible()
      await page.getByRole('button', { name: 'Fertig' }).click()
    })

    test('icon size of the service tiles: one setting for all, only in edit mode, kept across reloads, reset to medium', async ({ page }) => {
      await login(page)
      await page.getByRole('img', { name: 'live verbunden' }).waitFor()
      const sizes = page.getByRole('radiogroup', { name: 'Icon-Größe' })
      await expect(sizes).toHaveCount(0) // not outside edit mode
      const icons = page.getByRole('region', { name: 'Services' }).locator('[data-size]')
      const box = async () => (await page.getByTestId('service-tile').filter({ hasText: 'Jellyfin' }).locator('[data-size]').boundingBox())!.width
      const medium = await box()

      await page.getByRole('button', { name: 'Bearbeiten' }).click()
      await expect(sizes.getByRole('radio', { name: 'Mittel' })).toHaveAttribute('aria-checked', 'true')
      await sizes.getByRole('radio', { name: 'Groß' }).click()
      await expect(sizes.getByRole('radio', { name: 'Groß' })).toHaveAttribute('aria-checked', 'true')
      await expect.poll(box).toBeGreaterThan(medium)
      await page.getByRole('button', { name: 'Fertig' }).click()

      await page.reload()
      await page.getByRole('img', { name: 'live verbunden' }).waitFor()
      for (const el of await icons.all()) await expect(el).toHaveAttribute('data-size', 'lg') // every tile, not just one
      // the tile keeps room for name and host under the larger icon
      const tile = page.getByTestId('service-tile').filter({ hasText: 'Jellyfin' })
      const host = (await tile.getByText('jellyfin.home.example').boundingBox())!
      const frame = (await tile.boundingBox())!
      expect(host.y + host.height).toBeLessThanOrEqual(frame.y + frame.height)

      await page.getByRole('button', { name: 'Bearbeiten' }).click()
      await sizes.getByRole('radio', { name: 'Klein' }).click()
      await expect.poll(box).toBeLessThan(medium)
      await page.getByRole('button', { name: 'Auf Auto-Layout zurücksetzen' }).click()
      await expect(sizes.getByRole('radio', { name: 'Mittel' })).toHaveAttribute('aria-checked', 'true')
      await expect.poll(box).toBe(medium)
      await page.getByRole('button', { name: 'Fertig' }).click()
    })

    test('services page: only the services and links, with search; the widget stays on the overview', async ({ page }) => {
      await login(page)
      await page.getByRole('img', { name: 'live verbunden' }).waitFor()
      const widget = page.getByTestId('grid-item-services')
      await expect(widget.getByTestId('service-tile').filter({ hasText: 'Jellyfin' })).toBeVisible()
      await widget.getByRole('link', { name: 'Services-Seite' }).click()
      await expect(page).toHaveURL('/services')
      await expect(page.getByRole('heading', { name: 'Services & Links', level: 1 })).toBeVisible()
      await expect(page.getByRole('navigation', { name: 'Bereiche' }).getByRole('link', { name: 'Services & Links' })).toHaveAttribute('aria-current', 'page')
      // no widgets here, only the tiles in their groups
      await expect(page.getByTestId('gauge-cpu')).toHaveCount(0)
      const tiles = page.getByTestId('service-tile')
      await expect(tiles.filter({ hasText: 'Jellyfin' })).toHaveAttribute('href', 'https://jellyfin.home.example')
      expect(await page.getByTestId('tile-group').count()).toBeGreaterThan(1)
      // A wide screen makes the one-row tiles wider than 260 px: they keep the compact layout,
      // name and host stay inside the tile instead of being cut off at the bottom.
      await page.setViewportSize({ width: 2600, height: 1000 })
      const cut = () =>
        tiles.evaluateAll((els) =>
          // name and host are flex items with overflow hidden: when they don't fit they shrink and clip
          // (a couple of pixels for the descenders always overflow)
          els.filter((e) => [...e.querySelectorAll<HTMLElement>('.truncate')].some((t) => t.clientHeight < t.scrollHeight - 4)).map((e) => e.textContent),
        )
      await expect.poll(async () => (await tiles.first().boundingBox())!.width).toBeGreaterThan(260)
      expect(await cut()).toEqual([])
      await page.setViewportSize({ width: 1280, height: 720 })

      const search = page.getByRole('searchbox', { name: 'Services durchsuchen' })
      await search.fill('jelly')
      await expect(page.getByTestId('tile-group')).toHaveCount(0)
      await expect(tiles).toHaveCount(1)
      await expect(tiles).toHaveAttribute('href', 'https://jellyfin.home.example')
      await search.fill('gibt-es-nicht')
      await expect(page.getByText('Kein Service passt zu „gibt-es-nicht“.')).toBeVisible()
      await search.fill('')
      await expect(tiles.filter({ hasText: 'Home Assistant' })).toBeVisible()

      // edit mode: the same tools as in the widget, the search steps aside
      await page.getByRole('button', { name: 'Bearbeiten' }).click()
      await expect(search).toHaveCount(0)
      await expect(page.getByRole('radiogroup', { name: 'Icon-Größe' })).toBeVisible()
      await expect(tiles.filter({ hasText: 'Jellyfin' })).toHaveAttribute('role', 'button')
      await page.getByRole('button', { name: 'Fertig' }).click()
    })

    test('animations: off, subtle, strong in the sidebar and the palette; kept per browser; "reduce motion" means off', async ({ page }) => {
      await login(page)
      const html = page.locator('html')
      await expect(html).toHaveAttribute('data-motion', 'subtle') // default
      const group = page.getByRole('radiogroup', { name: 'Animationen' })
      await expect(group.getByRole('radio', { name: 'Dezent' })).toHaveAttribute('aria-checked', 'true')
      await group.getByRole('radio', { name: 'Kräftig' }).click()
      await expect(html).toHaveAttribute('data-motion', 'strong')
      await expect(page.getByText('Einblenden, Leuchten, Schimmer und Hover-Effekte.')).toBeVisible()
      await page.reload()
      await expect(html).toHaveAttribute('data-motion', 'strong') // set before the first paint
      await expect(page.getByRole('radiogroup', { name: 'Animationen' }).getByRole('radio', { name: 'Kräftig' })).toHaveAttribute('aria-checked', 'true')
      // from the command palette
      await page.keyboard.press('Control+k')
      await page.getByRole('combobox', { name: 'Suchen' }).fill('animationen aus')
      await page.keyboard.press('Enter')
      await expect(html).toHaveAttribute('data-motion', 'off')
      // nothing moves when off: the status dots and the progress shimmer stand still
      expect(
        await page
          .locator('.dot')
          .first()
          .evaluate((el) => getComputedStyle(el).animationName),
      ).toBe('none')
      await page.getByRole('radiogroup', { name: 'Animationen' }).getByRole('radio', { name: 'Dezent' }).click()
      await expect(html).toHaveAttribute('data-motion', 'subtle')
    })

    test('animations: without a choice, the system\'s "reduce motion" turns them off', async ({ browser }) => {
      const ctx = await browser.newContext({ reducedMotion: 'reduce' })
      const page = await ctx.newPage()
      await login(page)
      await page.evaluate(() => localStorage.removeItem('quadeck-motion'))
      await page.reload()
      await expect(page.locator('html')).toHaveAttribute('data-motion', 'off')
      await ctx.close()
    })

    test('color themes: swatches in the sidebar and the palette; the whole UI follows; kept per browser', async ({ page }) => {
      await login(page)
      const html = page.locator('html')
      const accent = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim())
      const pageBg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
      await expect(html).toHaveAttribute('data-theme', 'quadeck') // default
      expect(await accent()).toBe('#7cc4b8')
      const before = await pageBg()
      const group = page.getByRole('radiogroup', { name: 'Farbschema' })
      await expect(group.getByRole('radio', { name: 'Quadeck' })).toHaveAttribute('aria-checked', 'true')
      await group.getByRole('radio', { name: 'Amethyst' }).click()
      await expect(html).toHaveAttribute('data-theme', 'amethyst')
      await expect(page.getByText('Farbschema: Amethyst')).toBeVisible()
      expect(await accent()).toBe('#b4a0ff')
      expect(await pageBg()).not.toBe(before) // the surfaces change too, not only the accent
      // the current page in the navigation uses the new accent (after its 0.15s color transition)
      const active = page.getByRole('navigation').locator('.navbtn.on').first()
      await expect(active).toHaveCSS('color', 'rgb(212, 200, 255)')
      await page.reload()
      await expect(html).toHaveAttribute('data-theme', 'amethyst') // set before the first paint
      // hydrated (the server renders the default swatch as checked): only now Ctrl+K has a listener
      await expect(page.getByRole('radiogroup', { name: 'Farbschema' }).getByRole('radio', { name: 'Amethyst' })).toHaveAttribute('aria-checked', 'true')
      // from the command palette
      await page.keyboard.press('Control+k')
      await page.getByRole('combobox', { name: 'Suchen' }).fill('farbschema kupfer')
      await page.keyboard.press('Enter')
      await expect(html).toHaveAttribute('data-theme', 'copper')
      expect(await accent()).toBe('#e39b6f')
      await page.getByRole('radiogroup', { name: 'Farbschema' }).getByRole('radio', { name: 'Quadeck' }).click()
      await expect(html).toHaveAttribute('data-theme', 'quadeck')
      expect(await pageBg()).toBe(before)
    })

    test('command palette: Ctrl+K, search, navigate and unit actions', async ({ page }) => {
      await login(page)
      await page.getByRole('img', { name: 'live verbunden' }).waitFor()
      await page.keyboard.press('Control+k')
      const input = page.getByRole('combobox', { name: 'Suchen' })
      await input.fill('qbit')
      await expect(page.getByRole('listbox').getByRole('option').first()).toContainText('qBittorrent')
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
      // "Edit the overview" opens the edit mode
      await page.getByRole('button', { name: /Suchen/ }).click()
      await page.getByRole('combobox', { name: 'Suchen' }).fill('widgets')
      await page.keyboard.press('Enter')
      await expect(page).toHaveURL('/')
      await expect(page.getByRole('button', { name: 'Fertig' })).toHaveAttribute('aria-pressed', 'true')
      await page.getByRole('button', { name: 'Fertig' }).click()
    })

    test('animations: healthy lights stand still on subtle and only breathe on strong; warnings and errors pulse', async ({ page }) => {
      await login(page)
      await page.goto('/journal')
      const live = page.locator('.live:not(.off)') // following the journal
      await expect(live).toBeVisible()
      const anim = (sel: string, pseudo?: string) =>
        page
          .locator(sel)
          .first()
          .evaluate((el, p) => getComputedStyle(el, p).animationName, pseudo ?? null)
      await expect(page.locator('html')).toHaveAttribute('data-motion', 'subtle')
      expect(await anim('.live', '::before')).toBe('none')
      await page.goto('/')
      expect(await anim('.dot.ok')).toBe('none')
      expect(await anim('.dot.bad')).toBe('alarm') // the failed demo unit on its alarm card

      await page.evaluate(() => localStorage.setItem('quadeck-motion', 'strong'))
      await page.reload()
      await expect(page.locator('html')).toHaveAttribute('data-motion', 'strong')
      expect(await anim('.dot.ok')).toBe('breathe')
      expect(await anim('.dot.bad')).toBe('alarm')
      await page.goto('/journal')
      await expect(live).toBeVisible()
      expect(await anim('.live', '::before')).toBe('breathe')
      await page.evaluate(() => localStorage.removeItem('quadeck-motion'))
    })

    test('units filter and journal', async ({ page }) => {
      await login(page)
      await page.getByRole('link', { name: /Units/ }).click()
      await expect(page.getByTestId('unit-row')).toHaveCount(8) // default filter: containers
      await page.getByRole('link', { name: /^Alle/ }).click()
      await expect(page.getByTestId('unit-row')).toHaveCount(19) // 18 units (2 of them sockets) + 1 container without unit
      await page.getByRole('link', { name: /Fehlgeschlagen/ }).click()
      await expect(page).toHaveURL(/filter=failed/)
      await expect(page.getByTestId('unit-row')).toHaveCount(1) // immich-ml was restarted above
      await expect(page.getByTestId('unit-row')).toContainText('Prozess endete mit Exit 1')

      await page.getByTestId('unit-row').getByRole('link', { name: 'backup-offsite.service' }).click() // the name opens the journal
      await expect(page).toHaveURL(/\/journal\?unit=backup-offsite.service/)
      await page.getByRole('button', { name: 'Alle Units' }).click()
      await expect(page.getByTestId('journal')).toContainText("Failed with result 'oom-kill'")
      await page.getByRole('button', { name: 'Fehler' }).click()
      await expect(page.getByTestId('journal')).not.toContainText('Playback started')
    })

    test('installable as an app: manifest, icons and the iOS tags, readable before the login', async ({ page, request }) => {
      const manifest = await request.get('/manifest.webmanifest')
      expect(manifest.ok()).toBe(true)
      expect(manifest.headers()['content-type']).toContain('application/manifest+json')
      const m = (await manifest.json()) as { name: string; start_url: string; display: string; icons: { src: string; sizes: string; purpose?: string }[] }
      expect(m).toMatchObject({ name: 'Quadeck', start_url: '/', display: 'standalone' })
      expect(m.icons.map((i) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']))
      expect(m.icons.some((i) => i.purpose === 'maskable')).toBe(true)
      for (const icon of [...m.icons.map((i) => i.src), '/icons/apple-touch-icon.png']) {
        const r = await request.get(icon)
        expect(r.ok(), icon).toBe(true)
      }

      await page.goto('/login') // the login page already offers the install, before anyone signs in
      await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest')
      await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/icons/apple-touch-icon.png')
      await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#0b0f14')
      // Chrome's own verdict; Playwright's contexts are always incognito, nothing else may be missing
      const cdp = await page.context().newCDPSession(page)
      const { installabilityErrors } = (await cdp.send('Page.getInstallabilityErrors')) as { installabilityErrors: { errorId: string }[] }
      expect(installabilityErrors.map((e) => e.errorId).filter((id) => id !== 'in-incognito')).toEqual([])
    })

    test('API refuses anonymous and cross-site requests', async ({ request, page }) => {
      expect((await request.get('/api/events')).status()).toBe(401)
      expect((await request.post('/api/units', { data: { name: 'jellyfin.service', action: 'stop' } })).status()).toBe(401)
      await login(page)
      const res = await page.request.post('/api/units', { data: { name: 'jellyfin.service', action: 'stop' }, headers: { origin: 'http://evil.example' } })
      expect(res.status()).toBe(403)
      const noCsrf = await page.request.post('/api/units', { data: { name: 'jellyfin.service', action: 'stop' }, headers: { 'accept-language': 'de-DE' } })
      expect(noCsrf.status()).toBe(403)
      expect(await noCsrf.json()).toEqual({ error: 'CSRF-Token fehlt oder ist ungültig' })
    })
  })
