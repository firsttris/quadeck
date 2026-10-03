import { expect, test, type Page } from '@playwright/test'

// fixtures/demo/boot.json: systemd-boot with two kernels, loader on the ESP older than the package.
const PASSWORD = 'e2e-password-123'

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Passwort').fill(PASSWORD)
  await page.getByRole('button', { name: 'Anmelden' }).click()
  await expect(page).toHaveURL('/')
}

async function unlock(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Aktionen entsperren' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Passwort').fill(PASSWORD)
  await dialog.getByRole('button', { name: 'Entsperren' }).click()
  await expect(dialog).toBeHidden()
}

test('boot: entries, warnings, timeout, default, kernel parameters, one-time reboot', async ({ page }) => {
  await login(page)
  await page.goto('/system')
  await page.getByRole('tab', { name: 'Boot und Neustart' }).click()
  await expect(page).toHaveURL(/tab=boot/)
  await expect(page.getByRole('region', { name: 'Hinweise zum Start' })).toContainText('älter als das installierte systemd')
  await expect(page.getByTestId('boot-entry')).toHaveCount(3)
  await expect(page.getByTestId('boot-entry').first()).toContainText('Standard')
  await expect(page.getByTestId('boot-entry').first()).toContainText('läuft gerade')
  // Reboot into the firmware has its own button; Windows is a system and can be booted.
  await expect(page.getByTestId('boot-entry').filter({ hasText: 'Reboot Into Firmware Interface' })).toHaveCount(0)
  const windows = page.getByTestId('boot-entry').filter({ hasText: 'Windows Boot Manager' })
  await expect(windows.getByRole('button', { name: 'Als Standard' })).toBeVisible()
  await expect(windows.getByRole('button', { name: /Windows Boot Manager/ })).toBeVisible()
  await expect(page.getByTestId('kernel-param').filter({ hasText: 'i915.enable_guc' })).toContainText('QuickSync')

  await page.getByLabel('Wartezeit im Bootmenü').selectOption('menu-hidden')
  await unlock(page)
  await expect(page.getByLabel('Wartezeit im Bootmenü')).toHaveValue('menu-hidden')
  await expect(page.getByRole('region', { name: 'Bootloader' })).toContainText('gesetzt per bootctl')

  await page.getByRole('button', { name: 'Bootloader aktualisieren' }).click()
  await expect(page.getByRole('region', { name: 'Hinweise zum Start' })).not.toContainText('älter als')
  await expect(page.getByRole('region', { name: 'Hinweise zum Start' })).toContainText('Nur ein Kernel')

  // Second kernel: install, add its entry, boot it once.
  const lts = page.getByTestId('kernel').filter({ hasText: 'linux-lts' })
  await expect(page.getByTestId('kernel').filter({ hasText: 'Aktuell' })).toContainText('läuft gerade')
  await expect(page.getByRole('button', { name: 'linux entfernen' })).toBeDisabled()
  await lts.getByRole('button', { name: 'Installieren' }).click()
  const job = page.getByRole('dialog', { name: /Kernel installieren: linux-lts/ })
  await expect(job).toContainText('erfolgreich')
  await job.getByRole('button', { name: 'Schließen' }).click()
  await expect(lts).toContainText('kein Boot-Eintrag')
  await lts.getByRole('button', { name: 'Boot-Eintrag anlegen …' }).click()
  const entry = page.getByRole('dialog', { name: 'Boot-Eintrag für linux-lts anlegen?' })
  await expect(entry.getByLabel('Neuer Eintrag')).toContainText('linux   /vmlinuz-linux-lts')
  await entry.getByRole('button', { name: 'Anlegen' }).click()
  await expect(page.getByTestId('boot-entry')).toHaveCount(4)
  await expect(page.getByRole('region', { name: 'Hinweise zum Start' })).toHaveCount(0)

  const ltsEntry = page.getByTestId('boot-entry').filter({ hasText: 'linux-lts' })
  await ltsEntry.getByRole('button', { name: 'Als Standard' }).click()
  await expect(ltsEntry).toContainText('Standard')
  await expect(lts.getByRole('button', { name: 'linux-lts entfernen' })).toBeDisabled() // it is the default now
  await page.getByTestId('boot-entry').first().getByRole('button', { name: 'Als Standard' }).click()
  await expect(page.getByTestId('boot-entry').first()).toContainText('Standard')

  // Remove it again: the entry then points to nothing and can go too.
  await lts.getByRole('button', { name: 'linux-lts entfernen' }).click()
  await page.getByRole('dialog', { name: 'linux-lts entfernen?' }).getByRole('button', { name: 'Entfernen' }).click()
  const removeJob = page.getByRole('dialog', { name: /Kernel entfernen: linux-lts/ })
  await expect(removeJob).toContainText('erfolgreich')
  await removeJob.getByRole('button', { name: 'Schließen' }).click()
  await expect(ltsEntry).toContainText('fehlt: /vmlinuz-linux-lts')
  await ltsEntry.getByRole('button', { name: 'Aktionen für Arch Linux (linux-lts)' }).click()
  await page.getByRole('menuitem', { name: 'Löschen …' }).click()
  await page.getByRole('dialog', { name: 'arch-lts.conf löschen?' }).getByRole('button', { name: 'Löschen' }).click()
  await expect(page.getByTestId('boot-entry')).toHaveCount(3)

  const old = page.getByTestId('boot-entry').nth(1)
  await old.getByRole('button', { name: /Einmalig mit .* neu starten/ }).click()
  const confirm = page.getByRole('dialog', { name: 'Einmalig mit diesem Eintrag neu starten?' })
  await expect(confirm).toContainText('Fallback')
  await confirm.getByRole('button', { name: 'Jetzt neu starten' }).click()
  await expect(page.getByRole('region', { name: 'Neustart läuft' })).toContainText('Der Server startet neu')
})

test('boot entries: edit the default as a copy, check it live, test it once, rename, delete', async ({ page }) => {
  await login(page)
  await page.goto('/system?tab=boot')
  const rows = page.getByTestId('boot-entry')
  await expect(rows).toHaveCount(3)

  // The default (and running) entry is never changed in place: the editor makes a copy.
  await rows.first().getByRole('button', { name: 'Aktionen für Arch Linux' }).click()
  await expect(page.getByRole('menuitem', { name: 'Löschen …' })).toBeDisabled()
  await page.getByRole('menuitem', { name: 'Als Kopie bearbeiten …' }).click()
  const editor = page.getByRole('dialog', { name: 'Kopie von arch.conf' })
  await expect(editor).toContainText('bleibt, wie er ist')
  await expect(editor.getByLabel('Dateiname')).toHaveValue('arch-copy.conf')
  await expect(editor).toContainText('keine Probleme gefunden')

  // The form: kernel and initramfs from the boot partition, every parameter explained.
  const form = editor.getByTestId('entry-form')
  await expect(form.getByRole('textbox', { name: /^Titel/ })).toHaveValue('Arch Linux (copy)')
  await expect(form.getByRole('combobox', { name: /^Kernel/ })).toHaveValue('/vmlinuz-linux')
  await expect(form.getByRole('checkbox', { name: /intel-ucode.img/ })).toBeChecked()
  await expect(form.getByRole('checkbox', { name: /initramfs-linux-fallback.img/ })).not.toBeChecked()
  await expect(form.getByTestId('entry-param').first().getByText('nötig', { exact: true })).toBeVisible()
  await expect(form.getByText('nötig', { exact: true })).toHaveCount(1)
  await expect(form.getByTestId('entry-param').nth(3)).toContainText('QuickSync')
  await form.getByLabel('Parameter hinzufügen').fill('loglevel=3')
  await expect(form).toContainText('Nur Kernel-Meldungen bis Stufe 3 anzeigen')
  await form.getByRole('button', { name: 'Hinzufügen' }).click()
  await expect(form.getByTestId('entry-param').last()).toContainText('Nur Kernel-Meldungen bis Stufe 3')
  await form.getByRole('button', { name: 'quiet entfernen' }).click()
  await expect(form.getByTestId('entry-param')).toHaveCount(6)

  // The same file as text.
  await editor.getByRole('button', { name: 'Text' }).click()
  const text = editor.getByLabel('Inhalt des Eintrags')
  await expect(text).toHaveValue(/^title   Arch Linux \(copy\)\n[\s\S]*usbcore.autosuspend=-1 loglevel=3\n$/)

  // Live check: a file that is not on the boot partition, root= missing.
  const good = (await text.inputValue()).replace(' loglevel=3', ' quiet loglevel=3')
  await text.fill(good.replace('/initramfs-linux.img', '/initramfs-nope.img').replace(/root=\S+ /, ''))
  await expect(editor.getByTestId('entry-problem')).toHaveText(['Zeile 4:/initramfs-nope.img gibt es auf der Boot-Partition nicht', 'Zeile 5:In options fehlt root= – ohne findet der Kernel das System nicht'])
  await expect(editor.getByRole('button', { name: 'Weiter' })).toBeDisabled()
  await text.fill(good)
  await expect(editor).toContainText('keine Probleme gefunden')
  await editor.getByLabel('Dateiname').fill('arch-test.conf')
  await editor.getByRole('button', { name: 'Weiter' }).click()
  const create = page.getByRole('dialog', { name: 'arch-test.conf anlegen?' })
  await expect(create.getByLabel('Änderungen')).toContainText('+ options root=UUID=8c1f3e2a-5d4b-4c6e-9f1a-2b3c4d5e6f70 rw rootflags=subvol=@ i915.enable_guc=3 usbcore.autosuspend=-1 quiet loglevel=3')
  await create.getByRole('button', { name: 'Anlegen' }).click()
  await unlock(page)

  // Saved: test it once before it becomes the default.
  const testIt = page.getByRole('dialog', { name: 'arch-test.conf gespeichert – jetzt testen?' })
  await testIt.getByRole('button', { name: 'Einmalig damit starten …' }).click()
  const reboot = page.getByRole('dialog', { name: 'Einmalig mit diesem Eintrag neu starten?' })
  await expect(reboot).toContainText('Arch Linux (copy)')
  await reboot.getByRole('button', { name: 'Abbrechen' }).click()
  await expect(rows).toHaveCount(4)
  const copy = rows.filter({ hasText: 'Arch Linux (copy)' })

  // A copy is edited in place; every version stays in the history.
  await copy.getByRole('button', { name: 'Aktionen für Arch Linux (copy)' }).click()
  await page.getByRole('menuitem', { name: 'Bearbeiten …' }).click()
  const edit = page.getByRole('dialog', { name: 'arch-test.conf bearbeiten' })
  await expect(edit.getByLabel('Dateiname')).toHaveCount(0)
  await edit.getByRole('button', { name: 'Text' }).click()
  await edit.getByLabel('Inhalt des Eintrags').fill(good.replace('loglevel=3', 'loglevel=4'))
  await edit.getByRole('button', { name: 'Weiter' }).click()
  const save = page.getByRole('dialog', { name: 'Änderungen an arch-test.conf speichern?' })
  await expect(save.getByLabel('Änderungen')).toContainText('- options')
  await expect(save.getByLabel('Änderungen')).toContainText('loglevel=4')
  await save.getByRole('button', { name: 'Speichern' }).click()
  await page
    .getByRole('dialog', { name: /jetzt testen/ })
    .getByRole('button', { name: 'Später' })
    .click()

  await copy.getByRole('button', { name: 'Aktionen für Arch Linux (copy)' }).click()
  await page.getByRole('menuitem', { name: 'Bearbeiten …' }).click()
  await edit.getByRole('button', { name: 'Text' }).click()
  await edit.getByText('Verlauf (2)').click()
  await edit.getByRole('button', { name: 'In den Editor laden' }).last().click()
  await expect(edit).toContainText('geladen – noch nicht gespeichert')
  await expect(edit.getByLabel('Inhalt des Eintrags')).toHaveValue(/loglevel=3/)
  await edit.getByRole('button', { name: 'Abbrechen' }).click()

  // Rename, then delete (the text stays in the history).
  await copy.getByRole('button', { name: 'Aktionen für Arch Linux (copy)' }).click()
  await page.getByRole('menuitem', { name: 'Umbenennen …' }).click()
  const rename = page.getByRole('dialog', { name: 'arch-test.conf umbenennen' })
  await rename.getByLabel('Dateiname').fill('arch tuned')
  await expect(rename.getByRole('button', { name: 'Umbenennen' })).toBeDisabled()
  await rename.getByLabel('Dateiname').fill('arch-tuned.conf')
  await rename.getByRole('button', { name: 'Umbenennen' }).click()
  await expect(page.getByText('arch-test.conf heißt jetzt arch-tuned.conf')).toBeVisible()

  await copy.getByRole('button', { name: 'Aktionen für Arch Linux (copy)' }).click()
  await page.getByRole('menuitem', { name: 'Löschen …' }).click()
  const del = page.getByRole('dialog', { name: 'arch-tuned.conf löschen?' })
  await expect(del).toContainText('/boot/loader/entries/arch-tuned.conf')
  await del.getByRole('button', { name: 'Löschen' }).click()
  await expect(rows).toHaveCount(3)

  // A new entry starts from the default's kernel and options.
  await page.getByRole('button', { name: 'Neuer Eintrag …' }).click()
  const fresh = page.getByRole('dialog', { name: 'Neuer Boot-Eintrag' })
  await expect(fresh.getByLabel('Dateiname')).toHaveValue('new-entry.conf')
  await fresh.getByRole('button', { name: 'Text' }).click()
  await expect(fresh.getByLabel('Inhalt des Eintrags')).toHaveValue(/^title   New entry\nlinux   \/vmlinuz-linux\ninitrd  \/intel-ucode.img\n/)
  await expect(fresh).toContainText('keine Probleme gefunden')
  await fresh.getByRole('button', { name: 'Abbrechen' }).click()
})
