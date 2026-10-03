import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { msg } from '~/shared/i18n'
import { assertWritable } from '~/server/guard'
import { authed, readJson } from '~/server/http'
import { privileged } from '~/server/privileged'
import { unlockToken } from '~/server/unlock-sessions'

// GET: roots, or ?path=… the folder content.
// POST { mkdir: path } | { rename: { path, name } } (unlock). Copy/move/delete run as jobs (/api/jobs).
export const Route = createFileRoute('/api/files/')({
  server: {
    handlers: {
      GET: authed(async ({ request }) => {
        const path = new URL(request.url).searchParams.get('path')
        const p = privileged()
        if (path === null) return Response.json({ roots: await p.fileRoots() })
        return Response.json(await p.listDir(path))
      }),
      POST: authed(async ({ request }, session) => {
        assertWritable()
        const b = await readJson<{ mkdir?: unknown; rename?: { path?: unknown; name?: unknown } }>(request)
        const p = privileged()
        const token = unlockToken(session.id)
        if (typeof b.mkdir === 'string') await p.makeDir(token, b.mkdir)
        else if (b.rename && typeof b.rename.path === 'string' && typeof b.rename.name === 'string') await p.renamePath(token, b.rename.path, b.rename.name)
        else throw new HttpError(400, msg('api_files_mkdirRenameExpected'))
        return Response.json({ ok: true })
      }),
    },
  },
})
