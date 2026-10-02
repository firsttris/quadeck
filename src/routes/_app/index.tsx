import { Link, createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { useActions } from '~/components/Actions'
import { AddLinkDialog } from '~/components/AddLinkDialog'
import { Gauge } from '~/components/Gauge'
import { Glyph } from '~/components/Glyph'
import { ConfirmDialog } from '~/components/Modal'
import { PageHeader } from '~/components/PageHeader'
import { ServiceTile } from '~/components/ServiceTile'
import { Sparkline } from '~/components/Sparkline'
import { Dot, Pill, unitTone, type Tone } from '~/components/Status'
import { useToast } from '~/components/Toast'
import { api } from '~/lib/api'
import { bytes, calendarLabel, diskSize, num, pct, rate, relative } from '~/lib/format'
import { useLive } from '~/lib/live'
import type { Container, Disk, Service, Snapshot, Unit } from '~/shared/types'
import { failureReason } from '~/shared/units'

export const Route = createFileRoute('/_app/')({
  component: Overview,
})

function Overview() {
  const { snapshot } = useLive()
  const failed = snapshot.units.filter((u) => u.active === 'failed')
  return (
    <>
      <PageHeader title="Übersicht" subtitle={`${snapshot.host.hostname} · live über Podman-Socket und D-Bus`} />
      {failed.map((u) => (
        <AlertCard key={u.name} unit={u} snapshot={snapshot} />
      ))}
      <div className="grid grid-cols-12 gap-4">
        <Gauges snapshot={snapshot} />
        <Storage disks={snapshot.disks} />
        <Containers containers={snapshot.containers} />
        <Services snapshot={snapshot} />
        <Timers units={snapshot.units} />
      </div>
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

function Gauges({ snapshot }: { snapshot: Snapshot }) {
  const [open, setOpen] = useState(false)
  const s = snapshot.system
  const h = snapshot.host
  const netMax = s?.net.speedMbps ? (s.net.speedMbps * 1e6) / 8 : 125e6
  const net = s ? Math.max(s.net.rx, s.net.tx) / netMax : 0
  const temp = s?.temp
  return (
    <section aria-label="Systemwerte" className="order-3 col-span-12 md:order-none">
      <button type="button" className="btn sm mb-3 md:hidden" aria-expanded={open} onClick={() => setOpen(!open)}>
        Kennzahlen {open ? 'einklappen' : 'anzeigen'}
      </button>
      <div className={`${open ? 'grid' : 'hidden'} grid-cols-1 gap-4 sm:grid-cols-2 md:grid xl:grid-cols-4`}>
        <Gauge id="cpu" label="CPU" p={s?.cpu ?? 0} value={s ? pct(s.cpu) : '–'} sub={`${h.cpuCores} Kerne · Load ${s ? num(s.load[0], 2) : '–'}`} />
        <Gauge id="ram" label="RAM" p={s ? s.memUsed / s.memTotal : 0} value={s ? bytes(s.memUsed) : '–'} sub={s ? `von ${bytes(s.memTotal, 0)}` : ''} />
        <Gauge id="temp" label="CPU-Temp" p={temp ? Math.min(1, Math.max(0, (temp.celsius - 30) / 60)) : 0} value={temp ? `${Math.round(temp.celsius)} °C` : '–'} sub={temp?.sensor ?? 'kein Sensor'} />
        <Gauge id="net" label="Netz" p={net} value={s ? `↓ ${rate(s.net.rx)}` : '–'} sub={s ? `↑ ${rate(s.net.tx)} · ${s.net.iface}${s.net.speedMbps ? ` · ${s.net.speedMbps >= 1000 ? `${s.net.speedMbps / 1000} GbE` : `${s.net.speedMbps} Mbit`}` : ''}` : ''} />
      </div>
    </section>
  )
}

// ---------- storage ----------

function Storage({ disks }: { disks: Disk[] }) {
  const total = disks.reduce((a, d) => a + d.size, 0)
  const used = disks.reduce((a, d) => a + d.used, 0)
  return (
    <section className="panel order-4 col-span-12 flex flex-col gap-[14px] p-[18px] md:order-none lg:col-span-5" aria-label="Speicher">
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

// ---------- containers ----------

function containerTone(c: Container): { tone: Tone; label: string } {
  if (c.state !== 'running') return { tone: c.state === 'exited' && c.status.match(/Exited \((?!0\))/) ? 'bad' : 'idle', label: c.state === 'exited' ? 'gestoppt' : c.state }
  if (c.health === 'unhealthy') return { tone: 'bad', label: 'unhealthy' }
  if (c.health === 'starting') return { tone: 'warn', label: 'startet' }
  return { tone: 'ok', label: c.health ?? 'running' }
}

function Containers({ containers }: { containers: Container[] }) {
  const { run, busy, readonly } = useActions()
  const { connected } = useLive()
  return (
    <section className="panel order-5 col-span-12 flex flex-col gap-2 pt-[18px] pr-1 pb-[10px] pl-1 md:order-none lg:col-span-7" aria-label="Container">
      <div className="flex items-baseline gap-3 px-[14px]">
        <h2 className="h2 grow">Container</h2>
        <span className={`live ${connected ? '' : 'off'}`}>{connected ? 'live' : 'getrennt'}</span>
      </div>
      {containers.length === 0 ? (
        <p className="m-0 px-[14px] text-[13px] text-muted">Keine Container gefunden.</p>
      ) : (
        <div className="relative overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th className="hidden sm:table-cell">CPU · 15 min</th>
                <th>RAM</th>
                <th className="hidden 2xl:table-cell">Unit</th>
                {!readonly && (
                  <th>
                    <span className="sr-only">Aktionen</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {containers.map((c) => {
                const st = containerTone(c)
                const target = { kind: 'container' as const, name: c.name, unit: c.unit }
                return (
                  <tr key={c.id} data-testid="container-row">
                    <td>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[13px] font-medium">{c.name}</span>
                        <span className={c.unit ? 'chip q' : 'chip'} title={c.unit ?? 'ohne Unit, Steuerung über die Podman-API'}>
                          {c.unit ? 'Quadlet' : 'Podman'}
                        </span>
                      </div>
                    </td>
                    <td>
                      <Pill tone={st.tone}>{st.label}</Pill>
                    </td>
                    <td className="hidden sm:table-cell">
                      <div className="flex items-center gap-2">
                        <Sparkline values={c.cpuHistory} />
                        <span className="w-12 font-mono text-[12px]">{c.cpu !== undefined ? `${num(c.cpu, c.cpu < 10 ? 1 : 0)} %` : '–'}</span>
                      </div>
                    </td>
                    <td className="font-mono text-[12px]">{bytes(c.memUsage)}</td>
                    <td className="hidden font-mono text-[11px] text-muted 2xl:table-cell">{c.unit ?? 'Podman-API'}</td>
                    {!readonly && (
                      <td>
                        <div className="flex justify-end gap-1.5">
                          {c.state === 'running' ? (
                            <>
                              <IconBtn label={`${c.name} neu starten`} glyph="restart" disabled={busy === c.name} onClick={() => run('restart', target)} />
                              <IconBtn label={`${c.name} stoppen`} glyph="stop" danger disabled={busy === c.name} onClick={() => run('stop', target)} />
                            </>
                          ) : (
                            <IconBtn label={`${c.name} starten`} glyph="start" disabled={busy === c.name} onClick={() => run('start', target)} />
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function IconBtn({ label, glyph, onClick, danger, disabled }: { label: string; glyph: string; onClick: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <button type="button" className={`btn sm ${danger ? 'danger' : ''} !px-2`} aria-label={label} title={label} onClick={onClick} disabled={disabled}>
      <Glyph name={glyph} size={14} />
    </button>
  )
}

// ---------- services ----------

function Services({ snapshot }: { snapshot: Snapshot }) {
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<Service | null>(null)
  const say = useToast()
  const groups = snapshot.services
  return (
    <section className="panel order-1 col-span-12 flex flex-col gap-[14px] p-[18px] md:order-none" aria-label="Services">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="h2">Services</h2>
        <span className="grow text-[12px] text-muted">automatisch aus Caddy und Quadlets erkannt</span>
        {!snapshot.readonly && (
          <button type="button" className="btn sm" onClick={() => setAdding(true)}>
            <Glyph name="plus" size={14} strokeWidth={2} />
            Link hinzufügen
          </button>
        )}
      </div>
      {groups.length === 0 && (
        <p className="m-0 text-[13px] text-muted">
          Noch keine Services. Quadeck liest die Routen aus Caddy (Admin-API oder /etc/caddy/Caddyfile); eigene Links lassen sich oben hinzufügen.
        </p>
      )}
      {groups.map((g) => (
        <div key={g.name} className="flex flex-col gap-[10px]">
          <div className="flex items-center gap-2">
            <span className="text-[11px] tracking-[.08em] text-muted uppercase">{g.name}</span>
            <span className="text-[11px] text-[#4a525e]">{g.note}</span>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            {g.items.map((s) => (
              <ServiceTile key={s.key} s={s} onDelete={s.manualId !== undefined && !snapshot.readonly ? () => setRemoving(s) : undefined} />
            ))}
          </div>
        </div>
      ))}
      <AddLinkDialog open={adding} onClose={() => setAdding(false)} groups={useMemo(() => groups.map((g) => g.name), [groups])} />
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

// ---------- timers ----------

function Timers({ units }: { units: Unit[] }) {
  const timers = units
    .filter((u) => u.name.endsWith('.timer') && u.active === 'active')
    .sort((a, b) => (a.timer?.next ?? Infinity) - (b.timer?.next ?? Infinity))
    .slice(0, 6)
  const byService = new Map(units.map((u) => [u.name, u]))
  return (
    <section className="panel order-6 col-span-12 pt-[18px] pb-1.5 md:order-none md:col-span-6 xl:col-span-4" aria-label="Nächste Timer">
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
