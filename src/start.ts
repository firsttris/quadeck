import { msg } from '~/shared/i18n'
import { createMiddleware, createStart } from '@tanstack/react-start'
import { isSameOrigin } from './server/auth'

// Defence in depth: every unsafe request (server routes and server functions)
// must come from our own origin. Authenticated writes additionally check the
// session's CSRF token (see requireSession).
const sameOrigin = createMiddleware().server(async ({ next, request }) => {
  if (!isSameOrigin(request)) return Response.json({ error: msg('auth_foreignOrigin') }, { status: 403 }) as never
  return next()
})

export const startInstance = createStart(() => ({
  requestMiddleware: [sameOrigin],
}))
