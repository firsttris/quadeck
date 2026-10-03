import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { FileExplorer } from '~/components/FileExplorer'
import { PageHeader } from '~/components/PageHeader'
import { useT } from '~/i18n'
import { tr } from '~/shared/i18n'

export const Route = createFileRoute('/_app/files')({
  validateSearch: (s: Record<string, unknown>): { path?: string } => ({
    path: typeof s.path === 'string' && s.path.startsWith('/') ? s.path : undefined,
  }),
  head: () => ({ meta: [{ title: tr('Dateien · Quadeck', 'Files · Quadeck') }] }),
  component: FilesPage,
})

function FilesPage() {
  const { path } = Route.useSearch()
  const navigate = useNavigate()
  const t = useT().files
  return (
    <>
      <PageHeader title={t.page.title} subtitle={t.page.subtitle} />
      <FileExplorer path={path} onNavigate={(p) => void navigate({ to: '/files', search: { path: p } })} />
    </>
  )
}
