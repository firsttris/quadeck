import { expect, test, type Page } from '@playwright/test'

// Demo data: the in-memory file tree of FixtureFiles (/mnt/disk1, /mnt/disk2, /srv).
const PASSWORD = 'e2e-password-123'
const SHOTS = process.env.QUADECK_SHOTS

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

async function finishJob(page: Page, title: RegExp) {
  const job = page.getByRole('dialog', { name: title })
  await expect(job).toContainText('erfolgreich')
  await job.getByRole('button', { name: 'Schließen' }).click()
}

test('two panes: copy, move, drag and drop between them; kept in the address', async ({ page }) => {
  await login(page)
  await page.goto('/files?path=%2Fmnt%2Fdisk1%2FFilme')
  const files = page.getByRole('region', { name: 'Ordnerinhalt' })
  await files.getByRole('switch', { name: 'Zwei Spalten' }).click() // checked once the address has changed
  await expect(page).toHaveURL(/right=%2Fmnt%2Fdisk1%2FFilme/) // the right pane starts where the left one is
  const left = page.getByRole('region', { name: 'Linke Spalte' })
  const right = page.getByRole('region', { name: 'Rechte Spalte' })
  await expect(left).toHaveAttribute('data-active', 'true')
  await expect(page.getByRole('region', { name: 'Bereiche' })).toHaveCount(0) // each pane has its own area picker

  // Same folder on both sides: nothing to copy across
  await left.getByRole('checkbox', { name: 'Arrival (2016).mkv auswählen' }).check()
  await expect(files.getByRole('button', { name: 'Nach rechts kopieren' })).toBeDisabled()

  // Right: another disk
  await right.getByLabel('Bereich').selectOption('/mnt/disk2')
  await right.getByRole('button', { name: 'Backup', exact: true }).click()
  await expect(page).toHaveURL(/right=%2Fmnt%2Fdisk2%2FBackup/)
  await expect(right).toContainText('Leerer Ordner')
  await expect(right).toHaveAttribute('data-active', 'true') // clicking a pane makes it the active one
  await left.click({ position: { x: 5, y: 5 } })
  await expect(left).toHaveAttribute('data-active', 'true')
  await expect(left.getByRole('checkbox', { name: 'Arrival (2016).mkv auswählen' })).toBeChecked() // its selection stayed
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/two-panes.png`, fullPage: true })

  // Copy → right
  await files.getByRole('button', { name: 'Nach rechts kopieren' }).click()
  await unlockIfAsked(page)
  await finishJob(page, /Kopieren: Arrival/)
  await expect(right.getByTestId('file-row').filter({ hasText: 'Arrival (2016).mkv' })).toBeVisible()
  await expect(left.getByTestId('file-row').filter({ hasText: 'Arrival (2016).mkv' })).toBeVisible()

  // Again: asks before overwriting, naming the target folder
  await left.getByRole('checkbox', { name: 'Arrival (2016).mkv auswählen' }).check()
  await page.keyboard.press('F5') // F5 copies inside the explorer (and does not reload the page)
  const exists = page.getByRole('dialog', { name: 'Im Ziel schon vorhanden' })
  await expect(exists).toContainText('/mnt/disk2/Backup')
  await exists.getByRole('button', { name: 'Abbrechen' }).click()

  // Left to Downloads; then move from the right with F6
  await left.getByRole('button', { name: 'Eine Ebene höher' }).click()
  await left.getByRole('button', { name: 'Downloads', exact: true }).click()
  await expect(page).toHaveURL(/path=%2Fmnt%2Fdisk1%2FDownloads/)
  await right.getByRole('checkbox', { name: 'Arrival (2016).mkv auswählen' }).check()
  await expect(right).toHaveAttribute('data-active', 'true')
  await expect(files.getByRole('button', { name: 'Nach links verschieben' })).toBeEnabled() // the direction follows the active pane
  await page.keyboard.press('F6')
  await finishJob(page, /Verschieben: Arrival/)
  await expect(right).toContainText('Leerer Ordner')
  await expect(left.getByTestId('file-row').filter({ hasText: 'Arrival (2016).mkv' })).toBeVisible()

  // Drag a row onto the other pane: copies
  await left.getByTestId('file-row').filter({ hasText: 'Arrival (2016).mkv' }).dragTo(right)
  await finishJob(page, /Kopieren: Arrival/)
  await expect(right.getByTestId('file-row').filter({ hasText: 'Arrival (2016).mkv' })).toBeVisible()

  // Both folders survive a reload
  await page.reload()
  await expect(right.getByTestId('file-row').filter({ hasText: 'Arrival (2016).mkv' })).toBeVisible()
  await expect(left).toContainText('ubuntu-24.04.iso')

  // Clean up: delete the copy (F8) and both moved files' leftovers
  await right.getByRole('checkbox', { name: 'Arrival (2016).mkv auswählen' }).check()
  await page.keyboard.press('F8')
  await page.getByRole('dialog', { name: '„Arrival (2016).mkv“ löschen?' }).getByRole('button', { name: 'Endgültig löschen' }).click()
  await finishJob(page, /Löschen: Arrival/)
  await left.getByRole('checkbox', { name: 'Arrival (2016).mkv auswählen' }).check()
  await left.getByRole('button', { name: 'Eine Ebene höher' }).click() // selection is per folder
  await expect(left.getByRole('checkbox', { name: 'Filme auswählen' })).not.toBeChecked()

  // Off again: one pane, remembered by the browser
  await files.getByRole('switch', { name: 'Zwei Spalten' }).click()
  await expect(page).not.toHaveURL(/right=/)
  await expect(page.getByRole('region', { name: 'Bereiche' })).toBeVisible()
  await page.goto('/files?path=%2Fmnt%2Fdisk1')
  await expect(page.getByRole('region', { name: 'Linke Spalte' })).toHaveCount(0)
})

test('one pane: "Copy to …" opens the second pane as the target; the choice is remembered', async ({ page }) => {
  await login(page)
  await page.goto('/files?path=%2Fmnt%2Fdisk2%2FFotos%2F2024')
  const files = page.getByRole('region', { name: 'Ordnerinhalt' })
  await files.getByRole('button', { name: 'Aktionen für IMG_0002.jpg' }).click()
  await page.getByRole('menuitem', { name: 'Kopieren nach …' }).click()
  const left = page.getByRole('region', { name: 'Linke Spalte' })
  await expect(left.getByRole('checkbox', { name: 'IMG_0002.jpg auswählen' })).toBeChecked()
  await expect(files.getByTestId('two-hint')).toContainText('Öffne rechts den Zielordner')
  await page.goto('/files?path=%2Fsrv')
  await expect(page.getByRole('region', { name: 'Rechte Spalte' })).toBeVisible() // still two panes
})

test('two panes on a phone: one pane at a time, switched with tabs', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  await page.goto('/files?path=%2Fmnt%2Fdisk1&right=%2Fmnt%2Fdisk2')
  const left = page.getByRole('region', { name: 'Linke Spalte' })
  const right = page.getByRole('region', { name: 'Rechte Spalte' })
  await expect(left).toBeVisible()
  await expect(right).toBeHidden()
  await page.getByRole('tab', { name: /^Rechts/ }).click()
  await expect(right).toBeVisible()
  await expect(left).toBeHidden()
  await expect(page.getByRole('button', { name: 'Nach links kopieren' })).toBeVisible()
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/two-panes-phone.png`, fullPage: true })
})
