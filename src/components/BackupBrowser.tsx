import { useEffect, useState } from 'react'
import { api } from '~/lib/api'
import { bytes } from '~/lib/format'
import { localeOf } from '~/shared/i18n'
import type { BackupState, BackupSuggestion, LsEntry } from '~/shared/backup'
import { useActions } from './Actions'
import { BusyButton, useBusy } from './Busy'
import { useJobs } from './Jobs'
import { ConfirmDialog } from './Modal'
import { useToast } from './Toast'
import { useUnlock } from './Unlock'
import { m } from '~/paraglide/messages'
import { pickMsg } from '~/i18n'

const dateTime = (ts: number) => new Date(ts).toLocaleString(localeOf(), { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const nowLabel = (n: LsEntry['now']) => (n ? pickMsg({ same: m.backup_now_same, changed: m.backup_now_changed, missing: m.backup_now_missing }, n) : '')

const stamp = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

/** One snapshot like a file browser: folders, files, what changed since, download and restore. */
export function BackupBrowser({ state, snapshot, dir, onNavigate }: { state: BackupState; snapshot: string; dir?: string; onNavigate: (snapshot?: string, dir?: string) => void }) {
  const { readonly } = useActions()
  const jobs = useJobs()
  const unlock = useUnlock()
  const say = useToast()
  const snap = state.snapshots.find((s) => s.id === snapshot || s.short === snapshot)
  const [entries, setEntries] = useState<LsEntry[] | null>(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [where, setWhere] = useState<'new' | 'inplace'>('new')
  const [target, setTarget] = useState(`/srv/restore/${stamp()}`)
  const [confirm, setConfirm] = useState(false)
  const [suggestion, setSuggestion] = useState<BackupSuggestion | null>(null)
  // Without a folder: the common start of the backed-up paths.
  const start = dir ?? commonDir(snap?.paths ?? [])

  useEffect(() => {
    setEntries(null)
    setSelected([])
    setError('')
    api<{ entries: LsEntry[] }>(`/api/backup?snapshot=${encodeURIComponent(snapshot)}&dir=${encodeURIComponent(start)}`, { method: 'GET' })
      .then((r) => setEntries(r.entries))
      .catch((e: Error) => setError(e.message))
  }, [snapshot, start])
  useEffect(() => {
    api<BackupSuggestion>('/api/backup?suggest', { method: 'GET' })
      .then(setSuggestion)
      .catch(() => {})
  }, [])

  const crumbs = start === '/' ? [] : start.split('/').slice(1)
  const chosen = (entries ?? []).filter((e) => selected.includes(e.path))
  const size = chosen.reduce((n, e) => n + (e.size ?? 0), 0)
  // In place: stop what the plan stops, plus the containers whose folders are being restored.
  const stop = [...new Set([...(state.plan?.stop ?? []), ...(suggestion?.paths ?? []).filter((p) => p.path.startsWith('/') && selected.some((s) => s === p.path || s.startsWith(p.path + '/') || p.path.startsWith(s + '/'))).map((p) => suggestion!.stop.find((x) => x.from === p.from)?.unit).filter((u): u is string => !!u)])]

  const download = async (e: LsEntry) => {
    if (!(await unlock.ensure())) return
    window.location.href = `/api/backup?snapshot=${encodeURIComponent(snapshot)}&path=${encodeURIComponent(e.path)}`
  }
  const restoring = useBusy()
  const restore = async () => {
    const job = await jobs.start({ kind: 'backup-restore', snapshot, paths: selected, stop: where === 'inplace' ? stop : [], ...(where === 'new' ? { target } : {}) })
    if (job) setSelected([])
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn sm" onClick={() => onNavigate()}>
          ← Backups
        </button>
        <span className="grow" />
        <label className="flex items-center gap-2 text-[13px] text-muted">
          {m.backup_browse_state()}
          <select className="field !w-auto !py-1.5" value={snap?.id ?? snapshot} onChange={(e) => onNavigate(e.target.value, dir)}>
            {state.snapshots.map((s) => (
              <option key={s.id} value={s.id}>
                {dateTime(s.time)} · {s.short}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex flex-wrap items-start gap-[18px]">
        <section className="panel flex min-w-0 flex-[999_1_520px] flex-col" aria-label={m.backup_browse_files()}>
          <nav aria-label={m.backup_browse_path()} className="flex flex-wrap items-center gap-1.5 border-b border-line px-4 py-3 font-mono text-[13px] text-subtle">
            <button type="button" className="text-accent hover:text-accent-soft" onClick={() => onNavigate(snapshot, '/')}>
              /
            </button>
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-1.5">
                {i > 0 && <span aria-hidden="true">/</span>}
                {i === crumbs.length - 1 ? (
                  <span className="text-fg">{c}</span>
                ) : (
                  <button type="button" className="text-accent hover:text-accent-soft" onClick={() => onNavigate(snapshot, '/' + crumbs.slice(0, i + 1).join('/'))}>
                    {c}
                  </button>
                )}
              </span>
            ))}
          </nav>
          {error && (
            <p role="alert" className="m-0 px-4 py-3 text-[13px] text-[#ff8a80]">
              {error}
            </p>
          )}
          {!entries && !error && <p className="m-0 px-4 py-3 text-[13px] text-muted">{m.backup_loading()}</p>}
          {entries?.length === 0 && <p className="m-0 px-4 py-3 text-[13px] text-muted">{m.backup_browse_empty()}</p>}
          {!!entries?.length && (
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th className="w-[28px]">
                      <input type="checkbox" aria-label={m.backup_browse_all()} checked={entries.length > 0 && selected.length === entries.length} onChange={(e) => setSelected(e.target.checked ? entries.map((x) => x.path) : [])} />
                    </th>
                    <th>{m.backup_browse_name()}</th>
                    <th>{m.backup_browse_size()}</th>
                    <th>{m.backup_browse_changed()}</th>
                    <th>{m.backup_browse_today()}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.path} data-testid="backup-entry">
                      <td>
                        <input type="checkbox" aria-label={m.backup_browse_select({ name: e.name })} checked={selected.includes(e.path)} onChange={(ev) => setSelected(ev.target.checked ? [...selected, e.path] : selected.filter((p) => p !== e.path))} />
                      </td>
                      <td className="font-mono text-[13px]">
                        {e.type === 'dir' ? (
                          <button type="button" className="text-accent hover:text-accent-soft" onClick={() => onNavigate(snapshot, e.path)}>
                            {e.name}/
                          </button>
                        ) : (
                          e.name
                        )}
                      </td>
                      <td className="text-subtle">{e.type === 'file' ? bytes(e.size) : ''}</td>
                      <td className="text-subtle" suppressHydrationWarning>
                        {e.mtime ? dateTime(e.mtime) : ''}
                      </td>
                      <td>{e.now && e.now !== 'same' ? <span className={`chip ${e.now === 'missing' ? 'text-[#ff8a80]' : ''}`}>{nowLabel(e.now)}</span> : e.now ? <span className="text-[12px] text-muted">{nowLabel(e.now)}</span> : null}</td>
                      <td className="text-right">
                        {!readonly && e.type !== 'symlink' && e.type !== 'other' && (
                          <button type="button" className="btn sm" onClick={() => void download(e)} aria-label={m.backup_browse_downloadName({ name: e.name })}>
                            {e.type === 'dir' ? m.backup_browse_zip() : m.backup_browse_download()}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {!readonly && (
          <section className="panel flex flex-[1_1_300px] flex-col gap-3.5 p-[18px]" aria-label={m.backup_restore_title()}>
            <h2 className="h2">{selected.length ? m.backup_restore_selected({ n: selected.length }) : m.backup_restore_title()}</h2>
            {!selected.length && <p className="m-0 text-[13px] text-muted">{m.backup_restore_pick()}</p>}
            {selected.length > 0 && (
              <>
                <p className="m-0 font-mono text-[12px] break-all text-subtle">
                  {chosen.map((e) => e.name + (e.type === 'dir' ? '/' : '')).join(', ')}
                  {size > 0 ? ` · ${bytes(size)}` : ''}
                </p>
                <label className="flex items-start gap-2 text-[13px]">
                  <input type="radio" name="where" className="mt-0.5" checked={where === 'new'} onChange={() => setWhere('new')} />
                  <span className="flex min-w-0 grow flex-col gap-1.5">
                    {m.backup_restore_new()}
                    <input className="field !py-1.5 font-mono text-[12px]" value={target} aria-label={m.backup_restore_target()} disabled={where !== 'new'} onChange={(e) => setTarget(e.target.value.trim())} />
                  </span>
                </label>
                <label className="flex items-start gap-2 text-[13px]">
                  <input type="radio" name="where" className="mt-0.5" checked={where === 'inplace'} onChange={() => setWhere('inplace')} />
                  <span>
                    {m.backup_restore_inPlace()}
                    <span className="block text-[12px] text-[#e3b341]">{stop.length ? m.backup_restore_inPlaceStop({ units: stop.join(', ') }) : m.backup_restore_inPlaceWarn()}</span>
                  </span>
                </label>
                <BusyButton className="btn primary self-start" busy={restoring.is('new')} busyLabel={m.common_starting()} disabled={!!jobs.running || jobs.starting || (where === 'new' && !target.startsWith('/'))} onClick={() => (where === 'inplace' ? setConfirm(true) : void restoring.run('new', restore))}>
                  {m.backup_restore_start()}
                </BusyButton>
                <p className="m-0 text-[12px] text-muted">{m.backup_restore_job()}</p>
              </>
            )}
          </section>
        )}
      </div>
      <ConfirmDialog
        open={confirm}
        title={m.backup_restore_confirmTitle()}
        body={<p className="m-0">{m.backup_restore_confirmText({ n: selected.length, when: snap ? dateTime(snap.time) : snapshot })}</p>}
        confirm={m.backup_restore_start()}
        danger
        busyLabel={m.common_starting()}
        onConfirm={() => restore().catch((e: Error) => say(e.message, 'bad'))}
        onClose={() => setConfirm(false)}
      />
    </>
  )
}

/** The deepest folder all paths share ("/" when none). */
export function commonDir(paths: string[]): string {
  if (!paths.length) return '/'
  const parts = paths.map((p) => p.split('/').filter(Boolean))
  const out: string[] = []
  for (let i = 0; ; i++) {
    const seg = parts[0]![i]
    if (seg === undefined || parts.some((p) => p[i] !== seg)) break
    out.push(seg)
  }
  // A single path is itself the folder to show.
  return '/' + out.join('/')
}
