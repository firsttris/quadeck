import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'

export type AuthState = { state: 'setup' } | { state: 'login' } | { state: 'ok'; csrf: string; readonly: boolean }

export const getAuthState = createServerFn({ method: 'GET' }).handler(async (): Promise<AuthState> => {
  const { getSession, hasPassword, ensureSetupToken } = await import('~/server/auth')
  const { config } = await import('~/server/config')
  if (!hasPassword()) {
    ensureSetupToken()
    return { state: 'setup' }
  }
  const s = getSession(getRequest())
  return s ? { state: 'ok', csrf: s.csrf, readonly: config().readonly } : { state: 'login' }
})

export const getInitialSnapshot = createServerFn({ method: 'GET' }).handler(async () => {
  const { requireSession } = await import('~/server/auth')
  const { hubReady } = await import('~/server/hub')
  requireSession(getRequest())
  return (await hubReady()).snapshot()
})

export const getDashboardLayout = createServerFn({ method: 'GET' }).handler(async () => {
  const { requireSession } = await import('~/server/auth')
  const { getLayout } = await import('~/server/layout')
  requireSession(getRequest())
  return getLayout()
})
