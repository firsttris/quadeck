import { localeOf, msg } from '~/shared/i18n'
import type { Snapshot } from '~/shared/types'

export type PaletteAction =
  | { kind: 'navigate'; to: '/' | '/units' | '/journal' | '/system' | '/quadlets' | '/shares' | '/ssh' | '/disks' | '/files' | '/users' | '/hardware'; search?: Record<string, string> }
  | { kind: 'open'; url: string }
  | { kind: 'unit'; action: 'start' | 'stop' | 'restart'; name: string }

export interface PaletteItem {
  id: string
  /** Section id (German, also used for ranking); shown via sectionLabel(). */
  section: 'Seiten' | 'Services' | 'Units' | 'Journal'
  label: string
  hint?: string
  keywords: string
  action: PaletteAction
}

/** Everything the palette can jump to or run, from the live snapshot. */
export function paletteItems(s: Snapshot, readonly: boolean): PaletteItem[] {
  const items: PaletteItem[] = [
    { id: 'p:/', section: 'Seiten', label: msg('overview_title'), keywords: 'dashboard start home übersicht overview', action: { kind: 'navigate', to: '/' } },
    { id: 'p:/units', section: 'Seiten', label: 'Units', keywords: 'container dienste systemd quadlets services', action: { kind: 'navigate', to: '/units' } },
    { id: 'p:/units?failed', section: 'Seiten', label: msg('palette_page_failedUnits'), keywords: 'failed fehler error', action: { kind: 'navigate', to: '/units', search: { filter: 'failed' } } },
    { id: 'p:/journal', section: 'Seiten', label: 'Journal', keywords: 'logs journalctl', action: { kind: 'navigate', to: '/journal' } },
    { id: 'p:/quadlets', section: 'Seiten', label: msg('palette_page_editQuadlets'), keywords: 'editor container datei compose import file edit', action: { kind: 'navigate', to: '/quadlets' } },
    { id: 'p:/quadlets?new', section: 'Seiten', label: msg('palette_page_newContainer'), keywords: 'quadlet container anlegen neu new create', action: { kind: 'navigate', to: '/quadlets', search: { new: 'true' } } },
    {
      id: 'p:/system?boot',
      section: 'Seiten',
      label: msg('palette_page_bootRestart'),
      keywords: 'neustart reboot boot systemd-boot bootctl kernel parameter cmdline uefi bios restart',
      action: { kind: 'navigate', to: '/system', search: { tab: 'boot' } },
    },
    {
      id: 'p:/system?podman',
      section: 'Seiten',
      label: msg('palette_page_podmanSettings'),
      keywords: 'auto-update timer registries containers.conf podman settings',
      action: { kind: 'navigate', to: '/system', search: { tab: 'podman' } },
    },
    { id: 'p:/shares', section: 'Seiten', label: msg('shares_page_title'), keywords: 'shares smb samba nfs exports netzlaufwerk freigaben network drive', action: { kind: 'navigate', to: '/shares' } },
    {
      id: 'p:/disks',
      section: 'Seiten',
      label: msg('palette_page_disksSmart'),
      keywords: 'smart smartctl platten disks hdd ssd nvme selbsttest sektoren festplatten self-test sectors',
      action: { kind: 'navigate', to: '/disks' },
    },
    {
      id: 'p:/disks?mounts',
      section: 'Seiten',
      label: msg('palette_page_mountDisks'),
      keywords: 'fstab mount einhängen mounten platte festplatte nofail uuid disk',
      action: { kind: 'navigate', to: '/disks', search: { tab: 'mounts' } },
    },
    { id: 'p:/files', section: 'Seiten', label: msg('files_explorer_files'), keywords: 'dateien explorer ordner kopieren verschieben umbenennen löschen files folder copy move rename delete', action: { kind: 'navigate', to: '/files' } },
    {
      id: 'p:/hardware',
      section: 'Seiten',
      label: 'Hardware',
      keywords: 'hardware cpu prozessor ram arbeitsspeicher steckplatz mainboard bios gpu grafik usb pcie sata sensoren lüfter temperatur zigbee processor memory slot graphics sensors fan temperature',
      action: { kind: 'navigate', to: '/hardware' },
    },
    {
      id: 'p:/users',
      section: 'Seiten',
      label: msg('users_title'),
      keywords: 'benutzer konten user account passwort gruppen sudo wheel admin sperren samba useradd users password groups lock',
      action: { kind: 'navigate', to: '/users' },
    },
    { id: 'p:/ssh', section: 'Seiten', label: 'SSH', keywords: 'ssh schlüssel authorized_keys sshd passwort login fingerprint keys password', action: { kind: 'navigate', to: '/ssh' } },
    { id: 'p:/system', section: 'Seiten', label: 'Updates', keywords: 'system pakete upgrade pacman apt dnf aur images auto-update packages updates', action: { kind: 'navigate', to: '/system' } },
    {
      id: 'p:/system?packages',
      section: 'Seiten',
      label: msg('palette_page_installedPackages'),
      keywords: 'system pakete deinstallieren entfernen verwaist orphans packages installed uninstall remove',
      action: { kind: 'navigate', to: '/system', search: { tab: 'packages' } },
    },
  ]
  for (const g of s.services) {
    for (const svc of g.items) {
      items.push({ id: `s:${svc.key}`, section: 'Services', label: svc.name, hint: svc.host, keywords: `${svc.host} ${g.name} ${svc.container ?? ''} öffnen open`, action: { kind: 'open', url: svc.url } })
    }
  }
  // Units worth acting on: containers/Quadlets, failed ones, and services that run.
  const units = s.units.filter((u) => u.kind === 'quadlet' || u.active === 'failed' || (u.kind === 'service' && u.active === 'active' && u.sub === 'running'))
  for (const u of units) {
    const active = u.active === 'active'
    if (!readonly) {
      if (active) {
        items.push({ id: `u:restart:${u.name}`, section: 'Units', label: msg('units_restartAria', { name: u.name }), keywords: `restart neustart ${u.description}`, action: { kind: 'unit', action: 'restart', name: u.name } })
        items.push({ id: `u:stop:${u.name}`, section: 'Units', label: msg('palette_action_stopUnit', { unit: u.name }), keywords: `stop stopp ${u.description}`, action: { kind: 'unit', action: 'stop', name: u.name } })
      } else {
        const a = u.active === 'failed' ? 'restart' : 'start'
        items.push({
          id: `u:${a}:${u.name}`,
          section: 'Units',
          label: a === 'restart' ? msg('units_restartAria', { name: u.name }) : msg('units_startAria', { name: u.name }),
          keywords: `start ${u.description}`,
          action: { kind: 'unit', action: a, name: u.name },
        })
      }
    }
    items.push({ id: `j:${u.name}`, section: 'Journal', label: `Journal: ${u.name}`, keywords: `logs ${u.description}`, action: { kind: 'navigate', to: '/journal', search: { unit: u.name } } })
  }
  return items
}

/** Visible heading of a palette section. */
export function sectionLabel(section: PaletteItem['section']): string {
  return section === 'Seiten' ? msg('palette_section_pages') : section
}

/**
 * Every query word must appear in label, hint or keywords. Ranking: label
 * starts with the query, then a word of the label does, then the rest; pages
 * and services before unit actions.
 */
export function filterPalette(items: PaletteItem[], query: string, limit = 40): PaletteItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return items.filter((i) => i.section === 'Seiten' || i.section === 'Services').slice(0, limit)
  const words = q.split(/\s+/)
  const sectionRank = { Seiten: 0, Services: 1, Units: 2, Journal: 3 }
  return items
    .filter((i) => {
      const hay = `${i.label} ${i.hint ?? ''} ${i.keywords}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    })
    .map((i) => {
      const l = i.label.toLowerCase()
      const score = l.startsWith(q) ? 0 : l.split(/[\s.:-]+/).some((w) => w.startsWith(words[0]!)) ? 1 : 2
      return { i, score }
    })
    .sort((a, b) => a.score - b.score || sectionRank[a.i.section] - sectionRank[b.i.section] || a.i.label.localeCompare(b.i.label, localeOf()))
    .slice(0, limit)
    .map((x) => x.i)
}
