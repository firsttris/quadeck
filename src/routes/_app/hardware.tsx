import { Link, createFileRoute } from '@tanstack/react-router'
import { useCallback, useState, type ReactNode } from 'react'
import { PageHeader } from '~/components/PageHeader'
import { PowerUsage } from '~/components/PowerUsage'
import { useToast } from '~/components/Toast'
import { num } from '~/lib/format'
import { gpuQuadletLine, pcieGen, sensorUnit, shortGpuName, type Hardware, type SensorRaw } from '~/shared/hardware'
import { m } from '~/paraglide/messages'
import { usePolling } from '~/lib/polling'

type Tab = 'overview' | 'power'

export const Route = createFileRoute('/_app/hardware')({
  validateSearch: (s: Record<string, unknown>): { tab?: Tab } => ({ tab: s.tab === 'power' ? 'power' : undefined }),
  head: () => ({ meta: [{ title: 'Hardware · Quadeck' }] }),
  component: HardwarePage,
})

const gib = (n?: number) => (n ? (n >= 1024 ** 3 ? `${Math.round(n / 1024 ** 3)} GB` : `${Math.round(n / 1024 ** 2)} MB`) : '–')
const usbSpeed = (mbit?: number) => (!mbit ? '' : mbit >= 10000 ? 'USB 3.2 (10 Gbit/s)' : mbit >= 5000 ? 'USB 3 (5 Gbit/s)' : mbit >= 480 ? 'USB 2.0' : mbit >= 12 ? 'USB 1.1' : 'USB 1.0')

function Copy({ text, label }: { text: string; label: string }) {
  const say = useToast()
  return (
    <button
      type="button"
      className="btn sm shrink-0"
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          say(m.common_copied())
        } catch {
          say(m.hardware_copyHttps(), 'bad')
        }
      }}
    >
      {m.common_copy()}
    </button>
  )
}

function Card({ title, children, className = '' }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={`panel flex flex-col gap-2 p-[18px] text-[13px] ${className}`} aria-label={title}>
      <h2 className="h2">{title}</h2>
      {children}
    </section>
  )
}

function Facts({ rows }: { rows: [string, ReactNode | undefined][] }) {
  return (
    <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
      {rows
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="m-0">{v}</dd>
          </div>
        ))}
    </dl>
  )
}

function HardwarePage() {
  const { tab = 'overview' } = Route.useSearch()
  const [hw, setHw] = useState<Hardware | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/hardware')
      const d = (await r.json()) as Hardware & { error?: string }
      if (!r.ok) throw new Error(d.error ?? m.common_http({ status: r.status }))
      setHw(d)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  usePolling(load, 15_000) // sensors

  const s = hw?.system
  return (
    <>
      <PageHeader title={m.hardware_heading()} subtitle={s ? [s.product ?? s.board ?? s.vendor, s.chassis].filter(Boolean).join(' · ') || m.hardware_subtitle() : m.hardware_subtitle()} />
      <div role="tablist" aria-label={m.hardware_area()} className="flex flex-wrap gap-1.5">
        {(
          [
            ['overview', m.hardware_tab_overview()],
            ['power', m.hardware_tab_power()],
          ] as const
        ).map(([k, label]) => (
          <Link key={k} to="/hardware" search={k === 'overview' ? {} : { tab: k }} role="tab" aria-selected={tab === k} className={`seg ${tab === k ? 'on' : ''}`}>
            {label}
          </Link>
        ))}
      </div>
      {tab === 'power' && <PowerUsage />}
      {tab === 'overview' && error && <p className="m-0 text-[13px] text-[#e3b341]">{error}</p>}
      {tab === 'overview' && !hw && !error && <p className="m-0 text-muted">{m.hardware_reading()}</p>}
      {tab === 'overview' && hw && (
        <>
          {hw.warnings.length > 0 && (
            <section className="panel flex flex-col gap-1.5 px-[18px] py-4" aria-label={m.hardware_hints()}>
              {hw.warnings.map((w) => (
                <p key={w.text} className={`m-0 text-[13px] ${w.level === 'warning' ? 'text-[#e3b341]' : 'text-muted'}`}>
                  {w.text}
                </p>
              ))}
            </section>
          )}

          <div className="grid grid-cols-2 gap-[18px] md:grid-cols-4" aria-label={m.hardware_glance()}>
            {[
              [
                m.hardware_cpu(),
                hw.cpu.model
                  .replace(/\(R\)|\(TM\)|CPU|Processor|12th Gen|13th Gen|14th Gen/g, '')
                  .replace(/\s+/g, ' ')
                  .trim(),
                m.hardware_coresThreads({ cores: hw.cpu.cores, threads: hw.cpu.threads }),
              ],
              [m.hardware_memory(), gib(hw.memory.total), hw.memory.slots.length ? m.hardware_slotsUsed({ used: (hw.memory.slots.filter((x) => x.size).length), all: hw.memory.slots.length }) : ''],
              [m.hardware_graphics(), hw.gpus.length ? hw.gpus.map((g) => shortGpuName(g.name)).join(', ') : m.hardware_noneFound(), hw.gpus.length > 1 ? m.hardware_gpus({ n: hw.gpus.length }) : ''],
              [m.hardware_mainboard(), s?.board ?? s?.vendor ?? '–', s?.bios ? m.hardware_biosFrom({ version: (s.bios.version ?? ''), date: s.bios.date ?? "", hasDate: String(!!s.bios.date) }) : ''],
            ].map(([k, v, sub]) => (
              <div key={k} className="panel flex min-w-0 flex-col gap-0.5 px-[18px] py-3.5" data-testid="hw-summary">
                <span className="text-[11px] font-semibold tracking-[.06em] text-faint uppercase">{k}</span>
                <span className="truncate font-cond text-[17px] font-semibold" title={v}>
                  {v}
                </span>
                {sub && <span className="truncate text-[12px] text-muted">{sub}</span>}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-[18px] xl:grid-cols-2">
            <Card title={m.hardware_cpu()}>
              <Facts
                rows={[
                  [m.hardware_model(), hw.cpu.model],
                  [m.hardware_cores(), m.hardware_coresLong({ cores: hw.cpu.cores, threads: hw.cpu.threads, sockets: hw.cpu.sockets, multi: String(hw.cpu.sockets > 1) })],
                  [m.hardware_clock(), hw.cpu.maxMHz ? m.hardware_upTo({ ghz: num(hw.cpu.maxMHz / 1000, 1) }) : undefined],
                  [m.hardware_l3(), hw.cpu.cache?.replace(/\s*\(.*\)/, '')],
                  [m.hardware_virtualization(), hw.cpu.virtualization ? m.hardware_vmPossible({ virtualization: hw.cpu.virtualization }) : m.hardware_vmUnavailable()],
                ]}
              />
            </Card>

            <Card title={m.hardware_memory()}>
              {hw.memory.slots.length > 0 ? (
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4" aria-label={m.hardware_slots()}>
                  {hw.memory.slots.map((slot) => (
                    <div key={slot.locator} data-testid="ram-slot" className={`flex flex-col gap-0.5 rounded-[10px] border p-2.5 ${slot.size ? 'border-accent/45 bg-accent/8' : 'border-dashed border-edge'}`}>
                      <span className="truncate text-[11px] text-subtle" title={slot.locator}>
                        {slot.locator}
                      </span>
                      {slot.size ? (
                        <>
                          <span className="font-semibold">{gib(slot.size)}</span>
                          <span className="text-[12px] text-muted">{[slot.type, slot.speed ? `${slot.configuredSpeed ?? slot.speed} MT/s` : undefined].filter(Boolean).join(' · ')}</span>
                          {(slot.manufacturer || slot.part) && <span className="truncate text-[11px] text-subtle">{[slot.manufacturer, slot.part].filter(Boolean).join(' ')}</span>}
                        </>
                      ) : (
                        <span className="text-muted">{m.hardware_free()}</span>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="m-0 text-muted">{m.hardware_slotsUnreadable()}</p>
              )}
              <Facts
                rows={[
                  [m.hardware_total(), gib(hw.memory.total)],
                  [m.hardware_max(), hw.memory.maxCapacity ? m.hardware_perBoard({ size: gib(hw.memory.maxCapacity) }) : undefined],
                  ['ECC', hw.memory.ecc === undefined ? undefined : hw.memory.ecc ? m.hardware_eccYes() : m.hardware_eccNo()],
                ]}
              />
            </Card>

            <Card title={m.hardware_boardBios()}>
              <Facts
                rows={[
                  [m.hardware_vendor(), s?.vendor],
                  [m.hardware_model(), s?.product],
                  [m.hardware_mainboard(), s?.board],
                  [m.hardware_chassis(), s?.chassis],
                  ['BIOS', s?.bios ? [s.bios.version, s.bios.date && m.hardware_from({ date: s.bios.date })].filter(Boolean).join(' ') : undefined],
                  [m.hardware_biosVendor(), s?.bios?.vendor],
                  [m.hardware_virtualized(), s?.virt],
                ]}
              />
            </Card>

            <Card title={m.hardware_graphics()}>
              {hw.gpus.length === 0 && <p className="m-0 text-muted">{m.hardware_noGpu()}</p>}
              {hw.gpus.map((g) => {
                const line = gpuQuadletLine(g.nodes)
                return (
                  <div key={g.pci} className="flex flex-col gap-1.5 border-t border-line pt-2 first:border-t-0 first:pt-0" data-testid="gpu">
                    <div className="font-medium">{g.name}</div>
                    <div className="text-[12px] text-muted">
                      {g.pci} · {m.hardware_label_driver({ driver: (g.driver ?? '–') })} · {g.nodes.join(', ') || m.hardware_noDeviceNode()}
                    </div>
                    {line && (
                      <div className="flex items-center gap-2">
                        <code className="grow truncate rounded-md bg-sunken px-2 py-1 font-mono text-[12px]">{line}</code>
                        <Copy text={line} label={m.hardware_copyQuadletLine({ name: g.name })} />
                      </div>
                    )}
                  </div>
                )
              })}
              {hw.gpus.length > 0 && <p className="m-0 text-[12px] text-muted">{m.hardware_gpuHint()}</p>}
            </Card>

            <Card title={m.hardware_sensors()}>
              <Sensors list={hw.sensors} />
            </Card>

            <Card title={m.hardware_usbDevices()}>
              {hw.usb.length === 0 && <p className="m-0 text-muted">{m.hardware_noUsb()}</p>}
              {hw.usb.map((u) => (
                <div key={u.path} className="flex flex-col gap-1 border-t border-line pt-2 first:border-t-0 first:pt-0" data-testid="usb-device">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">{u.name ?? `${u.vendor}:${u.product}`}</span>
                    <span className="text-[12px] text-muted">{u.manufacturer}</span>
                  </div>
                  <div className="text-[12px] text-subtle">{[usbSpeed(u.speed), u.driver && m.hardware_label_driver({ driver: u.driver }), `${u.vendor}:${u.product}`].filter(Boolean).join(' · ')}</div>
                  {u.serial.map((p) => (
                    <div key={p} className="flex items-center gap-2">
                      <code className="grow truncate rounded-md bg-sunken px-2 py-1 font-mono text-[12px]" title={p}>
                        {p}
                      </code>
                      <Copy text={p} label={m.hardware_copyPath({ name: (u.name ?? u.product) })} />
                    </div>
                  ))}
                </div>
              ))}
              {hw.usb.some((u) => u.serial.length) && <p className="m-0 text-[12px] text-muted">{m.hardware_usbHint()}</p>}
            </Card>
          </div>

          {hw.sata.length > 0 && (
            <section className="panel relative flex flex-col overflow-x-auto" aria-label="SATA">
              <h2 className="h2 px-[18px] pt-4 pb-2">{m.hardware_sataLinks()}</h2>
              <table className="tbl">
                <tbody>
                  {hw.sata.map((a) => (
                    <tr key={a.link} data-testid="sata-link">
                      <td className="font-mono">{a.disk ?? '–'}</td>
                      <td>{a.model ?? ''}</td>
                      <td className={a.slow ? 'text-[#e3b341]' : ''}>
                        {a.speed ?? m.hardware_noDevice()}
                        {a.slow && m.hardware_possible({ limit: a.limit ?? '' })}
                      </td>
                      <td className="text-muted">{a.link}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="m-0 border-t border-line px-[18px] py-2 text-[12px] text-muted">
                {m.hardware_diskHealthBefore()}{' '}
                <Link to="/disks" className="text-accent">
                  {m.hardware_disks()}
                </Link>
                .
              </p>
            </section>
          )}

          <section className="panel relative flex flex-col overflow-x-auto" aria-label={m.hardware_pcieDevices()}>
            <h2 className="h2 px-[18px] pt-4 pb-2">{m.hardware_pcieDevices()}</h2>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{m.hardware_device()}</th>
                  <th className="hidden md:table-cell">{m.hardware_kind()}</th>
                  <th>{m.hardware_link()}</th>
                  <th className="hidden lg:table-cell">{m.hardware_driverCol()}</th>
                </tr>
              </thead>
              <tbody>
                {hw.pci
                  .filter((p) => p.kind !== 'bridge')
                  .map((p) => (
                    <tr key={p.address} data-testid="pci-device">
                      <td>
                        <div className="font-medium">{[p.vendorName?.replace(/ Corporation| Co Ltd| Technology Inc\.| Electronics/g, ''), p.deviceName].filter(Boolean).join(' ') || `${p.vendor}:${p.device}`}</div>
                        <div className="font-mono text-[11px] text-subtle">
                          {p.address}
                          {p.names?.length ? ` · ${p.names.join(', ')}` : ''}
                        </div>
                      </td>
                      <td className="hidden text-muted md:table-cell">{p.group}</td>
                      <td className={p.downgraded ? 'text-[#e3b341]' : ''}>
                        {p.linkWidth ? `x${p.linkWidth} · PCIe ${pcieGen(p.linkSpeed) ?? '?'}.0` : <span className="text-muted">–</span>}
                        {p.downgraded && <div className="text-[12px]">{p.downgraded}</div>}
                      </td>
                      <td className="hidden font-mono text-[12px] text-muted lg:table-cell">{p.driver ?? '–'}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </>
  )
}

function Sensors({ list }: { list: SensorRaw[] }) {
  if (!list.length) return <p className="m-0 text-muted">{m.hardware_noSensors()}</p>
  const chips = [...new Set(list.map((s) => s.chip))]
  return (
    <div className="flex flex-col gap-2.5">
      {chips.map((c) => (
        <div key={c} className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold tracking-[.06em] text-faint uppercase">{c}</span>
          {list
            .filter((s) => s.chip === c)
            .map((s) => {
              const scale = s.kind === 'temp' ? (s.crit ?? 100) : s.kind === 'fan' ? 2500 : undefined
              const pct = scale ? Math.min(100, (s.value / scale) * 100) : undefined
              const hot = s.kind === 'temp' && s.crit && s.value >= s.crit - 5
              return (
                <div key={s.label} className="grid grid-cols-[minmax(0,1fr)_90px_80px] items-center gap-3" data-testid="sensor">
                  <span className="truncate">{s.label}</span>
                  <span className="h-1.5 overflow-hidden rounded-full bg-line">{pct !== undefined && <span className={`block h-full ${hot ? 'bg-[#f85149]' : 'bg-accent'}`} style={{ width: `${pct}%` }} />}</span>
                  <span className={`text-right font-mono text-[12px] ${hot ? 'text-[#ff8a80]' : ''}`}>
                    {s.kind === 'fan' && s.value === 0 ? m.hardware_fanStopped() : `${s.kind === 'in' ? num(s.value, 2) : s.kind === 'power' ? num(s.value, 1) : Math.round(s.value)} ${sensorUnit(s.kind)}`}
                  </span>
                </div>
              )
            })}
        </div>
      ))}
    </div>
  )
}
