import { Link, Outlet, createFileRoute, redirect, useRouterState } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { ActionsProvider } from '~/components/Actions'
import { CommandPalette } from '~/components/CommandPalette'
import { JobChip, JobsProvider } from '~/components/Jobs'
import { UnlockChip, UnlockProvider } from '~/components/Unlock'
import { Glyph, Logo } from '~/components/Glyph'
import { Dot } from '~/components/Status'
import { ToastProvider } from '~/components/Toast'
import { api, setCsrfToken } from '~/lib/api'
import { duration } from '~/lib/format'
import { LiveProvider, useLive } from '~/lib/live'
import { getInitialSnapshot } from '~/lib/server-fns'

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
  return (
    <ToastProvider>
      <LiveProvider initial={initial}>
        <UnlockProvider>
        <JobsProvider>
        <ActionsProvider readonly={readonly}>
          <div className="grid min-h-screen grid-cols-1 md:grid-cols-[232px_minmax(0,1fr)]">
            <Sidebar onSearch={() => setPalette(true)} />
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

function Sidebar({ onSearch }: { onSearch: () => void }) {
  const { snapshot, connected } = useLive()
  const path = useRouterState({ select: (s) => s.location.pathname })
  const failed = snapshot.units.filter((u) => u.active === 'failed').length
  const h = snapshot.host
  const nav = [
    { to: '/', label: 'Übersicht', glyph: 'overview', badge: 0 },
    { to: '/units', label: 'Units', glyph: 'units', badge: failed },
    { to: '/journal', label: 'Journal', glyph: 'journal', badge: 0 },
    { to: '/quadlets', label: 'Quadlets', glyph: 'edit', badge: 0 },
    { to: '/shares', label: 'Freigaben', glyph: 'folder', badge: 0 },
    { to: '/ssh', label: 'SSH', glyph: 'key', badge: 0 },
    { to: '/system', label: 'System', glyph: 'package', badge: 0 },
  ] as const
  const problems = Object.entries(snapshot.sources).filter(([, s]) => !s.ok && s.error)
  return (
    <aside className="flex flex-col gap-[18px] border-b border-line bg-[rgba(13,17,23,.85)] px-[14px] py-5 md:sticky md:top-0 md:h-screen md:border-r md:border-b-0">
      <div className="flex items-center gap-[10px] px-[6px]">
        <Logo />
        <div className="font-cond text-[21px] font-semibold tracking-[.01em]">Quadeck</div>
      </div>
      <div className="mx-1 flex flex-col gap-[3px] rounded-[10px] border border-edge p-3 text-[12px] text-subtle">
        <div className="flex items-center gap-2 text-[13px] font-medium text-fg">
          <Dot tone={connected ? 'ok' : 'warn'} label={connected ? 'live verbunden' : 'Verbindung wird hergestellt'} />
          {h.hostname}
        </div>
        <span>
          {h.os}
          {h.systemdVersion ? ` · systemd ${h.systemdVersion}` : ''}
        </span>
        <span>
          {h.podmanVersion ? `Podman ${h.podmanVersion} · ` : ''}up {duration(h.uptimeSec)}
        </span>
      </div>
      <button type="button" className="btn mx-1 justify-start text-muted" onClick={onSearch} aria-keyshortcuts="Control+K">
        <Glyph name="search" size={15} strokeWidth={2} />
        <span className="grow text-left">Suchen</span>
        <kbd className="font-mono rounded border border-[#333a45] px-1.5 py-0.5 text-[11px]">Strg K</kbd>
      </button>
      <UnlockChip />
      <JobChip />
      <nav aria-label="Bereiche" className="flex flex-row flex-wrap gap-[2px] md:flex-col">
        {nav.map((n) => (
          <Link key={n.to} to={n.to} className={`navbtn ${path === n.to ? 'on' : ''}`} style={{ width: 'auto' }}>
            <Glyph name={n.glyph} />
            <span className="grow">{n.label}</span>
            {n.badge > 0 && <span className="rounded-full bg-[rgba(248,81,73,.16)] px-2 py-px text-[11px] font-semibold text-[#ff8a80]">{n.badge}</span>}
          </Link>
        ))}
      </nav>
      <div className="mt-auto flex flex-col gap-2 px-2 text-[12px] text-faint">
        {snapshot.readonly && <span className="chip self-start">Read-only</span>}
        {problems.map(([k, s]) => (
          <span key={k} title={s.error} className="flex items-start gap-2 text-[#e3b341]">
            <Dot tone="warn" />
            <span className="line-clamp-2">
              {SOURCE_LABEL[k] ?? k}: {s.error}
            </span>
          </span>
        ))}
        <button
          type="button"
          className="navbtn mt-1 !min-h-[34px] !px-0 text-[12px]"
          onClick={async () => {
            await api('/api/auth/logout').catch(() => {})
            window.location.href = '/login'
          }}
        >
          <Glyph name="logout" size={15} /> Abmelden
        </button>
        <span>Quadeck {__APP_VERSION__}</span>
      </div>
    </aside>
  )
}

const SOURCE_LABEL: Record<string, string> = { podman: 'Podman', systemd: 'systemd', caddy: 'Caddy', disks: 'Platten', system: 'System' }
