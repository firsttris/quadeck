// Config files a package update left next to the live ones (.pacnew & co.):
// what they are, what may be done with them and what to watch out for.

import { msg } from './i18n'
import { m } from '~/paraglide/messages'

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
  '/etc/passwd': msg(m.configfiles_hint_passwd),
  '/etc/shadow': msg(m.configfiles_hint_shadow),
  '/etc/group': msg(m.configfiles_hint_group),
  '/etc/gshadow': msg(m.configfiles_hint_gshadow),
  '/etc/shells': msg(m.configfiles_hint_shells),
  '/etc/fstab': msg(m.configfiles_hint_fstab),
  '/etc/crypttab': msg(m.configfiles_hint_crypttab),
  '/etc/sudoers': msg(m.configfiles_hint_sudoers),
  '/etc/hosts': msg(m.configfiles_hint_hosts),
  '/etc/hostname': msg(m.configfiles_hint_hostname),
})

const notes = (): [RegExp, string, Partial<Pick<ConfigFileInfo, 'check' | 'after'>>?][] => [
  [/^\/etc\/ssh\/sshd_config$/, msg(m.configfiles_hint_sshd), { check: 'sshd -t', after: 'sshd-reload' }],
  [/^\/etc\/mkinitcpio\.conf$/, msg(m.configfiles_hint_mkinitcpio), { after: 'mkinitcpio' }],
  [/^\/etc\/mkinitcpio\.d\//, msg(m.configfiles_hint_mkinitcpioPreset), { after: 'mkinitcpio' }],
  [/^\/etc\/pacman\.conf$/, msg(m.configfiles_hint_pacman)],
  [/^\/etc\/pacman\.d\/mirrorlist$/, msg(m.configfiles_hint_mirrorlist)],
  [/^\/etc\/locale\.gen$/, msg(m.configfiles_hint_localeGen), { after: 'locale-gen' }],
  [/^\/etc\/samba\/smb\.conf$/, msg(m.configfiles_hint_samba), { check: 'testparm', after: 'smb-reload' }],
  [/^\/etc\/systemd\//, msg(m.configfiles_hint_systemd)],
  [/^\/etc\/makepkg\.conf/, msg(m.configfiles_hint_makepkg)],
  [/^\/etc\/pam\.d\//, msg(m.configfiles_hint_pam)],
  [/^\/etc\/containers\//, msg(m.configfiles_hint_containers)],
  [/^\/etc\/default\/grub$/, msg(m.configfiles_hint_grub)],
  [/^\/etc\/tpm2-tss\//, msg(m.configfiles_hint_tpm)],
]

export function describeConfigFile(path: string, kind: 'new' | 'save', live: string): Pick<ConfigFileInfo, 'note' | 'noReplace' | 'check' | 'after'> {
  const hit = notes().find(([re]) => re.test(live))
  const blocked = noReplace()[live]
  const save = kind === 'save' ? msg(m.configfiles_hint_orphanSave) : undefined
  return { note: [save, blocked ? undefined : hit?.[1]].filter(Boolean).join(' ') || undefined, noReplace: blocked, ...(hit?.[2] ?? {}) }
}

/** What the confirmation says. */
export function describeConfigAction(f: Pick<ConfigFileInfo, 'path' | 'live' | 'kind'>, action: ConfigAction): string {
  switch (action) {
    case 'replace':
      return msg(m.configfiles_confirm_replace, { live: f.live })
    case 'keep':
      return f.kind === 'save' ? msg(m.configfiles_confirm_deleteSave, { path: f.path }) : msg(m.configfiles_confirm_keep, { path: f.path, live: f.live })
    case 'merge':
      return msg(m.configfiles_confirm_merge, { live: f.live, path: f.path })
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
    if (diff.length) return msg(m.configfiles_warn_mkinitcpioLines, { list: diff.join(', ') })
  }
  if (/\/samba\/smb\.conf$/.test(live)) {
    const shares = [...liveContent.matchAll(/^\s*\[([^\]]+)\]/gm)].map((m) => m[1]!).filter((n) => !['global', 'homes', 'printers', 'print$'].includes(n.toLowerCase()))
    if (shares.length) return msg(m.configfiles_warn_sambaShares, { list: shares.join(', ') })
  }
  return undefined
}
