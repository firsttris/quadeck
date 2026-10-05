import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'
import { assertWritable } from '~/server/guard'
import { authed, JSON_MAX, readJson } from '~/server/http'
import { privileged } from '~/server/privileged'
import { unlockToken } from '~/server/unlock-sessions'
import { TEXT_MAX } from '~/shared/files'

// GET: roots, ?path=… the folder content, ?read=… a text file, ?raw=…[&download=1] the file itself
// for the browser (Range for video; keys and secrets only when unlocked), ?archive=…&toDir=… what
// unpacking would do (checked), ?tools zip/unzip installed.
// POST { mkdir: path } | { rename: { path, name } } | { write: { path, content, expected } } (unlock).
// Copy/move/delete, unpacking and packing run as jobs (/api/jobs).
export const Route = createFileRoute('/api/files/')({
  server: {
    handlers: {
      GET: authed(async ({ request }, session) => {
        const q = new URL(request.url).searchParams
        const path = q.get('path')
        const p = privileged()
        const raw = q.get('raw')
        if (raw !== null) return p.fileResponse(unlockToken(session.id), raw, { range: request.headers.get('range'), download: q.get('download') === '1' })
        const archive = q.get('archive')
        if (archive !== null) return Response.json(await p.archivePreview(unlockToken(session.id), archive, q.get('toDir') ?? ''))
        if (q.get('tools') !== null) return Response.json(await p.archiveTools())
        const read = q.get('read')
        if (read !== null) return Response.json(await p.readTextFile(unlockToken(session.id), read))
        if (path === null) return Response.json({ roots: await p.fileRoots() })
        return Response.json(await p.listDir(path))
      }),
      POST: authed(async ({ request }, session) => {
        assertWritable()
        // the editor saves files up to TEXT_MAX; JSON escaping (\n, \", \\) makes the body somewhat larger
        const b = await readJson<{ mkdir?: unknown; rename?: { path?: unknown; name?: unknown }; write?: { path?: unknown; content?: unknown; expected?: unknown } }>(request, 2 * TEXT_MAX + JSON_MAX)
        const p = privileged()
        const token = unlockToken(session.id)
        const w = b.write
        if (w && typeof w.path === 'string' && typeof w.content === 'string' && typeof w.expected === 'string') return Response.json(await p.writeTextFile(token, w.path, w.content, w.expected))
        if (typeof b.mkdir === 'string') await p.makeDir(token, b.mkdir)
        else if (b.rename && typeof b.rename.path === 'string' && typeof b.rename.name === 'string') await p.renamePath(token, b.rename.path, b.rename.name)
        else throw new HttpError(400, msg(m.api_files_mkdirOrRename))
        return Response.json({ ok: true })
      }),
    },
  },
})
