import { Link, createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { PageHeader } from '~/components/PageHeader'
import { useToast } from '~/components/Toast'
import { SENSOR_UNIT, gpuQuadletLine, pcieGen, shortGpuName, type Hardware, type SensorRaw } from '~/shared/hardware'

export const Route = createFileRoute('/_app/hardware')({
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
          say('Kopiert')
        } catch {
          say('Kopieren geht nur über https oder localhost – bitte markieren', 'bad')
        }
      }}
    >
      Kopieren
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
  const [hw, setHw] = useState<Hardware | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/hardware')
      const d = (await r.json()) as Hardware & { error?: string }
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`)
      setHw(d)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  useEffect(() => {
    void load()
    const t = setInterval(load, 15_000) // sensors
    return () => clearInterval(t)
  }, [load])

  const s = hw?.system
  return (
    <>
      <PageHeader title="Hardware" subtitle={s ? [s.product ?? s.board ?? s.vendor, s.chassis].filter(Boolean).join(' · ') || 'Was in diesem Rechner steckt' : 'Was in diesem Rechner steckt'} />
      {error && <p className="m-0 text-[13px] text-[#e3b341]">{error}</p>}
      {!hw && !error && <p className="m-0 text-muted">Wird gelesen …</p>}
      {hw && (
        <>
          {hw.warnings.length > 0 && (
            <section className="panel flex flex-col gap-1.5 px-[18px] py-4" aria-label="Hinweise zur Hardware">
              {hw.warnings.map((w) => (
                <p key={w.text} className={`m-0 text-[13px] ${w.level === 'warning' ? 'text-[#e3b341]' : 'text-muted'}`}>
                  {w.text}
                </p>
              ))}
            </section>
          )}

          <div className="grid grid-cols-2 gap-[18px] md:grid-cols-4" aria-label="Auf einen Blick">
            {[
              ['Prozessor', hw.cpu.model.replace(/\(R\)|\(TM\)|CPU|Processor|12th Gen|13th Gen|14th Gen/g, '').replace(/\s+/g, ' ').trim(), `${hw.cpu.cores} Kerne · ${hw.cpu.threads} Threads`],
              ['Arbeitsspeicher', gib(hw.memory.total), hw.memory.slots.length ? `${hw.memory.slots.filter((x) => x.size).length} von ${hw.memory.slots.length} Steckplätzen belegt` : ''],
              ['Grafik', hw.gpus.length ? hw.gpus.map((g) => shortGpuName(g.name)).join(', ') : 'keine erkannt', hw.gpus.length > 1 ? `${hw.gpus.length} GPUs` : ''],
              ['Mainboard', s?.board ?? s?.vendor ?? '–', s?.bios ? `BIOS ${s.bios.version ?? ''}${s.bios.date ? ` vom ${s.bios.date}` : ''}` : ''],
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
            <Card title="Prozessor">
              <Facts
                rows={[
                  ['Modell', hw.cpu.model],
                  ['Kerne', `${hw.cpu.cores} Kerne, ${hw.cpu.threads} Threads${hw.cpu.sockets > 1 ? `, ${hw.cpu.sockets} Sockel` : ''}`],
                  ['Takt', hw.cpu.maxMHz ? `bis ${(hw.cpu.maxMHz / 1000).toFixed(1).replace('.', ',')} GHz` : undefined],
                  ['L3-Cache', hw.cpu.cache?.replace(/\s*\(.*\)/, '')],
                  ['Virtualisierung', hw.cpu.virtualization ? `${hw.cpu.virtualization} – virtuelle Maschinen möglich` : 'nicht verfügbar oder im BIOS aus'],
                ]}
              />
            </Card>

            <Card title="Arbeitsspeicher">
              {hw.memory.slots.length > 0 ? (
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4" aria-label="Steckplätze">
                  {hw.memory.slots.map((m) => (
                    <div key={m.locator} data-testid="ram-slot" className={`flex flex-col gap-0.5 rounded-[10px] border p-2.5 ${m.size ? 'border-[rgba(124,196,184,.45)] bg-[rgba(124,196,184,.08)]' : 'border-dashed border-edge'}`}>
                      <span className="truncate text-[11px] text-subtle" title={m.locator}>
                        {m.locator}
                      </span>
                      {m.size ? (
                        <>
                          <span className="font-semibold">{gib(m.size)}</span>
                          <span className="text-[12px] text-muted">
                            {[m.type, m.speed ? `${m.configuredSpeed ?? m.speed} MT/s` : undefined].filter(Boolean).join(' · ')}
                          </span>
                          {(m.manufacturer || m.part) && <span className="truncate text-[11px] text-subtle">{[m.manufacturer, m.part].filter(Boolean).join(' ')}</span>}
                        </>
                      ) : (
                        <span className="text-muted">frei</span>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="m-0 text-muted">Steckplätze nicht lesbar (dmidecode fehlt oder virtuelle Maschine).</p>
              )}
              <Facts
                rows={[
                  ['Gesamt', gib(hw.memory.total)],
                  ['Maximal', hw.memory.maxCapacity ? `${gib(hw.memory.maxCapacity)} laut Mainboard` : undefined],
                  ['ECC', hw.memory.ecc === undefined ? undefined : hw.memory.ecc ? 'ja – Speicherfehler werden erkannt und korrigiert' : 'nein'],
                ]}
              />
            </Card>

            <Card title="Mainboard und BIOS">
              <Facts
                rows={[
                  ['Hersteller', s?.vendor],
                  ['Modell', s?.product],
                  ['Mainboard', s?.board],
                  ['Bauform', s?.chassis],
                  ['BIOS', s?.bios ? [s.bios.version, s.bios.date && `vom ${s.bios.date}`].filter(Boolean).join(' ') : undefined],
                  ['BIOS-Hersteller', s?.bios?.vendor],
                  ['Virtualisiert', s?.virt],
                ]}
              />
            </Card>

            <Card title="Grafik">
              {hw.gpus.length === 0 && <p className="m-0 text-muted">Keine GPU erkannt.</p>}
              {hw.gpus.map((g) => {
                const line = gpuQuadletLine(g.nodes)
                return (
                  <div key={g.pci} className="flex flex-col gap-1.5 border-t border-line pt-2 first:border-t-0 first:pt-0" data-testid="gpu">
                    <div className="font-medium">{g.name}</div>
                    <div className="text-[12px] text-muted">
                      {g.pci} · Treiber {g.driver ?? '–'} · {g.nodes.join(', ') || 'keine Gerätedatei'}
                    </div>
                    {line && (
                      <div className="flex items-center gap-2">
                        <code className="grow truncate rounded-md bg-[#0e1319] px-2 py-1 font-mono text-[12px]">{line}</code>
                        <Copy text={line} label={`Quadlet-Zeile für ${g.name} kopieren`} />
                      </div>
                    )}
                  </div>
                )
              })}
              {hw.gpus.length > 0 && <p className="m-0 text-[12px] text-muted">Mit dieser Zeile im Abschnitt [Container] der Quadlet nutzt z. B. Jellyfin oder Immich die GPU für Hardware-Transcoding.</p>}
            </Card>

            <Card title="Sensoren">
              <Sensors list={hw.sensors} />
            </Card>

            <Card title="USB-Geräte">
              {hw.usb.length === 0 && <p className="m-0 text-muted">Keine USB-Geräte.</p>}
              {hw.usb.map((u) => (
                <div key={u.path} className="flex flex-col gap-1 border-t border-line pt-2 first:border-t-0 first:pt-0" data-testid="usb-device">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">{u.name ?? `${u.vendor}:${u.product}`}</span>
                    <span className="text-[12px] text-muted">{u.manufacturer}</span>
                  </div>
                  <div className="text-[12px] text-subtle">
                    {[usbSpeed(u.speed), u.driver && `Treiber ${u.driver}`, `${u.vendor}:${u.product}`].filter(Boolean).join(' · ')}
                  </div>
                  {u.serial.map((p) => (
                    <div key={p} className="flex items-center gap-2">
                      <code className="grow truncate rounded-md bg-[#0e1319] px-2 py-1 font-mono text-[12px]" title={p}>
                        {p}
                      </code>
                      <Copy text={p} label={`Pfad von ${u.name ?? u.product} kopieren`} />
                    </div>
                  ))}
                </div>
              ))}
              {hw.usb.some((u) => u.serial.length) && <p className="m-0 text-[12px] text-muted">Der Pfad unter /dev/serial/by-id bleibt gleich, auch wenn aus ttyUSB0 nach einem Neustart ttyUSB1 wird – so in Home Assistant oder Zigbee2MQTT eintragen (AddDevice= in der Quadlet).</p>}
            </Card>
          </div>

          {hw.sata.length > 0 && (
            <section className="panel relative flex flex-col overflow-x-auto" aria-label="SATA">
              <h2 className="h2 px-[18px] pt-4 pb-2">SATA-Anbindung</h2>
              <table className="tbl">
                <tbody>
                  {hw.sata.map((a) => (
                    <tr key={a.link} data-testid="sata-link">
                      <td className="font-mono">{a.disk ?? '–'}</td>
                      <td>{a.model ?? ''}</td>
                      <td className={a.slow ? 'text-[#e3b341]' : ''}>
                        {a.speed ?? 'kein Gerät'}
                        {a.slow && ` (möglich: ${a.limit})`}
                      </td>
                      <td className="text-muted">{a.link}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="m-0 border-t border-line px-[18px] py-2 text-[12px] text-muted">
                Gesundheit der Platten unter{' '}
                <Link to="/disks" className="text-accent">
                  Festplatten
                </Link>
                .
              </p>
            </section>
          )}

          <section className="panel relative flex flex-col overflow-x-auto" aria-label="PCIe-Geräte">
            <h2 className="h2 px-[18px] pt-4 pb-2">PCIe-Geräte</h2>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Gerät</th>
                  <th className="hidden md:table-cell">Art</th>
                  <th>Anbindung</th>
                  <th className="hidden lg:table-cell">Treiber</th>
                </tr>
              </thead>
              <tbody>
                {hw.pci
                  .filter((p) => p.group !== 'Brücken')
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
  if (!list.length) return <p className="m-0 text-muted">Keine Sensoren lesbar (in VMs normal; sonst fehlt oft das Kernel-Modul, z. B. nct6775 oder it87).</p>
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
                  <span className="h-1.5 overflow-hidden rounded-full bg-[#1b222c]">{pct !== undefined && <span className={`block h-full ${hot ? 'bg-[#f85149]' : 'bg-accent'}`} style={{ width: `${pct}%` }} />}</span>
                  <span className={`text-right font-mono text-[12px] ${hot ? 'text-[#ff8a80]' : ''}`}>
                    {s.kind === 'fan' && s.value === 0 ? 'steht' : `${s.kind === 'in' ? s.value.toFixed(2).replace('.', ',') : s.kind === 'power' ? s.value.toFixed(1).replace('.', ',') : Math.round(s.value)} ${SENSOR_UNIT[s.kind]}`}
                  </span>
                </div>
              )
            })}
        </div>
      ))}
    </div>
  )
}
