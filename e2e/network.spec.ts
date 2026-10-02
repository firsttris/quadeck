import { expect, test, type Page } from '@playwright/test'

// fixtures/demo/network.json + the demo containers' published ports.
const PASSWORD = 'e2e-password-123'

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Passwort').fill(PASSWORD)
  await page.getByRole('button', { name: 'Anmelden' }).click()
  await expect(page).toHaveURL('/')
}

test('network: interfaces, ports with programs and containers, firewall', async ({ page }) => {
  await login(page)
  await page.getByRole('link', { name: 'Netzwerk' }).click()
  const ifaces = page.getByTestId('iface')
  await expect(ifaces.filter({ hasText: 'enp3s0' })).toContainText('192.168.1.20/24')
  await expect(ifaces.filter({ hasText: 'enp3s0' })).toContainText('2.5 Gbit/s')
  await expect(ifaces.filter({ hasText: 'veth0' })).toHaveCount(0)
  await page.getByLabel(/auch Loopback und Container-Verbindungen/).check()
  await expect(ifaces.filter({ hasText: 'veth0' })).toHaveCount(1)

  await expect(page.getByRole('region', { name: 'Routen und DNS' })).toContainText('192.168.1.1 über enp3s0')

  await page.getByRole('tab', { name: /Ports/ }).click()
  const ports = page.getByRole('region', { name: 'Offene Ports' })
  const row = (port: string) => ports.getByTestId('port-row').filter({ has: page.getByText(port, { exact: true }) })
  await expect(row('22')).toContainText('sshd')
  await expect(row('22')).toContainText('offen')
  await expect(row('111').first()).toContainText('blockiert')
  await expect(row('8096')).toContainText('Container jellyfin')
  await expect(row('8096')).toContainText('offen (Podman)')
  await expect(row('631')).toContainText('nur dieser Rechner')
  await ports.getByLabel('nur aus dem Netz erreichbare').check()
  await expect(row('631')).toHaveCount(0)

  await page.getByRole('tab', { name: 'Firewall' }).click()
  await expect(page).toHaveURL(/tab=firewall/)
  const fw = page.getByRole('region', { name: 'Firewall' })
  await expect(fw).toContainText('firewalld aktiv')
  await expect(fw).toContainText('111/tcp')
})
