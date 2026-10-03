import { expect, test, type Page } from '@playwright/test'

// Runs after dashboard.spec.ts (password set there). Quadlet files come from
// fixtures/demo/quadlets and live in memory.
const PASSWORD = 'e2e-password-123'

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Passwort').fill(PASSWORD)
  await page.getByRole('button', { name: 'Anmelden' }).click()
  await expect(page).toHaveURL('/')
  await expect(page.getByRole('img', { name: 'live verbunden' })).toBeVisible()
}

async function unlock(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Aktionen entsperren' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Passwort').fill(PASSWORD)
  await dialog.getByRole('button', { name: 'Entsperren' }).click()
  await expect(dialog).toBeHidden()
}

test.describe.serial('Quadlets', () => {
  test('edit in the form, same file in the text view, save with diff and restart, history', async ({ page }) => {
    await login(page)
    await page.getByRole('navigation', { name: 'Bereiche' }).getByRole('link', { name: 'Units' }).click()
    await page.getByRole('link', { name: 'Quadlet-Dateien' }).click()
    await expect(page).toHaveURL(/\/quadlets/)
    await expect(page.getByTestId('quadlet-file')).toHaveCount(5)
    await page.getByTestId('quadlet-file').filter({ hasText: 'jellyfin.container' }).click()
    const editor = page.getByRole('region', { name: 'Editor jellyfin.container' })
    await expect(editor).toContainText('erzeugt jellyfin.service')

    await editor.getByLabel('Image', { exact: true }).fill('docker.io/jellyfin/jellyfin:10.9.11')
    await editor.getByRole('button', { name: 'PublishPort hinzufügen' }).click()
    await editor.getByLabel('PublishPort 2', { exact: true }).fill('8920:8920')
    await editor.getByRole('button', { name: 'Text' }).click()
    const text = editor.getByLabel('Quadlet-Datei')
    await expect(text).toHaveValue(/Image=docker\.io\/jellyfin\/jellyfin:10\.9\.11/)
    await expect(text).toHaveValue(/PublishPort=8096:8096\nPublishPort=8920:8920\n/)
    // Comment and the key the form does not know survive.
    await expect(text).toHaveValue(/# Hardware-Transcoding über die iGPU/)

    await editor.getByRole('button', { name: 'Speichern …' }).click()
    const review = page.getByRole('dialog', { name: 'jellyfin.container speichern?' })
    await expect(review.getByLabel('Änderungen')).toContainText('- Image=docker.io/jellyfin/jellyfin:latest')
    await expect(review.getByLabel('Änderungen')).toContainText('+ PublishPort=8920:8920')
    await review.getByRole('button', { name: 'Speichern & neu starten' }).click()
    await unlock(page)
    await expect(page.getByText('jellyfin.container gespeichert · jellyfin.service neu gestartet')).toBeVisible()

    await editor.getByRole('button', { name: 'Verlauf (2)' }).click()
    const history = page.getByRole('dialog', { name: 'Verlauf: jellyfin.container' })
    await expect(history.getByLabel('Änderungen')).toContainText('+ Image=docker.io/jellyfin/jellyfin:10.9.11')
    await history.getByRole('button', { name: 'Diese Version in den Editor laden' }).click()
    await editor.getByRole('button', { name: 'Formular' }).click()
    await expect(editor.getByLabel('Image', { exact: true })).toHaveValue('docker.io/jellyfin/jellyfin:latest')
    await editor.getByRole('button', { name: 'Verwerfen' }).click()
    await expect(editor.getByLabel('Image', { exact: true })).toHaveValue('docker.io/jellyfin/jellyfin:10.9.11')
  })

  test('line diagnostics block saving; a new file from a template', async ({ page }) => {
    await login(page)
    await page.goto('/quadlets?file=caddy.container')
    const editor = page.getByRole('region', { name: 'Editor caddy.container' })
    await editor.getByRole('button', { name: 'Text' }).click()
    const text = editor.getByLabel('Quadlet-Datei')
    await expect(text).toHaveValue(/Image=docker\.io\/library\/caddy:2/)
    await text.fill('[Container]\nImage=docker.io/library/caddy:2\nthis is wrong\nPortz=80\n')
    const hints = editor.getByRole('list', { name: 'Hinweise' })
    await expect(hints).toContainText('Zeile 3')
    await expect(hints).toContainText('Unbekannter Schlüssel Portz in [Container]')
    await expect(editor.getByRole('button', { name: 'Speichern …' })).toBeDisabled()
    await editor.getByRole('button', { name: 'Verwerfen' }).click()

    await page.getByRole('button', { name: 'Neu', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Neue Quadlet-Datei' })
    await dialog.getByLabel('Vorlage').selectOption({ label: 'Netzwerk' })
    await dialog.getByLabel('Name').fill('backend')
    await dialog.getByRole('button', { name: 'Im Editor öffnen' }).click()
    const fresh = page.getByRole('region', { name: 'Editor backend.network' })
    await expect(fresh).toContainText('neu – noch nicht gespeichert')
    await expect(fresh.getByLabel('NetworkName')).toHaveValue('backend')
    await fresh.getByRole('button', { name: 'Speichern …' }).click()
    await page.getByRole('dialog', { name: 'backend.network speichern?' }).getByRole('button', { name: 'Speichern & starten' }).click()
    await unlock(page)
    await expect(page.getByTestId('quadlet-file').filter({ hasText: 'backend.network' })).toBeVisible()
  })

  test('new container from the units page opens the dialog in the editor', async ({ page }) => {
    await login(page)
    await page.goto('/units')
    await page.getByRole('link', { name: '+ Neuer Container' }).click()
    const dialog = page.getByRole('dialog', { name: 'Neue Quadlet-Datei' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Abbrechen' }).click()
    await expect(dialog).toBeHidden()
    await expect(page).toHaveURL(/\/quadlets$/)
  })

  test('import from docker-compose', async ({ page }) => {
    await login(page)
    await page.goto('/quadlets')
    await page.getByRole('button', { name: 'Compose-Import' }).click()
    const dialog = page.getByRole('dialog', { name: 'Aus docker-compose importieren' })
    await dialog.getByLabel('Projektname').fill('paperless')
    await dialog.getByLabel('docker-compose.yml').fill('services:\n  paperless:\n    image: ghcr.io/paperless-ngx/paperless-ngx:latest\n    ports: ["8000:8000"]\n    depends_on: [redis]\n  redis:\n    image: redis:7\n')
    await dialog.getByRole('button', { name: 'Umwandeln' }).click()
    await expect(dialog.getByTestId('compose-file')).toHaveCount(3)
    await expect(dialog.getByTestId('compose-file').filter({ hasText: 'redis.container' })).toContainText('Image=docker.io/library/redis:7')
    await dialog.getByRole('button', { name: '3 Dateien anlegen' }).click()
    await unlock(page)
    await expect(page.getByRole('region', { name: 'Editor paperless.container' })).toBeVisible()
    await expect(page.getByTestId('quadlet-file')).toHaveCount(9)
  })

  test('podman settings: timer, global auto-update, registries.conf with TOML check', async ({ page }) => {
    await login(page)
    await page.goto('/quadlets?tab=settings') // old link: the settings moved to the System page
    await expect(page).toHaveURL(/\/system\?tab=podman/)
    const timer = page.getByRole('region', { name: 'Automatische Updates' })
    await expect(timer).toContainText('Podman 5.6.1')
    await timer.getByLabel('Zeitplan (OnCalendar)').fill('Mon *-*-* 04:00')
    await timer.getByRole('button', { name: 'Zeitplan übernehmen' }).click()
    await unlock(page)
    await expect(page.getByText('Zeitplan: Mon *-*-* 04:00')).toBeVisible()
    // The switch follows the server's answer, so click instead of uncheck().
    await timer.getByRole('switch', { name: 'Timer aktiv' }).click()
    await expect(page.getByText('Auto-Update-Timer deaktiviert')).toBeVisible()
    await expect(timer.getByRole('switch', { name: 'Timer aktiv' })).not.toBeChecked()

    const global = page.getByRole('region', { name: 'Auto-Update für alle Container' })
    await global.getByRole('switch', { name: 'AutoUpdate=registry für alle' }).click()
    await expect(global.getByRole('switch', { name: 'AutoUpdate=registry für alle' })).toBeChecked()
    await expect(page.getByText('AutoUpdate=registry gilt jetzt für alle Container')).toBeVisible()

    const reg = page.getByRole('region', { name: 'registries.conf' })
    await reg.getByLabel('Registries für Kurznamen').fill('docker.io, quay.io')
    await expect(reg.getByLabel('registries.conf als Text')).toHaveValue(/unqualified-search-registries = \["docker.io", "quay.io"\]/)
    await expect(reg.getByLabel('registries.conf als Text')).toHaveValue(/^# Short names/)
    await reg.getByRole('button', { name: 'Speichern …' }).click()
    await page.getByRole('dialog', { name: 'registries.conf speichern?' }).getByRole('button', { name: 'Speichern' }).click()
    await expect(page.getByText('/etc/containers/registries.conf gespeichert')).toBeVisible()

    await reg.getByLabel('registries.conf als Text').fill('broken = [')
    await reg.getByRole('button', { name: 'Speichern …' }).click()
    await page.getByRole('dialog', { name: 'registries.conf speichern?' }).getByRole('button', { name: 'Speichern' }).click()
    await expect(reg.getByRole('alert')).toContainText('TOML-Fehler')
    await expect(page.getByRole('region', { name: 'storage.conf' }).getByLabel('storage.conf als Text')).toHaveAttribute('readonly', '')
  })
})
