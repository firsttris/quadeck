// Overview widgets built from data Quadeck already has: updates, backups, one disk, the busiest
// containers and the latest notifications. Each keeps to a compact card with a link to its page.

import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { bytes, diskSize, pct, relative } from '~/lib/format'
import type { ImageUpdatesReport, PackageOverview, UpdatesReport } from '~/shared/packages'
import type { NotifyState } from '~/shared/notify'
import type { Snapshot } from '~/shared/types'
import { topContainers, type ContainersConfig, type DiskConfig, type LinksConfig, type ServiceConfig } from '~/shared/widgets'
import type { DeviceView } from '~/shared/devices'
import type { SpeedResult } from '~/shared/speedtest'
import type { SshState } from '~/shared/ssh'
import { api } from '~/lib/api'
import { actionBusyLabel, useActions } from './Actions'
import { BusyButton } from './Busy'
import { useToast } from './Toast'
import { m } from '~/paraglide/messages'
import { TrendLine } from './DiskUsage'
import { useJobs } from './Jobs'
import { Dot, Pill } from './Status'

function Head({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 pr-16">
      <h2 className="h2 min-w-0 grow truncate">{title}</h2>
      {children}
    </div>
  )
}

/** GET JSON, again whenever a job ends (and every `everyMs` if given). */
function useJson<T>(url: string, everyMs?: number) {
  const { finished } = useJobs()
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let stop = false
    const load = () =>
      fetch(url)
        .then(async (r) => {
          const d = (await r.json()) as T & { error?: string }
          if (!r.ok) throw new Error(d.error ?? m.common_http({ status: r.status }))
          if (!stop) (setData(d), setError(''))
        })
        .catch((e: Error) => !stop && setError(e.message))
    void load()
    const t = everyMs ? setInterval(() => document.visibilityState === 'visible' && void load(), everyMs) : undefined
    return () => {
      stop = true
      clearInterval(t)
    }
  }, [url, finished, everyMs])
  return { data, error }
}

// ---------- updates ----------

export function UpdatesWidget() {
  const overview = useJson<PackageOverview>('/api/system/overview')
  const updates = useJson<UpdatesReport>('/api/system/updates')
  const images = useJson<ImageUpdatesReport>('/api/system/images')
  const o = overview.data
  const u = updates.data
  const pendingImages = (images.data?.items ?? []).filter((i) => i.updated === 'pending').length
  const repo = u?.repo.length ?? 0
  return (
    <section className="flex flex-col gap-2 p-[18px]" aria-label={m.widgets_updates_name()} data-testid="updates-widget">
      <Head title={m.widgets_updates_name()}>{o?.rebootRequired && <Pill tone="warn">{m.widgets_updates_reboot()}</Pill>}</Head>
      {o && !o.manager ? (
        <p className="m-0 text-[13px] text-muted">{m.widgets_updates_noManager()}</p>
      ) : !u ? (
        <p className="m-0 text-[13px] text-muted">{updates.error || m.widgets_updates_checking()}</p>
      ) : (
        <>
          <div className="flex items-baseline gap-2">
            <span className="text-[26px] leading-none font-semibold tabular-nums">{repo}</span>
            <span className="text-[13px] text-muted">{repo === 0 ? m.widgets_updates_upToDate() : m.widgets_updates_packages()}</span>
          </div>
          <div className="flex flex-wrap justify-between gap-x-3 text-[12.5px]">
            <span>
              {[o?.aur?.helper ? m.widgets_updates_aur({ n: u.aur.length }) : '', m.widgets_updates_images({ n: pendingImages })].filter(Boolean).join(' · ')}
            </span>
            <span className="text-muted" suppressHydrationWarning>
              {m.widgets_updates_checked({ when: relative(u.checkedAt) })}
            </span>
          </div>
          {repo > 0 && <div className="truncate text-[12px] text-muted">{u.repo.slice(0, 6).map((p) => p.name).join(', ')}{repo > 6 ? ' …' : ''}</div>}
        </>
      )}
      <Link to="/system" className="btn sm no-drag self-start">
        {m.widgets_updates_open()}
      </Link>
    </section>
  )
}

// ---------- backups ----------

export function BackupsWidget({ backup }: { backup: Snapshot['backup'] }) {
  const tone = backup?.lastStatus === 'ok' ? 'ok' : backup?.lastStatus === 'warning' ? 'warn' : backup?.lastStatus === 'failed' ? 'bad' : 'idle'
  const stale = backup?.stale ?? []
  return (
    <section className="flex flex-col gap-2 p-[18px]" aria-label={m.widgets_backups_name()} data-testid="backups-widget">
      <Head title={m.widgets_backups_name()} />
      {!backup?.server && !stale.length ? (
        <p className="m-0 text-[13px] text-muted">{m.widgets_backups_none()}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[13px]">
          {backup?.server && (
            <li className="flex items-center gap-2">
              <Dot tone={tone} />
              <span className="grow">{m.widgets_backups_server()}</span>
              <span className={backup.lastStatus === 'failed' ? 'text-[#ff7b72]' : 'text-muted'} suppressHydrationWarning>
                {backup.lastAt ? relative(backup.lastAt) : m.widgets_backups_never()}
              </span>
            </li>
          )}
          {backup?.server && backup.lastStatus === 'failed' && backup.lastOkAt && (
            <li className="pl-4 text-[12px] text-muted" suppressHydrationWarning>
              {m.widgets_backups_lastOk({ when: relative(backup.lastOkAt) })}
            </li>
          )}
          {stale.map((c) => (
            <li key={c.name} className="flex items-center gap-2">
              <Dot tone="bad" />
              <span className="grow truncate">{m.widgets_backups_client({ name: c.name })}</span>
              <span className="text-[#ff7b72]">{c.never ? m.widgets_backups_never() : m.widgets_backups_days({ n: c.days })}</span>
            </li>
          ))}
        </ul>
      )}
      <Link to="/backups" className="btn sm no-drag self-start">
        {m.widgets_backups_open()}
      </Link>
    </section>
  )
}

// ---------- one disk ----------

const SMART_TONE = { ok: 'ok', warning: 'warn', critical: 'bad' } as const

export function DiskWidget({ config, snapshot }: { config: DiskConfig; snapshot: Snapshot }) {
  const d = snapshot.disks.find((x) => x.mount === config.mount)
  const title = config.mount ? m.widgets_disk_title({ mount: config.mount }) : m.widgets_disk_name()
  if (!d)
    return (
      <section className="flex flex-col gap-2 p-[18px]" aria-label={title} data-testid="disk-widget">
        <Head title={title} />
        <p className="m-0 text-[13px] text-muted">{config.mount ? m.widgets_disk_missing() : m.widgets_disk_choose()}</p>
      </section>
    )
  const used = d.size ? d.used / d.size : 0
  const smart = (snapshot.smart ?? []).find((s) => (d.disks ?? [d.dev]).includes(s.name) && s.supported && !s.standby)
  const bad = used >= 0.9 || (d.trend?.fullInDays !== undefined && d.trend.fullInDays <= 14)
  return (
    <section className="flex flex-col gap-2 p-[18px]" aria-label={title} data-testid="disk-widget">
      <Head title={title} />
      <div className="flex flex-wrap items-center justify-between gap-x-3 text-[12.5px]">
        <span className="flex items-center gap-1.5 text-subtle">
          {smart && <Dot tone={SMART_TONE[smart.level]} label={{ ok: m.overview_storage_smartOk(), warning: m.overview_storage_smartWarning(), critical: m.overview_storage_smartCritical() }[smart.level]} />}
          <span className="font-mono">{d.dev}</span> · {d.fstype}
          {d.tempC !== undefined ? ` · ${Math.round(d.tempC)} °C` : ''}
        </span>
        <span className={bad ? 'text-[#ff7b72]' : undefined}>{m.disks_usage_of({ used: diskSize(d.used), size: diskSize(d.size), pct: pct(used) })}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-[5px] bg-[#1c2430]" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(used * 100)} aria-label={d.mount}>
        <div className={`h-full rounded-[5px] ${bad ? 'bg-[#f85149]' : used >= 0.85 ? 'bg-[#d29922]' : 'bg-accent'}`} style={{ width: `${Math.min(100, used * 100)}%` }} />
      </div>
      <TrendLine trend={d.trend} bad={bad} />
    </section>
  )
}

// ---------- busiest containers ----------

export function ContainersWidget({ config, containers }: { config: ContainersConfig; containers: Snapshot['containers'] }) {
  const top = topContainers(containers, config.metric)
  const value = (c: (typeof top)[number]) => (config.metric === 'cpu' ? (c.cpu ?? 0) : (c.memUsage ?? 0))
  const max = Math.max(...top.map(value), config.metric === 'cpu' ? 1 : 1)
  const title = config.metric === 'cpu' ? m.widgets_containers_titleCpu() : m.widgets_containers_titleRam()
  return (
    <section className="flex flex-col gap-1.5 p-[18px]" aria-label={title} data-testid="containers-widget">
      <Head title={title} />
      {top.length === 0 && <p className="m-0 text-[13px] text-muted">{m.widgets_containers_none()}</p>}
      {top.map((c) => (
        <div key={c.name} className="flex flex-col gap-1">
          <div className="flex justify-between gap-2 text-[12.5px]">
            <span className="truncate font-mono text-[12px]">{c.name}</span>
            <span className="tabular-nums">{config.metric === 'cpu' ? pct((c.cpu ?? 0) / 100, 1) : bytes(c.memUsage)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-[4px] bg-[#1c2430]">
            <div className="h-full rounded-[4px] bg-accent" style={{ width: `${(value(c) / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </section>
  )
}

// ---------- notifications ----------

export function AlertsWidget() {
  const state = useJson<NotifyState>('/api/notifications', 60_000)
  const s = state.data
  const recent = (s?.log ?? []).filter((n) => !n.test).slice(-5).reverse()
  return (
    <section className="flex flex-col gap-2 p-[18px]" aria-label={m.widgets_alerts_name()} data-testid="alerts-widget">
      <Head title={m.widgets_alerts_name()}>{!!s?.active.length && <Pill tone="bad">{m.widgets_alerts_open({ n: s.active.length })}</Pill>}</Head>
      {!s ? (
        <p className="m-0 text-[13px] text-muted">{state.error || m.common_loading()}</p>
      ) : recent.length === 0 ? (
        <p className="m-0 text-[13px] text-muted">{m.widgets_alerts_none()}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[13px]">
          {recent.map((n) => (
            <li key={`${n.ts}-${n.title}`} className="flex items-baseline gap-2">
              <Dot tone={n.severity === 'critical' ? 'bad' : n.severity === 'warning' ? 'warn' : n.severity === 'ok' ? 'ok' : 'idle'} />
              <span className="min-w-0 grow truncate" title={n.body}>
                {n.title}
              </span>
              <span className="shrink-0 text-[12px] text-muted" suppressHydrationWarning>
                {relative(n.ts)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <Link to="/notifications" className="btn sm no-drag self-start">
        {m.widgets_alerts_openPage()}
      </Link>
    </section>
  )
}

// ---------- one service ----------

export function ServiceWidget({ config, snapshot }: { config: ServiceConfig; snapshot: Snapshot }) {
  const { run, busy, busyAction, readonly } = useActions()
  const unit = snapshot.units.find((u) => u.name === config.unit)
  const container = snapshot.containers.find((c) => c.unit === config.unit)
  const title = config.unit ? config.unit.replace(/\.service$/, '') : m.widgets_service_name()
  if (!unit)
    return (
      <section className="flex flex-col gap-2 p-[18px]" aria-label={title} data-testid="service-widget">
        <Head title={title} />
        <p className="m-0 text-[13px] text-muted">{config.unit ? m.widgets_service_missing() : m.widgets_service_choose()}</p>
      </section>
    )
  const tone = unit.active === 'active' ? 'ok' : unit.active === 'failed' ? 'bad' : unit.active === 'activating' || unit.active === 'deactivating' ? 'warn' : 'idle'
  const running = unit.active === 'active' || unit.active === 'activating'
  const act = (a: 'start' | 'stop' | 'restart') => run(a, { kind: 'unit', name: unit.name })
  return (
    <section className="flex flex-col gap-2 p-[18px]" aria-label={title} data-testid="service-widget">
      <Head title={title} />
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <Dot tone={tone} />
        <span>
          {unit.active} · {unit.sub}
        </span>
        <span className="text-muted" suppressHydrationWarning>
          {unit.since ? `· ${relative(unit.since)}` : ''}
        </span>
      </div>
      {unit.description && unit.description !== unit.name && <div className="truncate text-[12px] text-muted">{unit.description}</div>}
      {container && (
        <div className="flex gap-3 text-[12.5px] text-subtle">
          <span>CPU {pct((container.cpu ?? 0) / 100, 1)}</span>
          <span>RAM {bytes(container.memUsage)}</span>
          {container.health && <span>{container.health}</span>}
        </div>
      )}
      {!readonly && (
        <div className="flex flex-wrap gap-1.5">
          {!running && (
            <BusyButton className="btn sm no-drag" busy={busy === unit.name && busyAction === 'start'} busyLabel={actionBusyLabel('start')} disabled={!!busy} onClick={() => void act('start')}>
              {m.common_start()}
            </BusyButton>
          )}
          {running && (
            <BusyButton className="btn sm no-drag" busy={busy === unit.name && busyAction === 'restart'} busyLabel={actionBusyLabel('restart')} disabled={!!busy} onClick={() => void act('restart')}>
              {m.common_restart()}
            </BusyButton>
          )}
          {running && (
            <BusyButton className="btn sm no-drag" busy={busy === unit.name && busyAction === 'stop'} busyLabel={actionBusyLabel('stop')} disabled={!!busy} onClick={() => void act('stop')}>
              {m.common_stop()}
            </BusyButton>
          )}
          <Link to="/journal" search={{ unit: unit.name }} className="btn sm no-drag">
            {m.widgets_service_journal()}
          </Link>
        </div>
      )}
    </section>
  )
}

// ---------- devices in the LAN ----------

export function DevicesWidget({ fresh }: { fresh: NonNullable<Snapshot['devices']>['fresh'] }) {
  const state = useJson<{ devices: DeviceView[] }>('/api/network/devices', 60_000)
  const say = useToast()
  const [waking, setWaking] = useState<string | null>(null)
  const list = (state.data?.devices ?? []).filter((d) => !d.self)
  const online = list.filter((d) => d.online).length
  // devices the admin named and that can be woken: offline ones with a MAC
  const sleepers = list.filter((d) => !d.online && d.mac && d.label).slice(0, 4)
  const wake = async (d: DeviceView) => {
    setWaking(d.key)
    try {
      await api('/api/network/devices', { body: { action: 'wake', mac: d.mac } })
      say(m.devices_woken({ name: d.label ?? d.ip }))
    } catch (e) {
      say((e as Error).message, 'bad')
    } finally {
      setWaking(null)
    }
  }
  return (
    <section className="flex flex-col gap-2 p-[18px]" aria-label={m.widgets_devices_name()} data-testid="devices-widget">
      <Head title={m.widgets_devices_name()}>{fresh.length > 0 && <Pill tone="warn">{m.widgets_devices_new({ n: fresh.length })}</Pill>}</Head>
      {!state.data ? (
        <p className="m-0 text-[13px] text-muted">{state.error || m.common_loading()}</p>
      ) : (
        <>
          <div className="flex items-baseline gap-2">
            <span className="text-[26px] leading-none font-semibold tabular-nums">{online}</span>
            <span className="text-[13px] text-muted">{m.widgets_devices_online({ n: list.length })}</span>
          </div>
          {fresh.slice(0, 3).map((d) => (
            <div key={d.key} className="truncate text-[12.5px] text-[#e3b341]">
              {m.widgets_devices_freshOne({ name: d.name ?? d.vendor ?? d.ip, ip: d.ip })}
            </div>
          ))}
          {sleepers.map((d) => (
            <div key={d.key} className="flex items-center gap-2 text-[12.5px]">
              <Dot tone="idle" />
              <span className="grow truncate">{d.label}</span>
              <BusyButton className="btn sm no-drag" busy={waking === d.key} busyLabel={m.common_working()} disabled={!!waking} onClick={() => void wake(d)} aria-label={m.widgets_devices_wakeNamed({ name: d.label! })}>
                {m.widgets_devices_wake()}
              </BusyButton>
            </div>
          ))}
        </>
      )}
      <Link to="/network" search={{ tab: 'devices' }} className="btn sm no-drag self-start">
        {m.widgets_devices_open()}
      </Link>
    </section>
  )
}

// ---------- speed test ----------

export function SpeedWidget() {
  const state = useJson<{ history: SpeedResult[] }>('/api/speedtest', 5 * 60_000)
  // the history is newest first
  const internet = (state.data?.history ?? []).filter((r) => r.kind === 'internet')
  const last = internet[0]
  const recent = internet
    .slice(0, 12)
    .reverse()
    .map((r) => r.down)
  const max = Math.max(...recent, 1)
  return (
    <section className="flex flex-col gap-2 p-[18px]" aria-label={m.widgets_speed_name()} data-testid="speed-widget">
      <Head title={m.widgets_speed_name()} />
      {!state.data ? (
        <p className="m-0 text-[13px] text-muted">{state.error || m.common_loading()}</p>
      ) : !last ? (
        <p className="m-0 text-[13px] text-muted">{m.widgets_speed_none()}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span>
              <span className="text-[22px] font-semibold tabular-nums">↓ {last.down}</span> <span className="text-[12px] text-muted">Mbit/s</span>
            </span>
            <span>
              <span className="text-[16px] tabular-nums">↑ {last.up}</span> <span className="text-[12px] text-muted">Mbit/s</span>
            </span>
            <span className="text-[12px] text-muted">{m.widgets_speed_ping({ ms: Math.round(last.ping) })}</span>
          </div>
          {recent.length > 1 && (
            <div className="flex h-8 items-end gap-[3px]" aria-hidden="true">
              {recent.map((v, i) => (
                <div key={i} className="grow rounded-t-[2px] bg-accent opacity-70" style={{ height: `${Math.max(8, (v / max) * 100)}%` }} />
              ))}
            </div>
          )}
          <span className="text-[12px] text-muted" suppressHydrationWarning>
            {m.widgets_speed_at({ when: relative(last.at) })}
          </span>
        </>
      )}
      <Link to="/network" search={{ tab: 'speed' }} className="btn sm no-drag self-start">
        {m.widgets_speed_open()}
      </Link>
    </section>
  )
}

// ---------- logins ----------

export function LoginsWidget() {
  const state = useJson<SshState>('/api/ssh', 2 * 60_000)
  const s = state.data
  const logins = [...(s?.logins ?? [])].sort((a, b) => b.ts - a.ts).slice(0, 5)
  const failed = (s?.failed ?? []).reduce((a, f) => a + f.count, 0)
  return (
    <section className="flex flex-col gap-2 p-[18px]" aria-label={m.widgets_logins_name()} data-testid="logins-widget">
      <Head title={m.widgets_logins_name()}>{failed > 0 && <Pill tone="warn">{m.widgets_logins_failed({ n: failed })}</Pill>}</Head>
      {!s ? (
        <p className="m-0 text-[13px] text-muted">{state.error || m.common_loading()}</p>
      ) : !s.installed ? (
        <p className="m-0 text-[13px] text-muted">{m.widgets_logins_noSsh()}</p>
      ) : logins.length === 0 ? (
        <p className="m-0 text-[13px] text-muted">{m.widgets_logins_none()}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[13px]">
          {logins.map((l) => (
            <li key={`${l.ts}-${l.from}-${l.port ?? ''}`} className="flex items-baseline gap-2">
              <Dot tone={l.active ? 'ok' : 'idle'} />
              <span className="min-w-0 grow truncate">
                <b className="font-medium">{l.user}</b> <span className="font-mono text-[12px] text-muted">{l.from}</span>
              </span>
              <span className="shrink-0 text-[12px] text-muted" suppressHydrationWarning>
                {l.active ? m.widgets_logins_active() : relative(l.ts)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <Link to="/ssh" className="btn sm no-drag self-start">
        {m.widgets_logins_open()}
      </Link>
    </section>
  )
}

// ---------- link group ----------

export function LinksWidget({ config }: { config: LinksConfig }) {
  const title = config.title || m.widgets_links_name()
  return (
    <section className="flex flex-col gap-2 p-[18px]" aria-label={title} data-testid="links-widget">
      <Head title={title} />
      {config.links.length === 0 ? (
        <p className="m-0 text-[13px] text-muted">{m.widgets_links_empty()}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]">
          {config.links.map((l, i) => (
            <li key={i} className="min-w-0">
              <a href={l.url} target="_blank" rel="noreferrer noopener" className="no-drag flex items-baseline gap-2 rounded-[6px] px-1 py-0.5 hover:bg-[#161c24]">
                <span className="truncate">{l.name}</span>
                <span className="min-w-0 truncate font-mono text-[11px] text-muted">{l.url.replace(/^https?:\/\//, '')}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
