import { createFileRoute } from '@tanstack/react-router'
import { TerminalPage } from '~/components/Terminal'
import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'
import { CONTAINER_NAME } from '~/shared/terminal'
import { isTerminalCommand, type TerminalCommand } from '~/shared/job-diagnosis'

export const Route = createFileRoute('/_app/terminal')({
  validateSearch: (s: Record<string, unknown>): { container?: string; type?: TerminalCommand } => ({
    container: typeof s.container === 'string' && CONTAINER_NAME.test(s.container) ? s.container : undefined,
    // only commands from a fixed list, typed but never run: a link can't make the shell do anything
    type: isTerminalCommand(s.type) ? s.type : undefined,
  }),
  head: () => ({ meta: [{ title: msg(m.page_title_terminal) }] }),
  component: () => {
    const { container, type } = Route.useSearch()
    return <TerminalPage container={container} type={type} />
  },
})
