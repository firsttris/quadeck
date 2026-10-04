import { useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useActions } from '~/components/Actions'
import { PageHeader } from '~/components/PageHeader'
import { RemoveQuadletDialog } from '~/components/QuadletEditor'
import { RowMenu, type MenuItem } from '~/components/RowMenu'
import { useToast } from '~/components/Toast'
import { useGuardedApi } from '~/components/Unlock'
import { Sparkline } from '~/components/Sparkline'
import { TimersView } from '~/components/Timers'
import { ContainerUsageView } from '~/components/ContainerUsage'
import { containerState, Pill, unitState, unitTone, type Tone } from '~/components/Status'
import { age, bytes, num } from '~/lib/format'
import { useLive } from '~/lib/live'
import { failureReason } from '~/shared/units'
import { buildRows, FILTER_KEYS, failed, filters, matches, type Filter, type Row } from '~/lib/unit-rows'
import { m } from '~/paraglide/messages'

export const Route = createFileRoute('/_app/units')({
  validateSearch: (s: Record<string, unknown>): { filter?: Filter; view?: 'usage'; container?: string } => ({
    filter: FILTER_KEYS.some((k) => k === s.filter) ? (s.filter as Filter) : undefined,
    view: s.view === 'usage' ? 'usage' : undefined,
    container: typeof s.container === 'string' && /^[\w.-]{1,128}$/.test(s.container) ? s.container : undefined,
  }),
  head: () => ({ meta: [{ title: 'Units · Quadeck' }] }),
  component: Units,
})

function kindLabel(r: Row) {
  const u = r.unit
  if (!u) return 'podman'
  if (u.quadlet) return u.quadlet.type
  if (u.kind === 'timer') return 'timer'
  if (u.kind === 'socket') return 'socket'
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
  const { filter = hasContainers ? 'container' : 'all', view, container } = Route.useSearch()
  const { run, busy, readonly } = useActions()
  const shown = rows.filter((r) => matches(r, filter))
  // Failed first, then containers, then by name.
  shown.sort((a, b) => Number(!!failed(b)) - Number(!!failed(a)) || Number(!!b.container) - Number(!!a.container) || (a.unit?.name ?? a.container!.name).localeCompare(b.unit?.name ?? b.container!.name))
  const counts = Object.fromEntries(FILTER_KEYS.map((k) => [k, rows.filter((r) => matches(r, k)).length]))
  return (
    <>
      <PageHeader title="Units" subtitle={m.units_subtitle()}>
        {!readonly && (
          <>
            <Link to="/systemd" search={{ new: true }} className="btn sm">
              {m.units_newUnit()}
            </Link>
            <Link to="/quadlets" search={{ new: true }} className="btn sm">
              {m.units_newContainer()}
            </Link>
          </>
        )}
        <Link to="/quadlets" className="btn sm">
          {m.units_quadletFiles()}
        </Link>
      </PageHeader>
      <div className="flex flex-wrap items-center gap-1.5">
        <div role="group" aria-label={m.units_filter()} className="flex flex-wrap gap-1.5">
          {filters().map(([k, label]) => (
            <Link key={k} to="/units" search={{ filter: k }} className={`seg ${filter === k && view !== 'usage' ? 'on' : ''}`} aria-current={filter === k && view !== 'usage' ? 'true' : undefined}>
              {label}
              <span className="opacity-60">{counts[k]}</span>
            </Link>
          ))}
        </div>
        <span className="grow" />
        {hasContainers && (
          <Link to="/units" search={{ view: 'usage' }} className={`seg ${view === 'usage' ? 'on' : ''}`} aria-current={view === 'usage' ? 'true' : undefined}>
            {m.usage_tab()}
          </Link>
        )}
      </div>
      {snapshot.sources.systemd.error && (
        <p className="m-0 text-[13px] text-[#e3b341]">
          {m.units_systemdDown()} {snapshot.sources.systemd.error}
        </p>
      )}
      {snapshot.sources.podman.error && (
        <p className="m-0 text-[13px] text-[#e3b341]">
          {m.units_podmanDown()} {snapshot.sources.podman.error}
        </p>
      )}
      {view === 'usage' ? (
        <ContainerUsageView open={container} />
      ) : filter === 'timer' ? (
        <TimersView />
      ) : (
        <div className="panel relative overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>{m.units_col_unit()}</th>
                <th className="hidden 2xl:table-cell">{m.units_col_type()}</th>
                <th>{m.units_col_status()}</th>
                <th className="hidden xl:table-cell">{m.units_col_cpu()}</th>
                <th>{m.units_col_ram()}</th>
                <th className="hidden sm:table-cell">{m.units_col_since()}</th>
                <th className="hidden 2xl:table-cell">{m.units_col_boot()}</th>
                <th>
                  <span className="sr-only">{m.units_col_actions()}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-muted">
                    {m.units_empty()}
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
  const navigate = useNavigate()
  const guarded = useGuardedApi()
  const say = useToast()
  const [removing, setRemoving] = useState(false)
  const { unit: u, container: c } = row
  const name = u?.name ?? c!.name
  const st = status(row)
  const listen = u?.socket?.listen.length ? `${m.units_listens({ addrs: (u.socket.listen.map((l) => l.replace(/ \((Stream|Datagram|SequentialPacket)\)$/, '')).join(', ')) })}${u.socket.triggers ? ` → ${u.socket.triggers}` : ''}` : ''
  const why = u ? (failureReason(u) ?? listen ?? '') || [u.quadlet?.file, c?.image].filter(Boolean).join(' · ') : c!.image
  const detail = why || (u && u.description !== u.name ? u.description : '')
  const target = u ? { kind: 'unit' as const, name: u.name } : { kind: 'container' as const, name: c!.name }
  const active = u ? u.active === 'active' || u.active === 'activating' : c!.state === 'running'
  const memory = u?.memory ?? c?.memUsage
  // One button for what is usually wanted; everything else in the menu.
  const primary: 'restart' | 'start' = active || u?.active === 'failed' ? 'restart' : 'start'
  const bootable = u && (u.unitFileState === 'enabled' || u.unitFileState === 'disabled')
  const setBoot = async (enabled: boolean) => {
    try {
      const r = await guarded('/api/systemd', { body: { enable: { unit: u!.name, enabled } } })
      if (r) say(enabled ? m.units_bootOn({ name: u!.name }) : m.units_bootOff({ name: u!.name }))
    } catch (e) {
      say((e as Error).message, 'bad')
    }
  }
  const items: MenuItem[] = [
    ...(u ? [{ label: m.common_journal(), onSelect: () => void navigate({ to: '/journal', search: { unit: u.name } }) }] : []),
    ...(c ? [{ label: m.usage_menu(), onSelect: () => void navigate({ to: '/units', search: { view: 'usage', container: c.name } }) }] : []),
    ...(u?.quadlet
      ? [{ label: m.units_editQuadlet(), onSelect: () => void navigate({ to: '/quadlets', search: { file: u.quadlet!.file } }) }]
      : u
        ? [{ label: m.units_editUnit(), onSelect: () => void navigate({ to: '/systemd', search: { unit: u.name } }) }]
        : []),
    ...(readonly
      ? []
      : [
          ...(active ? [{ label: m.units_stopDots(), onSelect: () => run('stop', target), danger: true, disabled: busy === name, separator: true }] : []),
          ...(bootable ? [{ label: m.units_startAtBoot(), checked: u!.unitFileState === 'enabled', onSelect: () => void setBoot(u!.unitFileState !== 'enabled'), separator: true }] : []),
          ...(u?.quadlet ? [{ label: m.units_deleteQuadlet(), onSelect: () => setRemoving(true), danger: true, separator: !active || !!bootable }] : []),
        ]),
  ]
  return (
    <tr data-testid="unit-row">
      <td>
        <div className="flex max-w-[13rem] min-w-0 items-center gap-2 lg:max-w-[22rem] 2xl:max-w-[28rem]">
          {u ? (
            <Link to="/journal" search={{ unit: u.name }} className="truncate font-mono text-[13px] font-medium text-fg hover:text-accent" title={m.units_openJournal({ name })}>
              {name}
            </Link>
          ) : (
            <span className="font-mono text-[13px] font-medium">{name}</span>
          )}
          {c && u && c.name !== u.name.replace(/\.service$/, '') && <span className="chip">{c.name}</span>}
        </div>
        {detail && (
          <div title={detail} className={`max-w-[13rem] truncate text-[12px] lg:max-w-[22rem] 2xl:max-w-[28rem] ${u?.active === 'failed' ? 'text-[#ff8a80]' : 'text-muted'}`}>
            {detail}
          </div>
        )}
      </td>
      <td className="hidden 2xl:table-cell">
        <span className={u?.kind === 'quadlet' ? 'chip q' : 'chip'} title={u?.quadlet ? `Quadlet (.${u.quadlet.type})` : u ? undefined : m.units_containerNoUnit()}>
          {kindLabel(row)}
        </span>
      </td>
      <td>
        <Pill tone={st.tone}>{st.label}</Pill>
      </td>
      <td className="hidden xl:table-cell">
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
      <td className="hidden text-subtle 2xl:table-cell">{u?.unitFileState ?? (c ? m.units_noUnit() : '–')}</td>
      <td>
        <div className="flex justify-end gap-1.5">
          {!readonly && (
            <button type="button" className="btn sm" disabled={busy === name} onClick={() => run(primary, target)} aria-label={primary === 'restart' ? m.units_restartAria({ name }) : m.units_startAria({ name })}>
              {primary === 'restart' ? m.units_restart() : m.units_start()}
            </button>
          )}
          {items.length > 0 && <RowMenu label={m.common_actionsFor({ name })} items={items} />}
          {u?.quadlet && <RemoveQuadletDialog open={removing} name={u.quadlet.file} onClose={() => setRemoving(false)} onRemoved={() => {}} />}
        </div>
      </td>
    </tr>
  )
}
