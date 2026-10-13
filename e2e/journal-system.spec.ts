import { expect, type Page, test } from '@playwright/test'

// Demo: fixtures/demo/journal-system.json – two boots, kernel, logins, services.
const PASSWORD = 'e2e-password-123'

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Passwort').fill(PASSWORD)
  await page.getByRole('button', { name: 'Anmelden' }).click()
  await expect(page).toHaveURL('/')
}

test('journal → system: search over time, areas, source, priority and boots; details of one entry; filters in the URL', async ({ page }) => {
  await login(page)
  await page.goto('/journal')
  await page.getByRole('navigation', { name: 'Ansicht' }).getByRole('link', { name: 'System durchsuchen' }).click()
  await expect(page).toHaveURL('/journal?view=system')
  const list = page.getByRole('list', { name: 'Journal-Einträge' })
  const entries = list.getByTestId('sys-entry')
  await expect(entries.first()).toBeVisible()
  await expect(page.getByTestId('sys-count')).toContainText(/\d+ Einträge/)
  await expect(page.getByRole('button', { name: '24 Std' })).toHaveAttribute('aria-pressed', 'true') // default range
  await expect(page.getByTestId('sys-timeline')).toBeVisible()

  // Failed SSH logins of the last week: area, range and text; the hits are marked.
  await page.getByRole('button', { name: '7 Tage' }).click()
  await page.getByRole('group', { name: 'Bereich' }).getByRole('button', { name: 'Anmeldungen & sudo' }).click()
  await page.getByLabel('Volltextsuche').fill('failed password')
  await expect(page).toHaveURL(/q=failed(\+|%20)password/)
  await expect(entries.first()).toContainText('Failed password')
  for (const t of await entries.allInnerTexts()) expect(t).toMatch(/failed password/i)
  await expect(entries.first().locator('mark')).toHaveText(/failed password/i)

  // A click on the source filters by it.
  await entries.first().getByRole('button', { name: 'sshd', exact: true }).click()
  await expect(page.getByText('Quelle: sshd.service')).toBeVisible()
  await expect(page).toHaveURL(/src=u%3Asshd\.service/)

  // Details: the message, the usual fields, every field on request.
  await entries
    .first()
    .getByRole('button', { name: /Eintrag von .* öffnen/ })
    .click()
  const dialog = page.getByRole('dialog', { name: 'Journal-Eintrag' })
  await expect(dialog).toContainText('Failed password')
  await expect(dialog).toContainText('sshd.service')
  await dialog.getByText('Alle Felder').click()
  await expect(dialog).toContainText('_HOSTNAME')
  await expect(dialog).toContainText('nas-01')
  await dialog.getByRole('button', { name: 'Schließen' }).click()
  await expect(dialog).toBeHidden()

  // Reset: back to the defaults.
  await page.getByRole('button', { name: 'Filter zurücksetzen' }).first().click()
  await expect(page).toHaveURL('/journal?view=system')
  await expect(page.getByLabel('Volltextsuche')).toHaveValue('')

  // Kernel messages of all time; only errors; the boot before.
  await page.getByRole('group', { name: 'Zeitraum' }).getByRole('button', { name: 'Alles' }).click()
  const area = page.getByRole('group', { name: 'Bereich' })
  await area.getByRole('button', { name: 'Kernel' }).click()
  await expect(entries.first()).toBeVisible()
  for (const t of await entries.locator('.sj-src').allInnerTexts()) expect(t).toBe('kernel')
  await page.getByRole('combobox', { name: /^Ab Priorität/ }).selectOption({ label: 'Fehler' })
  await expect(entries.first()).toContainText('I/O error')
  for (const t of await entries.locator('.sj-prio').allInnerTexts()) expect(['Fehler', 'Kritisch', 'Alarm', 'Notfall']).toContain(t)
  await page.getByRole('button', { name: 'Filter zurücksetzen' }).first().click()
  await page.getByRole('group', { name: 'Zeitraum' }).getByRole('button', { name: 'Alles' }).click()
  await page.getByRole('combobox', { name: /^Start/ }).selectOption({ index: 2 }) // the boot before this one
  await expect(page).toHaveURL(/boot=-1/)
  await expect(list).toContainText('System is rebooting.')
  await expect(list).not.toContainText('OOM killer')

  // Nothing found: a hint and the way back.
  await page.getByLabel('Volltextsuche').fill('no such message anywhere')
  await expect(list).toContainText('Keine Einträge für diese Filter')

  // Back to the live view: it still follows the units.
  await page.getByRole('link', { name: 'Live' }).click()
  await expect(page).toHaveURL('/journal')
  await expect(page.getByTestId('journal')).toBeVisible()
})
