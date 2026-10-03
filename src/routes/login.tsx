import { createFileRoute, redirect } from '@tanstack/react-router'
import { useState } from 'react'
import { AuthCard, useHydrated } from '~/components/AuthCard'
import { api } from '~/lib/api'
import { tr } from '~/shared/i18n'
import { m } from '~/paraglide/messages'

export const Route = createFileRoute('/login')({
  beforeLoad: ({ context }) => {
    if (context.auth.state === 'setup') throw redirect({ to: '/setup' })
    if (context.auth.state === 'ok') throw redirect({ to: '/' })
  },
  head: () => ({ meta: [{ title: tr('Anmelden · Quadeck', 'Log in · Quadeck') }] }),
  component: Login,
})

function Login() {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const hydrated = useHydrated()
  return (
    <AuthCard title={m.shell_login_title()} subtitle={m.shell_login_subtitle()}>
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
          {m.shell_login_password()}
          <input name="password" type="password" required autoFocus autoComplete="current-password" className="field" />
        </label>
        {error && (
          <p role="alert" className="m-0 text-[13px] text-[#ff8a80]">
            {error}
          </p>
        )}
        <button type="submit" className="btn primary justify-center" disabled={busy || !hydrated}>
          {m.shell_login_submit()}
        </button>
      </form>
    </AuthCard>
  )
}
