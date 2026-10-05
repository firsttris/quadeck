import { useCallback, useMemo, useState } from 'react'
import { api } from '~/lib/api'
import { relative } from '~/lib/format'
import { serviceLabels, type DeviceView, type ScanResult } from '~/shared/devices'
import { useActions } from './Actions'
import { BusyButton, useBusy } from './Busy'
import { Modal } from './Modal'
import { Dot } from './Status'
import { useToast } from './Toast'
import { m } from '~/paraglide/messages'
import { usePolling } from '~/lib/polling'

type SweepMinutes = 0 | 15 | 30 | 60 | 360
interface View {
  devices: DeviceView[]
  scan?: ScanResult
  settings: { sweepMinutes: SweepMinutes }
  sweptAt?: number
  since?: number
}
type Filter = 'all' | 'online' | 'new'

const SWEEPS: SweepMinutes[] = [0, 15, 30, 60, 360]
const sweepLabel = (n: SweepMinutes) => (n === 0 ? m.devices_sweep_off() : n < 60 ? m.devices_sweep_min({ n }) : m.devices_sweep_hours({ n: n / 60 }))
const isNew = (d: DeviceView, since: number | undefined) => since !== undefined && !d.known && !d.label && !d.self && d.firstSeen > since
const title = (d: DeviceView) => d.label ?? d.name ?? d.vendor ?? d.ip

/** Network → Devices: who is in the LAN, under which name, since when. */
export function Devices() {
  const say = useToast()
  const [view, setView] = useState<View | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setView(await api<View>('/api/network/devices', { method: 'GET' }))
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  usePolling(load, 60_000)

  const post = async (body: Record<string, unknown>) => {
    try {
      const v = await api<View>('/api/network/devices', { body })
      setView(v)
      return v
    } catch (e) {
      say((e as Error).message, 'bad')
      return undefined
    }
  }
  const scan = async () => {
    setBusy(true)
    const v = await post({ action: 'scan' })
    setBusy(false)
    if (v) say(m.devices_scanned({ n: v.devices.filter((d) => d.online).length }))
  }

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (view?.devices ?? []).filter((d) => {
      if (filter === 'online' && !d.online) return false
      if (filter === 'new' && !isNew(d, view?.since)) return false
      if (!q) return true
      return [d.label, d.name, d.vendor, d.ip, d.mac, d.note, ...serviceLabels(d.services)].some((x) => x?.toLowerCase().includes(q))
    })
  }, [view, filter, query])

  if (!view) return error ? <p className="m-0 text-[13px] text-[#e3b341]">{error}</p> : <p className="m-0 text-muted">{m.network_loading()}</p>
  const online = view.devices.filter((d) => d.online).length
  const fresh = view.devices.filter((d) => isNew(d, view.since)).length
  const current = view.devices.find((d) => d.key === open)
  const missing = view.scan?.missing ?? []

  return (
    <section className="panel relative flex flex-col overflow-x-auto" aria-label={m.devices_title()}>
      <div className="flex flex-wrap items-center gap-3 px-[18px] pt-[18px] pb-2">
        <div className="flex grow flex-col gap-0.5">
          <h2 className="h2">{m.devices_title()}</h2>
          <span className="text-[12px] text-muted">
            {view.scan?.subnets.length ? m.devices_subnets({ subnets: view.scan.subnets.join(', ') }) : m.devices_noSubnet()}
            {view.sweptAt ? ` · ${m.devices_lastSweep({ when: relative(view.sweptAt) })}` : ''}
          </span>
        </div>
        <label className="flex items-center gap-2 text-[12px] text-muted">
          {m.devices_sweep()}
          <select
            className="field sm"
            value={view.settings.sweepMinutes}
            onChange={(e) =>
              void post({
                action: 'settings',
                sweepMinutes: Number(e.target.value),
              })
            }
          >
            {SWEEPS.map((n) => (
              <option key={n} value={n}>
                {sweepLabel(n)}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn primary sm" disabled={busy} onClick={() => void scan()}>
          {busy ? m.devices_scanning() : m.devices_scan()}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2 px-[18px] pb-3">
        <div role="group" aria-label={m.devices_filter()} className="flex gap-1.5">
          {(
            [
              ['all', m.devices_filter_all(), view.devices.length],
              ['online', m.devices_filter_online(), online],
              ['new', m.devices_filter_new(), fresh],
            ] as const
          ).map(([k, label, n]) => (
            <button key={k} type="button" className={`seg ${filter === k ? 'on' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>
              {label}
              <span className="opacity-60">{n}</span>
            </button>
          ))}
        </div>
        <span className="grow" />
        <input className="field sm w-56" type="search" placeholder={m.devices_search()} aria-label={m.devices_search()} value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {missing.length > 0 && (
        <p className="m-0 px-[18px] pb-3 text-[12px] text-muted">
          {missing.includes('ping')
            ? m.devices_missing_ping()
            : m.devices_missing({
                tools: missing.map((t) => (t === 'avahi-browse' ? 'avahi-utils' : t)).join(', '),
              })}
        </p>
      )}
      <table className="tbl">
        <thead>
          <tr>
            <th>{m.devices_col_device()}</th>
            <th>{m.devices_col_ip()}</th>
            <th>{m.devices_col_mac()}</th>
            <th>{m.devices_col_services()}</th>
            <th>{m.devices_col_seen()}</th>
            <th>
              <span className="sr-only">{m.devices_col_actions()}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {list.length === 0 && (
            <tr>
              <td colSpan={6} className="text-muted">
                {view.devices.length ? m.devices_noMatch() : m.devices_none()}
              </td>
            </tr>
          )}
          {list.map((d) => (
            <tr key={d.key} data-testid="device-row">
              <td>
                <div className="flex items-center gap-2">
                  <Dot tone={d.online ? 'ok' : 'idle'} label={d.online ? m.devices_online() : m.devices_offline()} />
                  <div className="flex min-w-0 flex-col">
                    <span className="flex flex-wrap items-center gap-1.5 font-medium">
                      {title(d)}
                      {d.self && <span className="pill">{m.devices_self()}</span>}
                      {isNew(d, view.since) && <span className="pill warn">{m.devices_new()}</span>}
                      {d.known && <span className="text-[11px] text-subtle">✓ {m.devices_known()}</span>}
                    </span>
                    <span className="text-[12px] text-muted">{[d.label && d.name !== d.label ? d.name : undefined, d.vendor].filter(Boolean).join(' · ')}</span>
                  </div>
                </div>
              </td>
              <td className="font-mono text-[13px]">
                {d.ip}
                {d.online && d.rtt !== undefined && (
                  <span className="block text-[11px] text-subtle">
                    {m.devices_rtt({
                      ms: d.rtt < 10 ? d.rtt.toFixed(1) : String(Math.round(d.rtt)),
                    })}
                  </span>
                )}
              </td>
              <td className="font-mono text-[12px]">
                {d.mac ?? '–'}
                {d.randomMac && (
                  <span className="block font-sans text-[11px] text-subtle" title={m.devices_randomMacHelp()}>
                    {m.devices_randomMac()}
                  </span>
                )}
              </td>
              <td>
                <div className="flex flex-wrap gap-1">
                  {serviceLabels(d.services).map((s) => (
                    <span key={s} className="pill">
                      {s}
                    </span>
                  ))}
                </div>
              </td>
              <td className="text-[12px] whitespace-nowrap">
                {d.online ? m.devices_online() : relative(d.lastSeen)}
                <span className="block text-subtle">{m.devices_firstSeen({ when: relative(d.firstSeen) })}</span>
              </td>
              <td className="text-right">
                <button type="button" className="btn sm" onClick={() => setOpen(d.key)} aria-label={m.devices_detailsFor({ name: title(d) })}>
                  {m.devices_details()}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {current && <DeviceDialog d={current} onClose={() => setOpen(null)} post={post} />}
    </section>
  )
}

function DeviceDialog({ d, onClose, post }: { d: DeviceView; onClose: () => void; post: (b: Record<string, unknown>) => Promise<View | undefined> }) {
  const say = useToast()
  const { readonly } = useActions()
  const [label, setLabel] = useState(d.label ?? '')
  const [note, setNote] = useState(d.note ?? '')
  const [known, setKnown] = useState(!!d.known)
  const [ports, setPorts] = useState<{ port: number; name: string; open: boolean }[] | null>(null)
  const [checking, setChecking] = useState(false)
  const work = useBusy<'save' | 'forget' | 'wake'>()
  const closing = work.is('save') || work.is('forget')

  const save = () =>
    work.run('save', async () => {
      if (await post({ action: 'edit', key: d.key, label, note, known })) {
        say(m.devices_saved({ name: label || title(d) }))
        onClose()
      }
    })
  const forget = () =>
    work.run('forget', async () => {
      if (await post({ action: 'forget', key: d.key })) {
        say(m.devices_forgotten({ name: title(d) }))
        onClose()
      }
    })
  const checkPorts = async () => {
    setChecking(true)
    try {
      setPorts((await api<{ ports: { port: number; name: string; open: boolean }[] }>('/api/network/devices', { body: { action: 'ports', ip: d.ip } })).ports)
    } catch (e) {
      say((e as Error).message, 'bad')
    } finally {
      setChecking(false)
    }
  }
  const wake = () =>
    work.run('wake', async () => {
      try {
        await api('/api/network/devices', {
          body: { action: 'wake', mac: d.mac },
        })
        say(m.devices_woken({ name: title(d) }))
      } catch (e) {
        say((e as Error).message, 'bad')
      }
    })
  const open = ports?.filter((p) => p.open) ?? []

  return (
    <Modal open title={title(d)} onClose={onClose} busy={closing}>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
        <dt className="text-muted">{m.devices_col_ip()}</dt>
        <dd className="m-0 font-mono">{d.ip}</dd>
        <dt className="text-muted">{m.devices_col_mac()}</dt>
        <dd className="m-0 font-mono">{d.mac ?? '–'}</dd>
        {d.name && (
          <>
            <dt className="text-muted">{m.devices_hostname()}</dt>
            <dd className="m-0">{d.name}</dd>
          </>
        )}
        {d.vendor && (
          <>
            <dt className="text-muted">{m.devices_vendor()}</dt>
            <dd className="m-0">{d.vendor}</dd>
          </>
        )}
        <dt className="text-muted">{m.devices_col_seen()}</dt>
        <dd className="m-0">
          {d.online ? m.devices_online() : relative(d.lastSeen)} · {m.devices_firstSeen({ when: relative(d.firstSeen) })}
        </dd>
        {d.services.length > 0 && (
          <>
            <dt className="text-muted">{m.devices_col_services()}</dt>
            <dd className="m-0 font-mono text-[12px]">{d.services.join(' ')}</dd>
          </>
        )}
      </dl>
      {d.randomMac && <p className="m-0 text-[12px] text-muted">{m.devices_randomMacHelp()}</p>}
      <label className="flex flex-col gap-1.5 text-[13px]">
        {m.devices_label()}
        <input className="field" value={label} maxLength={60} placeholder={d.name ?? ''} onChange={(e) => setLabel(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1.5 text-[13px]">
        {m.devices_note()}
        <textarea className="field" rows={2} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </label>
      <label className="flex items-start gap-2 text-[13px]">
        <input type="checkbox" className="mt-0.5" checked={known} onChange={(e) => setKnown(e.target.checked)} />
        <span>
          {m.devices_markKnown()}
          <span className="block text-[12px] text-muted">{m.devices_markKnownHelp()}</span>
        </span>
      </label>
      <div className="flex flex-col gap-2 border-t border-line pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="grow text-[13px]">{m.devices_ports()}</span>
          <button type="button" className="btn sm" disabled={checking} onClick={() => void checkPorts()}>
            {checking ? m.devices_portsChecking() : m.devices_portsCheck()}
          </button>
          {d.mac && !d.self && !readonly && (
            <BusyButton className="btn sm" busy={work.is('wake')} busyLabel={m.common_working()} disabled={work.busy !== null} onClick={() => void wake()}>
              {m.devices_wake()}
            </BusyButton>
          )}
        </div>
        {ports && open.length === 0 && <p className="m-0 text-[12px] text-muted">{m.devices_portsNone()}</p>}
        {open.length > 0 && (
          <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label={m.devices_portsOpen()}>
            {open.map((p) => (
              <li key={p.port} className="pill ok">
                {p.port} {p.name}
              </li>
            ))}
          </ul>
        )}
        <p className="m-0 text-[12px] text-muted">{m.devices_portsHelp()}</p>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        {!d.self && (
          <BusyButton className="btn danger" busy={work.is('forget')} busyLabel={m.common_deleting()} disabled={work.busy !== null} onClick={() => void forget()}>
            {m.devices_forget()}
          </BusyButton>
        )}
        <span className="grow" />
        <button type="button" className="btn" disabled={closing} onClick={onClose}>
          {m.common_cancel()}
        </button>
        <BusyButton className="btn primary" busy={work.is('save')} busyLabel={m.common_saving()} disabled={work.busy !== null} onClick={() => void save()}>
          {m.common_save()}
        </BusyButton>
      </div>
    </Modal>
  )
}
