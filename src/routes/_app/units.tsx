import { Link, createFileRoute } from '@tanstack/react-router'
import { useActions } from '~/components/Actions'
import { PageHeader } from '~/components/PageHeader'
import { Sparkline } from '~/components/Sparkline'
import { TimersView } from '~/components/Timers'
import { containerState, Pill, unitState, unitTone, type Tone } from '~/components/Status'
import { age, bytes, num } from '~/lib/format'
import { useLive } from '~/lib/live'
import { failureReason } from '~/shared/units'
import { buildRows, FILTERS, failed, matches, type Filter, type Row } from '~/lib/unit-rows'


export const Route = createFileRoute('/_app/units')({
  validateSearch: (s: Record<string, unknown>): { filter?: Filter } => ({
    filter: FILTERS.some(([k]) => k === s.filter) ? (s.filter as Filter) : undefined,
  }),
  head: () => ({ meta: [{ title: 'Units · Quadeck' }] }),
  component: Units,
})

function kindLabel(r: Row) {
  const u = r.unit
  if (!u) return 'podman · container'
  if (u.quadlet) return `quadlet · ${u.quadlet.type}`
  if (u.kind === 'timer') return 'timer'
  return u.type === 'oneshot' ? 'oneshot' : 'service'
}

function status(r: Row): { tone: Tone; label: string } {
  const u = r.unit
  const c = r.container
  // A running unit with a container shows the container's health.
  if (c && (!u || u.active === 'active')) {
    const s = containerState(c)
    if (u && c.state !== 'running') return { tone: unitTone(u), label: unitState(u) }
    return s
  }
  return { tone: unitTone(u!), label: unitState(u!) }
}

function Units() {
  const { snapshot } = useLive()
  const rows = buildRows(snapshot.units, snapshot.containers)
  const hasContainers = rows.some((r) => matches(r, 'container'))
  const { filter = hasContainers ? 'container' : 'all' } = Route.useSearch()
  const { run, busy, readonly } = useActions()
  const shown = rows.filter((r) => matches(r, filter))
  // Failed first, then containers, then by name.
  shown.sort(
    (a, b) =>
      Number(!!failed(b)) - Number(!!failed(a)) ||
      Number(!!b.container) - Number(!!a.container) ||
      (a.unit?.name ?? a.container!.name).localeCompare(b.unit?.name ?? b.container!.name),
  )
  const counts = Object.fromEntries(FILTERS.map(([k]) => [k, rows.filter((r) => matches(r, k)).length]))
  return (
    <>
      <PageHeader title="Units" subtitle="Container, Quadlets und System-Units – gesteuert über systemd" />
      <div role="group" aria-label="Filter" className="flex flex-wrap gap-1.5">
        {FILTERS.map(([k, label]) => (
          <Link key={k} to="/units" search={{ filter: k }} className={`seg ${filter === k ? 'on' : ''}`} aria-current={filter === k ? 'true' : undefined}>
            {label}
            <span className="opacity-60">{counts[k]}</span>
          </Link>
        ))}
      </div>
      {snapshot.sources.systemd.error && <p className="m-0 text-[13px] text-[#e3b341]">systemd nicht erreichbar: {snapshot.sources.systemd.error}</p>}
      {snapshot.sources.podman.error && <p className="m-0 text-[13px] text-[#e3b341]">Podman nicht erreichbar: {snapshot.sources.podman.error}</p>}
      {filter === 'timer' ? (
        <TimersView />
      ) : (
        <div className="panel relative overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Unit</th>
                <th className="hidden md:table-cell">Typ</th>
                <th>Status</th>
                <th className="hidden lg:table-cell">CPU · 15 min</th>
                <th>RAM</th>
                <th className="hidden sm:table-cell">Seit</th>
                <th className="hidden xl:table-cell">Boot</th>
                <th>
                  <span className="sr-only">Aktionen</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-muted">
                    Keine Einträge in diesem Filter.
                  </td>
                </tr>
              )}
              {shown.map((r) => (
                <UnitRow key={r.key} row={r} run={run} busy={busy} readonly={readonly} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

function UnitRow({ row, run, busy, readonly }: { row: Row; run: ReturnType<typeof useActions>['run']; busy: string | null; readonly: boolean }) {
  const { unit: u, container: c } = row
  const name = u?.name ?? c!.name
  const st = status(row)
  const why = u ? (failureReason(u) ?? [u.quadlet?.file, c?.image].filter(Boolean).join(' · ') ?? '') : c!.image
  const detail = why || (u && u.description !== u.name ? u.description : '')
  const target = u ? { kind: 'unit' as const, name: u.name } : { kind: 'container' as const, name: c!.name }
  const active = u ? u.active === 'active' || u.active === 'activating' : c!.state === 'running'
  const memory = u?.memory ?? c?.memUsage
  return (
    <tr data-testid="unit-row">
      <td className="max-w-[420px]">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[13px] font-medium">{name}</span>
          {c && u && c.name !== u.name.replace(/\.service$/, '') && <span className="chip">{c.name}</span>}
        </div>
        {detail && <div className={`truncate text-[12px] ${u?.active === 'failed' ? 'text-[#ff8a80]' : 'text-muted'}`}>{detail}</div>}
      </td>
      <td className="hidden md:table-cell">
        <span className={u?.kind === 'quadlet' ? 'chip q' : 'chip'}>{kindLabel(row)}</span>
      </td>
      <td>
        <Pill tone={st.tone}>{st.label}</Pill>
      </td>
      <td className="hidden lg:table-cell">
        {c && c.state === 'running' ? (
          <div className="flex items-center gap-2">
            <Sparkline values={c.cpuHistory} />
            <span className="w-12 font-mono text-[12px]">{c.cpu !== undefined ? `${num(c.cpu, c.cpu < 10 ? 1 : 0)} %` : '–'}</span>
          </div>
        ) : (
          <span className="text-muted">–</span>
        )}
      </td>
      <td className="font-mono text-[12px]">{bytes(memory)}</td>
      <td className="hidden sm:table-cell" suppressHydrationWarning>
        {u ? age(u.since) : '–'}
      </td>
      <td className="hidden text-subtle xl:table-cell">{u?.unitFileState ?? (c ? 'ohne Unit' : '–')}</td>
      <td>
        <div className="flex justify-end gap-1.5">
          {u && (
            <Link to="/journal" search={{ unit: u.name }} className="btn sm">
              Journal
            </Link>
          )}
          {u?.quadlet && (
            <Link to="/quadlets" search={{ file: u.quadlet.file }} className="btn sm" aria-label={`${u.quadlet.file} bearbeiten`}>
              Bearbeiten
            </Link>
          )}
          {!readonly &&
            (active ? (
              <>
                <button type="button" className="btn sm" disabled={busy === name} onClick={() => run('restart', target)} aria-label={`${name} neu starten`}>
                  Neu starten
                </button>
                <button type="button" className="btn sm danger" disabled={busy === name} onClick={() => run('stop', target)} aria-label={`${name} stoppen`}>
                  Stopp
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn sm"
                disabled={busy === name}
                onClick={() => run(u?.active === 'failed' ? 'restart' : 'start', target)}
                aria-label={`${name} ${u?.active === 'failed' ? 'neu starten' : 'starten'}`}
              >
                {u?.active === 'failed' ? 'Neu starten' : 'Starten'}
              </button>
            ))}
        </div>
      </td>
    </tr>
  )
}
