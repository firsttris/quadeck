import { createFileRoute, redirect } from '@tanstack/react-router'
import { useState } from 'react'
import { AuthCard, useHydrated } from '~/components/AuthCard'
import { api } from '~/lib/api'

export const Route = createFileRoute('/login')({
  beforeLoad: ({ context }) => {
    if (context.auth.state === 'setup') throw redirect({ to: '/setup' })
    if (context.auth.state === 'ok') throw redirect({ to: '/' })
  },
  head: () => ({ meta: [{ title: 'Anmelden · Quadeck' }] }),
  component: Login,
})

function Login() {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const hydrated = useHydrated()
  return (
    <AuthCard title="Anmelden" subtitle="Quadeck verwaltet Dienste mit Root-Rechten. Bitte melde dich an.">
      <form
        method="post"
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError('')
          try {
            await api('/api/auth/login', { body: { password: new FormData(e.currentTarget).get('password') } })
            window.location.href = '/'
          } catch (err) {
            setError((err as Error).message)
            setBusy(false)
          }
        }}
      >
        <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
          Passwort
          <input name="password" type="password" required autoFocus autoComplete="current-password" className="field" />
        </label>
        {error && (
          <p role="alert" className="m-0 text-[13px] text-[#ff8a80]">
            {error}
          </p>
        )}
        <button type="submit" className="btn primary justify-center" disabled={busy || !hydrated}>
          Anmelden
        </button>
      </form>
    </AuthCard>
  )
}
