import { Link, createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useActions } from '~/components/Actions'
import { AddLinkDialog } from '~/components/AddLinkDialog'
import { EditableGrid, recentlyDragged, type DefaultItem, type GridSpec } from '~/components/EditableGrid'
import { MetricCard, MetricDialog, type MetricCardId } from '~/components/MetricCards'
import { Glyph } from '~/components/Glyph'
import { ConfirmDialog } from '~/components/Modal'
import { PageHeader } from '~/components/PageHeader'
import { ServiceDialog } from '~/components/ServiceDialog'
import { ServiceTile } from '~/components/ServiceTile'
import { Dot, Pill } from '~/components/Status'
import { useToast } from '~/components/Toast'
import { api } from '~/lib/api'
import { calendarLabel, diskSize, pct, relative } from '~/lib/format'
import { useMetricHistory } from '~/lib/history'
import { useLive } from '~/lib/live'
import { getDashboardLayout } from '~/lib/server-fns'
import type { DashboardLayout, GridItem, LayoutScope } from '~/shared/layout'
import type { Disk, Service, ServiceGroup, Share, Snapshot, Unit } from '~/shared/types'
import { failureReason } from '~/shared/units'
import { m } from '~/paraglide/messages'
import { pickMsg } from '~/i18n'

export const Route = createFileRoute('/_app/')({
  loader: () => getDashboardLayout(),
  component: Overview,
})

// ---------- card grid (level 1) ----------

// Labels come from t.overview.cards.
const CARDS = [{ id: 'services' }, { id: 'storage' }, { id: 'timers' }, { id: 'shares' }, { id: 'cpu' }, { id: 'ram' }, { id: 'temp' }, { id: 'net' }, { id: 'gpu' }] as const
type CardId = (typeof CARDS)[number]['id']

// Gauge + one-hour chart; height follows the content.
// Metric cards have a fixed height (the chart fills it) and can be made small and square.
const GAUGE = { h: 6, minW: 2, minH: 4 }

/** Default card layout per breakpoint (h omitted = height follows the content). */
const CARD_DEFAULTS: Record<string, Record<CardId, Omit<DefaultItem, 'i'>>> = {
  lg: {
    cpu: { x: 0, y: 0, w: 3, ...GAUGE },
    ram: { x: 3, y: 0, w: 3, ...GAUGE },
    temp: { x: 6, y: 0, w: 3, ...GAUGE },
    net: { x: 9, y: 0, w: 3, ...GAUGE },
    services: { x: 0, y: 8, w: 8, minW: 3, minH: 3 },
    gpu: { x: 8, y: 8, w: 4, ...GAUGE },
    storage: { x: 8, y: 100, w: 4, minW: 2, minH: 3 },
    timers: { x: 8, y: 200, w: 4, minW: 2, minH: 3 },
    shares: { x: 8, y: 300, w: 4, minW: 2, minH: 3 },
  },
  md: {
    cpu: { x: 0, y: 0, w: 2, ...GAUGE, minW: 1 },
    ram: { x: 2, y: 0, w: 2, ...GAUGE, minW: 1 },
    temp: { x: 4, y: 0, w: 2, ...GAUGE, minW: 1 },
    net: { x: 0, y: 6, w: 3, ...GAUGE, minW: 1 },
    gpu: { x: 3, y: 6, w: 3, ...GAUGE, minW: 1 },
    services: { x: 0, y: 12, w: 6, minW: 2, minH: 3 },
    storage: { x: 0, y: 200, w: 3, minW: 2, minH: 3 },
    timers: { x: 3, y: 200, w: 3, minW: 2, minH: 3 },
    shares: { x: 0, y: 300, w: 3, minW: 2, minH: 3 },
  },
  xs: {
    services: { x: 0, y: 0, w: 1, minH: 3 },
    cpu: { x: 0, y: 100, w: 1, ...GAUGE, minW: 1 },
    ram: { x: 0, y: 104, w: 1, ...GAUGE, minW: 1 },
    temp: { x: 0, y: 108, w: 1, ...GAUGE, minW: 1 },
    net: { x: 0, y: 112, w: 1, ...GAUGE, minW: 1 },
    gpu: { x: 0, y: 116, w: 1, ...GAUGE, minW: 1 },
    storage: { x: 0, y: 200, w: 1, minH: 3 },
    timers: { x: 0, y: 300, w: 1, minH: 3 },
    shares: { x: 0, y: 400, w: 1, minH: 3 },
  },
}

const PAGE_GRID_BASE = { breakpoints: { lg: 960, md: 640, xs: 0 }, cols: { lg: 12, md: 6, xs: 1 }, rowHeight: 20, margin: [16, 16] as [number, number] }

// ---------- tile grid (level 2, inside the Services card) ----------

/** Breakpoints refer to the width of the Services card, not the window. */
const TILE_GRID_BASE = { breakpoints: { lg: 1100, md: 820, sm: 560, xs: 0 }, cols: { lg: 8, md: 6, sm: 4, xs: 2 }, rowHeight: 112, margin: [12, 12] as [number, number] }

function flowTiles(items: Service[], cols: number): DefaultItem[] {
  return items.map((s, n) => ({ i: s.key, x: n % cols, y: Math.floor(n / cols), w: 1, h: 1, maxW: Math.min(4, cols), maxH: 3 }))
}

// ---------- page ----------

function Overview() {
  const { snapshot } = useLive()
  const initial = Route.useLoaderData()
  const [layout, setLayout] = useState<DashboardLayout>(initial)
  const [editing, setEditing] = useState(false)
  const say = useToast()
  const cardLabel = (id: string) => pickMsg({ "services": m.overview_cards_services, "storage": m.overview_cards_storage, "timers": m.overview_cards_timers, "shares": m.overview_cards_shares, "cpu": m.overview_cards_cpu, "ram": m.overview_cards_ram, "temp": m.overview_cards_temp, "net": m.overview_cards_net, "gpu": m.overview_cards_gpu }, id)
  const failed = snapshot.units.filter((u) => u.active === 'failed')

  // "E" toggles edit mode (not while typing or in a dialog).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'e' || e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement
      if (t.closest('input, textarea, select, [contenteditable], dialog[open]') || document.querySelector('dialog[open]')) return
      setEditing((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const save = useCallback(
    (scope: LayoutScope, bp: string, items: GridItem[]) => {
      setLayout((l) => {
        const byId = new Map((l.layouts[scope][bp] ?? []).map((it) => [it.i, it]))
        for (const it of items) byId.set(it.i, it)
        return { ...l, layouts: { ...l.layouts, [scope]: { ...l.layouts[scope], [bp]: [...byId.values()] } } }
      })
      api('/api/layout', { body: { scope, breakpoint: bp, items } }).catch((e) => say(m.overview_edit_layoutNotSaved({ msg: ((e as Error).message) }), 'bad'))
    },
    [say],
  )

  const setHidden = (id: string, hidden: boolean) => {
    setLayout((l) => ({ ...l, hidden: hidden ? [...l.hidden, id] : l.hidden.filter((x) => x !== id) }))
    api('/api/layout/hidden', { body: { id, hidden } }).catch((e) => say((e as Error).message, 'bad'))
  }

  const reset = async () => {
    try {
      await api('/api/layout', { method: 'DELETE' })
      setLayout({ layouts: { page: {}, tiles: {} }, hidden: [] })
      say(m.overview_edit_layoutReset())
    } catch (e) {
      say((e as Error).message, 'bad')
    }
  }

  // The GPU card only exists when there is a GPU.
  const hasGpu = !!snapshot.system?.gpus?.length
  const visible = CARDS.filter((c) => !layout.hidden.includes(c.id) && (c.id !== 'gpu' || hasGpu))
  const history = useMetricHistory('1h')
  const [detail, setDetail] = useState<MetricCardId | null>(null)
  const metric = (id: MetricCardId) => <MetricCard id={id} snapshot={snapshot} history={history.series} now={history.now} onOpen={editing ? () => {} : setDetail} />
  const pageSpec: GridSpec = useMemo(
    () => ({ ...PAGE_GRID_BASE, defaults: (bp) => visible.map((c) => ({ i: c.id, ...CARD_DEFAULTS[bp]![c.id] })) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible.map((c) => c.id).join()],
  )

  const nodes: Record<CardId, React.ReactNode> = {
    services: <Services groups={snapshot.services} editing={editing} saved={layout.layouts.tiles} onSave={(bp, items) => save('tiles', bp, items)} />,
    storage: <Storage disks={snapshot.disks} smart={snapshot.smart ?? []} />,
    timers: <Timers units={snapshot.units} />,
    shares: <Shares shares={snapshot.shares} error={snapshot.sources.shares?.error} />,
    cpu: metric('cpu'),
    ram: metric('ram'),
    temp: metric('temp'),
    net: metric('net'),
    gpu: metric('gpu'),
  }

  return (
    <>
      <PageHeader title={m.overview_title()} subtitle={m.overview_subtitle({ host: snapshot.host.hostname })}>
        <button type="button" className={editing ? 'btn primary' : 'btn'} onClick={() => setEditing(!editing)} aria-pressed={editing} title={m.overview_edit_toggleTitle()}>
          <Glyph name="edit" size={15} strokeWidth={2} />
          {editing ? m.overview_edit_done() : m.overview_edit_edit()}
        </button>
      </PageHeader>
      {editing && (
        <div className="flex flex-wrap items-center gap-3 rounded-[10px] border border-[rgba(124,196,184,.35)] bg-[rgba(124,196,184,.08)] px-[14px] py-[10px] text-[13px] text-[#b6e3da]" role="status">
          <span className="grow">{m.overview_edit_help()}</span>
          {layout.hidden.length > 0 && (
            <span className="flex flex-wrap items-center gap-1.5">
              {m.overview_edit_hidden()}
              {layout.hidden.map((id) => (
                <button key={id} type="button" className="seg" onClick={() => setHidden(id, false)} aria-label={m.overview_edit_show({ label: cardLabel(id) })}>
                  <Glyph name="plus" size={12} strokeWidth={2} />
                  {cardLabel(id)}
                </button>
              ))}
            </span>
          )}
          {snapshot.hiddenServices.length > 0 && (
            <span className="flex flex-wrap items-center gap-1.5">
              {m.overview_edit_hiddenServices()}
              {snapshot.hiddenServices.map((h) => (
                <button
                  key={h.key}
                  type="button"
                  className="seg"
                  aria-label={m.overview_edit_showAgain({ name: h.name })}
                  onClick={() => api('/api/services/override', { body: { key: h.key, hidden: false, onlyHidden: true } }).catch((e) => say((e as Error).message, 'bad'))}
                >
                  <Glyph name="plus" size={12} strokeWidth={2} />
                  {h.name}
                </button>
              ))}
            </span>
          )}
          <button type="button" className="btn sm" onClick={reset}>
            {m.overview_edit_resetLayout()}
          </button>
        </div>
      )}
      {failed.map((u) => (
        <AlertCard key={u.name} unit={u} snapshot={snapshot} />
      ))}
      <EditableGrid
        spec={pageSpec}
        ssrBreakpoint="lg"
        items={visible.map((c) => ({ i: c.id, node: nodes[c.id] }))}
        saved={layout.layouts.page}
        editing={editing}
        onSave={(bp, items) => save('page', bp, items)}
        handle=".card-handle"
        itemClassName="card"
        renderChrome={(id) => {
          const label = cardLabel(id)
          return (
            <div className="card-chrome">
              <button type="button" className="card-handle" aria-label={m.overview_edit_move({ label })} title={m.overview_edit_dragToMove()}>
                <Glyph name="grip" size={15} strokeWidth={3.2} />
              </button>
              <button type="button" className="no-drag" onClick={() => setHidden(id, true)} aria-label={m.overview_edit_hide({ label })} title={m.overview_edit_hideTitle()}>
                <Glyph name="eyeOff" size={15} />
              </button>
            </div>
          )
        }}
      />
      <MetricDialog id={detail} snapshot={snapshot} onClose={() => setDetail(null)} />
    </>
  )
}

// ---------- alarm card ----------

function AlertCard({ unit, snapshot }: { unit: Unit; snapshot: Snapshot }) {
  const { run, busy, readonly } = useActions()
  const reason = failureReason(unit)
  const container = snapshot.containers.find((c) => c.unit === unit.name)
  return (
    <section className="panel alertcard flex flex-col gap-[10px] px-[18px] py-4" aria-label={m.overview_alert_label({ name: unit.name })}>
      <div className="flex flex-wrap items-center gap-[10px]">
        <Pill tone="bad">{m.overview_alert_pill()}</Pill>
        <span className="font-cond text-[16px] font-semibold" suppressHydrationWarning>
          {m.overview_alert_failed({ name: unit.name, when: relative(unit.since) })}
        </span>
      </div>
      <p className="m-0 text-[#c9d1d9]">
        {reason ?? m.overview_alert_stateFailed()}
        {unit.description && unit.description !== unit.name ? ` · ${unit.description}` : ''}
      </p>
      <div className="flex flex-wrap gap-2">
        <Link to="/journal" search={{ unit: unit.name }} className="btn sm">
          {m.overview_alert_showJournal()}
        </Link>
        {!readonly && (
          <button type="button" className="btn sm primary" disabled={busy === unit.name} onClick={() => run('restart', { kind: 'unit', name: unit.name })}>
            {m.common_restart()}
          </button>
        )}
        {container && <span className="self-center text-[12px] text-muted">{m.overview_alert_container({ name: container.name })}</span>}
      </div>
    </section>
  )
}

// ---------- storage ----------

const SMART_TONE = { ok: 'ok', warning: 'warn', critical: 'bad' } as const

function Storage({ disks, smart }: { disks: Disk[]; smart: Snapshot['smart'] }) {
  const smartLabel = { ok: m.overview_storage_smartOk(), warning: m.overview_storage_smartWarning(), critical: m.overview_storage_smartCritical() }
  const smartOf = (dev: string) => smart.find((x) => x.name === dev && x.supported && !x.standby)
  const total = disks.reduce((a, d) => a + d.size, 0)
  const used = disks.reduce((a, d) => a + d.used, 0)
  return (
    <section className="flex flex-col gap-[14px] p-[18px]" aria-label={m.overview_cards_storage()}>
      <div className="flex items-baseline justify-between">
        <h2 className="h2">{m.overview_cards_storage()}</h2>
        <span className="flex items-center gap-2 text-[12px] text-muted">
          {disks.length ? m.overview_storage_usedOf({ used: diskSize(used), total: diskSize(total) }) : ''}
          <Link to="/disks" className="btn sm no-drag">
            SMART
          </Link>
        </span>
      </div>
      {disks.length === 0 && <p className="m-0 text-[13px] text-muted">{m.overview_storage_empty()}</p>}
      {disks.map((d) => {
        const p = d.size ? d.used / d.size : 0
        const c = p >= 0.9 ? '#f85149' : p >= 0.8 ? '#d29922' : '#7cc4b8'
        return (
          <div key={d.path} className="flex flex-col gap-1.5" data-testid="disk">
            <div className="flex items-center gap-2">
              {smartOf(d.dev) ? <Dot tone={SMART_TONE[smartOf(d.dev)!.level]} label={smartLabel[smartOf(d.dev)!.level]} /> : <span className="w-2" />}
              <span className="w-[64px] truncate font-mono text-[13px]">{d.dev}</span>
              <span className="min-w-0 grow truncate text-[12px] text-muted">{[d.mount, diskSize(d.size), d.fstype].filter(Boolean).join(' · ')}</span>
              <span className="text-[12px] text-subtle">{d.tempC !== undefined ? `${Math.round(d.tempC)} °C` : ''}</span>
              <span className="chip">{d.role}</span>
            </div>
            <div className="bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p * 100)} aria-label={m.overview_storage_used({ what: d.mount })}>
              <div className="fill" style={{ width: `${(p * 100).toFixed(1)}%`, background: `linear-gradient(90deg, ${c}66, ${c})`, boxShadow: `0 0 12px ${c}88` }} />
            </div>
            <div className="flex justify-between text-[11px] text-muted tabular-nums">
              <span>{m.overview_storage_used({ what: diskSize(d.used) })}</span>
              <span>{pct(p)}</span>
            </div>
          </div>
        )
      })}
    </section>
  )
}

// ---------- services (with tile grid per group) ----------

function Services({ groups, editing, saved, onSave }: { groups: ServiceGroup[]; editing: boolean; saved: Record<string, GridItem[]>; onSave: (bp: string, items: GridItem[]) => void }) {
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<Service | null>(null)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const say = useToast()
  const groupNames = useMemo(() => groups.map((g) => g.name), [groups])
  // Look the service up live, so the dialog follows SSE updates.
  const edited = editingKey ? (groups.flatMap((g) => g.items).find((s) => s.key === editingKey) ?? null) : null
  return (
    <section className="flex flex-col gap-[14px] p-[18px]" aria-label={m.overview_cards_services()}>
      <div className="flex flex-wrap items-center gap-3 pr-16">
        <h2 className="h2">{m.overview_cards_services()}</h2>
        <span className="grow text-[12px] text-muted">{m.overview_services_detected()}</span>
        <button type="button" className="btn sm no-drag" onClick={() => setAdding(true)}>
          <Glyph name="plus" size={14} strokeWidth={2} />
          {m.overview_services_addLink()}
        </button>
      </div>
      {groups.length === 0 && <p className="m-0 text-[13px] text-muted">{m.overview_services_empty()}</p>}
      {groups.map((g) => (
        <TileGroup
          key={g.name}
          group={g}
          editing={editing}
          saved={saved}
          onSave={onSave}
          onDelete={setRemoving}
          onEdit={(s) => {
            if (!recentlyDragged()) setEditingKey(s.key)
          }}
        />
      ))}
      <AddLinkDialog open={adding} onClose={() => setAdding(false)} groups={groupNames} />
      <ServiceDialog service={edited} groups={groupNames} onClose={() => setEditingKey(null)} />
      <ConfirmDialog
        open={!!removing}
        title={m.overview_services_removeTitle({ name: (removing?.name ?? '') })}
        body={<p className="m-0">{m.overview_services_removeBody()}</p>}
        confirm={m.common_remove()}
        danger
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return
          try {
            await api(`/api/links/${removing.manualId}`, { method: 'DELETE' })
            say(m.overview_services_removed({ name: removing.name }))
          } catch (e) {
            say((e as Error).message, 'bad')
          }
        }}
      />
    </section>
  )
}

function TileGroup({
  group,
  editing,
  saved,
  onSave,
  onDelete,
  onEdit,
}: {
  group: ServiceGroup
  editing: boolean
  saved: Record<string, GridItem[]>
  onSave: (bp: string, items: GridItem[]) => void
  onDelete: (s: Service) => void
  onEdit: (s: Service) => void
}) {
  const keys = group.items.map((s) => s.key).join('\n')
  const spec: GridSpec = useMemo(
    () => ({ ...TILE_GRID_BASE, defaults: (_bp, cols) => flowTiles(group.items, cols) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [keys],
  )
  // Only this group's tiles are relevant for its grid.
  const own = useMemo(() => {
    const ids = new Set(group.items.map((s) => s.key))
    return Object.fromEntries(Object.entries(saved).map(([bp, items]) => [bp, items.filter((it) => ids.has(it.i))]))
  }, [saved, keys])
  return (
    <div className="flex flex-col gap-[10px]">
      <div className="flex items-center gap-2">
        <span className="text-[11px] tracking-[.08em] text-muted uppercase">{pickMsg({ "Medien": m.overview_groupNames_Medien, "Netzwerk": m.overview_groupNames_Netzwerk, "Produktivit\u00e4t": m.overview_groupNames_Produktivitaet }, group.name)}</span>
        <span className="text-[11px] text-[#4a525e]">{group.note}</span>
      </div>
      <EditableGrid
        spec={spec}
        ssrBreakpoint="sm"
        items={group.items.map((s) => ({ i: s.key, node: <ServiceTile s={s} editing={editing} onEdit={() => onEdit(s)} onDelete={s.manualId !== undefined ? () => onDelete(s) : undefined} /> }))}
        saved={own}
        editing={editing}
        onSave={onSave}
        measureItems={false}
      />
    </div>
  )
}

// ---------- timers ----------

function Timers({ units }: { units: Unit[] }) {
  const timers = units
    .filter((u) => u.name.endsWith('.timer') && u.active === 'active')
    .sort((a, b) => (a.timer?.next ?? Infinity) - (b.timer?.next ?? Infinity))
    .slice(0, 6)
  const byService = new Map(units.map((u) => [u.name, u]))
  return (
    <section className="pt-[18px] pb-1.5" aria-label={m.overview_cards_timers()}>
      <div className="flex items-baseline justify-between px-[18px] pb-2">
        <h2 className="h2">{m.overview_cards_timers()}</h2>
        <Link to="/units" search={{ filter: 'timer' }} className="btn sm">
          {m.overview_timers_all()}
        </Link>
      </div>
      {timers.length === 0 && <p className="m-0 border-t border-line px-[18px] py-3 text-[13px] text-muted">{m.overview_timers_empty()}</p>}
      {timers.map((tm) => {
        const svc = tm.timer?.unit ? byService.get(tm.timer.unit) : undefined
        return (
          <div key={tm.name} className="flex items-center gap-[10px] border-t border-line px-[18px] py-[9px]">
            <Dot tone={svc?.active === 'failed' ? 'bad' : 'ok'} label={svc?.active === 'failed' ? m.overview_timers_lastRunFailed() : m.overview_timers_ok()} />
            <div className="min-w-0 grow">
              <div className="truncate font-mono text-[13px]">{tm.name}</div>
              <div className="text-[12px] text-muted">{calendarLabel(tm.timer?.calendar)}</div>
            </div>
            <span className="font-mono text-[12px] text-subtle" suppressHydrationWarning>
              {relative(tm.timer?.next)}
            </span>
          </div>
        )
      })}
    </section>
  )
}

// ---------- shares ----------

function Shares({ shares, error }: { shares: Share[]; error?: string }) {
  return (
    <section className="pt-[18px] pb-1.5" aria-label={m.overview_cards_shares()}>
      <div className="flex items-baseline justify-between px-[18px] pb-2">
        <h2 className="h2">{m.overview_cards_shares()}</h2>
        <Link to="/shares" className="btn sm no-drag">
          {m.overview_shares_manage()}
        </Link>
      </div>
      {shares.length === 0 && <p className="m-0 border-t border-line px-[18px] py-3 text-[13px] text-muted">{error ? m.overview_shares_unreadable({ error }) : m.overview_shares_empty()}</p>}
      {shares.map((sh) => (
        <div key={`${sh.type}:${sh.name}:${sh.path}`} className="flex items-center gap-[10px] border-t border-line px-[18px] py-[9px]" data-testid="share">
          <span className={`${sh.type === 'SMB' ? 'chip q' : 'chip'} w-[30px] text-center`}>{sh.type}</span>
          <div className="min-w-0 grow">
            <div className="truncate font-medium">{sh.name}</div>
            <div className="truncate font-mono text-[11px] text-muted">
              {sh.path}
              {sh.note ? ` · ${sh.note}` : ''}
            </div>
          </div>
          <span className="max-w-[45%] truncate text-right text-[12px] text-subtle" title={sh.access}>
            {sh.access}
          </span>
        </div>
      ))}
    </section>
  )
}
