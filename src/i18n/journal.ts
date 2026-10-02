// Texts of the journal area. `de` defines the shape, `en` must match it (checked by tsc).

export const de = {
  subtitle: (unit: string | undefined) => `journalctl${unit ? ` -u ${unit}` : ''}, live gestreamt`,
  unitGroup: 'Unit',
  allUnits: 'Alle Units',
  prioGroup: 'Priorität',
  prio: { all: 'Alle', err: 'Fehler', warning: 'Warnungen' },
  fullText: 'Volltextsuche',
  search: 'Suchen…',
  status: { live: 'folgt', paused: 'pausiert', error: 'getrennt', connecting: 'verbindet' },
  pause: 'Pause',
  follow: 'Folgen',
  loading: 'Lade Journal…',
  empty: 'Keine Einträge.',
}

export const en: typeof de = {
  subtitle: (unit: string | undefined) => `journalctl${unit ? ` -u ${unit}` : ''}, streamed live`,
  unitGroup: 'Unit',
  allUnits: 'All units',
  prioGroup: 'Priority',
  prio: { all: 'All', err: 'Errors', warning: 'Warnings' },
  fullText: 'Full-text search',
  search: 'Search…',
  status: { live: 'following', paused: 'paused', error: 'disconnected', connecting: 'connecting' },
  pause: 'Pause',
  follow: 'Follow',
  loading: 'Loading journal…',
  empty: 'No entries.',
}
