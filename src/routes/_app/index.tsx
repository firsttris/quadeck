import { Link, createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useActions } from '~/components/Actions'
import { AddLinkDialog } from '~/components/AddLinkDialog'
import { EditableGrid, type DefaultItem, type GridSpec } from '~/components/EditableGrid'
import { Gauge } from '~/components/Gauge'
import { Glyph } from '~/components/Glyph'
import { ConfirmDialog } from '~/components/Modal'
import { PageHeader } from '~/components/PageHeader'
import { ServiceTile } from '~/components/ServiceTile'
import { Dot, Pill } from '~/components/Status'
import { useToast } from '~/components/Toast'
import { api } from '~/lib/api'
import { bytes, calendarLabel, diskSize, num, pct, rate, relative } from '~/lib/format'
import { useLive } from '~/lib/live'
import { getDashboardLayout } from '~/lib/server-fns'
import type { DashboardLayout, GridItem, LayoutScope } from '~/shared/layout'
import type { Disk, Service, ServiceGroup, Snapshot, Unit } from '~/shared/types'
import { failureReason } from '~/shared/units'

export const Route = createFileRoute('/_app/')({
  loader: () => getDashboardLayout(),
  component: Overview,
})

// ---------- card grid (level 1) ----------

const CARDS = [
  { id: 'services', label: 'Services' },
  { id: 'storage', label: 'Speicher' },
  { id: 'timers', label: 'Nächste Timer' },
  { id: 'cpu', label: 'CPU' },
  { id: 'ram', label: 'RAM' },
  { id: 'temp', label: 'CPU-Temp' },
  { id: 'net', label: 'Netz' },
] as const
type CardId = (typeof CARDS)[number]['id']

const GAUGE = { h: 4, minW: 2, minH: 4, maxH: 8 }

/** Default card layout per breakpoint (h omitted = height follows the content). */
const CARD_DEFAULTS: Record<string, Record<CardId, Omit<DefaultItem, 'i'>>> = {
  lg: {
    cpu: { x: 0, y: 0, w: 3, ...GAUGE },
    ram: { x: 3, y: 0, w: 3, ...GAUGE },
    temp: { x: 6, y: 0, w: 3, ...GAUGE },
    net: { x: 9, y: 0, w: 3, ...GAUGE },
    services: { x: 0, y: 4, w: 8, minW: 3, minH: 3 },
    storage: { x: 8, y: 4, w: 4, minW: 2, minH: 3 },
    timers: { x: 8, y: 200, w: 4, minW: 2, minH: 3 },
  },
  md: {
    cpu: { x: 0, y: 0, w: 3, ...GAUGE, minW: 1 },
    ram: { x: 3, y: 0, w: 3, ...GAUGE, minW: 1 },
    temp: { x: 0, y: 4, w: 3, ...GAUGE, minW: 1 },
    net: { x: 3, y: 4, w: 3, ...GAUGE, minW: 1 },
    services: { x: 0, y: 8, w: 6, minW: 2, minH: 3 },
    storage: { x: 0, y: 200, w: 3, minW: 2, minH: 3 },
    timers: { x: 3, y: 200, w: 3, minW: 2, minH: 3 },
  },
  xs: {
    services: { x: 0, y: 0, w: 1, minH: 3 },
    cpu: { x: 0, y: 100, w: 1, ...GAUGE, minW: 1 },
    ram: { x: 0, y: 104, w: 1, ...GAUGE, minW: 1 },
    temp: { x: 0, y: 108, w: 1, ...GAUGE, minW: 1 },
    net: { x: 0, y: 112, w: 1, ...GAUGE, minW: 1 },
    storage: { x: 0, y: 200, w: 1, minH: 3 },
    timers: { x: 0, y: 300, w: 1, minH: 3 },
  },
}

const PAGE_GRID_BASE = { breakpoints: { lg: 1200, md: 700, xs: 0 }, cols: { lg: 12, md: 6, xs: 1 }, rowHeight: 20, margin: [16, 16] as [number, number] }

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
      api('/api/layout', { body: { scope, breakpoint: bp, items } }).catch((e) => say(`Layout nicht gespeichert: ${(e as Error).message}`, 'bad'))
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
      say('Auto-Layout wiederhergestellt')
    } catch (e) {
      say((e as Error).message, 'bad')
    }
  }

  const visible = CARDS.filter((c) => !layout.hidden.includes(c.id))
  const pageSpec: GridSpec = useMemo(
    () => ({ ...PAGE_GRID_BASE, defaults: (bp) => visible.map((c) => ({ i: c.id, ...CARD_DEFAULTS[bp]![c.id] })) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible.map((c) => c.id).join()],
  )

  const nodes: Record<CardId, React.ReactNode> = {
    services: <Services groups={snapshot.services} editing={editing} saved={layout.layouts.tiles} onSave={(bp, items) => save('tiles', bp, items)} />,
    storage: <Storage disks={snapshot.disks} />,
    timers: <Timers units={snapshot.units} />,
    ...gaugeNodes(snapshot),
  }

  return (
    <>
      <PageHeader title="Übersicht" subtitle={`${snapshot.host.hostname} · live über Podman-Socket und D-Bus`}>
        <button type="button" className={editing ? 'btn primary' : 'btn'} onClick={() => setEditing(!editing)} aria-pressed={editing} title="Layout bearbeiten (Taste E)">
          <Glyph name="edit" size={15} strokeWidth={2} />
          {editing ? 'Fertig' : 'Bearbeiten'}
        </button>
      </PageHeader>
      {editing && (
        <div className="flex flex-wrap items-center gap-3 rounded-[10px] border border-[rgba(124,196,184,.35)] bg-[rgba(124,196,184,.08)] px-[14px] py-[10px] text-[13px] text-[#b6e3da]" role="status">
          <span className="grow">Bearbeiten-Modus: Karten am Griff ziehen, an der Ecke unten rechts vergrößern. Kacheln in „Services“ lassen sich ebenso verschieben und vergrößern.</span>
          {layout.hidden.length > 0 && (
            <span className="flex flex-wrap items-center gap-1.5">
              Ausgeblendet:
              {layout.hidden.map((id) => (
                <button key={id} type="button" className="seg" onClick={() => setHidden(id, false)} aria-label={`${CARDS.find((c) => c.id === id)?.label ?? id} einblenden`}>
                  <Glyph name="plus" size={12} strokeWidth={2} />
                  {CARDS.find((c) => c.id === id)?.label ?? id}
                </button>
              ))}
            </span>
          )}
          <button type="button" className="btn sm" onClick={reset}>
            Auf Auto-Layout zurücksetzen
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
          const label = CARDS.find((c) => c.id === id)?.label ?? id
          return (
            <div className="card-chrome">
              <button type="button" className="card-handle" aria-label={`${label} verschieben`} title="Ziehen zum Verschieben">
                <Glyph name="grip" size={15} strokeWidth={3.2} />
              </button>
              <button type="button" className="no-drag" onClick={() => setHidden(id, true)} aria-label={`${label} ausblenden`} title="Ausblenden">
                <Glyph name="eyeOff" size={15} />
              </button>
            </div>
          )
        }}
      />
    </>
  )
}

// ---------- alarm card ----------

function AlertCard({ unit, snapshot }: { unit: Unit; snapshot: Snapshot }) {
  const { run, busy, readonly } = useActions()
  const reason = failureReason(unit)
  const container = snapshot.containers.find((c) => c.unit === unit.name)
  return (
    <section className="panel alertcard flex flex-col gap-[10px] px-[18px] py-4" aria-label={`Fehlgeschlagen: ${unit.name}`}>
      <div className="flex flex-wrap items-center gap-[10px]">
        <Pill tone="bad">fehlgeschlagen</Pill>
        <span className="font-cond text-[16px] font-semibold" suppressHydrationWarning>
          {unit.name} ist {relative(unit.since)} ausgefallen
        </span>
      </div>
      <p className="m-0 text-[#c9d1d9]">
        {reason ?? 'Die Unit ist im Zustand failed.'}
        {unit.description && unit.description !== unit.name ? ` · ${unit.description}` : ''}
      </p>
      <div className="flex flex-wrap gap-2">
        <Link to="/journal" search={{ unit: unit.name }} className="btn sm">
          Journal anzeigen
        </Link>
        {!readonly && (
          <button type="button" className="btn sm primary" disabled={busy === unit.name} onClick={() => run('restart', { kind: 'unit', name: unit.name })}>
            Neu starten
          </button>
        )}
        {container && <span className="self-center text-[12px] text-muted">Container {container.name}</span>}
      </div>
    </section>
  )
}

// ---------- gauges ----------

function gaugeNodes(snapshot: Snapshot): Record<'cpu' | 'ram' | 'temp' | 'net', React.ReactNode> {
  const s = snapshot.system
  const h = snapshot.host
  const netMax = s?.net.speedMbps ? (s.net.speedMbps * 1e6) / 8 : 125e6
  const net = s ? Math.max(s.net.rx, s.net.tx) / netMax : 0
  const temp = s?.temp
  return {
    cpu: <Gauge bare id="cpu" label="CPU" p={s?.cpu ?? 0} value={s ? pct(s.cpu) : '–'} sub={`${h.cpuCores} Kerne · Load ${s ? num(s.load[0], 2) : '–'}`} />,
    ram: <Gauge bare id="ram" label="RAM" p={s ? s.memUsed / s.memTotal : 0} value={s ? bytes(s.memUsed) : '–'} sub={s ? `von ${bytes(s.memTotal, 0)}` : ''} />,
    temp: <Gauge bare id="temp" label="CPU-Temp" p={temp ? Math.min(1, Math.max(0, (temp.celsius - 30) / 60)) : 0} value={temp ? `${Math.round(temp.celsius)} °C` : '–'} sub={temp?.sensor ?? 'kein Sensor'} />,
    net: (
      <Gauge
        bare
        id="net"
        label="Netz"
        p={net}
        value={s ? `↓ ${rate(s.net.rx)}` : '–'}
        sub={s ? `↑ ${rate(s.net.tx)} · ${s.net.iface}${s.net.speedMbps ? ` · ${s.net.speedMbps >= 1000 ? `${s.net.speedMbps / 1000} GbE` : `${s.net.speedMbps} Mbit`}` : ''}` : ''}
      />
    ),
  }
}

// ---------- storage ----------

function Storage({ disks }: { disks: Disk[] }) {
  const total = disks.reduce((a, d) => a + d.size, 0)
  const used = disks.reduce((a, d) => a + d.used, 0)
  return (
    <section className="flex flex-col gap-[14px] p-[18px]" aria-label="Speicher">
      <div className="flex items-baseline justify-between">
        <h2 className="h2">Speicher</h2>
        <span className="text-[12px] text-muted">{disks.length ? `${diskSize(used)} von ${diskSize(total)}` : ''}</span>
      </div>
      {disks.length === 0 && <p className="m-0 text-[13px] text-muted">Keine eingehängten Dateisysteme gefunden.</p>}
      {disks.map((d) => {
        const p = d.size ? d.used / d.size : 0
        const c = p >= 0.9 ? '#f85149' : p >= 0.8 ? '#d29922' : '#7cc4b8'
        return (
          <div key={d.path} className="flex flex-col gap-1.5" data-testid="disk">
            <div className="flex items-center gap-2">
              <span className="w-[72px] truncate font-mono text-[13px]">{d.dev}</span>
              <span className="min-w-0 grow truncate text-[12px] text-muted">
                {[d.mount, diskSize(d.size), d.fstype].filter(Boolean).join(' · ')}
              </span>
              <span className="text-[12px] text-subtle">{d.tempC !== undefined ? `${Math.round(d.tempC)} °C` : ''}</span>
              <span className="chip">{d.role}</span>
            </div>
            <div className="bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p * 100)} aria-label={`${d.mount} belegt`}>
              <div className="fill" style={{ width: `${(p * 100).toFixed(1)}%`, background: `linear-gradient(90deg, ${c}66, ${c})`, boxShadow: `0 0 12px ${c}88` }} />
            </div>
            <div className="flex justify-between text-[11px] text-muted tabular-nums">
              <span>{diskSize(d.used)} belegt</span>
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
  const say = useToast()
  const groupNames = useMemo(() => groups.map((g) => g.name), [groups])
  return (
    <section className="flex flex-col gap-[14px] p-[18px]" aria-label="Services">
      <div className="flex flex-wrap items-center gap-3 pr-16">
        <h2 className="h2">Services</h2>
        <span className="grow text-[12px] text-muted">automatisch aus Caddy und Quadlets erkannt, dazu eigene Links</span>
        <button type="button" className="btn sm no-drag" onClick={() => setAdding(true)}>
          <Glyph name="plus" size={14} strokeWidth={2} />
          Link hinzufügen
        </button>
      </div>
      {groups.length === 0 && (
        <p className="m-0 text-[13px] text-muted">
          Noch keine Services. Quadeck liest die Routen aus Caddy (Admin-API oder /etc/caddy/Caddyfile); eigene Links lassen sich oben hinzufügen.
        </p>
      )}
      {groups.map((g) => (
        <TileGroup key={g.name} group={g} editing={editing} saved={saved} onSave={onSave} onDelete={setRemoving} />
      ))}
      <AddLinkDialog open={adding} onClose={() => setAdding(false)} groups={groupNames} />
      <ConfirmDialog
        open={!!removing}
        title={`Link „${removing?.name}“ entfernen?`}
        body={<p className="m-0">Der manuell angelegte Link wird gelöscht.</p>}
        confirm="Entfernen"
        danger
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return
          try {
            await api(`/api/links/${removing.manualId}`, { method: 'DELETE' })
            say(`${removing.name} entfernt`)
          } catch (e) {
            say((e as Error).message, 'bad')
          }
        }}
      />
    </section>
  )
}

function TileGroup({ group, editing, saved, onSave, onDelete }: { group: ServiceGroup; editing: boolean; saved: Record<string, GridItem[]>; onSave: (bp: string, items: GridItem[]) => void; onDelete: (s: Service) => void }) {
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
        <span className="text-[11px] tracking-[.08em] text-muted uppercase">{group.name}</span>
        <span className="text-[11px] text-[#4a525e]">{group.note}</span>
      </div>
      <EditableGrid
        spec={spec}
        ssrBreakpoint="sm"
        items={group.items.map((s) => ({ i: s.key, node: <ServiceTile s={s} editing={editing} onDelete={s.manualId !== undefined ? () => onDelete(s) : undefined} /> }))}
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
    <section className="pt-[18px] pb-1.5" aria-label="Nächste Timer">
      <div className="flex items-baseline justify-between px-[18px] pb-2">
        <h2 className="h2">Nächste Timer</h2>
        <Link to="/units" search={{ filter: 'timer' }} className="btn sm">
          Alle
        </Link>
      </div>
      {timers.length === 0 && <p className="m-0 border-t border-line px-[18px] py-3 text-[13px] text-muted">Keine aktiven Timer.</p>}
      {timers.map((t) => {
        const svc = t.timer?.unit ? byService.get(t.timer.unit) : undefined
        return (
          <div key={t.name} className="flex items-center gap-[10px] border-t border-line px-[18px] py-[9px]">
            <Dot tone={svc?.active === 'failed' ? 'bad' : 'ok'} label={svc?.active === 'failed' ? 'letzter Lauf fehlgeschlagen' : 'ok'} />
            <div className="min-w-0 grow">
              <div className="truncate font-mono text-[13px]">{t.name}</div>
              <div className="text-[12px] text-muted">{calendarLabel(t.timer?.calendar)}</div>
            </div>
            <span className="font-mono text-[12px] text-subtle" suppressHydrationWarning>
              {relative(t.timer?.next)}
            </span>
          </div>
        )
      })}
    </section>
  )
}
