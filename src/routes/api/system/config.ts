import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { msg } from '~/shared/i18n'
import { assertWritable } from '~/server/guard'
import { authed, readJson } from '~/server/http'
import { privileged } from '~/server/privileged'
import { unlockToken } from '~/server/unlock-sessions'

// .pacnew & co. GET ?path= → both versions, note, what is allowed.
// POST { path, action: 'replace' | 'keep' | 'merge', content? } with unlock.
export const Route = createFileRoute('/api/system/config')({
  server: {
    handlers: {
      GET: authed(async ({ request }) => Response.json(await privileged().configFile(new URL(request.url).searchParams.get('path') ?? ''))),
      POST: authed(async ({ request }, session) => {
        const b = await readJson<{ path?: unknown; action?: unknown; content?: unknown }>(request)
        assertWritable()
        if (typeof b.path !== 'string' || (b.action !== 'replace' && b.action !== 'keep' && b.action !== 'merge')) throw new HttpError(400, msg('api_config_pathActionRequired'))
        if (b.content !== undefined && typeof b.content !== 'string') throw new HttpError(400, msg('common_errors_invalidContent'))
        return Response.json(await privileged().applyConfigFile(unlockToken(session.id), b.path, b.action, b.content as string | undefined))
      }),
    },
  },
})
