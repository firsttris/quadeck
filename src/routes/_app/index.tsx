import { Link, createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { actionBusyLabel, useActions } from '~/components/Actions'
import { BusyButton, useBusy } from '~/components/Busy'
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
import { NoteDialog, NoteWidget, WidgetCatalog, WidgetSettingsDialog, widgetName, type CatalogEntry, type CatalogKind, type Configurable } from '~/components/Widgets'
import { AlertsWidget, BackupsWidget, ContainersWidget, DevicesWidget, DiskWidget, LinksWidget, LoginsWidget, ServiceWidget, SpeedWidget, UpdatesWidget } from '~/components/DashWidgets'
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
import { BUILTIN_CARDS, INSTANCE_KINDS, WIDGETS, defaultConfig, isBuiltinCard, type BuiltinCard, type InstanceKind, type WidgetInstance } from '~/shared/widgets'

export const Route = createFileRoute('/_app/')({
  loader: () => getDashboardLayout(),
  component: Overview,
})

// ---------- card grid (level 1) ----------

type CardId = BuiltinCard

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
    power: { x: 8, y: 50, w: 4, ...GAUGE },
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
    power: { x: 3, y: 150, w: 3, ...GAUGE, minW: 1 },
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
    power: { x: 0, y: 120, w: 1, ...GAUGE, minW: 1 },
    storage: { x: 0, y: 200, w: 1, minH: 3 },
    timers: { x: 0, y: 300, w: 1, minH: 3 },
    shares: { x: 0, y: 400, w: 1, minH: 3 },
  },
}

/** Where an added widget goes first: below everything, a third (desktop) or half (tablet) wide. */
const below = { lg: { x: 0, y: 900, w: 4, minW: 2, minH: 3 }, md: { x: 0, y: 900, w: 3, minW: 2, minH: 3 }, xs: { x: 0, y: 900, w: 1, minH: 3 } }
const INSTANCE_DEFAULTS: Record<InstanceKind, Record<string, Omit<DefaultItem, 'i'>>> = {
  // the starter widgets of a fresh install sit next to the services, above storage
  updates: { lg: { x: 8, y: 20, w: 4, minW: 2, minH: 3 }, md: { x: 0, y: 190, w: 3, minW: 2, minH: 3 }, xs: { x: 0, y: 50, w: 1, minH: 3 } },
  backups: { lg: { x: 8, y: 30, w: 4, minW: 2, minH: 3 }, md: { x: 3, y: 190, w: 3, minW: 2, minH: 3 }, xs: { x: 0, y: 60, w: 1, minH: 3 } },
  disk: below,
  containers: below,
  alerts: below,
  service: below,
  devices: below,
  speed: below,
  logins: below,
  links: below,
  note: below,
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
  const instance = (id: string) => layout.widgets.find((w) => w.id === id)
  const cardLabel = (id: string) => {
    const w = instance(id)
    if (w?.kind === 'note' && w.config.title) return w.config.title
    if (w?.kind === 'disk' && w.config.mount) return m.widgets_disk_title({ mount: w.config.mount })
    if (w?.kind === 'containers') return w.config.metric === 'cpu' ? m.widgets_containers_titleCpu() : m.widgets_containers_titleRam()
    if (w?.kind === 'service' && w.config.unit) return w.config.unit.replace(/\.service$/, '')
    if (w?.kind === 'links' && w.config.title) return w.config.title
    if (w) return widgetName(w.kind)
    return isBuiltinCard(id) ? widgetName(id) : id
  }
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

  const resetting = useBusy()
  const reset = () =>
    resetting.run('reset', async () => {
      try {
        await api('/api/layout', { method: 'DELETE' })
        setLayout((l) => ({ layouts: { page: {}, tiles: {} }, hidden: [], widgets: l.widgets }))
        say(m.overview_edit_layoutReset())
      } catch (e) {
        say((e as Error).message, 'bad')
      }
    })

  // The GPU card only exists when there is a GPU.
  const hasGpu = !!snapshot.system?.gpus?.length
  // The power card once the server reported power.
  const hasPower = !!snapshot.power
  const available = (id: CardId) => (id !== 'gpu' || hasGpu) && (id !== 'power' || hasPower)
  const visible = BUILTIN_CARDS.filter((id) => !layout.hidden.includes(id) && available(id))
  const shownIds = [...visible, ...layout.widgets.map((w) => w.id)]

  // ---- catalog: add built-in cards again or new widgets ----
  const [catalog, setCatalog] = useState(false)
  const [noteEdit, setNoteEdit] = useState<string | null>(null)
  const [configuring, setConfiguring] = useState<string | null>(null)
  const [removing, setRemoving] = useState<WidgetInstance | null>(null)
  const catalogEntries: CatalogEntry[] = [
    ...BUILTIN_CARDS.map((id) => ({ kind: id, count: visible.includes(id) ? 1 : 0, unavailable: !available(id) ? (id === 'gpu' ? m.widgets_catalog_noGpu() : m.widgets_catalog_noPower()) : undefined })),
    ...INSTANCE_KINDS.map((k) => ({ kind: k, count: layout.widgets.filter((w) => w.kind === k).length })),
  ]
  const addWidget = async (kind: CatalogKind) => {
    if (isBuiltinCard(kind)) {
      setHidden(kind, false)
      setCatalog(false)
      return
    }
    try {
      const w = await api<WidgetInstance>('/api/layout/widgets', { body: { kind, config: defaultConfig(kind) } })
      setLayout((l) => ({ ...l, widgets: [...l.widgets, w] }))
      setCatalog(false)
      // a new note opens for writing, a new disk asks which one
      if (w.kind === 'note') setNoteEdit(w.id)
      if (w.kind === 'disk' || w.kind === 'service' || w.kind === 'links') setConfiguring(w.id)
    } catch (e) {
      say((e as Error).message, 'bad')
    }
  }
  const dropWidget = async (w: WidgetInstance) => {
    try {
      await api(`/api/layout/widgets?id=${encodeURIComponent(w.id)}`, { method: 'DELETE' })
      setLayout((l) => ({ ...l, widgets: l.widgets.filter((x) => x.id !== w.id), layouts: { ...l.layouts, page: Object.fromEntries(Object.entries(l.layouts.page).map(([bp, items]) => [bp, items.filter((it) => it.i !== w.id)])) } }))
    } catch (e) {
      say((e as Error).message, 'bad')
    }
  }
  const removeCard = (id: string) => {
    const w = instance(id)
    if (!w) return setHidden(id, true)
    // a note or link group with content asks first (it is gone afterwards); the others go right away
    if ((w.kind === 'note' && (w.config.text || w.config.title)) || (w.kind === 'links' && w.config.links.length)) setRemoving(w)
    else void dropWidget(w)
  }
  const replaceWidget = (w: WidgetInstance) => setLayout((l) => ({ ...l, widgets: l.widgets.map((x) => (x.id === w.id ? w : x)) }))
  const history = useMetricHistory('1h')
  const [detail, setDetail] = useState<MetricCardId | null>(null)
  const metric = (id: MetricCardId) => <MetricCard id={id} snapshot={snapshot} history={history.series} now={history.now} onOpen={editing ? () => {} : setDetail} />
  const pageSpec: GridSpec = useMemo(
    () => ({
      ...PAGE_GRID_BASE,
      defaults: (bp) => [...visible.map((id) => ({ i: id, ...CARD_DEFAULTS[bp]![id] })), ...layout.widgets.map((w) => ({ i: w.id, ...INSTANCE_DEFAULTS[w.kind][bp]! }))],
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shownIds.join()],
  )

  const nodes: Record<string, React.ReactNode> = {
    services: <Services groups={snapshot.services} editing={editing} saved={layout.layouts.tiles} onSave={(bp, items) => save('tiles', bp, items)} />,
    storage: <Storage disks={snapshot.disks} smart={snapshot.smart ?? []} />,
    timers: <Timers units={snapshot.units} />,
    shares: <Shares shares={snapshot.shares} error={snapshot.sources.shares?.error} />,
    cpu: metric('cpu'),
    ram: metric('ram'),
    temp: metric('temp'),
    net: metric('net'),
    gpu: metric('gpu'),
    power: metric('power'),
  }
  for (const w of layout.widgets) {
    if (w.kind === 'note') nodes[w.id] = <NoteWidget widget={w} editing={editing} onEdit={() => setNoteEdit(w.id)} />
    else if (w.kind === 'updates') nodes[w.id] = <UpdatesWidget />
    else if (w.kind === 'backups') nodes[w.id] = <BackupsWidget backup={snapshot.backup} />
    else if (w.kind === 'disk') nodes[w.id] = <DiskWidget config={w.config} snapshot={snapshot} />
    else if (w.kind === 'containers') nodes[w.id] = <ContainersWidget config={w.config} containers={snapshot.containers} />
    else if (w.kind === 'alerts') nodes[w.id] = <AlertsWidget />
    else if (w.kind === 'service') nodes[w.id] = <ServiceWidget config={w.config} snapshot={snapshot} />
    else if (w.kind === 'devices') nodes[w.id] = <DevicesWidget fresh={snapshot.devices?.fresh ?? []} />
    else if (w.kind === 'speed') nodes[w.id] = <SpeedWidget />
    else if (w.kind === 'logins') nodes[w.id] = <LoginsWidget />
    else if (w.kind === 'links') nodes[w.id] = <LinksWidget config={w.config} />
  }
  const configured = layout.widgets.find((w) => w.id === configuring && w.kind !== 'note' && WIDGETS[w.kind].configurable) as Configurable | undefined
  const unitChoices = snapshot.units.filter((u) => u.name.endsWith('.service')).map((u) => ({ name: u.name, label: u.description && u.description !== u.name ? `${u.name} · ${u.description}` : u.name }))
  const mounts = snapshot.disks.filter((d) => d.mount).map((d) => ({ mount: d.mount, label: `${d.mount} · ${d.dev} · ${diskSize(d.size)}` }))
  const editedNote = layout.widgets.find((w) => w.id === noteEdit && w.kind === 'note') as (WidgetInstance & { kind: 'note' }) | undefined

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
          <button type="button" className="btn sm primary" onClick={() => setCatalog(true)}>
            <Glyph name="plus" size={13} strokeWidth={2} />
            {m.widgets_catalog_open()}
          </button>
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
          <BusyButton className="btn sm" busy={!!resetting.busy} busyLabel={m.common_working()} onClick={() => void reset()}>
            {m.overview_edit_resetLayout()}
          </BusyButton>
        </div>
      )}
      {failed.map((u) => (
        <AlertCard key={u.name} unit={u} snapshot={snapshot} />
      ))}
      <EditableGrid
        spec={pageSpec}
        ssrBreakpoint="lg"
        items={shownIds.map((id) => ({ i: id, node: nodes[id] }))}
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
              {instance(id) && WIDGETS[instance(id)!.kind].configurable && (
                <button type="button" className="no-drag" onClick={() => (instance(id)!.kind === 'note' ? setNoteEdit(id) : setConfiguring(id))} aria-label={m.overview_edit_settings({ label })} title={m.overview_edit_settingsTitle()}>
                  <Glyph name="settings" size={14} />
                </button>
              )}
              <button type="button" className="no-drag" onClick={() => removeCard(id)} aria-label={m.overview_edit_remove({ label })} title={m.overview_edit_removeTitle()}>
                <Glyph name="close" size={15} />
              </button>
            </div>
          )
        }}
      />
      {editing && (
        <button type="button" className="mt-4 grid min-h-[64px] w-full place-items-center rounded-[12px] border-[1.5px] border-dashed border-[rgba(124,196,184,.35)] text-[13px] text-accent" onClick={() => setCatalog(true)}>
          <span className="flex items-center gap-1.5">
            <Glyph name="plus" size={14} strokeWidth={2} />
            {m.widgets_catalog_open()}
          </span>
        </button>
      )}
      <MetricDialog id={detail} snapshot={snapshot} onClose={() => setDetail(null)} />
      <WidgetCatalog open={catalog} entries={catalogEntries} onClose={() => setCatalog(false)} onAdd={addWidget} />
      <NoteDialog widget={editedNote ?? null} onClose={() => setNoteEdit(null)} onSaved={replaceWidget} />
      <WidgetSettingsDialog widget={configured ?? null} mounts={mounts} units={unitChoices} onClose={() => setConfiguring(null)} onSaved={replaceWidget} />
      <ConfirmDialog
        open={!!removing}
        title={m.widgets_remove_title({ name: removing ? cardLabel(removing.id) : '' })}
        body={<p className="m-0">{m.widgets_remove_body()}</p>}
        confirm={m.common_remove()}
        danger
        busyLabel={m.common_deleting()}
        onClose={() => setRemoving(null)}
        onConfirm={() => (removing ? dropWidget(removing) : undefined)}
      />
    </>
  )
}

// ---------- alarm card ----------

function AlertCard({ unit, snapshot }: { unit: Unit; snapshot: Snapshot }) {
  const { run, busy, busyAction, readonly } = useActions()
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
          <BusyButton className="btn sm primary" busy={busy === unit.name} busyLabel={actionBusyLabel(busyAction ?? 'restart')} onClick={() => run('restart', { kind: 'unit', name: unit.name })}>
            {m.common_restart()}
          </BusyButton>
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
              <span className="text-[12px] text-subtle" title={d.tempFromSmart ? m.overview_storage_tempSmart() : undefined}>
                {d.tempC !== undefined ? `${Math.round(d.tempC)} °C` : ''}
              </span>
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
        busyLabel={m.common_deleting()}
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
