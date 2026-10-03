// Config files a package update left next to the live ones (.pacnew & co.):
// what they are, what may be done with them and what to watch out for.

import { msg } from './i18n'

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
  '/etc/passwd': msg('configfiles_newVersionDoesNotKnow'),
  '/etc/shadow': msg('configfiles_holdsPasswordsNeverTakeOver'),
  '/etc/group': msg('configfiles_newVersionDoesNotKnow2'),
  '/etc/gshadow': msg('configfiles_groupPasswordsNeverTakeOver'),
  '/etc/shells': msg('configfiles_listsAllowedShellsNewVersion'),
  '/etc/fstab': msg('configfiles_holdsYourDisksPackageVersion'),
  '/etc/crypttab': msg('configfiles_holdsYourEncryptedDrives'),
  '/etc/sudoers': msg('configfiles_mistakeHereLocksSudoOnly'),
  '/etc/hosts': msg('configfiles_holdsYourOwnNamesPackage'),
  '/etc/hostname': msg('configfiles_nameServer'),
})

const notes = (): [RegExp, string, Partial<Pick<ConfigFileInfo, 'check' | 'after'>>?][] => [
  [/^\/etc\/ssh\/sshd_config$/, msg('configfiles_settingsSshServerKeepYour'), { check: 'sshd -t', after: 'sshd-reload' }],
  [/^\/etc\/mkinitcpio\.conf$/, msg('configfiles_buildsInitramfsKernelStartsSure'), { after: 'mkinitcpio' }],
  [/^\/etc\/mkinitcpio\.d\//, msg('configfiles_presetKernelSInitramfsRebuild'), { after: 'mkinitcpio' }],
  [/^\/etc\/pacman\.conf$/, msg('configfiles_settingsPacmanCarryOverYour')],
  [/^\/etc\/pacman\.d\/mirrorlist$/, msg('configfiles_listDownloadServersIfYou')],
  [/^\/etc\/locale\.gen$/, msg('configfiles_whichLocalesGeneratedKeepYour'), { after: 'locale-gen' }],
  [/^\/etc\/samba\/smb\.conf$/, msg('configfiles_yourSharesDefinedHereNever'), { check: 'testparm', after: 'smb-reload' }],
  [/^\/etc\/systemd\//, msg('configfiles_settingSystemdServicePackageVersion')],
  [/^\/etc\/makepkg\.conf/, msg('configfiles_settingsBuildingPackagesAurCarry')],
  [/^\/etc\/pam\.d\//, msg('configfiles_loginRulesPamCarefulMistakes')],
  [/^\/etc\/containers\//, msg('configfiles_settingsPodmanKeepYourRegistries')],
  [/^\/etc\/default\/grub$/, msg('configfiles_settingsGrubKeepYourGrub')],
  [/^\/etc\/tpm2-tss\//, msg('configfiles_profilesTpmWithoutChangesYour')],
]

export function describeConfigFile(path: string, kind: 'new' | 'save', live: string): Pick<ConfigFileInfo, 'note' | 'noReplace' | 'check' | 'after'> {
  const hit = notes().find(([re]) => re.test(live))
  const blocked = noReplace()[live]
  const save = kind === 'save' ? msg('configfiles_savedVersionRemovedPackageNot') : undefined
  return { note: [save, blocked ? undefined : hit?.[1]].filter(Boolean).join(' ') || undefined, noReplace: blocked, ...(hit?.[2] ?? {}) }
}

/** What the confirmation says. */
export function describeConfigAction(f: Pick<ConfigFileInfo, 'path' | 'live' | 'kind'>, action: ConfigAction): string {
  switch (action) {
    case 'replace':
      return msg('configfiles_replacedByNewVersionYour', { live: f.live })
    case 'keep':
      return f.kind === 'save' ? msg('configfiles_deleted', { path: f.path }) : msg('configfiles_deletedStaysAs', { path: f.path, live: f.live })
    case 'merge':
      return msg('configfiles_savedYourEditedTextPrevious', { live: f.live, path: f.path })
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
    if (diff.length) return msg('configfiles_yourLinesDifferFromNew', { list: diff.join(', ') })
  }
  if (/\/samba\/smb\.conf$/.test(live)) {
    const shares = [...liveContent.matchAll(/^\s*\[([^\]]+)\]/gm)].map((m) => m[1]!).filter((n) => !['global', 'homes', 'printers', 'print$'].includes(n.toLowerCase()))
    if (shares.length) return msg('configfiles_newVersionDoesNotContain', { list: shares.join(', ') })
  }
  return undefined
}
