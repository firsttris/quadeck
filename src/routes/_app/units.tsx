import { Link, createFileRoute } from '@tanstack/react-router'
import { useActions } from '~/components/Actions'
import { PageHeader } from '~/components/PageHeader'
import { Pill, unitState, unitTone } from '~/components/Status'
import { age, bytes } from '~/lib/format'
import { useLive } from '~/lib/live'
import type { Unit } from '~/shared/types'
import { failureReason } from '~/shared/units'

const FILTERS = [
  ['all', 'Alle'],
  ['quadlet', 'Quadlets'],
  ['service', 'Services'],
  ['timer', 'Timer'],
  ['failed', 'Fehlgeschlagen'],
] as const
type Filter = (typeof FILTERS)[number][0]

export const Route = createFileRoute('/_app/units')({
  validateSearch: (s: Record<string, unknown>): { filter?: Filter } => ({
    filter: FILTERS.some(([k]) => k === s.filter) ? (s.filter as Filter) : undefined,
  }),
  head: () => ({ meta: [{ title: 'Units · Quadeck' }] }),
  component: Units,
})

function matches(u: Unit, f: Filter) {
  if (f === 'all') return true
  if (f === 'failed') return u.active === 'failed'
  return u.kind === f
}

function kindLabel(u: Unit) {
  if (u.quadlet) return `quadlet · ${u.quadlet.type}`
  if (u.kind === 'timer') return 'timer'
  return u.type === 'oneshot' ? 'oneshot' : 'service'
}

function Units() {
  const { snapshot } = useLive()
  const { filter = 'all' } = Route.useSearch()
  const { run, busy, readonly } = useActions()
  const units = snapshot.units.filter((u) => matches(u, filter))
  // Failed first, then Quadlets, then by name.
  units.sort((a, b) => Number(b.active === 'failed') - Number(a.active === 'failed') || Number(b.kind === 'quadlet') - Number(a.kind === 'quadlet') || a.name.localeCompare(b.name))
  const counts = Object.fromEntries(FILTERS.map(([k]) => [k, snapshot.units.filter((u) => matches(u, k)).length]))
  return (
    <>
      <PageHeader title="Units" subtitle="System-Units und Quadlets aus /etc/containers/systemd" />
      <div role="group" aria-label="Filter" className="flex flex-wrap gap-1.5">
        {FILTERS.map(([k, label]) => (
          <Link key={k} to="/units" search={{ filter: k === 'all' ? undefined : k }} className={`seg ${filter === k ? 'on' : ''}`} aria-current={filter === k ? 'true' : undefined}>
            {label}
            <span className="opacity-60">{counts[k]}</span>
          </Link>
        ))}
      </div>
      {snapshot.sources.systemd.error && <p className="m-0 text-[13px] text-[#e3b341]">systemd nicht erreichbar: {snapshot.sources.systemd.error}</p>}
      <div className="panel overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>Unit</th>
              <th>Typ</th>
              <th>Status</th>
              <th>Seit</th>
              <th>RAM</th>
              <th>Boot</th>
              <th>
                <span className="sr-only">Aktionen</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {units.length === 0 && (
              <tr>
                <td colSpan={7} className="text-muted">
                  Keine Units in diesem Filter.
                </td>
              </tr>
            )}
            {units.map((u) => {
              const why = failureReason(u) ?? (u.quadlet ? u.quadlet.file : u.description !== u.name ? u.description : '')
              const target = { kind: 'unit' as const, name: u.name }
              const active = u.active === 'active' || u.active === 'activating'
              return (
                <tr key={u.name} data-testid="unit-row">
                  <td>
                    <div className="font-mono text-[13px] font-medium">{u.name}</div>
                    {why && <div className={`text-[12px] ${u.active === 'failed' ? 'text-[#ff8a80]' : 'text-muted'}`}>{why}</div>}
                  </td>
                  <td>
                    <span className={u.kind === 'quadlet' ? 'chip q' : 'chip'}>{kindLabel(u)}</span>
                  </td>
                  <td>
                    <Pill tone={unitTone(u)}>{unitState(u)}</Pill>
                  </td>
                  <td suppressHydrationWarning>{age(u.since)}</td>
                  <td className="font-mono text-[12px]">{bytes(u.memory)}</td>
                  <td className="text-subtle">{u.unitFileState ?? '–'}</td>
                  <td>
                    <div className="flex justify-end gap-1.5">
                      <Link to="/journal" search={{ unit: u.name }} className="btn sm">
                        Journal
                      </Link>
                      {!readonly &&
                        (active ? (
                          <>
                            <button type="button" className="btn sm" disabled={busy === u.name} onClick={() => run('restart', target)}>
                              Neu starten
                            </button>
                            <button type="button" className="btn sm danger" disabled={busy === u.name} onClick={() => run('stop', target)}>
                              Stopp
                            </button>
                          </>
                        ) : (
                          <button type="button" className="btn sm" disabled={busy === u.name} onClick={() => run(u.active === 'failed' ? 'restart' : 'start', target)}>
                            {u.active === 'failed' ? 'Neu starten' : 'Starten'}
                          </button>
                        ))}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}
