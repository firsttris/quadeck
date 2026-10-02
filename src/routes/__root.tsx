import type { ReactNode } from 'react'
import { HeadContent, Outlet, Scripts, createRootRoute, useRouteContext } from '@tanstack/react-router'
import { I18nProvider, useT } from '~/i18n'
import { getAuthState } from '~/lib/server-fns'
import css from '~/styles.css?url'

export const Route = createRootRoute({
  beforeLoad: async () => ({ auth: await getAuthState() }),
  head: () => ({
    meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }, { name: 'color-scheme', content: 'dark' }, { title: 'Quadeck' }],
    links: [
      { rel: 'stylesheet', href: css },
      { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
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
  const t = useT().shell
  return (
    <div className="flex min-h-screen items-center justify-center text-muted">
      <p>
        {t.notFound} <a href="/">{t.toOverview}</a>
      </p>
    </div>
  )
}

function Document({ children }: { children: ReactNode }) {
  const lang = useRouteContext({ from: '__root__' }).auth.lang
  return (
    <html lang={lang}>
      <head>
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
