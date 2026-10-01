import { createFileRoute, redirect } from '@tanstack/react-router'
import { useState } from 'react'
import { AuthCard } from '~/components/AuthCard'
import { api } from '~/lib/api'

export const Route = createFileRoute('/setup')({
  validateSearch: (s: Record<string, unknown>): { token?: string } => ({ token: typeof s.token === 'string' ? s.token : undefined }),
  beforeLoad: ({ context }) => {
    if (context.auth.state !== 'setup') throw redirect({ to: '/login' })
  },
  head: () => ({ meta: [{ title: 'Einrichten · Quadeck' }] }),
  component: Setup,
})

function Setup() {
  const { token } = Route.useSearch()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <AuthCard title="Quadeck einrichten" subtitle="Lege das Admin-Passwort fest. Den Setup-Token zeigt das Installationsskript an; als root jederzeit mit „quadeck setup-token“.">
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault()
          const f = new FormData(e.currentTarget)
          if (f.get('password') !== f.get('password2')) {
            setError('Die Passwörter stimmen nicht überein')
            return
          }
          setBusy(true)
          setError('')
          try {
            await api('/api/auth/setup', { body: { token: f.get('token'), password: f.get('password') } })
            window.location.href = '/'
          } catch (err) {
            setError((err as Error).message)
            setBusy(false)
          }
        }}
      >
        <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
          Setup-Token
          <input name="token" required defaultValue={token} autoComplete="off" spellCheck={false} className="field font-mono" />
        </label>
        <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
          Neues Passwort (mind. 10 Zeichen)
          <input name="password" type="password" required minLength={10} autoComplete="new-password" className="field" />
        </label>
        <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
          Passwort wiederholen
          <input name="password2" type="password" required minLength={10} autoComplete="new-password" className="field" />
        </label>
        {error && (
          <p role="alert" className="m-0 text-[13px] text-[#ff8a80]">
            {error}
          </p>
        )}
        <button type="submit" className="btn primary justify-center" disabled={busy}>
          Passwort festlegen
        </button>
      </form>
    </AuthCard>
  )
}
