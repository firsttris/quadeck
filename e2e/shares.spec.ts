import { expect, test, type Page } from '@playwright/test'

// Runs after dashboard.spec.ts. smb.conf and exports come from fixtures/demo
// and are changed in memory.
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

test.describe.serial('Freigaben', () => {
  test('SMB: create with diff preview, edit, delete; overview card follows', async ({ page }) => {
    await login(page)
    await page.getByRole('region', { name: 'Freigaben' }).getByRole('link', { name: 'Verwalten' }).click()
    const smb = page.getByRole('region', { name: 'SMB-Freigaben' })
    await expect(smb.getByTestId('smb-share')).toHaveCount(2)
    await expect(smb.getByTestId('smb-share').filter({ hasText: 'Medien' })).toContainText('2 verbunden')
    await expect(smb).toContainText('smb läuft')

    await smb.getByRole('button', { name: 'Neue Freigabe' }).click()
    const form = page.getByRole('dialog', { name: 'Neue SMB-Freigabe' })
    await form.getByLabel('Name (im Netzwerk)').fill('Backup')
    await form.getByLabel('Pfad').fill('/etc/samba')
    await expect(form.getByRole('alert')).toContainText('/etc kann nicht freigegeben werden')
    await form.getByLabel('Pfad').fill('/mnt/storage/backup')
    await form.getByLabel('Erlaubte Benutzer und Gruppen').fill('tristan')
    await form.getByRole('button', { name: 'Weiter' }).click()

    const preview = page.getByRole('dialog', { name: 'SMB-Freigabe „Backup“ anlegen?' })
    await expect(preview.getByLabel('Änderungen')).toContainText('+ [Backup]')
    await expect(preview.getByLabel('Änderungen')).toContainText('+    valid users = tristan')
    await preview.getByRole('button', { name: 'Speichern' }).click()
    await unlock(page)
    await expect(page.getByText('smb.conf gespeichert, Samba lädt neu')).toBeVisible()
    await expect(smb.getByTestId('smb-share')).toHaveCount(3)

    await smb.getByRole('button', { name: 'Fotos bearbeiten' }).click()
    const edit = page.getByRole('dialog', { name: 'SMB-Freigabe „Fotos“' })
    await expect(edit.getByLabel('Erlaubte Benutzer und Gruppen')).toHaveValue('@family')
    await edit.getByLabel('Nur lesen').check()
    await edit.getByRole('button', { name: 'Weiter' }).click()
    const p2 = page.getByRole('dialog', { name: 'SMB-Freigabe „Fotos“ ändern?' })
    await expect(p2.getByLabel('Änderungen')).toContainText('- writable = yes')
    await expect(p2.getByLabel('Änderungen')).toContainText('+    read only = yes')
    await p2.getByRole('button', { name: 'Speichern' }).click()
    await expect(smb.getByTestId('smb-share').filter({ hasText: 'Fotos' })).toContainText('lesen')

    await smb.getByRole('button', { name: 'Backup löschen' }).click()
    const del = page.getByRole('dialog', { name: 'SMB-Freigabe „Backup“ löschen?' })
    await expect(del.getByLabel('Änderungen')).toContainText('- [Backup]')
    await del.getByRole('button', { name: 'Löschen' }).click()
    await expect(smb.getByTestId('smb-share')).toHaveCount(2)

    await page.goto('/')
    await expect(page.getByTestId('share').filter({ hasText: 'Fotos' })).toContainText('lesen')
  })

  test('NFS: new export goes to quadeck.exports, warnings for risky options, service control', async ({ page }) => {
    await login(page)
    await page.goto('/shares')
    const nfs = page.getByRole('region', { name: 'NFS-Exporte' })
    await expect(nfs.getByTestId('nfs-export')).toHaveCount(2)
    await expect(nfs.getByTestId('nfs-export').first()).toContainText('steht in /etc/exports')

    await nfs.getByRole('button', { name: 'Neuer Export' }).click()
    const form = page.getByRole('dialog', { name: 'Neuer NFS-Export' })
    await form.getByLabel('Verzeichnis').fill('/srv/backup')
    await form.getByLabel('Client 1').fill('*')
    await form.getByLabel('root 1').selectOption('no_root_squash')
    await expect(form.getByLabel('Zeile in exports')).toHaveText('/srv/backup *(rw,sync,no_subtree_check,no_root_squash)')
    await form.getByRole('button', { name: 'Weiter' }).click()
    const preview = page.getByRole('dialog', { name: 'NFS-Export /srv/backup anlegen?' })
    await expect(preview).toContainText('/etc/exports.d/quadeck.exports')
    await expect(preview).toContainText('Schreibzugriff für alle Rechner')
    await expect(preview).toContainText('no_root_squash: root auf dem Client ist auch hier root')
    await preview.getByRole('button', { name: 'Speichern' }).click()
    await unlock(page)
    await expect(nfs.getByTestId('nfs-export')).toHaveCount(3)

    await nfs.getByRole('button', { name: 'Stoppen' }).click()
    await expect(nfs).toContainText('nfs-server gestoppt')
    await nfs.getByRole('button', { name: 'Starten' }).click()
    await expect(nfs).toContainText('nfs-server läuft')
  })
})
