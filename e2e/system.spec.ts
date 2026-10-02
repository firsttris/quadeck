import { expect, test, type Page } from '@playwright/test'

// Runs after dashboard.spec.ts (password set there). Package data comes from
// fixtures/demo/packages.json; jobs are simulated by the fixture backend.
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

test.describe.serial('System', () => {
  test('updates: news, packages, AUR, images and the system upgrade with live output', async ({ page }) => {
    await login(page)
    await page.getByRole('link', { name: 'System' }).click()
    await expect(page.getByRole('heading', { name: 'System', exact: true })).toBeVisible()

    const news = page.getByRole('region', { name: 'Arch-News' })
    await expect(news).toContainText('Manual intervention for pacman 7.0.0')
    await expect(news).toContainText('1 neu seit dem letzten Update')

    const repo = page.getByRole('region', { name: 'Systempakete · pacman' })
    await expect(repo.getByTestId('update-row')).toHaveCount(4)
    await expect(repo.getByTestId('update-row').filter({ hasText: 'linux' })).toContainText('6.10.1.arch1-1 → 6.10.3.arch1-2')
    await expect(repo).toContainText('Danach ist ein Neustart nötig (linux, glibc)')
    await expect(page.getByRole('region', { name: 'AUR' })).toContainText('Baut als tristan mit yay')
    await expect(page.getByRole('region', { name: 'Konfigurationsdateien' })).toContainText('/etc/pacman.d/mirrorlist.pacnew')

    await repo.getByRole('button', { name: 'Alle aktualisieren (4)' }).click()
    const confirm = page.getByRole('dialog', { name: 'Systemupdate starten?' })
    await expect(confirm).toContainText('ungelesene Arch-News')
    await confirm.getByRole('button', { name: 'Aktualisieren' }).click()
    await unlock(page)

    const job = page.getByRole('dialog', { name: 'Systemupdate' })
    await expect(job.getByLabel('Ausgabe')).toContainText('$ pacman -Syu')
    await expect(job.getByLabel('Ausgabe')).toContainText('upgrading podman...')
    await expect(job).toContainText('erfolgreich')
    await job.getByRole('button', { name: 'Schließen' }).click()

    await expect(repo).toContainText('Alles aktuell.')
    await expect(page.getByRole('region', { name: 'Neustart nötig' })).toContainText('Kernel aktualisiert')
    await expect(page.getByRole('region', { name: 'Letzte Jobs' })).toContainText('Systemupdate')
  })

  test('container images: single update, then all with rollback', async ({ page }) => {
    await login(page)
    await page.goto('/system')
    const images = page.getByRole('region', { name: 'Container-Images' })
    await expect(images.getByTestId('image-row')).toHaveCount(3)
    await expect(images).toContainText('2 Updates')
    await images.getByRole('button', { name: 'jellyfin aktualisieren' }).click()
    await unlock(page)
    const job = page.getByRole('dialog', { name: 'Image aktualisieren: jellyfin.service' })
    await expect(job.getByLabel('Ausgabe')).toContainText('$ systemctl restart jellyfin.service')
    await expect(job).toContainText('erfolgreich')
    await job.getByRole('button', { name: 'Schließen' }).click()
    await expect(images).toContainText('1 Update')

    // Already unlocked: no second password prompt.
    await images.getByRole('button', { name: 'Alle aktualisieren' }).click()
    await page.getByRole('dialog', { name: 'Container-Images aktualisieren?' }).getByRole('button', { name: 'Aktualisieren' }).click()
    const all = page.getByRole('dialog', { name: 'Container-Images aktualisieren' })
    await expect(all).toContainText('erfolgreich')
    await all.getByRole('button', { name: 'Schließen' }).click()
    await expect(images.getByText('Update verfügbar')).toHaveCount(0)
  })

  test('installed packages: filters, details, protected packages and removal with preview', async ({ page }) => {
    await login(page)
    await page.goto('/system?tab=packages')
    const rows = page.getByTestId('package-row')
    await expect(rows).toHaveCount(22)
    const filters = page.getByRole('group', { name: 'Filter' })
    await filters.getByRole('button', { name: /^Fremd \/ AUR/ }).click()
    await expect(rows).toHaveCount(2)
    await filters.getByRole('button', { name: /^Verwaist/ }).click()
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('python-old-lib')
    await filters.getByRole('button', { name: /^Alle/ }).click()

    // Protected packages cannot be selected
    await expect(page.getByRole('checkbox', { name: 'systemd auswählen' })).toBeDisabled()

    await page.getByLabel('Pakete suchen').fill('tldr')
    await expect(rows).toHaveCount(1)
    await rows.first().getByRole('button', { name: 'tealdeer' }).click()
    const detail = page.getByRole('dialog', { name: 'tealdeer' })
    await expect(detail).toContainText('A very fast implementation of tldr')
    await expect(detail.getByRole('button', { name: 'tealdeer-data' })).toBeVisible()
    await detail.getByRole('button', { name: 'Entfernen …' }).click()

    const remove = page.getByRole('dialog', { name: 'tealdeer entfernen?' })
    await expect(remove.getByRole('list', { name: 'Wird entfernt' })).toContainText('tealdeer-data')
    await remove.getByRole('button', { name: '2 entfernen' }).click()
    await unlock(page)
    const job = page.getByRole('dialog', { name: 'Entfernen: tealdeer' })
    await expect(job).toContainText('erfolgreich')
    await job.getByRole('button', { name: 'Schließen' }).click()
    await page.getByLabel('Pakete suchen').fill('')
    await expect(rows).toHaveCount(20)

    // Protected packages are marked as such by the server.
    const res = await page.request.get('/api/system/packages/systemd')
    expect(((await res.json()) as { protected: boolean }).protected).toBe(true)
  })
})
