import { containerState } from '~/components/Status'
import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'
import type { Container, Unit } from '~/shared/types'

export const FILTER_KEYS = ['all', 'container', 'service', 'timer', 'socket', 'failed'] as const
export type Filter = (typeof FILTER_KEYS)[number]

/** Filter chips with their labels in the current language. */
export const filters = (): [Filter, string][] => [
  ['all', msg(m.system_packages_filters_all)],
  ['container', msg(m.units_row_containers)],
  ['service', msg(m.overview_cards_services)],
  ['timer', msg(m.units_row_timers)],
  ['socket', msg(m.units_row_sockets)],
  ['failed', msg(m.units_row_failed)],
]

/**
 * One row per unit; a Quadlet unit carries its container (matched via the
 * PODMAN_SYSTEMD_UNIT label). Containers without a unit get rows of their own.
 */
export interface Row {
  key: string
  unit?: Unit
  container?: Container
}

export function buildRows(units: Unit[], containers: Container[]): Row[] {
  const byUnit = new Map(containers.filter((c) => c.unit).map((c) => [c.unit!, c]))
  const rows: Row[] = units.map((u) => ({ key: u.name, unit: u, container: byUnit.get(u.name) }))
  for (const c of containers) if (!c.unit || !units.some((u) => u.name === c.unit)) rows.push({ key: `ct:${c.name}`, container: c })
  return rows
}

export const failed = (r: Row) => r.unit?.active === 'failed' || (!r.unit && r.container && containerState(r.container).tone === 'bad')

export function matches(r: Row, f: Filter) {
  if (f === 'all') return true
  if (f === 'failed') return !!failed(r)
  if (f === 'container') return !!r.container || r.unit?.quadlet?.type === 'container'
  return r.unit?.kind === f
}
