import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '~/lib/api'
import { age, bytes, pct, relative } from '~/lib/format'
import {
  cleanupPlan,
  containerLabel,
  defaultSelection,
  imageLabel,
  planSize,
  removableContainer,
  shortId,
  storageSummary,
  type CleanupItem,
  type CleanupKind,
  type CleanupResult,
  type CleanupSelection,
  type PodmanImage,
  type PodmanStorage,
  type PodmanVolume,
  type PruneEvery,
} from '~/shared/podman-storage'
import { useActions } from './Actions'
import { BusyButton, Spinner, useBusy } from './Busy'
import { Modal } from './Modal'
import { useToast } from './Toast'
import { useGuardedApi } from './Unlock'
import { m } from '~/paraglide/messages'
import { pickMsg } from '~/i18n'

type Tab = 'images' | 'volumes' | 'containers'
type Cleaned = { results: CleanupResult[]; skipped: number; storage: PodmanStorage }

const kindLabel = (k: CleanupKind) => pickMsg({ container: m.podstore_kind_container, image: m.podstore_kind_image, volume: m.podstore_kind_volume, network: m.podstore_kind_network }, k)

/** System → Podman: what Podman keeps on disk, what uses it, and cleaning up with a preview. */
export function PodmanStorageCard() {
  const say = useToast()
  const guarded = useGuardedApi()
  const { readonly } = useActions()
  const [s, setS] = useState<PodmanStorage | null>(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<Tab>('images')
  const [cleaning, setCleaning] = useState(false)
  /** "kind:id" of the item being removed, "clean" for the cleanup dialog, "prune", "reload". */
  const work = useBusy()
  const busy = work.busy !== null

  const load = useCallback(async () => {
    try {
      setS(await api<PodmanStorage>('/api/podman/storage', { method: 'GET' }))
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  /** Removes items; returns the result for the dialog, or undefined (locked, error). */
  const remove = (items: CleanupItem[], key = items.length === 1 ? `${items[0]!.kind}:${items[0]!.id}` : 'clean'): Promise<Cleaned | undefined> =>
    work.run(key, async () => {
      try {
        const r = await guarded<Cleaned>('/api/podman/storage', { body: { items: items.map((i) => ({ kind: i.kind, id: i.id })) } })
        if (!r) return undefined
        setS(r.storage)
        const ok = r.results.filter((x) => x.ok)
        const failed = r.results.length - ok.length
        say(m.podstore_freed({ size: bytes(planSize(ok.map((x) => x.item))), n: ok.length }), failed || r.skipped ? 'bad' : undefined)
        return r
      } catch (e) {
        say((e as Error).message, 'bad')
        return undefined
      }
    })
  const setPrune = (every: PruneEvery | null) =>
    work.run('prune', async () => {
      try {
        const r = await guarded<PodmanStorage>('/api/podman/storage', { body: { prune: every } })
        if (r) {
          setS(r)
          say(every ? m.podstore_prune_on() : m.podstore_prune_off())
        }
      } catch (e) {
        say((e as Error).message, 'bad')
      }
    })

  const sum = useMemo(() => (s ? storageSummary(s) : undefined), [s])
  if (error)
    return (
      <section className="panel flex flex-col gap-2 p-[18px]" aria-label={m.podstore_title()}>
        <h2 className="h2">{m.podstore_title()}</h2>
        <p className="m-0 text-[13px] text-[#e3b341]">{error}</p>
      </section>
    )
  if (!s || !sum)
    return (
      <section className="panel p-[18px]" aria-label={m.podstore_title()}>
        <p className="m-0 text-muted">{m.podstore_loading()}</p>
      </section>
    )
  const total = sum.images.size + sum.volumes.size + sum.containers.size
  const tiles: [string, number, string, string | undefined][] = [
    [m.podstore_images(), sum.images.size, m.podstore_imagesCount({ n: sum.images.count }), sum.images.free ? m.podstore_freeUnused({ size: bytes(sum.images.free), n: sum.images.unused }) : undefined],
    [m.podstore_volumes(), sum.volumes.size, m.podstore_volumesCount({ n: sum.volumes.count }), sum.volumes.free || sum.volumes.unused ? m.podstore_freeOrphan({ size: bytes(sum.volumes.free), n: sum.volumes.unused }) : undefined],
    [m.podstore_containers(), sum.containers.size, m.podstore_containersCount({ n: sum.containers.count, running: sum.containers.running }), sum.containers.stopped ? m.podstore_freeStopped({ size: bytes(sum.containers.free), n: sum.containers.stopped }) : undefined],
  ]
  const stopped = s.containers.filter((c) => c.state !== 'running')

  return (
    <section className="panel flex flex-col gap-4 p-[18px]" aria-label={m.podstore_title()}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex grow flex-col gap-0.5">
          <h2 className="h2">{m.podstore_title()}</h2>
          <span className="text-[12px] text-muted">
            {s.root && <span className="font-mono">{s.root}</span>}
            {` · ${m.podstore_total({ size: bytes(total) })}`}
            {s.disk ? ` · ${m.podstore_disk({ percent: pct(s.disk.used / s.disk.size) })}` : ''}
          </span>
        </div>
        <BusyButton className="btn sm" busy={work.is('reload')} busyLabel={m.podstore_reloading()} disabled={busy} onClick={() => void work.run('reload', load)}>
          {m.podstore_reload()}
        </BusyButton>
        {!readonly && (
          <BusyButton className="btn primary sm" busy={work.is('clean')} busyLabel={m.podstore_cleaning()} disabled={busy} onClick={() => setCleaning(true)}>
            {m.podstore_clean()}
          </BusyButton>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {tiles.map(([label, size, count, free]) => (
          <div key={label} className="flex flex-col gap-1 rounded-[10px] border border-line p-3" data-testid="podstore-tile">
            <span className="label-caps">{label}</span>
            <span className="text-[20px] font-semibold">{bytes(size)}</span>
            <span className="text-[12px] text-subtle">{count}</span>
            {free && <span className="text-[12px] text-[#e3b341]">{free}</span>}
          </div>
        ))}
      </div>

      <div role="tablist" aria-label={m.podstore_lists()} className="flex flex-wrap gap-1.5">
        {(
          [
            ['images', m.podstore_images(), s.images.length],
            ['volumes', m.podstore_volumes(), s.volumes.length],
            ['containers', m.podstore_stoppedContainers(), stopped.length],
          ] as const
        ).map(([k, label, n]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={`seg ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>
            {label}
            <span className="opacity-60">{n}</span>
          </button>
        ))}
      </div>

      <div className="overflow-x-auto">
        {tab === 'images' && <ImagesTable s={s} busy={busy || readonly} removing={work.busy} onRemove={(i) => void remove([i])} />}
        {tab === 'volumes' && <VolumesTable s={s} busy={busy || readonly} removing={work.busy} onRemove={(i) => remove([i])} />}
        {tab === 'containers' && (
          <table className="tbl">
            <thead>
              <tr>
                <th>{m.podstore_col_container()}</th>
                <th>{m.podstore_col_image()}</th>
                <th>{m.podstore_col_state()}</th>
                <th>{m.podstore_col_size()}</th>
                <th>
                  <span className="sr-only">{m.podstore_col_actions()}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {stopped.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-muted">
                    {m.podstore_noStopped()}
                  </td>
                </tr>
              )}
              {stopped.map((c) => (
                <tr key={c.id} data-testid="podstore-row" className={work.is(`container:${c.id}`) ? 'opacity-60' : undefined}>
                  <td>
                    <span className="font-mono">{containerLabel(c)}</span>
                    {c.unit && <span className="block text-[12px] text-muted">{c.unit}</span>}
                  </td>
                  <td className="font-mono text-[12px]">{c.image}</td>
                  <td className="text-[13px]">
                    {c.state}
                    {c.exitCode !== undefined ? ` · Exit ${c.exitCode}` : ''}
                    {c.exitedAt ? <span className="block text-[12px] text-muted">{relative(c.exitedAt)}</span> : null}
                  </td>
                  <td>{bytes(c.size)}</td>
                  <td className="text-right">
                    {removableContainer(c) ? (
                      <BusyButton
                        className="btn sm danger"
                        busy={work.is(`container:${c.id}`)}
                        busyLabel={m.podstore_removing()}
                        disabled={busy || readonly}
                        onClick={() => void remove([{ kind: 'container', id: c.id, label: containerLabel(c), size: c.size }])}
                        aria-label={m.podstore_removeFor({ name: containerLabel(c) })}
                      >
                        {m.podstore_remove()}
                      </BusyButton>
                    ) : (
                      <span className="text-[12px] text-muted">{c.unit ? m.podstore_byQuadlet() : m.podstore_inPod()}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <PruneRow s={s} readonly={readonly} saving={work.is('prune')} disabled={busy} onChange={(e) => void setPrune(e)} />
      {cleaning && <CleanupDialog s={s} onClose={() => setCleaning(false)} remove={remove} />}
    </section>
  )
}

function usedByNames(s: PodmanStorage, ids: string[]) {
  return ids.map((id) => {
    const c = s.containers.find((x) => x.id === id)
    return c ? containerLabel(c) : shortId(id)
  })
}

function ImagesTable({ s, busy, removing, onRemove }: { s: PodmanStorage; busy: boolean; removing: string | null; onRemove: (i: CleanupItem) => void }) {
  // Unused first, then by size.
  const rows = [...s.images].sort((a, b) => Number(a.usedBy.length > 0 || a.quadlets.length > 0) - Number(b.usedBy.length > 0 || b.quadlets.length > 0) || b.size - a.size)
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>{m.podstore_col_image()}</th>
          <th>{m.podstore_col_size()}</th>
          <th>{m.podstore_col_age()}</th>
          <th>{m.podstore_col_usedBy()}</th>
          <th>
            <span className="sr-only">{m.podstore_col_actions()}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((i: PodmanImage) => {
          const users = usedByNames(s, i.usedBy)
          const unused = !users.length && !i.quadlets.length
          return (
            <tr key={i.id} data-testid="podstore-row" className={removing === `image:${i.id}` ? 'opacity-60' : unused ? 'bg-[#d29922]/[0.06]' : undefined}>
              <td>
                <span className="font-mono text-[13px]">{i.names[0] ?? m.podstore_untagged({ id: shortId(i.id) })}</span>
                {i.names.length > 1 && <span className="block font-mono text-[11px] text-muted">{i.names.slice(1).join(', ')}</span>}
                {i.dangling && <span className="block text-[12px] text-[#e3b341]">{i.previously ? m.podstore_oldVersionOf({ name: i.previously }) : m.podstore_oldVersion()}</span>}
              </td>
              <td>{bytes(i.size)}</td>
              <td className="text-[13px] text-subtle">{age(i.created)}</td>
              <td className="text-[13px]">{users.length ? users.join(', ') : i.quadlets.length ? m.podstore_quadletStopped({ files: i.quadlets.join(', ') }) : <span className="text-[#e3b341]">{m.podstore_nobody()}</span>}</td>
              <td className="text-right">
                {unused ? (
                  <BusyButton
                    className="btn sm danger"
                    busy={removing === `image:${i.id}`}
                    busyLabel={m.podstore_removing()}
                    disabled={busy}
                    onClick={() => onRemove({ kind: 'image', id: i.id, label: imageLabel(i), size: i.size })}
                    aria-label={m.podstore_removeFor({ name: imageLabel(i) })}
                  >
                    {m.podstore_remove()}
                  </BusyButton>
                ) : (
                  <span className="text-[12px] text-muted">{m.podstore_inUse()}</span>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function VolumesTable({ s, busy, removing, onRemove }: { s: PodmanStorage; busy: boolean; removing: string | null; onRemove: (i: CleanupItem) => Promise<unknown> }) {
  const [confirm, setConfirm] = useState<PodmanVolume | null>(null)
  const rows = [...s.volumes].sort((a, b) => Number(a.usedBy.length > 0) - Number(b.usedBy.length > 0) || (b.size ?? 0) - (a.size ?? 0))
  return (
    <>
      <table className="tbl">
        <thead>
          <tr>
            <th>{m.podstore_col_volume()}</th>
            <th>{m.podstore_col_size()}</th>
            <th>{m.podstore_col_created()}</th>
            <th>{m.podstore_col_usedBy()}</th>
            <th>
              <span className="sr-only">{m.podstore_col_actions()}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((v) => {
            const users = usedByNames(s, v.usedBy)
            const orphan = !users.length
            return (
              <tr key={v.name} data-testid="podstore-row" className={removing === `volume:${v.name}` ? 'opacity-60' : orphan ? 'bg-[#d29922]/[0.06]' : undefined}>
                <td>
                  <span className="font-mono text-[13px]">{v.anonymous ? `${shortId(v.name)}…` : v.name}</span>
                  <span className="block text-[12px] text-muted">
                    {[v.anonymous ? m.podstore_anonymous() : undefined, v.quadlet, orphan && !v.quadlet ? m.podstore_orphanHint() : undefined].filter(Boolean).join(' · ')}
                  </span>
                  {v.mountpoint && <span className="block font-mono text-[11px] text-faint">{v.mountpoint}</span>}
                </td>
                <td>{bytes(v.size)}</td>
                <td className="text-[13px] text-subtle">{v.created ? relative(v.created) : '–'}</td>
                <td className="text-[13px]">{users.length ? users.join(', ') : <span className="text-[#e3b341]">{m.podstore_nobody()}</span>}</td>
                <td className="text-right">
                  {orphan && !v.quadlet ? (
                    <BusyButton className="btn sm danger" busy={removing === `volume:${v.name}`} busyLabel={m.podstore_removing()} disabled={busy} onClick={() => setConfirm(v)} aria-label={m.podstore_removeFor({ name: v.name })}>
                      {m.podstore_removeDots()}
                    </BusyButton>
                  ) : (
                    <span className="text-[12px] text-muted">{orphan ? m.podstore_viaQuadlet() : m.podstore_inUse()}</span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {confirm && (
        <Modal open title={m.podstore_volumeConfirmTitle({ name: confirm.name })} onClose={() => setConfirm(null)} busy={removing === `volume:${confirm.name}`}>
          <p className="m-0 text-[13px]">{m.podstore_volumeWarning()}</p>
          <p className="m-0 text-[13px] text-muted">
            {bytes(confirm.size)}
            {confirm.mountpoint ? ` · ${confirm.mountpoint}` : ''}
          </p>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" disabled={removing === `volume:${confirm.name}`} onClick={() => setConfirm(null)}>
              {m.common_cancel()}
            </button>
            {/* stays open while Podman deletes, closes when done */}
            <BusyButton
              className="btn danger"
              busy={removing === `volume:${confirm.name}`}
              busyLabel={m.podstore_removing()}
              onClick={async () => {
                await onRemove({ kind: 'volume', id: confirm.name, label: confirm.name, size: confirm.size })
                setConfirm(null)
              }}
            >
              {m.podstore_volumeDelete()}
            </BusyButton>
          </div>
        </Modal>
      )}
    </>
  )
}

function CleanupDialog({ s, onClose, remove }: { s: PodmanStorage; onClose: () => void; remove: (items: CleanupItem[]) => Promise<Cleaned | undefined> }) {
  const [sel, setSel] = useState<CleanupSelection>(defaultSelection())
  const [volumesOn, setVolumesOn] = useState(false)
  const [done, setDone] = useState<Cleaned | null>(null)
  const [busy, setBusy] = useState(false)
  const [started, setStarted] = useState(0)
  const elapsed = useElapsed(busy ? started : 0)
  const orphans = cleanupPlan(s, { containers: sel.containers, dangling: false, unusedImages: false, networks: false, volumes: s.volumes.map((v) => v.name) }).filter((i) => i.kind === 'volume')
  const effective = { ...sel, volumes: volumesOn ? sel.volumes : [] }
  const plan = cleanupPlan(s, effective)
  /** What one checkbox adds (images and networks freed by removing the selected containers count). */
  const only = (k: keyof Omit<CleanupSelection, 'volumes'>, kind: CleanupKind) => cleanupPlan(s, { containers: sel.containers, dangling: false, unusedImages: false, networks: false, volumes: [], [k]: true }).filter((i) => i.kind === kind)
  const toggle = (k: keyof Omit<CleanupSelection, 'volumes'>) => setSel({ ...sel, [k]: !sel[k] })
  const run = async () => {
    setBusy(true)
    setStarted(Date.now())
    const r = await remove(plan)
    setBusy(false)
    if (r) setDone(r)
  }

  if (done) {
    const ok = done.results.filter((r) => r.ok)
    const failed = done.results.filter((r) => !r.ok)
    return (
      <Modal open title={m.podstore_cleanTitle()} onClose={onClose}>
        <p className="m-0 text-[15px] font-semibold">{m.podstore_freed({ size: bytes(planSize(ok.map((r) => r.item))), n: ok.length })}</p>
        {failed.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]" aria-label={m.podstore_failed()}>
            {failed.map((r) => (
              <li key={`${r.item.kind}:${r.item.id}`} className="text-[#f85149]">
                {kindLabel(r.item.kind)} {r.item.label}: {r.error}
              </li>
            ))}
          </ul>
        )}
        {done.skipped > 0 && <p className="m-0 text-[13px] text-muted">{m.podstore_skipped({ n: done.skipped })}</p>}
        <div className="flex justify-end">
          <button type="button" className="btn primary" onClick={onClose}>
            {m.podstore_close()}
          </button>
        </div>
      </Modal>
    )
  }

  const row = ({ k, label, help, list }: { k: keyof Omit<CleanupSelection, 'volumes'>; label: string; help: string; list: CleanupItem[] }) => (
    <label key={k} className="flex items-start gap-2.5 text-[13px]">
      <input type="checkbox" className="mt-0.5" checked={sel[k]} disabled={busy} onChange={() => toggle(k)} />
      <span className="grow">
        {label}
        <span className="block text-[12px] text-muted">{help}</span>
      </span>
      <span className="text-subtle">{list.length ? (planSize(list) ? bytes(planSize(list)) : m.podstore_items({ n: list.length })) : '–'}</span>
    </label>
  )

  return (
    <Modal open title={m.podstore_cleanTitle()} onClose={onClose} busy={busy}>
      <p className="m-0 text-[13px] text-muted">{m.podstore_cleanIntro()}</p>
      <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0">
        <legend className="label-caps mb-1.5 p-0">{m.podstore_safe()}</legend>
        {row({ k: 'containers', label: m.podstore_sel_containers(), help: m.podstore_sel_containersHelp(), list: only('containers', 'container') })}
        {row({ k: 'dangling', label: m.podstore_sel_dangling(), help: m.podstore_sel_danglingHelp(), list: only('dangling', 'image') })}
        {row({ k: 'networks', label: m.podstore_sel_networks(), help: m.podstore_sel_networksHelp(), list: only('networks', 'network') })}
      </fieldset>
      <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0">
        <legend className="label-caps mb-1.5 p-0">{m.podstore_thorough()}</legend>
        {row({ k: 'unusedImages', label: m.podstore_sel_unused(), help: m.podstore_sel_unusedHelp(), list: only('unusedImages', 'image') })}
      </fieldset>
      {orphans.length > 0 && (
        <div className="flex flex-col gap-2 rounded-[10px] border border-[#5b2a2a] bg-[#f85149]/[0.06] p-3">
          <label className="flex items-start gap-2.5 text-[13px]">
            <input type="checkbox" className="mt-0.5" checked={volumesOn} disabled={busy} onChange={(e) => setVolumesOn(e.target.checked)} />
            <span className="grow">
              <span className="font-medium text-[#f85149]">{m.podstore_sel_volumes()}</span>
              <span className="block text-[12px]">{m.podstore_volumeWarning()}</span>
            </span>
            <span className="text-subtle">{bytes(planSize(orphans))}</span>
          </label>
          {volumesOn && (
            <fieldset className="m-0 flex flex-col gap-1.5 border-0 py-0 pr-0 pl-6" aria-label={m.podstore_sel_volumes()}>
              {orphans.map((v) => (
                <label key={v.id} className="flex items-center gap-2 text-[13px]">
                  <input type="checkbox" checked={sel.volumes.includes(v.id)} disabled={busy} onChange={(e) => setSel({ ...sel, volumes: e.target.checked ? [...sel.volumes, v.id] : sel.volumes.filter((x) => x !== v.id) })} />
                  <span className="grow font-mono">{v.label}</span>
                  <span className="text-subtle">{bytes(v.size)}</span>
                </label>
              ))}
            </fieldset>
          )}
        </div>
      )}
      <div className="flex flex-col gap-2 rounded-[10px] border border-line p-3" aria-live="polite">
        <span className="text-[15px] font-semibold" data-testid="podstore-preview">
          {plan.length ? m.podstore_preview({ size: bytes(planSize(plan)), n: plan.length }) : m.podstore_previewNone()}
        </span>
        {plan.length > 0 && (
          <ul className="m-0 flex max-h-48 list-none flex-col gap-0.5 overflow-y-auto p-0 font-mono text-[12px] text-subtle" aria-label={m.podstore_previewList()}>
            {plan.map((i) => (
              <li key={`${i.kind}:${i.id}`}>
                {kindLabel(i.kind)} · {i.label}
                {i.size ? ` · ${bytes(i.size)}` : ''}
              </li>
            ))}
          </ul>
        )}
      </div>
      {busy ? (
        <p className="m-0 flex items-center gap-2 text-[13px] text-accent" aria-live="polite" data-testid="podstore-progress">
          <Spinner />
          {m.podstore_cleaningStatus({ n: plan.length, seconds: elapsed })}
        </p>
      ) : (
        <p className="m-0 text-[12px] text-muted">{m.podstore_cleanSafety()}</p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          {m.common_cancel()}
        </button>
        <BusyButton className="btn danger" busy={busy} busyLabel={m.podstore_cleaning()} disabled={plan.length === 0} onClick={() => void run()}>
          {m.podstore_cleanRun({ n: plan.length })}
        </BusyButton>
      </div>
    </Modal>
  )
}

function PruneRow({ s, readonly, saving, disabled, onChange }: { s: PodmanStorage; readonly: boolean; saving: boolean; disabled: boolean; onChange: (e: PruneEvery | null) => void }) {
  const p = s.prune
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex grow items-start gap-2.5 text-[13px]">
          <input type="checkbox" className="mt-0.5" checked={!!p} disabled={readonly || disabled} onChange={(e) => onChange(e.target.checked ? 'weekly' : null)} />
          <span>
            {m.podstore_prune()}
            <span className="block text-[12px] text-muted">{m.podstore_pruneHelp()}</span>
          </span>
        </label>
        {p && (
          <select className="field sm" aria-label={m.podstore_pruneEvery()} value={p.every} disabled={readonly || disabled} onChange={(e) => onChange(e.target.value as PruneEvery)}>
            <option value="weekly">{m.podstore_prune_weekly()}</option>
            <option value="monthly">{m.podstore_prune_monthly()}</option>
          </select>
        )}
        {saving && (
          <span className="flex items-center gap-1.5 text-[12px] text-accent" aria-live="polite">
            <Spinner />
            {m.common_saving()}
          </span>
        )}
      </div>
      {p && (
        <span className="pl-6 text-[12px] text-muted">
          {p.last ? m.podstore_pruneLast({ when: relative(p.last) }) : m.podstore_pruneNever()}
          {p.next ? ` · ${m.podstore_pruneNext({ when: relative(p.next) })}` : ''}
          {' · '}
          <span className="font-mono">quadeck-podman-prune.timer</span>
        </span>
      )}
    </div>
  )
}

/** Whole seconds since `since` (0 = not running), ticking once a second. */
function useElapsed(since: number) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!since) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [since])
  return since ? Math.max(0, Math.floor((now - since) / 1000)) : 0
}
