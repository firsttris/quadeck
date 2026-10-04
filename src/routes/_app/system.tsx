import { Link, createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useActions } from '~/components/Actions'
import { BusyButton, useBusy } from '~/components/Busy'
import { Glyph } from '~/components/Glyph'
import { STATUS_LABEL, statusTone, useJobs } from '~/components/Jobs'
import { ConfirmDialog, Modal } from '~/components/Modal'
import { PageHeader } from '~/components/PageHeader'
import { PodmanSettingsView } from '~/components/PodmanSettings'
import { BootView } from '~/components/Boot'
import { ConfigFilesPanel } from '~/components/ConfigFiles'
import { Pill } from '~/components/Status'
import { api } from '~/lib/api'
import { bytes, relative } from '~/lib/format'
import { localeOf } from '~/shared/i18n'
import { REBOOT_PACKAGES, type ImageUpdatesReport, type InstalledPackage, type JobInfo, type NewsItem, type PackageDetail, type PackageOverview, type PackageUpdate, type RemovePreview, type UpdatesReport } from '~/shared/packages'
import { m } from '~/paraglide/messages'
import { pickMsg } from '~/i18n'

type Tab = 'updates' | 'packages' | 'podman' | 'boot'

export const Route = createFileRoute('/_app/system')({
  validateSearch: (s: Record<string, unknown>): { tab?: Tab } => ({ tab: s.tab === 'packages' || s.tab === 'podman' || s.tab === 'boot' ? s.tab : undefined }),
  head: () => ({ meta: [{ title: 'System · Quadeck' }] }),
  component: SystemPage,
})

type Overview = PackageOverview & { news?: { items: NewsItem[]; error?: string } }

/** GET JSON with reload; reloads whenever a job ends. */
function useData<T>(url: string) {
  const { finished } = useJobs()
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    try {
      const r = await fetch(url)
      const d = (await r.json()) as T & { error?: string }
      if (!r.ok) throw new Error(d.error ?? m.common_http({ status: r.status }))
      setData(d)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [url])
  useEffect(() => {
    void load()
  }, [load, finished])
  return { data, error, setData, reload: load }
}

function SystemPage() {
  const { tab = 'updates' } = Route.useSearch()
  const overview = useData<Overview>('/api/system/overview')
  const o = overview.data
  return (
    <>
      <PageHeader title={m.system_page_title()} subtitle={o ? (o.manager ? m.system_page_subtitle({ manager: o.label, aur: o.aur?.helper ?? "", hasAur: String(!!o.aur?.helper) }) : m.system_page_noManager()) : m.system_page_defaultSubtitle()} />
      <div role="tablist" aria-label={m.system_page_tabs()} className="flex flex-wrap gap-1.5">
        <Link to="/system" search={{}} role="tab" aria-selected={tab === 'updates'} className={`seg ${tab === 'updates' ? 'on' : ''}`}>
          {m.system_page_updates()}
        </Link>
        <Link to="/system" search={{ tab: 'packages' }} role="tab" aria-selected={tab === 'packages'} className={`seg ${tab === 'packages' ? 'on' : ''}`}>
          {m.system_page_installed()}
        </Link>
        <Link to="/system" search={{ tab: 'podman' }} role="tab" aria-selected={tab === 'podman'} className={`seg ${tab === 'podman' ? 'on' : ''}`}>
          {m.system_page_podman()}
        </Link>
        <Link to="/system" search={{ tab: 'boot' }} role="tab" aria-selected={tab === 'boot'} className={`seg ${tab === 'boot' ? 'on' : ''}`}>
          {m.system_page_boot()}
        </Link>
      </div>
      {overview.error && <p className="m-0 text-[13px] text-[#e3b341]">{overview.error}</p>}
      {o?.rebootRequired && tab !== 'boot' && (
        <section className="panel alertcard flex flex-wrap items-center gap-3 px-[18px] py-3" aria-label={m.system_page_rebootNeeded()}>
          <Glyph name="restart" />
          <div className="grow">
            <div className="font-medium">{m.system_page_rebootRecommended()}</div>
            <div className="text-[13px] text-muted">{o.rebootReason}</div>
          </div>
          <Link to="/system" search={{ tab: 'boot' }} className="btn sm">
            {m.system_page_rebootDots()}
          </Link>
        </section>
      )}
      {tab === 'updates' ? <Updates overview={o} onOverviewChanged={() => void overview.reload()} /> : tab === 'packages' ? <Packages overview={o} /> : tab === 'boot' ? <BootView rebootReason={o?.rebootReason} /> : <PodmanSettingsView />}
    </>
  )
}

// ---------- Updates ----------

function Updates({ overview: o, onOverviewChanged }: { overview: Overview | null; onOverviewChanged: () => void }) {
  const jobs = useJobs()
  const { readonly } = useActions()
  const updates = useData<UpdatesReport>('/api/system/updates')
  const images = useData<ImageUpdatesReport>('/api/system/images')
  const history = useData<{ jobs: JobInfo[] }>('/api/jobs')
  const [checking, setChecking] = useState(false)
  const [confirm, setConfirm] = useState<null | 'upgrade' | 'aur' | 'images'>(null)
  const u = updates.data
  const busy = !!jobs.running || jobs.starting
  const imageStart = useBusy()

  const check = async () => {
    setChecking(true)
    try {
      const [a, b] = await Promise.allSettled([api<UpdatesReport>('/api/system/updates'), api<ImageUpdatesReport>('/api/system/images')])
      if (a.status === 'fulfilled') updates.setData(a.value)
      if (b.status === 'fulfilled') images.setData(b.value)
    } finally {
      setChecking(false)
    }
  }

  const rebootPkgs = (u?.repo ?? []).filter((x) => REBOOT_PACKAGES.test(x.name)).map((x) => x.name)
  const pendingImages = (images.data?.items ?? []).filter((i) => i.updated === 'pending')
  const news = o?.news?.items ?? []
  const unread = news.filter((n) => o?.lastUpgrade && n.date > o.lastUpgrade)
  const canAct = !readonly

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 text-[13px] text-muted">
        <span suppressHydrationWarning>{u ? m.system_updates_lastChecked({ when: relative(u.checkedAt) }) : updates.error ? '' : m.system_updates_checking()}</span>
        {o?.lastUpgrade && <span suppressHydrationWarning>{m.system_updates_lastUpgrade({ when: relative(o.lastUpgrade) })}</span>}
        <button type="button" className="btn sm ml-auto" onClick={check} disabled={checking}>
          <Glyph name="restart" size={14} /> {checking ? m.system_updates_checkingShort() : m.system_updates_checkNow()}
        </button>
      </div>

      {news.length > 0 && (
        <section className="panel flex flex-col" aria-label={m.system_updates_news()}>
          <div className="flex items-baseline gap-2 px-[18px] pt-4 pb-2">
            <h2 className="h2">{m.system_updates_news()}</h2>
            {unread.length > 0 && <Pill tone="warn">{m.system_updates_newSince({ n: unread.length })}</Pill>}
            <span className="ml-auto text-[12px] text-muted">{m.system_updates_readFirst()}</span>
          </div>
          {news.slice(0, 4).map((n) => (
            <a key={n.link} href={n.link} target="_blank" rel="noreferrer" className="flex items-center gap-3 border-t border-line px-[18px] py-[9px] hover:bg-[rgba(255,255,255,.03)]">
              <span className={`grow text-[13px] ${unread.includes(n) ? 'font-medium text-fg' : 'text-[#c9d1d9]'}`}>{n.title}</span>
              <span className="font-mono text-[12px] text-subtle">{new Date(n.date).toLocaleDateString(localeOf())}</span>
            </a>
          ))}
          {o?.news?.error && <p className="m-0 border-t border-line px-[18px] py-2 text-[12px] text-[#e3b341]">{o.news.error}</p>}
        </section>
      )}

      <UpdateTable
        title={m.system_updates_systemPackages({ label: o?.label ?? "", hasLabel: String(!!o?.label) })}
        items={u?.repo}
        error={u?.error ?? updates.error}
        empty={m.system_updates_upToDate()}
        note={rebootPkgs.length ? m.system_updates_rebootAfter({ pkgs: rebootPkgs.join(', ') }) : undefined}
        action={
          canAct && u?.repo.length ? (
            <button type="button" className="btn primary sm" disabled={busy} onClick={() => setConfirm('upgrade')}>
              <Glyph name="download" size={14} /> {m.system_updates_updateAllN({ n: u.repo.length })}
            </button>
          ) : undefined
        }
      />

      {o?.manager === 'pacman' && (
        <UpdateTable
          title="AUR"
          items={u?.aur}
          error={u?.aurError}
          empty={m.system_updates_noAur()}
          note={!o.aur?.helper ? m.system_updates_noHelper() : !o.aur.user ? m.system_updates_noAurUser() : m.system_updates_buildsAs({ user: o.aur.user, helper: o.aur.helper })}
          action={
            canAct && u?.aur.length && o.aur?.helper && o.aur.user ? (
              <button type="button" className="btn sm" disabled={busy} onClick={() => setConfirm('aur')}>
                <Glyph name="download" size={14} /> {m.system_updates_updateAur({ n: u.aur.length })}
              </button>
            ) : undefined
          }
        />
      )}

      <section className="panel flex flex-col" aria-label={m.system_updates_images()}>
        <div className="flex flex-wrap items-center gap-2 px-[18px] pt-4 pb-2">
          <h2 className="h2">{m.system_updates_images()}</h2>
          {pendingImages.length > 0 && <Pill tone="warn">{m.system_updates_imageUpdates({ n: pendingImages.length })}</Pill>}
          {canAct && pendingImages.length > 0 && (
            <button type="button" className="btn sm ml-auto" disabled={busy} onClick={() => setConfirm('images')}>
              <Glyph name="download" size={14} /> {m.system_updates_updateAll()}
            </button>
          )}
        </div>
        {images.data?.error || images.error ? (
          <p className="m-0 border-t border-line px-[18px] py-3 text-[13px] text-[#e3b341]">{images.data?.error ?? images.error}</p>
        ) : !images.data ? (
          <p className="m-0 border-t border-line px-[18px] py-3 text-[13px] text-muted">{m.system_updates_checking()}</p>
        ) : images.data.items.length === 0 ? (
          <p className="m-0 border-t border-line px-[18px] py-3 text-[13px] text-muted">
            {m.system_updates_noAutoUpdateBefore()} <span className="font-mono">AutoUpdate=registry</span> {m.system_updates_noAutoUpdateAfter()}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{m.system_updates_container()}</th>
                  <th>{m.system_updates_image()}</th>
                  <th className="hidden md:table-cell">{m.system_updates_unit()}</th>
                  <th>{m.common_status()}</th>
                  <th>
                    <span className="sr-only">{m.common_actions()}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {images.data.items.map((i) => (
                  <tr key={i.unit + i.container} data-testid="image-row">
                    <td className="font-mono text-[13px]">{i.container}</td>
                    <td className="max-w-[360px] truncate font-mono text-[12px] text-muted">{i.image}</td>
                    <td className="hidden font-mono text-[12px] md:table-cell">{i.unit}</td>
                    <td>
                      <Pill tone={i.updated === 'pending' ? 'warn' : i.updated === 'failed' ? 'bad' : 'ok'}>{i.updated === 'pending' ? m.system_updates_updateAvailable() : i.updated === 'false' ? m.system_updates_current() : i.updated}</Pill>
                    </td>
                    <td className="text-right">
                      {canAct && i.updated === 'pending' && (
                        <BusyButton className="btn sm" busy={imageStart.is(i.unit)} busyLabel={m.common_starting()} disabled={busy} onClick={() => void imageStart.run(i.unit, () => jobs.start({ kind: 'image-update', unit: i.unit }))} aria-label={m.system_updates_updateOne({ name: i.container })}>
                          {m.system_updates_update()}
                        </BusyButton>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="m-0 border-t border-line px-[18px] py-2 text-[12px] text-muted">{m.system_updates_imagesHint()}</p>
      </section>

      {o && o.configFiles.length > 0 && <ConfigFilesPanel files={o.configFiles} hint={o.configHint} onChanged={onOverviewChanged} />}

      {(history.data?.jobs.length ?? 0) > 0 && (
        <section className="panel flex flex-col" aria-label={m.system_updates_recentJobs()}>
          <h2 className="h2 px-[18px] pt-4 pb-2">{m.system_updates_recentJobs()}</h2>
          {history.data!.jobs.map((j) => (
            <div key={j.id} className="flex items-center gap-3 border-t border-line px-[18px] py-[8px]">
              <Pill tone={statusTone(j.status)}>{STATUS_LABEL[j.status]}</Pill>
              <span className="grow truncate text-[13px]">{j.title}</span>
              <span className="font-mono text-[12px] text-subtle" suppressHydrationWarning>
                {relative(j.startedAt)}
              </span>
              <button type="button" className="btn sm" onClick={() => jobs.show(j.id)}>
                {m.system_updates_output()}
              </button>
            </div>
          ))}
        </section>
      )}

      <ConfirmDialog
        open={confirm === 'upgrade'}
        title={m.system_updates_upgradeTitle()}
        confirm={m.system_updates_update()}
        body={
          <p className="m-0">
            {m.system_updates_upgradeBody({ n: u?.repo.length ?? 0, label: o?.label ?? '' })}
            {unread.length > 0 && m.system_updates_unreadNews()}
            {rebootPkgs.length > 0 && m.system_updates_rebootAfterShort()}
          </p>
        }
        onConfirm={() => jobs.start({ kind: 'upgrade' })}
        busyLabel={m.common_starting()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'aur'}
        title={m.system_updates_aurTitle()}
        confirm={m.system_updates_update()}
        body={<p className="m-0">{m.system_updates_aurBody({ helper: o?.aur?.helper ?? '', n: u?.aur.length ?? 0, user: o?.aur?.user ?? '' })}</p>}
        onConfirm={() => jobs.start({ kind: 'aur-upgrade' })}
        busyLabel={m.common_starting()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'images'}
        title={m.system_updates_imagesTitle()}
        confirm={m.system_updates_update()}
        body={<p className="m-0">{m.system_updates_imagesBody({ names: (pendingImages.map((i) => i.container).join(', ')) })}</p>}
        onConfirm={() => jobs.start({ kind: 'images-update' })}
        busyLabel={m.common_starting()}
        onClose={() => setConfirm(null)}
      />
    </>
  )
}

function UpdateTable({ title, items, error, empty, note, action }: { title: string; items?: PackageUpdate[]; error?: string; empty: string; note?: string; action?: React.ReactNode }) {
  return (
    <section className="panel flex flex-col" aria-label={title}>
      <div className="flex flex-wrap items-center gap-2 px-[18px] pt-4 pb-2">
        <h2 className="h2">{title}</h2>
        {!!items?.length && <Pill tone="warn">{items.length}</Pill>}
        {action && <span className="ml-auto">{action}</span>}
      </div>
      {error ? (
        <p className="m-0 border-t border-line px-[18px] py-3 text-[13px] text-[#e3b341]">{error}</p>
      ) : !items ? (
        <p className="m-0 border-t border-line px-[18px] py-3 text-[13px] text-muted">{m.system_updates_checking()}</p>
      ) : items.length === 0 ? (
        <p className="m-0 border-t border-line px-[18px] py-3 text-[13px] text-muted">{empty}</p>
      ) : (
        <div className="max-h-[420px] overflow-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>{m.system_updates_package()}</th>
                <th>{m.system_updates_version()}</th>
                <th className="hidden sm:table-cell">{m.system_updates_source()}</th>
                <th className="hidden md:table-cell">{m.system_updates_download()}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((x) => (
                <tr key={x.name} data-testid="update-row">
                  <td className="font-mono text-[13px]">{x.name}</td>
                  <td className="font-mono text-[12px]">
                    <span className="text-muted">{x.from || m.system_updates_new()}</span> <span className="text-subtle">→</span> <span className="text-accent">{x.to}</span>
                  </td>
                  <td className="hidden text-[12px] text-muted sm:table-cell">{x.repo ?? '–'}</td>
                  <td className="hidden font-mono text-[12px] text-muted md:table-cell">{x.downloadSize ? bytes(x.downloadSize) : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {note && <p className="m-0 border-t border-line px-[18px] py-2 text-[12px] text-muted">{note}</p>}
    </section>
  )
}

// ---------- Installed packages ----------

type PkgFilter = 'all' | 'explicit' | 'dependency' | 'foreign' | 'orphan'
const PKG_FILTERS: PkgFilter[] = ['all', 'explicit', 'dependency', 'foreign', 'orphan']
const PAGE = 200

function pkgMatches(p: InstalledPackage, f: PkgFilter) {
  if (f === 'all') return true
  if (f === 'foreign') return !!p.foreign
  if (f === 'orphan') return !!p.orphan
  return p.reason === f
}

function Packages({ overview: o }: { overview: Overview | null }) {
  const { readonly } = useActions()
  const list = useData<{ packages: InstalledPackage[] }>('/api/system/packages')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<PkgFilter>('all')
  const [sort, setSort] = useState<'name' | 'size'>('name')
  const [limit, setLimit] = useState(PAGE)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [detail, setDetail] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string[] | null>(null)
  const pkgs = list.data?.packages
  const prot = useMemo(() => new Set(o?.protected ?? []), [o])
  const canRemove = !readonly && !!o?.canRemove

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    const res = (pkgs ?? []).filter((p) => pkgMatches(p, filter) && (!q || p.name.toLowerCase().includes(q) || p.description?.toLowerCase().includes(q)))
    return sort === 'size' ? res.sort((a, b) => (b.size ?? 0) - (a.size ?? 0)) : res.sort((a, b) => a.name.localeCompare(b.name))
  }, [pkgs, query, filter, sort])
  const counts = useMemo(() => Object.fromEntries(PKG_FILTERS.map((k) => [k, (pkgs ?? []).filter((p) => pkgMatches(p, k)).length])), [pkgs])
  const totalSize = shown.reduce((s, p) => s + (p.size ?? 0), 0)

  useEffect(() => setLimit(PAGE), [query, filter, sort])
  // Drop selections that disappeared (removed packages).
  useEffect(() => setSelected((s) => new Set([...s].filter((n) => pkgs?.some((p) => p.name === n)))), [pkgs])

  const toggle = (name: string) =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(name)) n.delete(name)
      else n.add(name)
      return n
    })

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <input className="field w-full sm:w-[280px]" type="search" placeholder={m.system_packages_searchPlaceholder()} aria-label={m.system_packages_search()} value={query} onChange={(e) => setQuery(e.target.value)} />
        <div role="group" aria-label={m.system_packages_filter()} className="flex flex-wrap gap-1.5">
          {PKG_FILTERS.filter((k) => k === 'all' || counts[k]).map((k) => (
            <button key={k} type="button" className={`seg ${filter === k ? 'on' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>
              {pickMsg({ "all": m.system_packages_filters_all, "explicit": m.system_packages_filters_explicit, "dependency": m.system_packages_filters_dependency, "foreign": m.system_packages_filters_foreign, "orphan": m.system_packages_filters_orphan }, k)}
              <span className="opacity-60">{counts[k]}</span>
            </button>
          ))}
        </div>
        <label className="ml-auto flex items-center gap-2 text-[12px] text-muted">
          {m.system_packages_sort()}
          <select className="field !py-1" value={sort} onChange={(e) => setSort(e.target.value as 'name' | 'size')}>
            <option value="name">{m.common_name()}</option>
            <option value="size">{m.common_size()}</option>
          </select>
        </label>
      </div>
      {list.error && <p className="m-0 text-[13px] text-[#e3b341]">{list.error}</p>}
      {selected.size > 0 && (
        <div className="panel flex flex-wrap items-center gap-3 px-[18px] py-2.5 text-[13px]" role="region" aria-label={m.system_packages_selection()}>
          <span>{m.system_packages_selected({ n: selected.size })}</span>
          <button type="button" className="btn sm" onClick={() => setSelected(new Set())}>
            {m.system_packages_clearSelection()}
          </button>
          {canRemove && (
            <button type="button" className="btn danger sm ml-auto" onClick={() => setRemoving([...selected])}>
              <Glyph name="trash" size={14} /> {m.system_packages_removeDots()}
            </button>
          )}
        </div>
      )}
      <div className="panel relative overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              {canRemove && (
                <th className="w-8">
                  <span className="sr-only">{m.system_packages_selection()}</span>
                </th>
              )}
              <th>{m.system_packages_package()}</th>
              <th className="hidden md:table-cell">{m.system_packages_version()}</th>
              <th className="hidden sm:table-cell">{m.common_size()}</th>
              <th className="hidden lg:table-cell">{m.system_packages_reason()}</th>
            </tr>
          </thead>
          <tbody>
            {!pkgs && !list.error && (
              <tr>
                <td colSpan={5} className="text-muted">
                  {m.common_loading()}
                </td>
              </tr>
            )}
            {pkgs && shown.length === 0 && (
              <tr>
                <td colSpan={5} className="text-muted">
                  {m.system_packages_noneInSelection()}
                </td>
              </tr>
            )}
            {shown.slice(0, limit).map((p) => (
              <tr key={p.name} data-testid="package-row" className="cursor-pointer" onClick={() => setDetail(p.name)}>
                {canRemove && (
                  <td onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" aria-label={m.system_packages_select({ name: p.name })} checked={selected.has(p.name)} disabled={prot.has(p.name)} onChange={() => toggle(p.name)} />
                  </td>
                )}
                <td className="max-w-[460px]">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button type="button" className="font-mono text-[13px] font-medium hover:underline" onClick={() => setDetail(p.name)}>
                      {p.name}
                    </button>
                    {p.foreign && <span className="chip q">{o?.manager === 'pacman' ? 'AUR' : m.system_packages_foreign()}</span>}
                    {p.orphan && <span className="chip">{m.system_packages_orphan()}</span>}
                    {prot.has(p.name) && <span className="chip">{m.system_packages_protected()}</span>}
                  </div>
                  {p.description && <div className="truncate text-[12px] text-muted">{p.description}</div>}
                </td>
                <td className="hidden font-mono text-[12px] md:table-cell">{p.version}</td>
                <td className="hidden font-mono text-[12px] sm:table-cell">{p.size !== undefined ? bytes(p.size) : '–'}</td>
                <td className="hidden text-[12px] text-subtle lg:table-cell">{p.reason === 'explicit' ? m.system_packages_explicit() : p.reason === 'dependency' ? m.system_packages_filters_dependency() : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-[12px] text-muted">
        <span>
          {m.system_packages_count({ n: shown.length })}
          {totalSize ? ` · ${bytes(totalSize)}` : ''}
        </span>
        {filter === 'orphan' && canRemove && shown.length > 0 && (
          <button type="button" className="btn sm" onClick={() => setRemoving(shown.map((p) => p.name))}>
            {m.system_packages_removeOrphans()}
          </button>
        )}
        {shown.length > limit && (
          <button type="button" className="btn sm ml-auto" onClick={() => setLimit((l) => l + PAGE)}>
            {m.system_packages_showMore({ n: Math.min(PAGE, shown.length - limit) })}
          </button>
        )}
      </div>
      <PackageDialog name={detail} canRemove={canRemove} onOpen={setDetail} onRemove={(n) => setRemoving([n])} onClose={() => setDetail(null)} />
      <RemoveDialog
        names={removing}
        onClose={() => setRemoving(null)}
        onStarted={() => {
          setSelected(new Set())
          setDetail(null)
        }}
      />
    </>
  )
}

function NameList({ title, names, onOpen }: { title: string; names: string[]; onOpen: (n: string) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[12px] font-medium text-muted">
        {title} ({names.length})
      </div>
      {names.length === 0 ? (
        <span className="text-[13px] text-subtle">–</span>
      ) : (
        <div className="flex max-h-[120px] flex-wrap gap-1 overflow-y-auto">
          {names.map((n) => {
            const target = n.split(/[<>=: ]/)[0]!
            return (
              <button key={n} type="button" className="chip hover:border-accent" onClick={() => onOpen(target)}>
                {n}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function PackageDialog({ name, canRemove, onOpen, onRemove, onClose }: { name: string | null; canRemove: boolean; onOpen: (n: string) => void; onRemove: (n: string) => void; onClose: () => void }) {
  const [d, setD] = useState<PackageDetail | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    setD(null)
    setError('')
    if (!name) return
    let stop = false
    fetch(`/api/system/packages/${encodeURIComponent(name)}`)
      .then(async (r) => {
        const data = (await r.json()) as PackageDetail & { error?: string }
        if (!r.ok) throw new Error(data.error ?? m.common_http({ status: r.status }))
        if (!stop) setD(data)
      })
      .catch((e: Error) => !stop && setError(e.message))
    return () => {
      stop = true
    }
  }, [name])
  return (
    <Modal open={!!name} onClose={onClose} title={name ?? ''} wide>
      {error && (
        <p role="alert" className="m-0 text-[13px] text-[#ff8a80]">
          {error}
        </p>
      )}
      {!d && !error && <p className="m-0 text-muted">{m.common_loading()}</p>}
      {d && (
        <>
          {d.description && <p className="m-0 text-[#c9d1d9]">{d.description}</p>}
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
            <dt className="text-muted">{m.system_packages_version()}</dt>
            <dd className="m-0 font-mono">{d.version}</dd>
            {d.size !== undefined && (
              <>
                <dt className="text-muted">{m.common_size()}</dt>
                <dd className="m-0 font-mono">{bytes(d.size)}</dd>
              </>
            )}
            {d.reason && (
              <>
                <dt className="text-muted">{m.system_packages_installed()}</dt>
                <dd className="m-0">
                  {d.reason === 'explicit' ? m.system_packages_explicit() : m.system_packages_asDependency()}
                  {d.installedAt ? ` · ${new Date(d.installedAt).toLocaleDateString(localeOf())}` : ''}
                </dd>
              </>
            )}
            {d.url && (
              <>
                <dt className="text-muted">{m.system_packages_website()}</dt>
                <dd className="m-0 truncate">
                  <a className="text-accent hover:underline" href={/^https?:\/\//.test(d.url) ? d.url : undefined} target="_blank" rel="noreferrer">
                    {d.url}
                  </a>
                </dd>
              </>
            )}
          </dl>
          <NameList title={m.system_packages_dependsOn()} names={d.depends} onOpen={onOpen} />
          <NameList title={m.system_packages_requiredBy()} names={d.requiredBy} onOpen={onOpen} />
          {!!d.optionalFor?.length && <NameList title={m.system_packages_optionalFor()} names={d.optionalFor} onOpen={onOpen} />}
          {d.protected && <p className="m-0 text-[12px] text-muted">{m.system_packages_protectedHint()}</p>}
        </>
      )}
      <div className="flex justify-end gap-2">
        {d && canRemove && !d.protected && (
          <button type="button" className="btn danger mr-auto" onClick={() => onRemove(d.name)}>
            <Glyph name="trash" size={14} /> {m.system_packages_removeDots()}
          </button>
        )}
        <button type="button" className="btn" onClick={onClose}>
          {m.common_close()}
        </button>
      </div>
    </Modal>
  )
}

function RemoveDialog({ names, onClose, onStarted }: { names: string[] | null; onClose: () => void; onStarted: () => void }) {
  const jobs = useJobs()
  const [preview, setPreview] = useState<RemovePreview | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    setPreview(null)
    setError('')
    if (!names) return
    api<RemovePreview>('/api/system/remove-preview', { body: { names } })
      .then(setPreview)
      .catch((e: Error) => setError(e.message))
  }, [names])
  const ok = preview && !preview.error && preview.blocked.length === 0 && preview.packages.length > 0
  return (
    <Modal open={!!names} onClose={onClose} busy={jobs.starting} title={names?.length === 1 ? m.system_packages_removeOne({ name: (names[0]!) }) : m.system_packages_removeMany({ n: (names?.length ?? 0) })}>
      {!preview && !error && <p className="m-0 text-muted">{m.system_packages_previewing()}</p>}
      {(error || preview?.error) && (
        <pre role="alert" className="joblog !min-h-0 text-[#ff8a80]">
          {error || preview?.error}
        </pre>
      )}
      {preview && !preview.error && (
        <>
          <p className="m-0 text-[13px] text-[#c9d1d9]">{m.system_packages_removesN({ n: preview.packages.length })}</p>
          <ul className="m-0 flex max-h-[240px] list-none flex-col overflow-y-auto rounded-lg border border-edge p-0" aria-label={m.system_packages_toBeRemoved()}>
            {preview.packages.map((p) => (
              <li key={p.name} className="flex justify-between gap-3 border-b border-line px-3 py-1.5 font-mono text-[12px] last:border-b-0">
                <span className={preview.blocked.includes(p.name) ? 'text-[#ff8a80]' : ''}>{p.name}</span>
                <span className="text-muted">{p.version}</span>
              </li>
            ))}
          </ul>
          {preview.blocked.length > 0 && (
            <p role="alert" className="m-0 text-[13px] text-[#ff8a80]">
              {m.system_packages_blocked({ names: preview.blocked.join(', ') })}
            </p>
          )}
        </>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" disabled={jobs.starting} onClick={onClose}>
          {m.common_cancel()}
        </button>
        <BusyButton
          className="btn danger"
          busy={jobs.starting}
          busyLabel={m.common_starting()}
          disabled={!ok || !!jobs.running}
          onClick={async () => {
            const job = await jobs.start({ kind: 'remove', names: names! })
            if (job) {
              onStarted()
              onClose()
            }
          }}
        >
          {preview ? m.system_packages_removeN({ n: preview.packages.length }) : m.common_remove()}
        </BusyButton>
      </div>
    </Modal>
  )
}
