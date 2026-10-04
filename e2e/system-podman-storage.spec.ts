import { expect, test, type Page } from '@playwright/test'

// Demo data: fixtures/demo/podman-storage.json, served by an in-memory Podman API (deletes included).
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

test('podman storage: what uses what, delete one volume, clean up with preview, cleanup timer', async ({ page }) => {
  await login(page)
  await page.goto('/system?tab=podman')
  const card = page.getByRole('region', { name: 'Speicher & Aufräumen' })
  await expect(card).toContainText('/var/lib/containers/storage')
  await expect(card).toContainText(/Platte zu 78/)
  await expect(card.getByTestId('podstore-tile')).toHaveCount(3)
  await expect(card.getByTestId('podstore-tile').nth(2)).toContainText('11 Container, 6 laufen')

  // Images: unused first, old versions named after what they were
  const rows = card.getByTestId('podstore-row')
  await expect(rows).toHaveCount(14)
  await expect(rows.filter({ hasText: 'alte Version von ghcr.io/immich-app/immich-server:release' })).toContainText('niemand')
  await expect(rows.filter({ hasText: 'docker.io/jellyfin/jellyfin:latest' }).last()).toContainText('in Benutzung')

  // Volumes: delete the orphaned one, after a warning
  await card.getByRole('tab', { name: /^Volumes/ }).click()
  await expect(rows.filter({ hasText: 'caddy-data' })).toContainText('caddy')
  await expect(rows.filter({ hasText: 'caddy-data' }).getByRole('button')).toHaveCount(0)
  await card.getByRole('button', { name: 'nextcloud-data löschen' }).click()
  const confirm = page.getByRole('dialog', { name: 'Volume nextcloud-data löschen?' })
  await expect(confirm).toContainText('Gelöscht ist gelöscht')
  await confirm.getByRole('button', { name: 'Volume endgültig löschen' }).click()
  await unlockIfAsked(page)
  await expect(page.getByRole('status')).toContainText('freigegeben (1 gelöscht)')
  await expect(rows.filter({ hasText: 'nextcloud-data' })).toHaveCount(0)

  // Cleanup dialog with a live preview
  await card.getByRole('button', { name: 'Aufräumen …' }).click()
  const dialog = page.getByRole('dialog', { name: 'Podman aufräumen' })
  const preview = dialog.getByTestId('podstore-preview')
  await expect(preview).toContainText('9 Einträge')
  const list = dialog.getByRole('list', { name: 'Wird gelöscht' })
  await expect(list).toContainText('old-nginx')
  await expect(list).toContainText('nextcloud_default')
  await expect(list).not.toContainText('Netzwerk · immich') // a Quadlet's network stays
  await dialog.getByRole('checkbox', { name: /^Alle ungenutzten Images/ }).check()
  await expect(preview).toContainText('11 Einträge')
  await expect(list).toContainText('docker.io/library/nextcloud:29')
  await dialog.getByRole('checkbox', { name: /^Alle ungenutzten Images/ }).uncheck()
  await dialog.getByRole('checkbox', { name: /^Volumes ohne Container/ }).check()
  await expect(preview).toContainText('9 Einträge') // volumes are picked one by one
  await dialog.getByRole('checkbox', { name: /^9b1d77/ }).check()
  await expect(preview).toContainText('10 Einträge')
  await dialog.getByRole('button', { name: '10 Einträge löschen' }).click()
  await unlockIfAsked(page)
  await expect(dialog).toContainText('freigegeben (10 gelöscht)')
  await dialog.getByRole('button', { name: 'Schließen' }).click()

  await card.getByRole('tab', { name: /^Gestoppte Container/ }).click()
  await expect(rows).toHaveCount(2) // the Quadlet ones stay
  await expect(rows.filter({ hasText: 'immich-ml' })).toContainText('gehört zu einem Quadlet')

  // Regular cleanup as a timer
  await card.getByRole('checkbox', { name: /^Regelmäßig aufräumen/ }).click() // checked once the server confirms
  await unlockIfAsked(page)
  await expect(page.getByRole('status')).toContainText('Regelmäßiges Aufräumen eingerichtet')
  await expect(card).toContainText('quadeck-podman-prune.timer')
  await card.getByLabel('Wie oft').selectOption('monthly')
  await expect(card.getByLabel('Wie oft')).toHaveValue('monthly')
  await page.goto('/units?filter=timer')
  await expect(page.getByText('quadeck-podman-prune.timer').first()).toBeVisible()

  // and off again (the timers spec expects the demo's own timers only)
  await page.goto('/system?tab=podman')
  await card.getByRole('checkbox', { name: /^Regelmäßig aufräumen/ }).click()
  await unlockIfAsked(page)
  await expect(page.getByRole('status')).toContainText('Regelmäßiges Aufräumen entfernt')
  await expect(card).not.toContainText('quadeck-podman-prune.timer')
})
