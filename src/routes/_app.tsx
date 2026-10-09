import { Link, Outlet, createFileRoute, redirect, useRouterState } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ActionsProvider } from '~/components/Actions'
import { CommandPalette } from '~/components/CommandPalette'
import { JobChip, JobsProvider } from '~/components/Jobs'
import { UnlockChip, UnlockProvider } from '~/components/Unlock'
import { LangSelect } from '~/components/AuthCard'
import { Glyph, Logo } from '~/components/Glyph'
import { MotionSelect } from '~/components/MotionSelect'
import { ThemeSelect } from '~/components/ThemeSelect'
import { PasskeysDialog } from '~/components/Passkeys'
import { Dot } from '~/components/Status'
import { ToastProvider } from '~/components/Toast'
import { api, setCsrfToken } from '~/lib/api'
import { duration } from '~/lib/format'
import { LiveProvider, useLiveState } from '~/lib/live'
import { getInitialSnapshot } from '~/lib/server-fns'
import { m } from '~/paraglide/messages'
import { pickMsg } from '~/i18n'

export const Route = createFileRoute('/_app')({
  beforeLoad: ({ context }) => {
    if (context.auth.state === 'setup') throw redirect({ to: '/setup' })
    if (context.auth.state !== 'ok') throw redirect({ to: '/login' })
    return { csrf: context.auth.csrf, readonly: context.auth.readonly }
  },
  loader: () => getInitialSnapshot(),
  staleTime: Infinity, // live updates come via SSE
  component: AppLayout,
})

function AppLayout() {
  const initial = Route.useLoaderData()
  const { csrf, readonly } = Route.useRouteContext()
  setCsrfToken(csrf)
  useEffect(() => setCsrfToken(csrf), [csrf])
  const [palette, setPalette] = useState(false)
  const [menu, setMenu] = useState(false)
  const closeMenu = useCallback(() => setMenu(false), [])
  return (
    <ToastProvider>
      <LiveProvider initial={initial}>
        <UnlockProvider>
          <JobsProvider>
            <ActionsProvider readonly={readonly}>
              <div className="grid min-h-screen grid-cols-1 md:grid-cols-[232px_minmax(0,1fr)]">
                <MobileBar onMenu={() => setMenu(true)} onSearch={() => setPalette(true)} />
                <Sidebar
                  open={menu}
                  onClose={closeMenu}
                  onSearch={() => {
                    setMenu(false)
                    setPalette(true)
                  }}
                />
                <main className="box-border flex w-full min-w-0 flex-col gap-[18px] px-4 pt-[22px] pb-12 md:px-7">
                  <Outlet />
                </main>
              </div>
              <CommandPalette open={palette} onOpenChange={setPalette} />
            </ActionsProvider>
          </JobsProvider>
        </UnlockProvider>
      </LiveProvider>
    </ToastProvider>
  )
}

type NavItem = { to: '/' | '/units' | '/journal' | '/disks' | '/files' | '/shares' | '/backups' | '/ssh' | '/terminal' | '/network' | '/system' | '/notifications' | '/users'; label: string; glyph: string; badge: number }

function useNav(): { title?: string; items: NavItem[] }[] {
  const { snapshot } = useLiveState()
  const failed = snapshot.units.filter((u) => u.active === 'failed').length
  const smart = (snapshot.smart ?? []).filter((d) => d.level !== 'ok').length
  return [
    { items: [{ to: '/', label: m.shell_nav_overview(), glyph: 'overview', badge: 0 }] },
    {
      title: m.shell_nav_services(),
      items: [
        { to: '/units', label: m.shell_nav_units(), glyph: 'units', badge: failed },
        { to: '/journal', label: m.shell_nav_journal(), glyph: 'journal', badge: 0 },
      ],
    },
    {
      title: m.shell_nav_storage(),
      items: [
        { to: '/disks', label: m.shell_nav_disks(), glyph: 'disk', badge: smart },
        { to: '/files', label: m.shell_nav_files(), glyph: 'file', badge: 0 },
        { to: '/shares', label: m.shell_nav_shares(), glyph: 'folder', badge: 0 },
        { to: '/backups', label: m.shell_nav_backups(), glyph: 'shield', badge: (snapshot.backup?.lastStatus === 'failed' ? 1 : 0) + (snapshot.backup?.stale?.length ?? 0) },
      ],
    },
    {
      title: m.shell_nav_server(),
      items: [
        { to: '/network', label: m.shell_nav_network(), glyph: 'network', badge: 0 },
        { to: '/users', label: m.shell_nav_users(), glyph: 'people', badge: 0 },
        { to: '/ssh', label: m.shell_nav_ssh(), glyph: 'key', badge: 0 },
        { to: '/terminal', label: m.shell_nav_terminal(), glyph: 'terminal', badge: 0 },
        { to: '/system', label: m.shell_nav_system(), glyph: 'package', badge: 0 },
        { to: '/notifications', label: m.shell_nav_notifications(), glyph: 'bell', badge: 0 },
      ],
    },
  ]
}

const Badge = ({ n }: { n: number }) => <span className="rounded-full bg-[rgba(248,81,73,.16)] px-2 py-px text-[11px] font-semibold text-[#ff8a80]">{n}</span>

/** Phones: a slim bar with the menu, the page's state and search instead of the whole sidebar above the content. */
function MobileBar({ onMenu, onSearch }: { onMenu: () => void; onSearch: () => void }) {
  const { snapshot, connected } = useLiveState()
  const problems = useNav()
    .flatMap((g) => g.items)
    .reduce((n, i) => n + i.badge, 0)
  return (
    <header className="sticky top-0 z-30 flex items-center gap-1 border-b border-line bg-bg/92 px-2 py-2 backdrop-blur md:hidden">
      <button type="button" className="relative grid h-10 w-10 place-items-center rounded-lg text-fg hover:bg-surface" onClick={onMenu} aria-label={m.shell_bar_openMenu()}>
        <Glyph name="menu" size={20} strokeWidth={2} />
        {problems > 0 && <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-[#f85149]" aria-label={m.shell_bar_problems({ n: problems })} />}
      </button>
      <Link to="/" className="flex min-w-0 grow items-center gap-2 text-fg no-underline">
        <Logo size={26} />
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="font-cond text-[17px] font-semibold">Quadeck</span>
          <span className="flex items-center gap-1.5 text-[11px] text-subtle">
            <Dot tone={connected ? 'ok' : 'warn'} label={connected ? m.shell_bar_connected() : m.shell_bar_connecting()} />
            <span className="truncate">{snapshot.host.hostname}</span>
          </span>
        </span>
      </Link>
      <JobChip compact />
      <UnlockChip compact />
      <button type="button" className="grid h-10 w-10 place-items-center rounded-lg text-muted hover:bg-surface" onClick={onSearch} aria-label={m.shell_bar_search()}>
        <Glyph name="search" size={19} strokeWidth={2} />
      </button>
    </header>
  )
}

function Sidebar({ open, onClose, onSearch }: { open: boolean; onClose: () => void; onSearch: () => void }) {
  const { snapshot, connected } = useLiveState()
  const path = useRouterState({ select: (s) => s.location.pathname })
  const nav = useNav()
  const h = snapshot.host
  const [passkeys, setPasskeys] = useState(false)

  // The drawer closes when a page is chosen, on Escape, and doesn't let the page behind scroll.
  useEffect(() => onClose(), [path]) // eslint-disable-line react-hooks/exhaustive-deps
  const closeButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', key)
    document.documentElement.style.overflow = 'hidden'
    // A modal drawer: focus moves into it, the page behind can't be reached with Tab or a screen
    // reader, and focus goes back where it was when the drawer closes.
    const before = document.activeElement as HTMLElement | null
    const behind = [...document.querySelectorAll<HTMLElement>('main, header')]
    for (const el of behind) el.inert = true
    closeButton.current?.focus()
    return () => {
      window.removeEventListener('keydown', key)
      document.documentElement.style.overflow = ''
      for (const el of behind) el.inert = false
      before?.focus?.()
    }
  }, [open, onClose])

  const problems = Object.entries(snapshot.sources).filter(([, s]) => !s.ok && s.error)
  return (
    <>
      <div className={`fixed inset-0 z-40 bg-black/55 transition-opacity md:hidden ${open ? 'opacity-100' : 'pointer-events-none opacity-0'}`} onClick={onClose} aria-hidden="true" />
      <aside
        aria-label={m.shell_nav_navigation()}
        className={`fixed inset-y-0 left-0 z-50 flex w-[280px] max-w-[85vw] flex-col gap-[16px] overflow-y-auto border-r border-line bg-sunken px-[14px] py-5 transition-[transform,visibility] duration-200 md:sticky md:top-0 md:z-auto md:visible md:h-screen md:w-auto md:max-w-none md:translate-x-0 md:bg-bg/85 ${open ? 'visible translate-x-0' : 'invisible -translate-x-full'}`}
      >
        <div className="flex items-center gap-[10px] px-[6px]">
          <Logo />
          <div className="grow font-cond text-[21px] font-semibold tracking-[.01em]">Quadeck</div>
          <button ref={closeButton} type="button" className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-surface md:hidden" onClick={onClose} aria-label={m.shell_bar_closeMenu()}>
            <Glyph name="close" size={18} strokeWidth={2} />
          </button>
        </div>
        <Link
          to="/hardware"
          title={m.shell_bar_hardwareTitle()}
          aria-label={m.shell_bar_hardwareLabel({ host: h.hostname })}
          className={`mx-1 flex flex-col gap-[3px] rounded-[10px] border p-3 text-[12px] text-subtle no-underline hover:border-rim-strong ${path === '/hardware' ? 'border-accent' : 'border-edge'}`}
        >
          <div className="flex items-center gap-2 text-[13px] font-medium text-fg">
            <Dot tone={connected ? 'ok' : 'warn'} label={connected ? m.shell_bar_connected() : m.shell_bar_connecting()} />
            {h.hostname}
          </div>
          <span>
            {h.os}
            {h.systemdVersion ? ` · systemd ${h.systemdVersion}` : ''}
          </span>
          <span>
            {h.podmanVersion ? `Podman ${h.podmanVersion} · ` : ''}
            {m.shell_bar_uptime({ duration: duration(h.uptimeSec) })}
          </span>
        </Link>
        <button type="button" className="btn mx-1 justify-start text-muted" onClick={onSearch} aria-keyshortcuts="Control+K">
          <Glyph name="search" size={15} strokeWidth={2} />
          <span className="grow text-left">{m.shell_bar_search()}</span>
          <kbd className="font-mono rounded border border-rim-strong px-1.5 py-0.5 text-[11px] max-md:hidden">{m.shell_bar_searchKey()}</kbd>
        </button>
        <UnlockChip />
        <JobChip />
        <nav aria-label={m.shell_nav_areas()} className="flex flex-col gap-[2px]">
          {nav.map((g, i) => (
            <div key={g.title ?? i} role="group" aria-label={g.title} className="flex flex-col gap-[2px]">
              {g.title && <div className="mt-2.5 mb-0.5 px-3 text-[10.5px] font-semibold tracking-[.08em] text-faint uppercase">{g.title}</div>}
              {g.items.map((n) => (
                <Link key={n.to} to={n.to} className={`navbtn max-md:min-h-[42px] ${path === n.to ? 'on' : ''}`} aria-current={path === n.to ? 'page' : undefined}>
                  <Glyph name={n.glyph} />
                  <span className="grow">{n.label}</span>
                  {n.badge > 0 && <Badge n={n.badge} />}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-2 px-2 text-[12px] text-faint">
          {snapshot.readonly && <span className="chip self-start">{m.shell_bar_readonly()}</span>}
          {problems.map(([k, s]) => (
            <span key={k} title={s.error} className="flex items-start gap-2 text-[#e3b341]">
              <Dot tone="warn" />
              <span className="line-clamp-2">
                {pickMsg({ "podman": m.shell_sources_podman, "systemd": m.shell_sources_systemd, "caddy": m.shell_sources_caddy, "disks": m.shell_sources_disks, "system": m.shell_sources_system, "smart": m.shell_sources_smart }, k) ?? k}: {s.error}
              </span>
            </span>
          ))}
          <button type="button" className="navbtn mt-1 !min-h-[34px] !px-0 text-[12px]" onClick={() => setPasskeys(true)}>
            <Glyph name="key" size={15} /> {m.shell_bar_passkeys()}
          </button>
          <PasskeysDialog open={passkeys} onClose={() => setPasskeys(false)} />
          <button
            type="button"
            className="navbtn !min-h-[34px] !px-0 text-[12px]"
            onClick={async () => {
              await api('/api/auth/logout').catch(() => {})
              window.location.href = '/login'
            }}
          >
            <Glyph name="logout" size={15} /> {m.shell_bar_logout()}
          </button>
          <ThemeSelect />
          <MotionSelect />
          <div className="flex items-center justify-between gap-2">
            <span>Quadeck {__APP_VERSION__}</span>
            <LangSelect />
          </div>
        </div>
      </aside>
    </>
  )
}
