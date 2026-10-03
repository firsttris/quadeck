import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { FileExplorer } from '~/components/FileExplorer'
import { PageHeader } from '~/components/PageHeader'
import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'

export const Route = createFileRoute('/_app/files')({
  validateSearch: (s: Record<string, unknown>): { path?: string } => ({
    path: typeof s.path === 'string' && s.path.startsWith('/') ? s.path : undefined,
  }),
  head: () => ({ meta: [{ title: msg('page_title_files') }] }),
  component: FilesPage,
})

function FilesPage() {
  const { path } = Route.useSearch()
  const navigate = useNavigate()
  return (
    <>
      <PageHeader title={m.files_page_title()} subtitle={m.files_page_subtitle()} />
      <FileExplorer path={path} onNavigate={(p) => void navigate({ to: '/files', search: { path: p } })} />
    </>
  )
}
