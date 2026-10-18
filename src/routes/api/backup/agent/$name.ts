import { createFileRoute } from '@tanstack/react-router'
import { m } from '~/paraglide/messages'
import { HttpError } from '~/server/auth'
import { assertWritable } from '~/server/guard'
import { errorResponse, readText } from '~/server/http'
import { localize } from '~/server/lang'
import { privileged } from '~/server/privileged'
import { CLIENT_NAME } from '~/shared/backup'
import { AGENT_BODY_MAX, AGENT_KINDS, type AgentKind } from '~/shared/backup-agent'
import { msg } from '~/shared/i18n'

// What a backup client's `quadeck-backup` asks by itself (no login: its token, renewed with every
// setup script, is the authorisation; the helper checks it): ?do=settings|plan (GET),
// inventory|report (POST, lines), propose|preview (POST, a plan as JSON). See shared/backup-agent.ts.
const READS: AgentKind[] = ['settings', 'plan']

async function handle(request: Request, name: string, method: 'GET' | 'POST') {
  try {
    const kind = new URL(request.url).searchParams.get('do') as AgentKind
    if (!CLIENT_NAME.test(name) || !AGENT_KINDS.includes(kind) || READS.includes(kind) !== (method === 'GET')) throw new HttpError(400, msg(m.common_errors_unknownRequest))
    const auth = request.headers.get('authorization') ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    if (kind === 'propose') assertWritable()
    const body = method === 'POST' ? await readText(request, AGENT_BODY_MAX) : ''
    const reply = await privileged().backupAgent(name, token, kind, body)
    if ('text' in reply) return new Response(reply.text, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })
    return Response.json(reply.json, { headers: { 'cache-control': 'no-store' } })
  } catch (e) {
    // The client prints the message: plain text, in English (no viewer language here).
    const status = e instanceof HttpError ? e.status : 500
    if (status === 500) return errorResponse(e)
    return new Response(`${localize((e as Error).message, 'en')}\n`, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  }
}

export const Route = createFileRoute('/api/backup/agent/$name')({
  server: {
    handlers: {
      GET: ({ request, params }) => handle(request, params.name, 'GET'),
      POST: ({ request, params }) => handle(request, params.name, 'POST'),
    },
  },
})
