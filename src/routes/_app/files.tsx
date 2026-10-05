import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useCallback } from 'react'
import { FileExplorer, type Side } from '~/components/FileExplorer'
import { PageHeader } from '~/components/PageHeader'
import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'

export const Route = createFileRoute('/_app/files')({
  // path: the (left) folder; right: the second pane's folder ("" = open, not chosen yet)
  validateSearch: (s: Record<string, unknown>): { path?: string; right?: string } => ({
    path: typeof s.path === 'string' && s.path.startsWith('/') ? s.path : undefined,
    right: typeof s.right === 'string' && (s.right === '' || s.right.startsWith('/')) ? s.right : undefined,
  }),
  head: () => ({ meta: [{ title: msg(m.page_title_files) }] }),
  component: FilesPage,
})

function FilesPage() {
  const { path, right } = Route.useSearch()
  const navigate = useNavigate()
  const onNavigate = useCallback((p: string, side?: Side) => void navigate({ to: '/files', search: (s) => (side === 'right' ? { ...s, right: p } : { ...s, path: p }) }), [navigate])
  const onTwoPanes = useCallback((r: string | null) => void navigate({ to: '/files', search: (s) => ({ ...s, right: r ?? undefined }) }), [navigate])
  return (
    <>
      <PageHeader title={m.files_page_title()} subtitle={m.files_page_subtitle()} />
      <FileExplorer path={path} right={right} onNavigate={onNavigate} onTwoPanes={onTwoPanes} />
    </>
  )
}
