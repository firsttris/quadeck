// Config files a package update left next to the live ones (.pacnew & co.):
// what they are, what may be done with them and what to watch out for.

import { tr } from './i18n'

export type ConfigAction = 'replace' | 'keep' | 'merge'

export interface ConfigFileInfo {
  /** The .pacnew/.pacsave/… file. */
  path: string
  /** The file that is in use. */
  live: string
  /** new = newer default from the package; save = your version kept after removing the package. */
  kind: 'new' | 'save'
  liveExists: boolean
  liveContent?: string
  content?: string
  /** Too big or not text: no diff, only keep/delete. */
  binary?: boolean
  /** What the file is and what to look out for. */
  note?: string
  /** Why "take over the new one" is not offered (nothing but keep). */
  noReplace?: string
  /** Why taking over the new one as it is would break something – merge instead. */
  replaceRisk?: string
  /** Checked before writing (sshd -t, testparm …). */
  check?: string
  /** What should follow (mkinitcpio -P …). */
  after?: 'mkinitcpio' | 'sshd-reload' | 'smb-reload' | 'locale-gen'
}

const NEW = /\.(pacnew|rpmnew|dpkg-dist|dpkg-new|ucf-dist|apk-new)$/
const SAVE = /\.(pacsave(\.\d+)?|rpmsave|dpkg-old)$/

export function parseConfigPath(path: string): { live: string; kind: 'new' | 'save' } | undefined {
  if (NEW.test(path)) return { live: path.replace(NEW, ''), kind: 'new' }
  if (SAVE.test(path)) return { live: path.replace(SAVE, ''), kind: 'save' }
  return undefined
}

/** Files whose new default must never replace yours: it does not know your users, disks, rules. */
const noReplace = (): Record<string, string> => ({
  '/etc/passwd': tr(
    'Die neue Fassung kennt deine Benutzer nicht – übernehmen würde alle Konten außer root löschen. Fast immer: „Meine behalten“.',
    'The new version does not know your users – taking it over would delete every account except root. Almost always: “Keep mine”.',
  ),
  '/etc/shadow': tr('Enthält die Passwörter – nie die Paketfassung übernehmen.', 'Holds the passwords – never take over the package version.'),
  '/etc/group': tr('Die neue Fassung kennt deine Gruppen und Mitgliedschaften nicht.', 'The new version does not know your groups and memberships.'),
  '/etc/gshadow': tr('Gruppenpasswörter – nie die Paketfassung übernehmen.', 'Group passwords – never take over the package version.'),
  '/etc/shells': tr(
    'Listet die erlaubten Shells; die neue Fassung kennt nachinstallierte (zsh, fish) nicht. Meist „Meine behalten“.',
    'Lists the allowed shells; the new version does not know ones installed later (zsh, fish). Usually “Keep mine”.',
  ),
  '/etc/fstab': tr('Enthält deine Platten – die Paketfassung würde sie aus dem Start nehmen.', 'Holds your disks – the package version would drop them from boot.'),
  '/etc/crypttab': tr('Enthält deine verschlüsselten Laufwerke.', 'Holds your encrypted drives.'),
  '/etc/sudoers': tr('Ein Fehler hier sperrt sudo – nur von Hand mit visudo ändern.', 'A mistake here locks sudo – only change it by hand with visudo.'),
  '/etc/hosts': tr('Enthält deine eigenen Namen; die Paketfassung ist leer.', 'Holds your own names; the package version is empty.'),
  '/etc/hostname': tr('Der Name des Servers.', 'The name of the server.'),
})

const notes = (): [RegExp, string, Partial<Pick<ConfigFileInfo, 'check' | 'after'>>?][] => [
  [
    /^\/etc\/ssh\/sshd_config$/,
    tr(
      'Einstellungen des SSH-Servers. Deine Änderungen (Port, Passwort-Login, AllowUsers) erhalten – Quadecks eigene liegen in sshd_config.d/ und bleiben ohnehin. Vor dem Speichern prüft sshd -t die Datei.',
      'Settings of the SSH server. Keep your changes (Port, password login, AllowUsers) – Quadeck’s own live in sshd_config.d/ and stay anyway. sshd -t checks the file before saving.',
    ),
    { check: 'sshd -t', after: 'sshd-reload' },
  ],
  [
    /^\/etc\/mkinitcpio\.conf$/,
    tr(
      'Baut das initramfs, mit dem der Kernel startet. Deine Zeilen MODULES und HOOKS (Verschlüsselung, btrfs, GPU, plymouth) unbedingt behalten – sonst bootet der Server nicht. Danach das initramfs neu bauen.',
      'Builds the initramfs the kernel starts with. Be sure to keep your MODULES and HOOKS lines (encryption, btrfs, GPU, plymouth) – otherwise the server will not boot. Rebuild the initramfs afterwards.',
    ),
    { after: 'mkinitcpio' },
  ],
  [/^\/etc\/mkinitcpio\.d\//, tr('Preset fürs initramfs eines Kernels. Danach das initramfs neu bauen.', 'Preset for a kernel’s initramfs. Rebuild the initramfs afterwards.'), { after: 'mkinitcpio' }],
  [
    /^\/etc\/pacman\.conf$/,
    tr(
      'Einstellungen von pacman. Eigene Anpassungen übernehmen: [multilib], ParallelDownloads, Color, IgnorePkg, eigene Repositories.',
      'Settings of pacman. Carry over your own changes: [multilib], ParallelDownloads, Color, IgnorePkg, your own repositories.',
    ),
  ],
  [
    /^\/etc\/pacman\.d\/mirrorlist$/,
    tr(
      'Liste der Download-Server. Hast du sie nicht selbst gepflegt (oder mit reflector erzeugt), kann die neue Fassung übernommen werden – dann aber mindestens einen Server einkommentieren.',
      'List of download servers. If you did not maintain it yourself (or generate it with reflector), the new version can be taken over – but then uncomment at least one server.',
    ),
  ],
  [
    /^\/etc\/locale\.gen$/,
    tr(
      'Welche Sprachen erzeugt werden. Deine einkommentierten Zeilen (z. B. de_DE.UTF-8) behalten, sonst danach locale-gen.',
      'Which locales are generated. Keep your uncommented lines (e.g. de_DE.UTF-8), otherwise run locale-gen afterwards.',
    ),
    { after: 'locale-gen' },
  ],
  [
    /^\/etc\/samba\/smb\.conf$/,
    tr(
      'Deine Freigaben stehen hier – nie einfach die Paketfassung übernehmen. Vor dem Speichern prüft testparm die Datei.',
      'Your shares are defined here – never simply take over the package version. testparm checks the file before saving.',
    ),
    { check: 'testparm', after: 'smb-reload' },
  ],
  [
    /^\/etc\/systemd\//,
    tr(
      'Einstellung eines systemd-Dienstes. Die Paketfassung ist meist nur auskommentiert; eigene Werte gehören besser in ein Drop-in (…conf.d/).',
      'Setting of a systemd service. The package version is usually all commented out; your own values are better placed in a drop-in (…conf.d/).',
    ),
  ],
  [
    /^\/etc\/makepkg\.conf/,
    tr(
      'Einstellungen zum Bauen von Paketen (AUR). Eigene Werte (MAKEFLAGS, COMPRESSZST) übernehmen, sonst die neue Fassung.',
      'Settings for building packages (AUR). Carry over your own values (MAKEFLAGS, COMPRESSZST), otherwise take the new version.',
    ),
  ],
  [
    /^\/etc\/pam\.d\//,
    tr(
      'Anmelderegeln (PAM). Vorsicht: Fehler hier können Anmeldungen verhindern. Hast du nichts geändert, die neue Fassung übernehmen.',
      'Login rules (PAM). Careful: mistakes here can prevent logins. If you changed nothing, take over the new version.',
    ),
  ],
  [/^\/etc\/containers\//, tr('Einstellungen von Podman. Deine Registries und Speicherorte behalten.', 'Settings of Podman. Keep your registries and storage locations.')],
  [/^\/etc\/default\/grub$/, tr('Einstellungen für GRUB. Deine GRUB_CMDLINE_LINUX-Zeile behalten; danach grub-mkconfig.', 'Settings for GRUB. Keep your GRUB_CMDLINE_LINUX line; run grub-mkconfig afterwards.')],
  [/^\/etc\/tpm2-tss\//, tr('Profile für das TPM. Ohne eigene Änderungen kann die neue Fassung übernommen werden.', 'Profiles for the TPM. Without changes of your own, the new version can be taken over.')],
]

export function describeConfigFile(path: string, kind: 'new' | 'save', live: string): Pick<ConfigFileInfo, 'note' | 'noReplace' | 'check' | 'after'> {
  const hit = notes().find(([re]) => re.test(live))
  const blocked = noReplace()[live]
  const save =
    kind === 'save' ? tr('Gesicherte Fassung eines entfernten Pakets – nicht aktiv. Brauchst du nichts daraus, kann sie weg.', 'Saved version of a removed package – not in use. If you need nothing from it, it can go.') : undefined
  return { note: [save, blocked ? undefined : hit?.[1]].filter(Boolean).join(' ') || undefined, noReplace: blocked, ...(hit?.[2] ?? {}) }
}

/** What the confirmation says. */
export function describeConfigAction(f: Pick<ConfigFileInfo, 'path' | 'live' | 'kind'>, action: ConfigAction): string {
  switch (action) {
    case 'replace':
      return tr(`${f.live} wird durch die neue Fassung ersetzt; deine bisherige bleibt als ${f.live}.quadeck-bak.`, `${f.live} is replaced by the new version; your previous one is kept as ${f.live}.quadeck-bak.`)
    case 'keep':
      return f.kind === 'save' ? tr(`${f.path} wird gelöscht.`, `${f.path} is deleted.`) : tr(`${f.path} wird gelöscht; ${f.live} bleibt wie es ist.`, `${f.path} is deleted; ${f.live} stays as it is.`)
    case 'merge':
      return tr(
        `${f.live} wird mit deinem bearbeiteten Text gespeichert (vorherige Fassung als ${f.live}.quadeck-bak), ${f.path} gelöscht.`,
        `${f.live} is saved with your edited text (previous version as ${f.live}.quadeck-bak), ${f.path} is deleted.`,
      )
  }
}

const activeLine = (text: string, key: string) =>
  text
    .split('\n')
    .filter((l) => new RegExp(`^\\s*${key}\\s*=`).test(l))
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .join('\n')

/** Taking over the package version as it is would lose something important. */
export function replaceRisk(live: string, liveContent: string | undefined, content: string | undefined): string | undefined {
  if (liveContent === undefined || content === undefined) return undefined
  if (/\/mkinitcpio\.conf$/.test(live)) {
    const diff = ['MODULES', 'HOOKS', 'BINARIES', 'FILES'].filter((k) => activeLine(liveContent, k) !== activeLine(content, k))
    if (diff.length)
      return tr(
        `Deine Zeilen ${diff.join(', ')} weichen von der neuen Fassung ab (z. B. sd-encrypt, btrfs, GPU-Module). Übernehmen könnte den Server unbootbar machen – bitte „Zusammenführen“ und deine Zeilen behalten.`,
        `Your ${diff.join(', ')} lines differ from the new version (e.g. sd-encrypt, btrfs, GPU modules). Taking it over could leave the server unbootable – please “Merge” and keep your lines.`,
      )
  }
  if (/\/samba\/smb\.conf$/.test(live)) {
    const shares = [...liveContent.matchAll(/^\s*\[([^\]]+)\]/gm)].map((m) => m[1]!).filter((n) => !['global', 'homes', 'printers', 'print$'].includes(n.toLowerCase()))
    if (shares.length)
      return tr(
        `Die neue Fassung enthält deine Freigaben (${shares.join(', ')}) nicht – übernehmen würde sie löschen. „Meine behalten“ oder zusammenführen.`,
        `The new version does not contain your shares (${shares.join(', ')}) – taking it over would delete them. “Keep mine” or merge.`,
      )
  }
  return undefined
}
