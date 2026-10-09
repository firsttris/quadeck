import { createFileRoute, redirect } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { AuthCard, useHydrated } from '~/components/AuthCard'
import { Glyph } from '~/components/Glyph'
import { api } from '~/lib/api'
import { loginWithPasskey, passkeyErrorMessage, passkeysSupported } from '~/lib/passkeys'
import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'

export const Route = createFileRoute('/login')({
  beforeLoad: ({ context }) => {
    if (context.auth.state === 'setup') throw redirect({ to: '/setup' })
    if (context.auth.state === 'ok') throw redirect({ to: '/' })
  },
  head: () => ({ meta: [{ title: msg(m.page_title_login) }] }),
  component: Login,
})

function Login() {
  const { auth } = Route.useRouteContext()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const hydrated = useHydrated()
  // Only once a passkey is set up, and only where the browser can use it (HTTPS, host name)
  const [passkey, setPasskey] = useState(false)
  useEffect(() => setPasskey(auth.state === 'login' && auth.passkeys && passkeysSupported()), [auth])
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
        {passkey && (
          <>
            <div className="flex items-center gap-3 text-[12px] text-faint" aria-hidden>
              <span className="h-px grow bg-rim" />
              {m.shell_login_or()}
              <span className="h-px grow bg-rim" />
            </div>
            <button
              type="button"
              className="btn justify-center"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                setError('')
                try {
                  await loginWithPasskey()
                  window.location.href = '/'
                } catch (err) {
                  setError(passkeyErrorMessage(err))
                  setBusy(false)
                }
              }}
            >
              <Glyph name="key" size={15} /> {m.shell_login_passkey()}
            </button>
          </>
        )}
      </form>
    </AuthCard>
  )
}
