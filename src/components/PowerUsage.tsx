import { Link } from '@tanstack/react-router'
import { useCallback, useState } from 'react'
import { api } from '~/lib/api'
import { num } from '~/lib/format'
import { COMPONENTS, sumSplit, type Component, type DiskKind, type EnergySettings, type HourEnergy, type PowerNow } from '~/shared/energy'
import { localeOf } from '~/shared/i18n'
import { BusyButton, useBusy } from './Busy'
import { Modal } from './Modal'
import { useToast } from './Toast'
import { m } from '~/paraglide/messages'
import { pickMsg } from '~/i18n'
import { usePolling } from '~/lib/polling'

interface Report {
  now?: PowerNow
  settings: EnergySettings
  hours: HourEnergy[]
  days: HourEnergy[]
  months: HourEnergy[]
  today: number
  month: { kwh: number; projected: number }
  year?: number
  dayAverage?: number
  standbyToday: Record<string, number>
  standbySavings?: number
  since?: number
}
type Range = '24h' | '7d' | '30d' | '12m'

const COLOR: Record<Component, string> = { cpu: 'var(--color-accent)', gpu: 'var(--color-accent-2)', disks: '#d29922', rest: 'var(--color-faint)' }
const label = (c: Component) => pickMsg({ cpu: m.energy_cpu, gpu: m.energy_gpu, disks: m.energy_disks, rest: m.energy_rest }, c)
const kindLabel = (k: DiskKind) => pickMsg({ hdd: m.energy_kind_hdd, ssd: m.energy_kind_ssd, nvme: m.energy_kind_nvme }, k)
const w = (v: number) => `${num(v, v < 10 ? 1 : 0)} W`
const kwhText = (v: number) => `${num(v, v < 10 ? 2 : v < 100 ? 1 : 0)} kWh`
const euro = (v: number) => new Intl.NumberFormat(localeOf(), { style: 'currency', currency: 'EUR' }).format(v)

function Badge({ measured }: { measured: boolean }) {
  return measured ? <span className="pill ok">{m.energy_measured()}</span> : <span className="pill warn">{m.energy_estimated()}</span>
}

/** Hardware → Power: what the server draws now, per component, and what it used over time. */
export function PowerUsage() {
  const [r, setR] = useState<Report | null>(null)
  const [error, setError] = useState('')
  const [range, setRange] = useState<Range>('30d')
  const [editing, setEditing] = useState(false)

  const load = useCallback(async () => {
    try {
      setR(await api<Report>('/api/power', { method: 'GET' }))
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  usePolling(load, 30_000)

  if (error) return <p className="m-0 text-[13px] text-[#e3b341]">{error}</p>
  if (!r) return <p className="m-0 text-muted">{m.energy_loading()}</p>
  const p = r.now
  const price = r.settings.price
  const bars = range === '24h' ? r.hours : range === '7d' ? r.days.slice(-7) : range === '30d' ? r.days : r.months
  const unitWh = range === '24h'
  const peak = bars.length ? bars.reduce((a, b) => (sumSplit(b) > sumSplit(a) ? b : a)) : undefined
  const max = Math.max(1, ...bars.map(sumSplit))
  const when = (ts: number) =>
    range === '24h' ? new Date(ts).toLocaleTimeString(localeOf(), { hour: '2-digit', minute: '2-digit' }) : range === '12m' ? new Date(ts).toLocaleDateString(localeOf(), { month: 'long', year: 'numeric' }) : new Date(ts).toLocaleDateString(localeOf(), { day: 'numeric', month: 'short' })
  const amount = (wh: number) => (unitWh ? `${num(wh, 0)} Wh` : kwhText(wh / 1000))

  return (
    <>
      <section className="panel flex flex-col gap-4 p-[18px]" aria-label={m.energy_now()}>
        <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
          <div className="flex flex-col">
            <span className="label-caps">{m.energy_nowEstimated()}</span>
            <span className="font-cond text-[44px] leading-none font-semibold" data-testid="energy-total">
              {p ? w(p.total) : '–'}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="label-caps">{m.energy_today()}</span>
            <span className="text-[20px] font-semibold">{kwhText(r.today)}</span>
            <span className="text-[12px] text-subtle">{euro(r.today * price)}</span>
          </div>
          <div className="flex flex-col">
            <span className="label-caps">{m.energy_month()}</span>
            <span className="text-[20px] font-semibold">{kwhText(r.month.kwh)}</span>
            <span className="text-[12px] text-subtle">{m.energy_projected({ kwh: kwhText(r.month.projected), cost: euro(r.month.projected * price) })}</span>
          </div>
          {r.year !== undefined && (
            <div className="flex flex-col">
              <span className="label-caps">{m.energy_year()}</span>
              <span className="text-[20px] font-semibold">≈ {kwhText(r.year)}</span>
              <span className="text-[12px] text-subtle">{m.energy_yearCost({ cost: euro(r.year * price), price: euro(price) })}</span>
            </div>
          )}
          <span className="grow" />
          <button type="button" className="btn sm" onClick={() => setEditing(true)}>
            {m.energy_settings()}
          </button>
        </div>
        {p ? (
          <>
            <div className="flex h-[14px] gap-[2px] overflow-hidden rounded-[6px]" aria-hidden="true">
              {COMPONENTS.map((c) => (
                <div key={c} style={{ width: `${(p[c] / p.total) * 100}%`, background: COLOR[c] }} />
              ))}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {COMPONENTS.map((c) => (
                <div key={c} className="flex flex-col gap-1 rounded-[10px] border border-line p-3" data-testid={`energy-${c}`}>
                  <span className="flex items-center gap-2">
                    <span className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: COLOR[c] }} />
                    <span className="font-medium">{label(c)}</span>
                    <span className="grow" />
                    <Badge measured={c === 'cpu' ? p.cpuMeasured : c === 'gpu' ? p.gpuMeasured : false} />
                  </span>
                  <span className="text-[20px] font-semibold">{c === 'gpu' && !p.gpuMeasured ? '–' : w(p[c])}</span>
                  <span className="text-[12px] text-muted">
                    {c === 'cpu'
                      ? p.cpuMeasured
                        ? m.energy_cpuRapl()
                        : m.energy_cpuGuess()
                      : c === 'gpu'
                        ? p.gpuMeasured
                          ? m.energy_gpuDriver()
                          : m.energy_gpuNone()
                        : c === 'disks'
                          ? m.energy_disksHelp({ active: p.disksNow.filter((d) => d.state !== 'standby').length, standby: p.disksNow.filter((d) => d.state === 'standby').length })
                          : m.energy_restHelp({ base: num(p.base, 0), loss: num(r.settings.lossPct, 0) })}
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="m-0 text-[13px] text-muted">{m.energy_waiting()}</p>
        )}
      </section>

      <section className="panel flex flex-col gap-3 p-[18px]" aria-label={m.energy_history()}>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="h2 grow">{m.energy_history()}</h2>
          <div role="group" aria-label={m.energy_range()} className="flex gap-1.5">
            {(
              [
                ['24h', m.energy_range_24h()],
                ['7d', m.energy_range_7d()],
                ['30d', m.energy_range_30d()],
                ['12m', m.energy_range_12m()],
              ] as const
            ).map(([k, text]) => (
              <button key={k} type="button" className={`seg ${range === k ? 'on' : ''}`} aria-pressed={range === k} onClick={() => setRange(k)}>
                {text}
              </button>
            ))}
          </div>
        </div>
        {bars.length === 0 ? (
          <p className="m-0 text-[13px] text-muted">{m.energy_noHistory()}</p>
        ) : (
          <>
            <div className="flex gap-2">
              <div className="flex h-[200px] w-14 flex-col justify-between text-right text-[11px] text-muted" aria-hidden="true">
                <span>{amount(max)}</span>
                <span>{amount(max / 2)}</span>
                <span>0</span>
              </div>
              <ul className="m-0 flex h-[200px] flex-1 list-none items-end gap-[3px] border-b border-line p-0" aria-label={m.energy_history()} data-testid="energy-bars">
                {bars.map((b) => (
                  <li key={b.ts} className="flex h-full min-w-0 flex-1 flex-col justify-end gap-px" title={`${when(b.ts)}: ${amount(sumSplit(b))}`} aria-label={`${when(b.ts)}: ${amount(sumSplit(b))}`}>
                    {[...COMPONENTS].reverse().map((c) => (
                      <div key={c} style={{ height: `${(b[c] / max) * 100}%`, background: COLOR[c] }} className="first:rounded-t-[2px]" />
                    ))}
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-16 text-[12px] text-subtle">
              {COMPONENTS.map((c) => (
                <span key={c} className="flex items-center gap-1.5">
                  <span className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: COLOR[c] }} />
                  {label(c)}
                </span>
              ))}
              <span className="grow" />
              {peak && <span>{m.energy_peak({ amount: amount(sumSplit(peak)), when: when(peak.ts) })}</span>}
            </div>
          </>
        )}
      </section>

      {p && p.disksNow.length > 0 && (
        <section className="panel flex flex-col gap-3 p-[18px]" aria-label={m.energy_disksTitle()}>
          <div className="flex flex-wrap items-baseline gap-x-3">
            <h2 className="h2">{m.energy_disksTitle()}</h2>
            <span className="text-[12px] text-muted">{m.energy_disksNote()}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{m.energy_col_disk()}</th>
                  <th>{m.energy_col_kind()}</th>
                  <th>{m.energy_col_state()}</th>
                  <th>{m.energy_col_now()}</th>
                  <th>{m.energy_col_standby()}</th>
                </tr>
              </thead>
              <tbody>
                {p.disksNow.map((d) => (
                  <tr key={d.name} data-testid="energy-disk">
                    <td>
                      <span className="font-mono">{d.name}</span> <span className="text-muted">{d.model}</span>
                    </td>
                    <td>
                      {kindLabel(d.kind)}
                      {d.usb ? ' · USB' : ''}
                    </td>
                    <td>{d.state === 'standby' ? m.energy_state_standby() : m.energy_state_active()}</td>
                    <td>{w(d.watts)}</td>
                    <td className="text-subtle">{d.kind === 'hdd' ? m.energy_hours({ h: num(r.standbyToday[d.name] ?? 0, (r.standbyToday[d.name] ?? 0) < 10 ? 1 : 0) }) : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {r.standbySavings !== undefined && r.standbySavings > 0.05 && (
            <div className="flex flex-wrap items-center gap-3 rounded-[10px] border border-[#23502c] bg-[#3fb950]/[0.06] px-3.5 py-3 text-[13px]">
              <span className="grow">{m.energy_savings({ kwh: kwhText(r.standbySavings), cost: euro(r.standbySavings * price) })}</span>
              <Link to="/disks">{m.energy_savingsLink()}</Link>
            </div>
          )}
        </section>
      )}

      <p className="m-0 text-[12px] text-muted">{m.energy_footnote()}</p>
      {editing && (
        <SettingsDialog
          s={r.settings}
          onClose={() => setEditing(false)}
          onSaved={(x) => {
            setR(x)
            setEditing(false)
          }}
        />
      )}
    </>
  )
}

function SettingsDialog({ s, onClose, onSaved }: { s: EnergySettings; onClose: () => void; onSaved: (r: Report) => void }) {
  const say = useToast()
  const [price, setPrice] = useState(num(s.price, 2))
  const [baseW, setBase] = useState(String(s.baseW))
  const [lossPct, setLoss] = useState(String(s.lossPct))
  const work = useBusy()
  const busy = work.is('save')
  const save = () =>
    work.run('save', async () => {
      try {
        onSaved(await api<Report>('/api/power', { body: { price, baseW, lossPct } }))
        say(m.energy_saved())
      } catch (e) {
        say((e as Error).message, 'bad')
      }
    })
  const field = (labelText: string, value: string, set: (v: string) => void, unit: string, help?: string) => (
    <label className="flex flex-col gap-1.5 text-[13px]">
      {labelText}
      <span className="flex items-center gap-2">
        <input className="field w-28" inputMode="decimal" value={value} onChange={(e) => set(e.target.value)} />
        <span className="text-subtle">{unit}</span>
      </span>
      {help && <span className="text-[12px] text-muted">{help}</span>}
    </label>
  )
  return (
    <Modal open title={m.energy_settingsTitle()} onClose={onClose} busy={busy}>
      {field(m.energy_price(), price, setPrice, m.energy_priceUnit())}
      {field(m.energy_base(), baseW, setBase, 'W', m.energy_baseHelp())}
      {field(m.energy_loss(), lossPct, setLoss, '%', m.energy_lossHelp())}
      <p className="m-0 text-[12px] text-muted">{m.energy_calibrate()}</p>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          {m.common_cancel()}
        </button>
        <BusyButton className="btn primary" busy={busy} busyLabel={m.common_saving()} onClick={() => void save()}>
          {m.common_save()}
        </BusyButton>
      </div>
    </Modal>
  )
}
