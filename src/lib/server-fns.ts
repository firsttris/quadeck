import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'

import type { Lang } from '~/shared/i18n'

export type AuthState = ({ state: 'setup' } | { state: 'login'; passkeys: boolean } | { state: 'ok'; csrf: string; readonly: boolean }) & { lang: Lang }

export const getAuthState = createServerFn({ method: 'GET' }).handler(async (): Promise<AuthState> => {
  const { getSession, hasPassword, ensureSetupToken } = await import('~/server/auth')
  const { config } = await import('~/server/config')
  const { requestLang } = await import('~/server/lang')
  const lang = requestLang(getRequest())
  if (!hasPassword()) {
    ensureSetupToken()
    return { state: 'setup', lang }
  }
  const s = getSession(getRequest())
  if (s) return { state: 'ok', csrf: s.csrf, readonly: config().readonly, lang }
  const { hasPasskeys } = await import('~/server/passkeys')
  return { state: 'login', passkeys: hasPasskeys(), lang }
})

export const getInitialSnapshot = createServerFn({ method: 'GET' }).handler(async () => {
  const { requireSession } = await import('~/server/auth')
  const { hubReady } = await import('~/server/hub')
  const { localizeDeep, requestLang } = await import('~/server/lang')
  requireSession(getRequest())
  return localizeDeep((await hubReady()).snapshot(), requestLang(getRequest()))
})

export const getDashboardLayout = createServerFn({ method: 'GET' }).handler(async () => {
  const { requireSession } = await import('~/server/auth')
  const { getLayout } = await import('~/server/layout')
  requireSession(getRequest())
  return getLayout()
})
