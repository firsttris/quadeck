import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { FileExplorer } from '~/components/FileExplorer'
import { useCallback, useEffect, useState } from 'react'
import { useActions } from '~/components/Actions'
import { Glyph } from '~/components/Glyph'
import { HistoryChart } from '~/components/HistoryChart'
import { InstallHint } from '~/components/InstallHint'
import { Modal } from '~/components/Modal'
import { PageHeader } from '~/components/PageHeader'
import { Pill, type Tone } from '~/components/Status'
import { useToast } from '~/components/Toast'
import { useGuardedApi } from '~/components/Unlock'
import { api } from '~/lib/api'
import { diskSize, num, relative } from '~/lib/format'
import { assessSmart, attributeLevel, describeReason, HINT_TEXT, smartHints, type SmartAssessment, type SmartDisk, type SmartLevel, type SmartReport } from '~/shared/smart'

export const Route = createFileRoute('/_app/disks')({
  validateSearch: (s: Record<string, unknown>): { tab?: 'files'; path?: string } => ({
    tab: s.tab === 'files' ? 'files' : undefined,
    path: typeof s.path === 'string' && s.path.startsWith('/') ? s.path : undefined,
  }),
  head: () => ({ meta: [{ title: 'Festplatten · Quadeck' }] }),
  component: DisksPage,
})

const LEVEL: Record<SmartLevel, { tone: Tone; label: string }> = {
  ok: { tone: 'ok', label: 'gesund' },
  warning: { tone: 'warn', label: 'Warnung' },
  critical: { tone: 'bad', label: 'kritisch' },
}

function kind(d: SmartDisk) {
  if (d.protocol === 'NVMe') return 'NVMe-SSD'
  if (d.rotationRate === 0) return 'SSD'
  if (d.rotationRate) return `HDD · ${d.rotationRate} U/min`
  return d.protocol ?? ''
}

const years = (h: number) => (h >= 8760 ? `${num(h / 8760, 1)} Jahre` : h >= 720 ? `${Math.round(h / 720)} Monate` : `${h} h`)

function DisksPage() {
  const { tab, path } = Route.useSearch()
  const navigate = useNavigate()
  return (
    <>
      <PageHeader title="Festplatten" subtitle={tab === 'files' ? 'Dateien in den Datenbereichen – kopieren, verschieben, umbenennen, löschen' : 'SMART-Zustand aller Laufwerke – Verlauf, Selbsttests, was zu tun ist'} />
      <div role="tablist" aria-label="Bereich" className="flex flex-wrap gap-1.5">
        <Link to="/disks" search={{}} role="tab" aria-selected={tab !== 'files'} className={`seg ${tab !== 'files' ? 'on' : ''}`}>
          SMART
        </Link>
        <Link to="/disks" search={{ tab: 'files' }} role="tab" aria-selected={tab === 'files'} className={`seg ${tab === 'files' ? 'on' : ''}`}>
          Dateien
        </Link>
      </div>
      {tab === 'files' ? <FileExplorer path={path} onNavigate={(p) => void navigate({ to: '/disks', search: { tab: 'files', path: p } })} /> : <Smart />}
    </>
  )
}

function Smart() {
  const [report, setReport] = useState<SmartReport | null>(null)
  const [error, setError] = useState('')
  const [reading, setReading] = useState(false)
  const [detail, setDetail] = useState<SmartDisk | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/disks/smart')
      const d = (await r.json()) as SmartReport & { error?: string }
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`)
      setReport(d)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const readNow = async () => {
    setReading(true)
    try {
      setReport(await api<SmartReport>('/api/disks/smart', { body: {} }))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setReading(false)
    }
  }

  const assessed = (report?.disks ?? []).map((d) => ({ disk: d, a: assessSmart(d) }))
  const hints = smartHints(assessed.map((x) => x.a))
  const problems = assessed.filter((x) => x.a.level !== 'ok')

  return (
    <>
      {report?.installed && (
        <div className="flex flex-wrap items-center gap-3 text-[12px] text-muted">
          <span suppressHydrationWarning>Gelesen {relative(report.checkedAt)} · automatisch alle 30 Minuten, schlafende Platten werden nicht geweckt</span>
          <button type="button" className="btn sm ml-auto" onClick={readNow} disabled={reading}>
            <Glyph name="restart" size={14} /> {reading ? 'Lese …' : 'Jetzt lesen'}
          </button>
        </div>
      )}
      {error && <p className="m-0 text-[13px] text-[#e3b341]">{error}</p>}
      {!report && !error && <p className="m-0 text-muted">SMART-Daten werden gelesen …</p>}
      {report && !report.installed && (
        <section className="panel" aria-label="smartmontools installieren">
          <InstallHint feature="smart" what="smartctl ist nicht installiert – ohne das Paket smartmontools kann Quadeck die SMART-Werte der Platten nicht lesen." onInstalled={readNow} />
        </section>
      )}
      {problems.length > 0 && (
        <section className={`panel flex flex-col gap-2 px-[18px] py-4 ${problems.some((p) => p.a.level === 'critical') ? 'alertcard' : ''}`} aria-label="Handlungsbedarf">
          <h2 className="h2">Handlungsbedarf</h2>
          {problems.map(({ disk, a }) => (
            <p key={disk.name} className="m-0 text-[13px]">
              <span className="font-mono">{disk.name}</span> {disk.model ? `(${disk.model})` : ''}: {a.reasons.map(describeReason).join(' · ')}
            </p>
          ))}
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px] text-[#c9d1d9]">
            {hints.map((h) => (
              <li key={h}>→ {HINT_TEXT[h]}</li>
            ))}
          </ul>
        </section>
      )}
      {report?.installed && (
        <>
          <div className="grid grid-cols-1 gap-[18px] xl:grid-cols-2">
            {assessed.map(({ disk, a }) => (
              <DiskCard key={disk.name} disk={disk} a={a} onDetail={() => setDetail(disk)} onReport={setReport} />
            ))}
          </div>
          <p className="m-0 text-[12px] text-muted" suppressHydrationWarning>
            Werte für den Verlauf werden stündlich gespeichert und ein Jahr lang aufbewahrt.
          </p>
        </>
      )}
      <DetailDialog disk={detail} onClose={() => setDetail(null)} />
    </>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: Tone }) {
  const color = tone === 'bad' ? 'text-[#ff8a80]' : tone === 'warn' ? 'text-[#e3b341]' : 'text-fg'
  return (
    <div className="flex min-w-[96px] flex-col">
      <span className="label-caps">{label}</span>
      <span className={`font-cond text-[18px] font-semibold tabular-nums ${color}`}>{value}</span>
    </div>
  )
}

function DiskCard({ disk: d, a, onDetail, onReport }: { disk: SmartDisk; a: SmartAssessment; onDetail: () => void; onReport: (r: SmartReport) => void }) {
  const say = useToast()
  const guarded = useGuardedApi()
  const { readonly } = useActions()
  const attr = (id: number) => d.attributes.find((x) => x.id === id)
  const realloc = attr(5)
  const pending = attr(197)
  const pill = !d.supported ? { tone: 'idle' as Tone, label: 'kein SMART' } : d.standby ? { tone: 'idle' as Tone, label: 'schläft' } : LEVEL[a.level]
  const test = async (type: 'short' | 'long') => {
    try {
      const r = await guarded<SmartReport>('/api/disks/smart', { body: { selftest: { disk: d.name, type } } })
      if (r) {
        onReport(r)
        say(`${type === 'short' ? 'Kurzer' : 'Langer'} Selbsttest auf ${d.name} gestartet (${type === 'short' ? 'ca. 2 Minuten' : 'mehrere Stunden'}; die Platte bleibt nutzbar)`)
      }
    } catch (e) {
      say((e as Error).message, 'bad')
    }
  }
  return (
    <section className={`panel flex flex-col gap-3 p-[18px] ${a.level === 'critical' ? 'alertcard' : ''}`} aria-label={`Platte ${d.name}`} data-testid="smart-disk">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 grow">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[15px] font-semibold">{d.name}</span>
            <Pill tone={pill.tone}>{pill.label}</Pill>
            {d.testRunning !== undefined && <Pill tone="warn">Selbsttest läuft · noch {d.testRunning} %</Pill>}
          </div>
          <div className="truncate text-[13px] text-muted">
            {[d.model, d.sizeBytes ? diskSize(d.sizeBytes) : '', kind(d)].filter(Boolean).join(' · ') || d.message}
          </div>
        </div>
        {d.supported && !d.standby && (
          <button type="button" className="btn sm" onClick={onDetail} aria-label={`Details zu ${d.name}`}>
            Details und Verlauf
          </button>
        )}
      </div>
      {d.supported && !d.standby && (
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {d.temperature !== undefined && <Stat label="Temperatur" value={`${d.temperature} °C`} tone={d.temperature >= 60 ? 'bad' : d.temperature > 50 ? 'warn' : undefined} />}
          {d.powerOnHours !== undefined && <Stat label="Laufzeit" value={years(d.powerOnHours)} />}
          {d.wearLevel !== undefined && <Stat label="Verschleiß" value={`${d.wearLevel} %`} tone={d.wearLevel >= 100 ? 'bad' : d.wearLevel >= 80 ? 'warn' : undefined} />}
          {realloc && <Stat label="Ersetzte Sektoren" value={realloc.raw} tone={Number(realloc.raw) > 0 ? 'warn' : undefined} />}
          {pending && <Stat label="Wartende Sektoren" value={pending.raw} tone={Number(pending.raw) > 0 ? 'warn' : undefined} />}
          {d.errorMedium !== undefined && <Stat label="Medienfehler" value={String(d.errorMedium)} tone={d.errorMedium > 0 ? 'warn' : undefined} />}
        </div>
      )}
      {a.reasons.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]" aria-label="Befund">
          {a.reasons.map((r, i) => (
            <li key={i} className={a.level === 'critical' ? 'text-[#ff8a80]' : 'text-[#e3b341]'}>
              {describeReason(r)}
            </li>
          ))}
        </ul>
      )}
      {(!d.supported || d.standby) && <p className="m-0 text-[12px] text-muted">{d.standby ? 'Die Platte schläft – sie wird für SMART nicht geweckt. Werte beim nächsten Lesen, wenn sie aktiv ist.' : `${d.message ?? 'Kein SMART'} – bei virtuellen Laufwerken normal; bei USB-Gehäusen hilft oft eines mit SAT-Unterstützung.`}</p>}
      {d.supported && !d.standby && !readonly && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3 text-[12px] text-muted">
          <span className="grow">{d.selfTests[0] ? `Letzter Selbsttest: ${d.selfTests[0].type} – ${d.selfTests[0].status}` : 'Noch kein Selbsttest'}</span>
          <button type="button" className="btn sm" disabled={d.testRunning !== undefined} onClick={() => test('short')}>
            Kurztest
          </button>
          <button type="button" className="btn sm" disabled={d.testRunning !== undefined} onClick={() => test('long')}>
            Langtest
          </button>
        </div>
      )}
    </section>
  )
}

type Trends = Partial<Record<'temp' | 'realloc' | 'pending' | 'uncorrectable' | 'crc' | 'wear' | 'media', [number, number][]>>

function DetailDialog({ disk: d, onClose }: { disk: SmartDisk | null; onClose: () => void }) {
  const [days, setDays] = useState(90)
  const [trends, setTrends] = useState<Trends | null>(null)
  useEffect(() => {
    setTrends(null)
    if (!d) return
    fetch(`/api/disks/smart?history=${encodeURIComponent(d.id)}&days=${days}`)
      .then((r) => r.json())
      .then((x: { series: Trends }) => setTrends(x.series))
      .catch(() => setTrends({}))
  }, [d, days])
  const span = days * 24 * 3600_000
  const now = Date.now()
  const counters = trends ? ([['realloc', 'Ersetzte Sektoren', '#e3b341'], ['pending', 'Wartende Sektoren', '#ff8a80'], ['crc', 'CRC-Fehler', '#b4a0ff'], ['media', 'Medienfehler', '#ff8a80']] as const).filter(([k]) => trends[k]?.length) : []
  return (
    <Modal open={!!d} onClose={onClose} title={d ? `${d.name} · ${d.model ?? ''}` : ''} wide>
      {d && (
        <>
          <dl className="m-0 grid grid-cols-[auto_1fr_auto_1fr] gap-x-4 gap-y-1 text-[13px]">
            <dt className="text-muted">Seriennummer</dt>
            <dd className="m-0 font-mono">{d.serial ?? '–'}</dd>
            <dt className="text-muted">Firmware</dt>
            <dd className="m-0 font-mono">{d.firmware ?? '–'}</dd>
            <dt className="text-muted">Betriebsstunden</dt>
            <dd className="m-0 font-mono">{d.powerOnHours ?? '–'}</dd>
            <dt className="text-muted">Einschaltvorgänge</dt>
            <dd className="m-0 font-mono">{d.powerCycles ?? '–'}</dd>
            {d.family && (
              <>
                <dt className="text-muted">Familie</dt>
                <dd className="m-0">{d.family}</dd>
              </>
            )}
            {d.unsafeShutdowns !== undefined && (
              <>
                <dt className="text-muted">Stromausfälle</dt>
                <dd className="m-0 font-mono">{d.unsafeShutdowns}</dd>
              </>
            )}
          </dl>

          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Zeitraum">
            {[30, 90, 365].map((n) => (
              <button key={n} type="button" className={`seg ${days === n ? 'on' : ''}`} aria-pressed={days === n} onClick={() => setDays(n)}>
                {n === 365 ? '1 Jahr' : `${n} Tage`}
              </button>
            ))}
          </div>
          {trends && !trends.temp?.length && !counters.length && <p className="m-0 text-[13px] text-muted">Noch kein Verlauf – Werte werden stündlich gespeichert.</p>}
          {!!trends?.temp?.length && (
            <section aria-label="Temperaturverlauf" className="pb-5">
              <h3 className="m-0 mb-1 text-[13px] font-semibold">Temperatur</h3>
              <HistoryChart detailed label={`${d.name} Temperatur`} series={[{ label: 'Temperatur', color: '#e3b341', points: trends.temp }]} span={span} now={now} format={(v) => `${Math.round(v)} °C`} height={110} />
            </section>
          )}
          {counters.length > 0 && trends && (
            <section aria-label="Fehlerzähler" className="pb-5">
              <h3 className="m-0 mb-1 text-[13px] font-semibold">Fehlerzähler – steigende Werte sind das Warnsignal</h3>
              <HistoryChart detailed label={`${d.name} Fehlerzähler`} series={counters.map(([k, label, color]) => ({ label, color, points: trends[k]! }))} span={span} now={now} format={(v) => String(Math.round(v))} yMin={0} height={110} />
            </section>
          )}
          {!!trends?.wear?.length && (
            <section aria-label="Verschleißverlauf" className="pb-5">
              <h3 className="m-0 mb-1 text-[13px] font-semibold">Verschleiß</h3>
              <HistoryChart detailed label={`${d.name} Verschleiß`} series={[{ label: 'Verschleiß', color: '#7cc4b8', points: trends.wear }]} span={span} now={now} format={(v) => `${Math.round(v)} %`} yMin={0} height={90} />
            </section>
          )}

          {d.attributes.length > 0 && (
            <div className="max-h-[300px] overflow-auto rounded-[10px] border border-edge">
              <table className="tbl" aria-label="SMART-Attribute">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Attribut</th>
                    <th>Wert</th>
                    <th>Schlechtester</th>
                    <th>Grenze</th>
                    <th>Rohwert</th>
                  </tr>
                </thead>
                <tbody>
                  {d.attributes.map((x) => {
                    const lvl = attributeLevel(x)
                    return (
                      <tr key={x.id} className={lvl === 'critical' ? 'text-[#ff8a80]' : lvl === 'warning' ? 'text-[#e3b341]' : ''}>
                        <td className="font-mono text-[12px]">{x.id}</td>
                        <td className="text-[12px]">
                          {x.name}
                          {x.prefailure ? <span className="ml-1 text-subtle">(Vorausfall)</span> : null}
                        </td>
                        <td className="font-mono text-[12px]">{x.value}</td>
                        <td className="font-mono text-[12px]">{x.worst}</td>
                        <td className="font-mono text-[12px]">{x.threshold}</td>
                        <td className="font-mono text-[12px]">{x.raw}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          {d.selfTests.length > 0 && (
            <div>
              <h3 className="m-0 mb-1 text-[13px] font-semibold">Selbsttests</h3>
              {d.selfTests.slice(0, 5).map((t, i) => (
                <div key={i} className="flex gap-3 text-[12px]">
                  <span className={t.passed ? 'text-[#7ee2a8]' : 'text-[#ff8a80]'}>{t.passed ? '✓' : '✗'}</span>
                  <span className="w-[120px]">{t.type}</span>
                  <span className="grow">{t.status}</span>
                  {t.hours !== undefined && <span className="font-mono text-subtle">bei {t.hours} h</span>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <div className="flex justify-end">
        <button type="button" className="btn" onClick={onClose}>
          Schließen
        </button>
      </div>
    </Modal>
  )
}
