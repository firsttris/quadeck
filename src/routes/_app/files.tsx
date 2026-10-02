import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { FileExplorer } from '~/components/FileExplorer'
import { PageHeader } from '~/components/PageHeader'

export const Route = createFileRoute('/_app/files')({
  validateSearch: (s: Record<string, unknown>): { path?: string } => ({
    path: typeof s.path === 'string' && s.path.startsWith('/') ? s.path : undefined,
  }),
  head: () => ({ meta: [{ title: 'Dateien · Quadeck' }] }),
  component: FilesPage,
})

function FilesPage() {
  const { path } = Route.useSearch()
  const navigate = useNavigate()
  return (
    <>
      <PageHeader title="Dateien" subtitle="Dateien in den Datenbereichen – kopieren, verschieben, umbenennen, löschen" />
      <FileExplorer path={path} onNavigate={(p) => void navigate({ to: '/files', search: { path: p } })} />
    </>
  )
}
