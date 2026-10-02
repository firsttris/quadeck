// Config files a package update left next to the live ones (.pacnew & co.):
// what they are, what may be done with them and what to watch out for.

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
const NO_REPLACE: Record<string, string> = {
  '/etc/passwd': 'Die neue Fassung kennt deine Benutzer nicht – übernehmen würde alle Konten außer root löschen. Fast immer: „Meine behalten“.',
  '/etc/shadow': 'Enthält die Passwörter – nie die Paketfassung übernehmen.',
  '/etc/group': 'Die neue Fassung kennt deine Gruppen und Mitgliedschaften nicht.',
  '/etc/gshadow': 'Gruppenpasswörter – nie die Paketfassung übernehmen.',
  '/etc/shells': 'Listet die erlaubten Shells; die neue Fassung kennt nachinstallierte (zsh, fish) nicht. Meist „Meine behalten“.',
  '/etc/fstab': 'Enthält deine Platten – die Paketfassung würde sie aus dem Start nehmen.',
  '/etc/crypttab': 'Enthält deine verschlüsselten Laufwerke.',
  '/etc/sudoers': 'Ein Fehler hier sperrt sudo – nur von Hand mit visudo ändern.',
  '/etc/hosts': 'Enthält deine eigenen Namen; die Paketfassung ist leer.',
  '/etc/hostname': 'Der Name des Servers.',
}

const NOTES: [RegExp, string, Partial<Pick<ConfigFileInfo, 'check' | 'after'>>?][] = [
  [/^\/etc\/ssh\/sshd_config$/, 'Einstellungen des SSH-Servers. Deine Änderungen (Port, Passwort-Login, AllowUsers) erhalten – Quadecks eigene liegen in sshd_config.d/ und bleiben ohnehin. Vor dem Speichern prüft sshd -t die Datei.', { check: 'sshd -t', after: 'sshd-reload' }],
  [/^\/etc\/mkinitcpio\.conf$/, 'Baut das initramfs, mit dem der Kernel startet. Deine Zeilen MODULES und HOOKS (Verschlüsselung, btrfs, GPU, plymouth) unbedingt behalten – sonst bootet der Server nicht. Danach das initramfs neu bauen.', { after: 'mkinitcpio' }],
  [/^\/etc\/mkinitcpio\.d\//, 'Preset fürs initramfs eines Kernels. Danach das initramfs neu bauen.', { after: 'mkinitcpio' }],
  [/^\/etc\/pacman\.conf$/, 'Einstellungen von pacman. Eigene Anpassungen übernehmen: [multilib], ParallelDownloads, Color, IgnorePkg, eigene Repositories.'],
  [/^\/etc\/pacman\.d\/mirrorlist$/, 'Liste der Download-Server. Hast du sie nicht selbst gepflegt (oder mit reflector erzeugt), kann die neue Fassung übernommen werden – dann aber mindestens einen Server einkommentieren.'],
  [/^\/etc\/locale\.gen$/, 'Welche Sprachen erzeugt werden. Deine einkommentierten Zeilen (z. B. de_DE.UTF-8) behalten, sonst danach locale-gen.', { after: 'locale-gen' }],
  [/^\/etc\/samba\/smb\.conf$/, 'Deine Freigaben stehen hier – nie einfach die Paketfassung übernehmen. Vor dem Speichern prüft testparm die Datei.', { check: 'testparm', after: 'smb-reload' }],
  [/^\/etc\/systemd\//, 'Einstellung eines systemd-Dienstes. Die Paketfassung ist meist nur auskommentiert; eigene Werte gehören besser in ein Drop-in (…conf.d/).'],
  [/^\/etc\/makepkg\.conf/, 'Einstellungen zum Bauen von Paketen (AUR). Eigene Werte (MAKEFLAGS, COMPRESSZST) übernehmen, sonst die neue Fassung.'],
  [/^\/etc\/pam\.d\//, 'Anmelderegeln (PAM). Vorsicht: Fehler hier können Anmeldungen verhindern. Hast du nichts geändert, die neue Fassung übernehmen.'],
  [/^\/etc\/containers\//, 'Einstellungen von Podman. Deine Registries und Speicherorte behalten.'],
  [/^\/etc\/default\/grub$/, 'Einstellungen für GRUB. Deine GRUB_CMDLINE_LINUX-Zeile behalten; danach grub-mkconfig.'],
  [/^\/etc\/tpm2-tss\//, 'Profile für das TPM. Ohne eigene Änderungen kann die neue Fassung übernommen werden.'],
]

export function describeConfigFile(path: string, kind: 'new' | 'save', live: string): Pick<ConfigFileInfo, 'note' | 'noReplace' | 'check' | 'after'> {
  const hit = NOTES.find(([re]) => re.test(live))
  const noReplace = NO_REPLACE[live]
  const save = kind === 'save' ? 'Gesicherte Fassung eines entfernten Pakets – nicht aktiv. Brauchst du nichts daraus, kann sie weg.' : undefined
  return { note: [save, noReplace ? undefined : hit?.[1]].filter(Boolean).join(' ') || undefined, noReplace, ...(hit?.[2] ?? {}) }
}

/** What the confirmation says. */
export function describeConfigAction(f: Pick<ConfigFileInfo, 'path' | 'live' | 'kind'>, action: ConfigAction): string {
  switch (action) {
    case 'replace':
      return `${f.live} wird durch die neue Fassung ersetzt; deine bisherige bleibt als ${f.live}.quadeck-bak.`
    case 'keep':
      return f.kind === 'save' ? `${f.path} wird gelöscht.` : `${f.path} wird gelöscht; ${f.live} bleibt wie es ist.`
    case 'merge':
      return `${f.live} wird mit deinem bearbeiteten Text gespeichert (vorherige Fassung als ${f.live}.quadeck-bak), ${f.path} gelöscht.`
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
    if (diff.length) return `Deine Zeilen ${diff.join(', ')} weichen von der neuen Fassung ab (z. B. sd-encrypt, btrfs, GPU-Module). Übernehmen könnte den Server unbootbar machen – bitte „Zusammenführen“ und deine Zeilen behalten.`
  }
  if (/\/samba\/smb\.conf$/.test(live)) {
    const shares = [...liveContent.matchAll(/^\s*\[([^\]]+)\]/gm)].map((m) => m[1]!).filter((n) => !['global', 'homes', 'printers', 'print$'].includes(n.toLowerCase()))
    if (shares.length) return `Die neue Fassung enthält deine Freigaben (${shares.join(', ')}) nicht – übernehmen würde sie löschen. „Meine behalten“ oder zusammenführen.`
  }
  return undefined
}
