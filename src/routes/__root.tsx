import type { ReactNode } from 'react'
import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'
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
  notFoundComponent: () => (
    <div className="flex min-h-screen items-center justify-center text-muted">
      <p>
        Seite nicht gefunden. <a href="/">Zur Übersicht</a>
      </p>
    </div>
  ),
})

function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="de">
      <head>
        <HeadContent />
      </head>
      <body className="backdrop min-h-screen">
        {children}
        <Scripts />
      </body>
    </html>
  )
}
