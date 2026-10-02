import type { Snapshot } from '~/shared/types'

export type PaletteAction =
  | { kind: 'navigate'; to: '/' | '/units' | '/journal' | '/system' | '/quadlets' | '/shares' | '/ssh' | '/disks' | '/files'; search?: Record<string, string> }
  | { kind: 'open'; url: string }
  | { kind: 'unit'; action: 'start' | 'stop' | 'restart'; name: string }

export interface PaletteItem {
  id: string
  section: 'Seiten' | 'Services' | 'Units' | 'Journal'
  label: string
  hint?: string
  keywords: string
  action: PaletteAction
}

/** Everything the palette can jump to or run, from the live snapshot. */
export function paletteItems(s: Snapshot, readonly: boolean): PaletteItem[] {
  const items: PaletteItem[] = [
    { id: 'p:/', section: 'Seiten', label: 'Übersicht', keywords: 'dashboard start home', action: { kind: 'navigate', to: '/' } },
    { id: 'p:/units', section: 'Seiten', label: 'Units', keywords: 'container dienste systemd quadlets', action: { kind: 'navigate', to: '/units' } },
    { id: 'p:/units?failed', section: 'Seiten', label: 'Fehlgeschlagene Units', keywords: 'failed fehler', action: { kind: 'navigate', to: '/units', search: { filter: 'failed' } } },
    { id: 'p:/journal', section: 'Seiten', label: 'Journal', keywords: 'logs journalctl', action: { kind: 'navigate', to: '/journal' } },
    { id: 'p:/quadlets', section: 'Seiten', label: 'Quadlets bearbeiten', keywords: 'editor container datei compose import', action: { kind: 'navigate', to: '/quadlets' } },
    { id: 'p:/quadlets?new', section: 'Seiten', label: 'Neuer Container', keywords: 'quadlet container anlegen neu', action: { kind: 'navigate', to: '/quadlets', search: { new: 'true' } } },
    { id: 'p:/system?boot', section: 'Seiten', label: 'Boot und Neustart', keywords: 'neustart reboot boot systemd-boot bootctl kernel parameter cmdline uefi bios', action: { kind: 'navigate', to: '/system', search: { tab: 'boot' } } },
    { id: 'p:/system?podman', section: 'Seiten', label: 'Podman-Einstellungen', keywords: 'auto-update timer registries containers.conf podman', action: { kind: 'navigate', to: '/system', search: { tab: 'podman' } } },
    { id: 'p:/shares', section: 'Seiten', label: 'Freigaben', keywords: 'shares smb samba nfs exports netzlaufwerk', action: { kind: 'navigate', to: '/shares' } },
    { id: 'p:/disks', section: 'Seiten', label: 'Festplatten (SMART)', keywords: 'smart smartctl platten disks hdd ssd nvme selbsttest sektoren', action: { kind: 'navigate', to: '/disks' } },
    { id: 'p:/disks?mounts', section: 'Seiten', label: 'Platten einhängen (fstab)', keywords: 'fstab mount einhängen mounten platte festplatte nofail uuid', action: { kind: 'navigate', to: '/disks', search: { tab: 'mounts' } } },
    { id: 'p:/files', section: 'Seiten', label: 'Dateien', keywords: 'dateien explorer ordner kopieren verschieben umbenennen löschen files', action: { kind: 'navigate', to: '/files' } },
    { id: 'p:/ssh', section: 'Seiten', label: 'SSH', keywords: 'ssh schlüssel authorized_keys sshd passwort login fingerprint', action: { kind: 'navigate', to: '/ssh' } },
    { id: 'p:/system', section: 'Seiten', label: 'Updates', keywords: 'system pakete upgrade pacman apt dnf aur images auto-update', action: { kind: 'navigate', to: '/system' } },
    { id: 'p:/system?packages', section: 'Seiten', label: 'Installierte Pakete', keywords: 'system pakete deinstallieren entfernen verwaist orphans', action: { kind: 'navigate', to: '/system', search: { tab: 'packages' } } },
  ]
  for (const g of s.services) {
    for (const svc of g.items) {
      items.push({ id: `s:${svc.key}`, section: 'Services', label: svc.name, hint: svc.host, keywords: `${svc.host} ${g.name} ${svc.container ?? ''} öffnen`, action: { kind: 'open', url: svc.url } })
    }
  }
  // Units worth acting on: containers/Quadlets, failed ones, and services that run.
  const units = s.units.filter((u) => u.kind === 'quadlet' || u.active === 'failed' || (u.kind === 'service' && u.active === 'active' && u.sub === 'running'))
  for (const u of units) {
    const active = u.active === 'active'
    if (!readonly) {
      if (active) {
        items.push({ id: `u:restart:${u.name}`, section: 'Units', label: `${u.name} neu starten`, keywords: `restart neustart ${u.description}`, action: { kind: 'unit', action: 'restart', name: u.name } })
        items.push({ id: `u:stop:${u.name}`, section: 'Units', label: `${u.name} stoppen`, keywords: `stop stopp ${u.description}`, action: { kind: 'unit', action: 'stop', name: u.name } })
      } else {
        const a = u.active === 'failed' ? 'restart' : 'start'
        items.push({ id: `u:${a}:${u.name}`, section: 'Units', label: `${u.name} ${a === 'restart' ? 'neu starten' : 'starten'}`, keywords: `start ${u.description}`, action: { kind: 'unit', action: a, name: u.name } })
      }
    }
    items.push({ id: `j:${u.name}`, section: 'Journal', label: `Journal: ${u.name}`, keywords: `logs ${u.description}`, action: { kind: 'navigate', to: '/journal', search: { unit: u.name } } })
  }
  return items
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
    .sort((a, b) => a.score - b.score || sectionRank[a.i.section] - sectionRank[b.i.section] || a.i.label.localeCompare(b.i.label, 'de'))
    .slice(0, limit)
    .map((x) => x.i)
}
