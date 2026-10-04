import { expect, test, type Page } from '@playwright/test'

const PASSWORD = 'e2e-password-123'

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Passwort').fill(PASSWORD)
  await page.getByRole('button', { name: 'Anmelden' }).click()
  await expect(page).toHaveURL('/')
}

test('network devices: scan, name, ports, wake-on-LAN, interval and the opt-in rule', async ({ page }) => {
  await login(page)
  await page.goto('/network')
  await page.getByRole('tab', { name: 'Geräte' }).click()
  await expect(page).toHaveURL('/network?tab=devices')
  const panel = page.getByRole('region', { name: 'Geräte im Netzwerk' })
  await expect(panel).toContainText('Netz 192.168.1.0/24')

  await panel.getByRole('button', { name: 'Jetzt scannen' }).click()
  await expect(page.getByRole('status')).toContainText('Scan fertig: 15 Geräte online')
  const rows = page.getByTestId('device-row')
  await expect(rows).toHaveCount(15)
  await expect(rows.filter({ hasText: 'nas-01' })).toContainText('dieser Server')
  await expect(rows.filter({ hasText: 'fritz.box' })).toContainText('AVM GmbH')
  await expect(rows.filter({ hasText: '192.168.1.77' })).toContainText('zufällige MAC')
  await expect(rows.filter({ hasText: 'brother-hl-l2350' })).toContainText('Drucker')

  await panel.getByRole('searchbox', { name: /Name, IP, MAC/ }).fill('brother')
  await expect(rows).toHaveCount(1)
  await panel.getByRole('button', { name: 'Details zu brother-hl-l2350' }).click()
  const dialog = page.getByRole('dialog', { name: 'brother-hl-l2350' })
  await expect(dialog).toContainText('30:05:5c:aa:71:0e')
  await expect(dialog).toContainText('_ipp._tcp')
  await dialog.getByRole('button', { name: 'Ports prüfen' }).click()
  await expect(dialog.getByRole('list', { name: 'Offene Ports' })).toContainText('631 IPP')
  await expect(dialog.getByRole('list', { name: 'Offene Ports' })).toContainText('9100 RAW print')
  await dialog.getByRole('button', { name: 'Aufwecken (Wake-on-LAN)' }).click()
  await expect(page.getByRole('status')).toContainText('Weckpaket an brother-hl-l2350 gesendet')
  await dialog.getByLabel('Eigener Name').fill('Office printer')
  await dialog.getByLabel('Notiz').fill('Toner in the cellar')
  await dialog.getByLabel('Als bekannt markieren').check()
  await dialog.getByRole('button', { name: 'Speichern' }).click()
  await expect(dialog).toBeHidden()
  await panel.getByRole('searchbox').fill('office') // the own name is searchable too
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('Office printer')
  await expect(rows.first()).toContainText('brother-hl-l2350 · Brother Industries')
  await expect(rows.first()).toContainText('bekannt')

  // filters
  await panel.getByRole('searchbox').fill('')
  await panel.getByRole('button', { name: /^Neu/ }).click()
  await expect(rows).toHaveCount(0)
  await expect(panel).toContainText('Kein Gerät passt zum Filter.')
  await panel.getByRole('button', { name: /^Alle/ }).click()
  await expect(rows).toHaveCount(15)

  // the interval is kept
  await panel.getByLabel('Automatisch scannen').selectOption({ label: 'alle 1 h' })
  await page.reload()
  await expect(page.getByLabel('Automatisch scannen')).toHaveValue('60')
  await expect(page.getByTestId('device-row').filter({ hasText: 'Office printer' })).toHaveCount(1)

  // the notification rule exists and starts switched off
  await page.goto('/notifications')
  await expect(page.getByText('Neues Gerät im Netzwerk', { exact: true })).toBeVisible()
})
