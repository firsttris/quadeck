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
import { useT, type Messages } from '~/i18n'
import { api } from '~/lib/api'
import { diskSize, num, relative } from '~/lib/format'
import { tr } from '~/shared/i18n'
import { assessSmart, attributeLevel, describeNote, describeReason, hintText, smartHints, type SmartAssessment, type SmartBaseline, type SmartDisk, type SmartLevel, type SmartReport } from '~/shared/smart'

export const Route = createFileRoute('/_app/disks')({
  // The file explorer used to be a tab here; old links land on its own page.
  validateSearch: (s: Record<string, unknown>): { tab?: 'files' | 'mounts'; path?: string } => ({
    tab: s.tab === 'files' || s.tab === 'mounts' ? s.tab : undefined,
    path: typeof s.path === 'string' && s.path.startsWith('/') ? s.path : undefined,
  }),
  beforeLoad: ({ search }) => {
    if (search.tab === 'files') throw redirect({ to: '/files', search: { path: search.path } })
  },
  head: () => ({ meta: [{ title: tr('Festplatten · Quadeck', 'Disks · Quadeck') }] }),
  component: DisksPage,
})

type T = Messages['disks']

const LEVEL_TONE: Record<SmartLevel, Tone> = { ok: 'ok', warning: 'warn', critical: 'bad' }

function kind(d: SmartDisk, t: T) {
  if (d.protocol === 'NVMe') return 'NVMe-SSD'
  if (d.rotationRate === 0) return 'SSD'
  if (d.rotationRate) return t.smart.hdd(d.rotationRate)
  return d.protocol ?? ''
}

const years = (h: number, t: T) => (h >= 8760 ? t.smart.years(num(h / 8760, 1)) : h >= 720 ? t.smart.months(Math.round(h / 720)) : `${h} h`)

function DisksPage() {
  const { tab } = Route.useSearch()
  const mounts = tab === 'mounts'
  const t = useT().disks
  return (
    <>
      <PageHeader title={t.page.title} subtitle={mounts ? t.page.subtitleMounts : t.page.subtitleSmart} />
      <div role="tablist" aria-label={t.page.area} className="flex flex-wrap gap-1.5">
        <Link to="/disks" search={{}} role="tab" aria-selected={!mounts} className={`seg ${!mounts ? 'on' : ''}`}>
          SMART
        </Link>
        <Link to="/disks" search={{ tab: 'mounts' }} role="tab" aria-selected={mounts} className={`seg ${mounts ? 'on' : ''}`}>
          {t.page.mountsTab}
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
  const tt = useT()
  const t = tt.disks.smart

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/disks/smart')
      const d = (await r.json()) as SmartReport & { error?: string }
      if (!r.ok) throw new Error(d.error ?? tt.common.http(r.status))
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

  const assessed = (report?.disks ?? []).map((d) => ({ disk: d, a: assessSmart(d, report?.baselines?.[d.id]) }))
  const hints = smartHints(assessed.map((x) => x.a))
  const problems = assessed.filter((x) => x.a.level !== 'ok')

  return (
    <>
      {report?.installed && (
        <div className="flex flex-wrap items-center gap-3 text-[12px] text-muted">
          <span suppressHydrationWarning>{t.readAt(relative(report.checkedAt))}</span>
          <button type="button" className="btn sm ml-auto" onClick={readNow} disabled={reading}>
            <Glyph name="restart" size={14} /> {reading ? t.reading : t.readNow}
          </button>
        </div>
      )}
      {error && <p className="m-0 text-[13px] text-[#e3b341]">{error}</p>}
      {!report && !error && <p className="m-0 text-muted">{t.loading}</p>}
      {report && !report.installed && (
        <section className="panel" aria-label={t.installLabel}>
          <InstallHint feature="smart" what={t.notInstalled} onInstalled={readNow} />
        </section>
      )}
      {problems.length > 0 && (
        <section className={`panel flex flex-col gap-2 px-[18px] py-4 ${problems.some((p) => p.a.level === 'critical') ? 'alertcard' : ''}`} aria-label={t.actionNeeded}>
          <h2 className="h2">{t.actionNeeded}</h2>
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
              <DiskCard key={disk.name} disk={disk} a={a} onDetail={() => setDetail(disk)} onReport={setReport} />
            ))}
          </div>
          <p className="m-0 text-[12px] text-muted" suppressHydrationWarning>
            {t.historyKept}
          </p>
        </>
      )}
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

function DiskCard({ disk: d, a, onDetail, onReport }: { disk: SmartDisk; a: SmartAssessment; onDetail: () => void; onReport: (r: SmartReport) => void }) {
  const say = useToast()
  const guarded = useGuardedApi()
  const { readonly } = useActions()
  const t = useT().disks
  const c = t.card
  const attr = (id: number) => d.attributes.find((x) => x.id === id)
  const realloc = attr(5)
  const pending = attr(197)
  const pill = !d.supported ? { tone: 'idle' as Tone, label: c.noSmart } : d.standby ? { tone: 'idle' as Tone, label: c.asleep } : { tone: LEVEL_TONE[a.level], label: t.level[a.level] }
  const test = async (type: 'short' | 'long') => {
    try {
      const r = await guarded<SmartReport>('/api/disks/smart', { body: { selftest: { disk: d.name, type } } })
      if (r) {
        onReport(r)
        say(type === 'short' ? c.shortStarted(d.name) : c.longStarted(d.name))
      }
    } catch (e) {
      say((e as Error).message, 'bad')
    }
  }
  return (
    <section className={`panel flex flex-col gap-3 p-[18px] ${a.level === 'critical' ? 'alertcard' : ''}`} aria-label={c.diskLabel(d.name)} data-testid="smart-disk">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 grow">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[15px] font-semibold">{d.name}</span>
            <Pill tone={pill.tone}>{pill.label}</Pill>
            {d.testRunning !== undefined && <Pill tone="warn">{c.testRunning(d.testRunning)}</Pill>}
          </div>
          <div className="truncate text-[13px] text-muted">{[d.model, d.sizeBytes ? diskSize(d.sizeBytes) : '', kind(d, t)].filter(Boolean).join(' · ') || d.message}</div>
        </div>
        {d.supported && !d.standby && (
          <button type="button" className="btn sm" onClick={onDetail} aria-label={c.detailsFor(d.name)}>
            {c.detailsButton}
          </button>
        )}
      </div>
      {d.supported && !d.standby && (
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {d.temperature !== undefined && <Stat label={c.temperature} value={`${d.temperature} °C`} tone={d.temperature >= 60 ? 'bad' : d.temperature > 50 ? 'warn' : undefined} />}
          {d.powerOnHours !== undefined && <Stat label={c.runtime} value={years(d.powerOnHours, t)} />}
          {d.wearLevel !== undefined && <Stat label={c.wear} value={`${d.wearLevel} %`} tone={d.wearLevel >= 100 ? 'bad' : d.wearLevel >= 80 ? 'warn' : undefined} />}
          {realloc && <Stat label={c.reallocated} value={realloc.raw} tone={Number(realloc.raw) > 0 ? 'warn' : undefined} />}
          {pending && <Stat label={c.pending} value={pending.raw} tone={Number(pending.raw) > 0 ? 'warn' : undefined} />}
          {d.errorMedium !== undefined && <Stat label={c.mediaErrors} value={String(d.errorMedium)} tone={d.errorMedium > 0 ? 'warn' : undefined} />}
        </div>
      )}
      {a.reasons.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]" aria-label={c.findings}>
          {a.reasons.map((r, i) => (
            <li key={i} className={a.level === 'critical' ? 'text-[#ff8a80]' : 'text-[#e3b341]'}>
              {describeReason(r)}
            </li>
          ))}
        </ul>
      )}
      {a.notes.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[12px] text-muted" aria-label={c.notes}>
          {a.notes.map((n, i) => (
            <li key={i} suppressHydrationWarning>
              {describeNote(n)}
            </li>
          ))}
        </ul>
      )}
      {(!d.supported || d.standby) && <p className="m-0 text-[12px] text-muted">{d.standby ? c.standbyText : c.unsupportedText(d.message ?? c.noSmartCap)}</p>}
      {d.supported && !d.standby && !readonly && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3 text-[12px] text-muted">
          <span className="grow">{d.selfTests[0] ? c.lastTest(d.selfTests[0].type, d.selfTests[0].status) : c.noTest}</span>
          <button type="button" className="btn sm" disabled={d.testRunning !== undefined} onClick={() => test('short')}>
            {c.shortTest}
          </button>
          <button type="button" className="btn sm" disabled={d.testRunning !== undefined} onClick={() => test('long')}>
            {c.longTest}
          </button>
        </div>
      )}
    </section>
  )
}

type Trends = Partial<Record<'temp' | 'realloc' | 'pending' | 'uncorrectable' | 'crc' | 'wear' | 'media', [number, number][]>>

function DetailDialog({ disk: d, baseline, onClose }: { disk: SmartDisk | null; baseline?: SmartBaseline; onClose: () => void }) {
  const [days, setDays] = useState(90)
  const [trends, setTrends] = useState<Trends | null>(null)
  const tt = useT()
  const t = tt.disks.detail
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
          ['realloc', tt.disks.card.reallocated, '#e3b341'],
          ['pending', tt.disks.card.pending, '#ff8a80'],
          ['crc', t.crcErrors, '#b4a0ff'],
          ['media', tt.disks.card.mediaErrors, '#ff8a80'],
        ] as const
      ).filter(([k]) => trends[k]?.length)
    : []
  return (
    <Modal open={!!d} onClose={onClose} title={d ? `${d.name} · ${d.model ?? ''}` : ''} wide>
      {d && (
        <>
          <dl className="m-0 grid grid-cols-[auto_1fr_auto_1fr] gap-x-4 gap-y-1 text-[13px]">
            <dt className="text-muted">{t.serial}</dt>
            <dd className="m-0 font-mono">{d.serial ?? '–'}</dd>
            <dt className="text-muted">Firmware</dt>
            <dd className="m-0 font-mono">{d.firmware ?? '–'}</dd>
            <dt className="text-muted">{t.powerOnHours}</dt>
            <dd className="m-0 font-mono">{d.powerOnHours ?? '–'}</dd>
            <dt className="text-muted">{t.powerCycles}</dt>
            <dd className="m-0 font-mono">{d.powerCycles ?? '–'}</dd>
            {d.family && (
              <>
                <dt className="text-muted">{t.family}</dt>
                <dd className="m-0">{d.family}</dd>
              </>
            )}
            {d.unsafeShutdowns !== undefined && (
              <>
                <dt className="text-muted">{t.unsafeShutdowns}</dt>
                <dd className="m-0 font-mono">{d.unsafeShutdowns}</dd>
              </>
            )}
          </dl>

          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t.range}>
            {[30, 90, 365].map((n) => (
              <button key={n} type="button" className={`seg ${days === n ? 'on' : ''}`} aria-pressed={days === n} onClick={() => setDays(n)}>
                {n === 365 ? t.oneYear : t.days(n)}
              </button>
            ))}
          </div>
          {trends && !trends.temp?.length && !counters.length && <p className="m-0 text-[13px] text-muted">{t.noHistory}</p>}
          {!!trends?.temp?.length && (
            <section aria-label={t.tempHistory} className="pb-5">
              <h3 className="m-0 mb-1 text-[13px] font-semibold">{tt.disks.card.temperature}</h3>
              <HistoryChart
                detailed
                label={`${d.name} ${tt.disks.card.temperature}`}
                series={[{ label: tt.disks.card.temperature, color: '#e3b341', points: trends.temp }]}
                span={span}
                now={now}
                format={(v) => `${Math.round(v)} °C`}
                height={110}
              />
            </section>
          )}
          {counters.length > 0 && trends && (
            <section aria-label={t.errorCounters} className="pb-5">
              <h3 className="m-0 mb-1 text-[13px] font-semibold">{t.errorCountersTitle}</h3>
              <HistoryChart
                detailed
                label={`${d.name} ${t.errorCounters}`}
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
            <section aria-label={t.wearHistory} className="pb-5">
              <h3 className="m-0 mb-1 text-[13px] font-semibold">{tt.disks.card.wear}</h3>
              <HistoryChart
                detailed
                label={`${d.name} ${tt.disks.card.wear}`}
                series={[{ label: tt.disks.card.wear, color: '#7cc4b8', points: trends.wear }]}
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
              <table className="tbl" aria-label={t.attributes}>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>{t.attribute}</th>
                    <th>{t.value}</th>
                    <th>{t.worst}</th>
                    <th>{t.threshold}</th>
                    <th>{t.raw}</th>
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
                          {x.prefailure ? <span className="ml-1 text-subtle">{t.prefailure}</span> : null}
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
              <h3 className="m-0 mb-1 text-[13px] font-semibold">{t.selfTests}</h3>
              {d.selfTests.slice(0, 5).map((st, i) => (
                <div key={i} className="flex gap-3 text-[12px]">
                  <span className={st.passed ? 'text-[#7ee2a8]' : 'text-[#ff8a80]'}>{st.passed ? '✓' : '✗'}</span>
                  <span className="w-[120px]">{st.type}</span>
                  <span className="grow">{st.status}</span>
                  {st.hours !== undefined && <span className="font-mono text-subtle">{t.atHours(st.hours)}</span>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <div className="flex justify-end">
        <button type="button" className="btn" onClick={onClose}>
          {tt.common.close}
        </button>
      </div>
    </Modal>
  )
}
