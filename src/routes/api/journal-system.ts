import { createFileRoute } from '@tanstack/react-router'
import { m } from '~/paraglide/messages'
import { HttpError } from '~/server/auth'
import { authed } from '~/server/http'
import { journalBoots, journalEntry, parseJournalQuery, queryJournal } from '~/server/journal-query'
import { msg } from '~/shared/i18n'

// Journal → System (read-only, like the live journal; the web app reads it as systemd-journal):
// GET ?boots → the boots · ?entry=<cursor> → every field of one entry ·
// otherwise one page for scope, boot, since, prio, unit, ident, q, before (newest first).
export const Route = createFileRoute('/api/journal-system')({
  server: {
    handlers: {
      GET: authed(async ({ request }) => {
        const q = new URL(request.url).searchParams
        if (q.has('boots')) return Response.json(await journalBoots())
        if (q.has('entry')) {
          const cursor = q.get('entry')
          if (!cursor) throw new HttpError(400, msg(m.journal_error_invalidFilter))
          return Response.json({ fields: await journalEntry(cursor) })
        }
        return Response.json(await queryJournal(parseJournalQuery(q)))
      }),
    },
  },
})
