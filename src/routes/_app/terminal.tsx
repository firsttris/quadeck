import { createFileRoute } from '@tanstack/react-router'
import { TerminalPage } from '~/components/Terminal'
import { msg } from '~/shared/i18n'
import { CONTAINER_NAME } from '~/shared/terminal'

export const Route = createFileRoute('/_app/terminal')({
  validateSearch: (s: Record<string, unknown>): { container?: string } => ({ container: typeof s.container === 'string' && CONTAINER_NAME.test(s.container) ? s.container : undefined }),
  head: () => ({ meta: [{ title: msg('page_title_terminal') }] }),
  component: () => <TerminalPage container={Route.useSearch().container} />,
})
