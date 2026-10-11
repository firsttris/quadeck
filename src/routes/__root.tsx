import { createRootRoute, HeadContent, Outlet, Scripts, useRouteContext } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { I18nProvider } from '~/i18n'
import { MOTION_INIT_SCRIPT } from '~/lib/motion'
import { getAuthState } from '~/lib/server-fns'
import { THEME_INIT_SCRIPT } from '~/lib/theme'
import { m } from '~/paraglide/messages'
import css from '~/styles.css?url'

export const Route = createRootRoute({
  beforeLoad: async () => ({ auth: await getAuthState() }),
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { name: 'color-scheme', content: 'dark' },
      // Installable from the browser ("add to home screen"); it opens without the browser's bars
      { name: 'theme-color', content: '#0b0f14' },
      { name: 'mobile-web-app-capable', content: 'yes' },
      { name: 'apple-mobile-web-app-title', content: 'Quadeck' },
      { name: 'apple-mobile-web-app-status-bar-style', content: 'black' },
      { title: 'Quadeck' },
    ],
    links: [
      { rel: 'stylesheet', href: css },
      { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
      { rel: 'manifest', href: '/manifest.webmanifest' },
      { rel: 'apple-touch-icon', href: '/icons/apple-touch-icon.png' },
    ],
  }),
  component: () => (
    <Document>
      <Outlet />
    </Document>
  ),
  notFoundComponent: NotFound,
})

function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center text-muted">
      <p>
        {m.shell_notFound()} <a href="/">{m.shell_toOverview()}</a>
      </p>
    </div>
  )
}

function Document({ children }: { children: ReactNode }) {
  const lang = useRouteContext({ from: '__root__' }).auth.lang
  return (
    // data-motion and data-theme are set by the init scripts before React hydrates
    <html lang={lang} suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: our own constant init scripts, they must run before the first paint */}
        <script dangerouslySetInnerHTML={{ __html: `${MOTION_INIT_SCRIPT};${THEME_INIT_SCRIPT}` }} />
        <HeadContent />
      </head>
      <body className="backdrop min-h-screen">
        <I18nProvider lang={lang}>
          {children}
          <Scripts />
        </I18nProvider>
      </body>
    </html>
  )
}
