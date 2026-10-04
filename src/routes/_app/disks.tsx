import { Link, createFileRoute, redirect } from '@tanstack/react-router'
import { MountsView } from '~/components/Mounts'
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
import { msg } from '~/shared/i18n'
import { assessSmart, attributeLevel, describeNote, describeReason, hintText, smartHints, type SmartAssessment, type SmartBaseline, type SmartDisk, type SmartLevel, type SmartReport, type TempSensorGap } from '~/shared/smart'
import { m } from '~/paraglide/messages'
import { PowerDialog, PowerRow, type PowerInfo } from '~/components/DiskPower'
import { dailyWakes, type DiskPower } from '~/shared/power'
import { pickMsg } from '~/i18n'

export const Route = createFileRoute('/_app/disks')({
  // The file explorer used to be a tab here; old links land on its own page.
  validateSearch: (s: Record<string, unknown>): { tab?: 'files' | 'mounts'; path?: string } => ({
    tab: s.tab === 'files' || s.tab === 'mounts' ? s.tab : undefined,
    path: typeof s.path === 'string' && s.path.startsWith('/') ? s.path : undefined,
  }),
  beforeLoad: ({ search }) => {
    if (search.tab === 'files') throw redirect({ to: '/files', search: { path: search.path } })
  },
  head: () => ({ meta: [{ title: msg('page_title_disks') }] }),
  component: DisksPage,
})

const LEVEL_TONE: Record<SmartLevel, Tone> = { ok: 'ok', warning: 'warn', critical: 'bad' }

function kind(d: SmartDisk) {
  if (d.protocol === 'NVMe') return 'NVMe-SSD'
  if (d.rotationRate === 0) return 'SSD'
  if (d.rotationRate) return m.disks_smart_hdd({ rpm: d.rotationRate })
  return d.protocol ?? ''
}

const years = (h: number) => (h >= 8760 ? m.disks_smart_years({ n: num(h / 8760, 1) }) : h >= 720 ? m.disks_smart_months({ n: Math.round(h / 720) }) : `${h} h`)

function DisksPage() {
  const { tab } = Route.useSearch()
  const mounts = tab === 'mounts'
  return (
    <>
      <PageHeader title={m.disks_page_title()} subtitle={mounts ? m.disks_page_subtitleMounts() : m.disks_page_subtitleSmart()} />
      <div role="tablist" aria-label={m.disks_page_area()} className="flex flex-wrap gap-1.5">
        <Link to="/disks" search={{}} role="tab" aria-selected={!mounts} className={`seg ${!mounts ? 'on' : ''}`}>
          SMART
        </Link>
        <Link to="/disks" search={{ tab: 'mounts' }} role="tab" aria-selected={mounts} className={`seg ${mounts ? 'on' : ''}`}>
          {m.disks_page_mountsTab()}
        </Link>
      </div>
      {mounts ? <MountsView /> : <Smart />}
    </>
  )
}

function Smart() {
  const [report, setReport] = useState<SmartReport | null>(null)
  const [error, setError] = useState('')
  const [reading, setReading] = useState(false)
  const [detail, setDetail] = useState<SmartDisk | null>(null)
  const [power, setPower] = useState<PowerInfo | null>(null)
  const [powerDisk, setPowerDisk] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/disks/smart')
      const d = (await r.json()) as SmartReport & { error?: string }
      if (!r.ok) throw new Error(d.error ?? m.common_http({ status: r.status }))
      setReport(d)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  useEffect(() => {
    void load()
    api<PowerInfo>('/api/disks/power', { method: 'GET' })
      .then(setPower)
      .catch(() => {})
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

  const assessed = (report?.disks ?? []).map((d) => ({ disk: d, a: assessSmart(d, report?.baselines?.[d.id]) }))
  const hints = smartHints(assessed.map((x) => x.a))
  const problems = assessed.filter((x) => x.a.level !== 'ok')

  return (
    <>
      {report?.installed && (
        <div className="flex flex-wrap items-center gap-3 text-[12px] text-muted">
          <span suppressHydrationWarning>{m.disks_smart_readAt({ when: relative(report.checkedAt) })}</span>
          <button type="button" className="btn sm ml-auto" onClick={readNow} disabled={reading}>
            <Glyph name="restart" size={14} /> {reading ? m.disks_smart_reading() : m.disks_smart_readNow()}
          </button>
        </div>
      )}
      {error && <p className="m-0 text-[13px] text-[#e3b341]">{error}</p>}
      {!report && !error && <p className="m-0 text-muted">{m.disks_smart_loading()}</p>}
      {report && !report.installed && (
        <section className="panel" aria-label={m.disks_smart_installLabel()}>
          <InstallHint feature="smart" what={m.disks_smart_notInstalled()} onInstalled={readNow} />
        </section>
      )}
      {report?.tempSensors && <TempSensorNote gap={report.tempSensors} />}
      {problems.length > 0 && (
        <section className={`panel flex flex-col gap-2 px-[18px] py-4 ${problems.some((p) => p.a.level === 'critical') ? 'alertcard' : ''}`} aria-label={m.disks_smart_actionNeeded()}>
          <h2 className="h2">{m.disks_smart_actionNeeded()}</h2>
          {problems.map(({ disk, a }) => (
            <p key={disk.name} className="m-0 text-[13px]">
              <span className="font-mono">{disk.name}</span> {disk.model ? `(${disk.model})` : ''}: {a.reasons.map(describeReason).join(' · ')}
            </p>
          ))}
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px] text-[#c9d1d9]">
            {hints.map((h) => (
              <li key={h}>→ {hintText(h)}</li>
            ))}
          </ul>
        </section>
      )}
      {report?.installed && (
        <>
          <div className="grid grid-cols-1 gap-[18px] xl:grid-cols-2">
            {assessed.map(({ disk, a }) => (
              <DiskCard key={disk.name} disk={disk} a={a} onDetail={() => setDetail(disk)} onReport={setReport} power={power?.disks.find((p) => p.name === disk.name)} wakes={power?.wakes[disk.name]} onPower={() => setPowerDisk(disk.name)} />
            ))}
          </div>
          <p className="m-0 text-[12px] text-muted" suppressHydrationWarning>
            {m.disks_smart_historyKept()}
          </p>
        </>
      )}
      {power && !power.installed && power.disks.length > 0 && (
        <section className="panel" aria-label={m.power_install()}>
          <InstallHint feature="hdparm" what={m.power_installWhat()} onInstalled={() => void api<PowerInfo>('/api/disks/power', { method: 'GET' }).then(setPower)} />
        </section>
      )}
      {power && powerDisk && power.disks.find((d) => d.name === powerDisk) && <PowerDialog disk={power.disks.find((d) => d.name === powerDisk)!} info={power} onClose={() => setPowerDisk(null)} onSaved={setPower} />}
      <DetailDialog disk={detail} baseline={detail ? report?.baselines?.[detail.id] : undefined} onClose={() => setDetail(null)} />
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

function DiskCard({ disk: d, a, onDetail, onReport, power, wakes, onPower }: { disk: SmartDisk; a: SmartAssessment; onDetail: () => void; onReport: (r: SmartReport) => void; power?: DiskPower; wakes?: number; onPower: () => void }) {
  const say = useToast()
  const guarded = useGuardedApi()
  const { readonly } = useActions()
  const attr = (id: number) => d.attributes.find((x) => x.id === id)
  const realloc = attr(5)
  const pending = attr(197)
  const pill = !d.supported
    ? { tone: 'idle' as Tone, label: m.disks_card_noSmart() }
    : d.standby
      ? { tone: 'idle' as Tone, label: m.disks_card_asleep() }
      : { tone: LEVEL_TONE[a.level], label: pickMsg({ ok: m.disks_level_ok, warning: m.disks_level_warning, critical: m.disks_level_critical }, a.level) }
  const test = async (type: 'short' | 'long') => {
    try {
      const r = await guarded<SmartReport>('/api/disks/smart', { body: { selftest: { disk: d.name, type } } })
      if (r) {
        onReport(r)
        say(type === 'short' ? m.disks_card_shortStarted({ name: d.name }) : m.disks_card_longStarted({ name: d.name }))
      }
    } catch (e) {
      say((e as Error).message, 'bad')
    }
  }
  return (
    <section className={`panel flex flex-col gap-3 p-[18px] ${a.level === 'critical' ? 'alertcard' : ''}`} aria-label={m.disks_card_diskLabel({ name: d.name })} data-testid="smart-disk">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 grow">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[15px] font-semibold">{d.name}</span>
            <Pill tone={pill.tone}>{pill.label}</Pill>
            {d.testRunning !== undefined && <Pill tone="warn">{m.disks_card_testRunning({ pct: d.testRunning })}</Pill>}
          </div>
          <div className="truncate text-[13px] text-muted">{[d.model, d.sizeBytes ? diskSize(d.sizeBytes) : '', kind(d)].filter(Boolean).join(' · ') || d.message}</div>
        </div>
        {d.supported && !d.standby && (
          <button type="button" className="btn sm" onClick={onDetail} aria-label={m.disks_card_detailsFor({ name: d.name })}>
            {m.disks_card_detailsButton()}
          </button>
        )}
      </div>
      {d.supported && !d.standby && (
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {d.temperature !== undefined && <Stat label={m.disks_card_temperature()} value={`${d.temperature} °C`} tone={d.temperature >= 60 ? 'bad' : d.temperature > 50 ? 'warn' : undefined} />}
          {d.powerOnHours !== undefined && <Stat label={m.disks_card_runtime()} value={years(d.powerOnHours)} />}
          {d.wearLevel !== undefined && <Stat label={m.disks_card_wear()} value={`${d.wearLevel} %`} tone={d.wearLevel >= 100 ? 'bad' : d.wearLevel >= 80 ? 'warn' : undefined} />}
          {realloc && <Stat label={m.disks_card_reallocated()} value={realloc.raw} tone={Number(realloc.raw) > 0 ? 'warn' : undefined} />}
          {pending && <Stat label={m.disks_card_pending()} value={pending.raw} tone={Number(pending.raw) > 0 ? 'warn' : undefined} />}
          {d.errorMedium !== undefined && <Stat label={m.disks_card_mediaErrors()} value={String(d.errorMedium)} tone={d.errorMedium > 0 ? 'warn' : undefined} />}
        </div>
      )}
      {a.reasons.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]" aria-label={m.disks_card_findings()}>
          {a.reasons.map((r, i) => (
            <li key={i} className={a.level === 'critical' ? 'text-[#ff8a80]' : 'text-[#e3b341]'}>
              {describeReason(r)}
            </li>
          ))}
        </ul>
      )}
      {a.notes.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[12px] text-muted" aria-label={m.disks_card_notes()}>
          {a.notes.map((n, i) => (
            <li key={i} suppressHydrationWarning>
              {describeNote(n)}
            </li>
          ))}
        </ul>
      )}
      {(!d.supported || d.standby) && <p className="m-0 text-[12px] text-muted">{d.standby ? m.disks_card_standbyText() : m.disks_card_unsupportedText({ msg: d.message ?? m.disks_card_noSmartCap() })}</p>}
      {power && <PowerRow disk={power} wakes={wakes} onEdit={onPower} />}
      {d.supported && !d.standby && !readonly && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3 text-[12px] text-muted">
          <span className="grow">{d.selfTests[0] ? m.disks_card_lastTest({ type: d.selfTests[0].type, status: d.selfTests[0].status }) : m.disks_card_noTest()}</span>
          <button type="button" className="btn sm" disabled={d.testRunning !== undefined} onClick={() => test('short')}>
            {m.disks_card_shortTest()}
          </button>
          <button type="button" className="btn sm" disabled={d.testRunning !== undefined} onClick={() => test('long')}>
            {m.disks_card_longTest()}
          </button>
        </div>
      )}
    </section>
  )
}

type Trends = Partial<Record<'temp' | 'realloc' | 'pending' | 'uncorrectable' | 'crc' | 'wear' | 'media' | 'startstop', [number, number][]>>

function DetailDialog({ disk: d, baseline, onClose }: { disk: SmartDisk | null; baseline?: SmartBaseline; onClose: () => void }) {
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
  const counters = trends
    ? (
        [
          ['realloc', m.disks_card_reallocated(), '#e3b341'],
          ['pending', m.disks_card_pending(), '#ff8a80'],
          ['crc', m.disks_detail_crcErrors(), '#b4a0ff'],
          ['media', m.disks_card_mediaErrors(), '#ff8a80'],
        ] as const
      ).filter(([k]) => trends[k]?.length)
    : []
  return (
    <Modal open={!!d} onClose={onClose} title={d ? `${d.name} · ${d.model ?? ''}` : ''} wide>
      {d && (
        <>
          <dl className="m-0 grid grid-cols-[auto_1fr_auto_1fr] gap-x-4 gap-y-1 text-[13px]">
            <dt className="text-muted">{m.disks_detail_serial()}</dt>
            <dd className="m-0 font-mono">{d.serial ?? '–'}</dd>
            <dt className="text-muted">Firmware</dt>
            <dd className="m-0 font-mono">{d.firmware ?? '–'}</dd>
            <dt className="text-muted">{m.disks_detail_powerOnHours()}</dt>
            <dd className="m-0 font-mono">{d.powerOnHours ?? '–'}</dd>
            <dt className="text-muted">{m.disks_detail_powerCycles()}</dt>
            <dd className="m-0 font-mono">{d.powerCycles ?? '–'}</dd>
            {d.family && (
              <>
                <dt className="text-muted">{m.disks_detail_family()}</dt>
                <dd className="m-0">{d.family}</dd>
              </>
            )}
            {d.unsafeShutdowns !== undefined && (
              <>
                <dt className="text-muted">{m.disks_detail_unsafeShutdowns()}</dt>
                <dd className="m-0 font-mono">{d.unsafeShutdowns}</dd>
              </>
            )}
          </dl>

          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={m.disks_detail_range()}>
            {[30, 90, 365].map((n) => (
              <button key={n} type="button" className={`seg ${days === n ? 'on' : ''}`} aria-pressed={days === n} onClick={() => setDays(n)}>
                {n === 365 ? m.disks_detail_oneYear() : m.disks_detail_days({ n })}
              </button>
            ))}
          </div>
          {trends && !trends.temp?.length && !counters.length && <p className="m-0 text-[13px] text-muted">{m.disks_detail_noHistory()}</p>}
          {!!trends?.temp?.length && (
            <section aria-label={m.disks_detail_tempHistory()} className="pb-5">
              <h3 className="m-0 mb-1 text-[13px] font-semibold">{m.disks_card_temperature()}</h3>
              <HistoryChart
                detailed
                label={`${d.name} ${m.disks_card_temperature()}`}
                series={[{ label: m.disks_card_temperature(), color: '#e3b341', points: trends.temp }]}
                span={span}
                now={now}
                format={(v) => `${Math.round(v)} °C`}
                height={110}
              />
            </section>
          )}
          {!!trends?.startstop && dailyWakes(trends.startstop).length > 1 && (
            <section aria-label={m.power_wakesHistory()} className="pb-5">
              <h3 className="m-0 mb-1 text-[13px] font-semibold">{m.power_wakesHistory()}</h3>
              <HistoryChart
                detailed
                label={`${d.name} ${m.power_wakesHistory()}`}
                series={[{ label: m.power_wakesHistory(), color: '#7cc4b8', points: dailyWakes(trends.startstop) }]}
                span={span}
                now={now}
                format={(v) => String(Math.round(v))}
                yMin={0}
                height={90}
              />
            </section>
          )}
          {counters.length > 0 && trends && (
            <section aria-label={m.disks_detail_errorCounters()} className="pb-5">
              <h3 className="m-0 mb-1 text-[13px] font-semibold">{m.disks_detail_errorCountersTitle()}</h3>
              <HistoryChart
                detailed
                label={`${d.name} ${m.disks_detail_errorCounters()}`}
                series={counters.map(([k, label, color]) => ({ label, color, points: trends[k]! }))}
                span={span}
                now={now}
                format={(v) => String(Math.round(v))}
                yMin={0}
                height={110}
              />
            </section>
          )}
          {!!trends?.wear?.length && (
            <section aria-label={m.disks_detail_wearHistory()} className="pb-5">
              <h3 className="m-0 mb-1 text-[13px] font-semibold">{m.disks_card_wear()}</h3>
              <HistoryChart
                detailed
                label={`${d.name} ${m.disks_card_wear()}`}
                series={[{ label: m.disks_card_wear(), color: '#7cc4b8', points: trends.wear }]}
                span={span}
                now={now}
                format={(v) => `${Math.round(v)} %`}
                yMin={0}
                height={90}
              />
            </section>
          )}

          {d.attributes.length > 0 && (
            <div className="max-h-[300px] overflow-auto rounded-[10px] border border-edge">
              <table className="tbl" aria-label={m.disks_detail_attributes()}>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>{m.disks_detail_attribute()}</th>
                    <th>{m.disks_detail_value()}</th>
                    <th>{m.disks_detail_worst()}</th>
                    <th>{m.disks_detail_threshold()}</th>
                    <th>{m.disks_detail_raw()}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.attributes.map((x) => {
                    const lvl = attributeLevel(x, baseline)
                    return (
                      <tr key={x.id} className={lvl === 'critical' ? 'text-[#ff8a80]' : lvl === 'warning' ? 'text-[#e3b341]' : ''}>
                        <td className="font-mono text-[12px]">{x.id}</td>
                        <td className="text-[12px]">
                          {x.name}
                          {x.prefailure ? <span className="ml-1 text-subtle">{m.disks_detail_prefailure()}</span> : null}
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
              <h3 className="m-0 mb-1 text-[13px] font-semibold">{m.disks_detail_selfTests()}</h3>
              {d.selfTests.slice(0, 5).map((st, i) => (
                <div key={i} className="flex gap-3 text-[12px]">
                  <span className={st.passed ? 'text-[#7ee2a8]' : 'text-[#ff8a80]'}>{st.passed ? '✓' : '✗'}</span>
                  <span className="w-[120px]">{st.type}</span>
                  <span className="grow">{st.status}</span>
                  {st.hours !== undefined && <span className="font-mono text-subtle">{m.disks_detail_atHours({ h: st.hours })}</span>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <div className="flex justify-end">
        <button type="button" className="btn" onClick={onClose}>
          {m.common_close()}
        </button>
      </div>
    </Modal>
  )
}

function TempSensorNote({ gap }: { gap: TempSensorGap }) {
  const disks = gap.disks.join(', ')
  return (
    <section className="panel flex flex-col gap-2 px-[18px] py-3 text-[13px]" aria-label={m.disks_temp_label()} data-testid="temp-sensor-note">
      {gap.drivetempLoaded ? (
        <p className="m-0 text-muted">{m.disks_temp_noSensor({ disks })}</p>
      ) : (
        <>
          <p className="m-0 text-[#e3b341]">{m.disks_temp_noModule({ disks })}</p>
          <div className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1">
            <span className="text-muted">{m.disks_temp_loadNow()}</span>
            <code className="font-mono text-[12px] break-all select-all">sudo modprobe drivetemp</code>
            <span className="text-muted">{m.disks_temp_loadAtBoot()}</span>
            <code className="font-mono text-[12px] break-all select-all">echo drivetemp | sudo tee /etc/modules-load.d/drivetemp.conf</code>
          </div>
        </>
      )}
    </section>
  )
}
