import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { authed, readJson } from '~/server/http'
import { LANG_SETTING } from '~/server/notify'
import { setSetting } from '~/server/settings'
import { isLang, tr } from '~/shared/i18n'

// The UI's language switch: e-mails and push messages follow it.
export const Route = createFileRoute('/api/lang')({
  server: {
    handlers: {
      POST: authed(async ({ request }) => {
        const { lang } = await readJson<{ lang?: unknown }>(request)
        if (!isLang(lang)) throw new HttpError(400, tr('lang muss de oder en sein', 'lang must be de or en'))
        setSetting(LANG_SETTING, lang)
        return Response.json({ ok: true })
      }),
    },
  },
})
