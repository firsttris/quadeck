import { useNavigate } from '@tanstack/react-router'
import { useCallback, useState } from 'react'
import { api } from '~/lib/api'
import { bytes, num, pct } from '~/lib/format'
import { USAGE_RANGES, type ContainerUsage, type UsageRange } from '~/shared/container-usage'
import { HistoryChart } from './HistoryChart'
import { Modal } from './Modal'
import { Sparkline } from './Sparkline'
import { m } from '~/paraglide/messages'
import { usePolling } from '~/lib/polling'

type Sort = 'cpu' | 'mem'
const cpuText = (v: number) => `${num(v, v < 10 ? 1 : 0)} %`
const rangeLabel = (r: UsageRange) => (r === '24h' ? m.usage_range_24h() : r === '7d' ? m.usage_range_7d() : m.usage_range_30d())

/** Units → Usage: which container used how much CPU and RAM over the last day, week or month. */
export function ContainerUsageView({ open }: { open?: string }) {
  const navigate = useNavigate()
  const [range, setRange] = useState<UsageRange>('24h')
  const [sort, setSort] = useState<Sort>('cpu')
  const [data, setData] = useState<{ containers: ContainerUsage[]; now: number } | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      setData(await api<{ containers: ContainerUsage[]; now: number }>(`/api/metrics/containers?range=${range}`, { method: 'GET' }))
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [range])
  usePolling(load, 60_000)

  const rows = [...(data?.containers ?? [])].sort((a, b) => (sort === 'cpu' ? b.cpuAvg - a.cpuAvg : b.memAvg - a.memAvg))
  const top = Math.max(1e-9, ...rows.map((r) => (sort === 'cpu' ? r.cpuAvg : r.memAvg)))
  const current = open ? data?.containers.find((c) => c.name === open) : undefined
  const close = () => void navigate({ to: '/units', search: { view: 'usage' } })

  return (
    <section className="panel flex flex-col gap-3 p-[18px]" aria-label={m.usage_title()}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex grow flex-col gap-0.5">
          <h2 className="h2">{m.usage_title()}</h2>
          <span className="text-[12px] text-muted">{m.usage_subtitle()}</span>
        </div>
        <div role="group" aria-label={m.usage_range()} className="flex gap-1.5">
          {(Object.keys(USAGE_RANGES) as UsageRange[]).map((r) => (
            <button key={r} type="button" className={`seg ${range === r ? 'on' : ''}`} aria-pressed={range === r} onClick={() => setRange(r)}>
              {rangeLabel(r)}
            </button>
          ))}
        </div>
        <div role="group" aria-label={m.usage_sort()} className="flex gap-1.5">
          <button type="button" className={`seg ${sort === 'cpu' ? 'on' : ''}`} aria-pressed={sort === 'cpu'} onClick={() => setSort('cpu')}>
            {m.usage_byCpu()}
          </button>
          <button type="button" className={`seg ${sort === 'mem' ? 'on' : ''}`} aria-pressed={sort === 'mem'} onClick={() => setSort('mem')}>
            {m.usage_byRam()}
          </button>
        </div>
      </div>
      {error && <p className="m-0 text-[13px] text-[#e3b341]">{error}</p>}
      <div className="overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>{m.usage_col_container()}</th>
              <th>{m.usage_col_cpu()}</th>
              <th className="hidden md:table-cell">{m.usage_col_cpuPeak()}</th>
              <th>{m.usage_col_ram()}</th>
              <th className="hidden md:table-cell">{m.usage_col_ramPeak()}</th>
              <th className="hidden lg:table-cell">{m.usage_col_running()}</th>
              <th className="hidden xl:table-cell">{m.usage_col_trend()}</th>
              <th>
                <span className="sr-only">{m.usage_col_actions()}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data && rows.length === 0 && (
              <tr>
                <td colSpan={8} className="text-muted">
                  {m.usage_none()}
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.name} data-testid="usage-row">
                <td>
                  <span className="font-mono text-[13px] font-medium">{r.name}</span>
                  {r.unit && <span className="block text-[12px] text-muted">{r.unit}</span>}
                  <span className="mt-1 block h-1 rounded bg-line" aria-hidden="true">
                    <span className="block h-1 rounded bg-accent" style={{ width: `${((sort === 'cpu' ? r.cpuAvg : r.memAvg) / top) * 100}%` }} />
                  </span>
                </td>
                <td className="font-mono text-[12px]">{cpuText(r.cpuAvg)}</td>
                <td className="hidden font-mono text-[12px] text-subtle md:table-cell">{cpuText(r.cpuMax)}</td>
                <td className="font-mono text-[12px]">{bytes(r.memAvg)}</td>
                <td className="hidden font-mono text-[12px] text-subtle md:table-cell">{bytes(r.memMax)}</td>
                <td className="hidden text-[12px] text-subtle lg:table-cell">{pct(r.uptime)}</td>
                <td className="hidden xl:table-cell">
                  <Sparkline values={r.cpu.map(([, v]) => v)} />
                </td>
                <td className="text-right">
                  <button type="button" className="btn sm" onClick={() => void navigate({ to: '/units', search: { view: 'usage', container: r.name } })} aria-label={m.usage_detailsFor({ name: r.name })}>
                    {m.usage_details()}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="m-0 text-[12px] text-muted">{m.usage_note()}</p>
      {open && data && (
        <Modal open title={m.usage_dialogTitle({ name: open })} onClose={close} wide>
          {current ? (
            <>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label={m.usage_range()}>
                {(Object.keys(USAGE_RANGES) as UsageRange[]).map((r) => (
                  <button key={r} type="button" className={`seg ${range === r ? 'on' : ''}`} aria-pressed={range === r} onClick={() => setRange(r)}>
                    {rangeLabel(r)}
                  </button>
                ))}
              </div>
              <section className="flex flex-col gap-2" aria-label="CPU">
                <h3 className="m-0 text-[13px] font-semibold">
                  CPU <span className="font-normal text-muted">{m.usage_stats({ avg: cpuText(current.cpuAvg), max: cpuText(current.cpuMax) })}</span>
                </h3>
                <div className="pb-5">
                  <HistoryChart
                    detailed
                    label={m.usage_chartCpu({ name: current.name })}
                    series={[
                      { label: m.usage_avg(), color: '#7cc4b8', points: current.cpu },
                      { label: m.usage_peak(), color: '#e3b341', points: current.cpuPeak },
                    ]}
                    span={USAGE_RANGES[range]}
                    now={data.now}
                    format={cpuText}
                    yMin={0}
                    height={150}
                  />
                </div>
              </section>
              <section className="flex flex-col gap-2" aria-label="RAM">
                <h3 className="m-0 text-[13px] font-semibold">
                  RAM <span className="font-normal text-muted">{m.usage_stats({ avg: bytes(current.memAvg), max: bytes(current.memMax) })}</span>
                </h3>
                <div className="pb-5">
                  <HistoryChart detailed label={m.usage_chartRam({ name: current.name })} series={[{ label: 'RAM', color: '#b4a0ff', points: current.mem }]} span={USAGE_RANGES[range]} now={data.now} format={(v) => bytes(v)} yMin={0} height={150} />
                </div>
              </section>
            </>
          ) : (
            <p className="m-0 text-[13px] text-muted">{m.usage_noData()}</p>
          )}
          <div className="flex justify-end">
            <button type="button" className="btn" onClick={close}>
              {m.common_close()}
            </button>
          </div>
        </Modal>
      )}
    </section>
  )
}
