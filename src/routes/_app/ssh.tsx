import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { useActions } from '~/components/Actions'
import { InstallHint } from '~/components/InstallHint'
import { PageHeader } from '~/components/PageHeader'
import { Dot, Pill, type Tone } from '~/components/Status'
import { SshKeys, SshPreviewDialog, type SshPending } from '~/components/SshKeys'
import { useToast } from '~/components/Toast'
import { useGuardedApi } from '~/components/Unlock'
import { relative } from '~/lib/format'
import { validateSettings, type RootLogin, type SshSettings, type SshState } from '~/shared/ssh'
import { m } from '~/paraglide/messages'
import { pickMsg } from '~/i18n'

export const Route = createFileRoute('/_app/ssh')({
  head: () => ({ meta: [{ title: 'SSH · Quadeck' }] }),
  component: SshPage,
})

function SshPage() {
  const [state, setState] = useState<SshState | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState<SshPending | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/ssh')
      const d = (await r.json()) as SshState & { error?: string }
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`)
      setState(d)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  useEffect(() => {
    void load()
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [load])

  return (
    <>
      <PageHeader title="SSH" subtitle={m.ssh_subtitle()} />
      {error && <p className="m-0 text-[13px] text-[#e3b341]">{error}</p>}
      {state?.error && (
        <p role="alert" className="m-0 text-[13px] text-[#e3b341]">
          {state.error}
        </p>
      )}
      {!state && !error && <p className="m-0 text-muted">{m.ssh_loading()}</p>}
      {state && !state.installed && (
        <section className="panel" aria-label={m.ssh_install_label()}>
          <InstallHint feature="ssh" what={m.ssh_install_what()} onInstalled={load} />
        </section>
      )}
      {state?.installed && (
        <div className="grid grid-cols-1 gap-[18px] xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <div className="flex flex-col gap-[18px]">
            <Access state={state} onState={setState} />
            <Hardening state={state} onPreview={setPending} />
          </div>
          <div className="flex flex-col gap-[18px]">
            <SshKeys state={state} onPreview={setPending} />
            <Logins state={state} />
            <NewDevice state={state} />
          </div>
        </div>
      )}
      <SshPreviewDialog pending={pending} onClose={() => setPending(null)} onDone={setState} />
    </>
  )
}

// ---------- service + host keys ----------

function Access({ state, onState }: { state: SshState; onState: (s: SshState) => void }) {
  const say = useToast()
  const guarded = useGuardedApi()
  const { readonly } = useActions()
  const [busy, setBusy] = useState(false)
  const services = state.services.filter((s) => s.unit.endsWith('.service'))
  const active = state.services.some((s) => s.active)
  const enabled = state.services.some((s) => s.enabled)
  const act = async (action: 'start' | 'restart' | 'enable') => {
    setBusy(true)
    try {
      const st = await guarded<SshState>('/api/ssh', { body: { service: action } })
      if (st) {
        onState(st)
        say(action === 'enable' ? m.ssh_access_enabled() : action === 'restart' ? m.ssh_access_restarted() : m.ssh_access_started())
      }
    } catch (e) {
      say((e as Error).message, 'bad')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="panel flex flex-col" aria-label={m.ssh_access_title()}>
      <div className="flex flex-wrap items-center gap-2 px-[18px] pt-4 pb-2">
        <h2 className="h2 grow">{m.ssh_access_title()}</h2>
        {state.services.map((s) => (
          <Pill key={s.unit} tone={s.active ? 'ok' : 'idle'}>
            {s.unit} {s.active ? m.ssh_access_running() : m.ssh_access_off()}
          </Pill>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-line px-[18px] py-2.5 text-[13px]">
        <span className="grow text-muted">
          {m.ssh_access_port()} <span className="font-mono text-fg">{state.ports.join(', ')}</span>
          {m.ssh_access_keyLogin({ on: String(!!state.effective.pubkeyAuthentication) })}
        </span>
        {!readonly && services.length > 0 && (
          <span className="flex gap-1.5">
            {!enabled && (
              <button type="button" className="btn sm" disabled={busy} onClick={() => act('enable')}>
                {m.ssh_access_enable()}
              </button>
            )}
            {active ? (
              <button type="button" className="btn sm" disabled={busy} onClick={() => act('restart')}>
                {m.ssh_access_restart()}
              </button>
            ) : (
              <button type="button" className="btn sm primary" disabled={busy} onClick={() => act('start')}>
                {m.ssh_access_start()}
              </button>
            )}
          </span>
        )}
      </div>
      <div className="border-t border-line px-[18px] py-3">
        <div className="mb-1.5 text-[12px] font-medium text-muted">{m.ssh_access_fingerprints()}</div>
        {state.hostKeys.map((k) => (
          <div key={k.fingerprint} className="flex flex-wrap items-baseline gap-x-3 py-0.5" data-testid="host-key">
            <span className="w-[120px] shrink-0 text-[12px] text-muted">{k.type.replace('ssh-', '').replace('ecdsa-sha2-', 'ECDSA ')}</span>
            <span className="font-mono text-[12px] break-all select-all">{k.fingerprint}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

// ---------- hardening ----------

function Row({ tone, label, value, help }: { tone: Tone; label: string; value: string; help: string }) {
  return (
    <div className="flex items-start gap-3 border-t border-line px-[18px] py-2.5" data-testid="ssh-check">
      <span className="pt-1">
        <Dot tone={tone} />
      </span>
      <div className="min-w-0 grow">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="font-medium">{label}</span>
          <span className="text-[13px]">{value}</span>
        </div>
        <div className="text-[12px] text-muted">{help}</div>
      </div>
    </div>
  )
}

function Hardening({ state, onPreview }: { state: SshState; onPreview: (p: SshPending) => void }) {
  const { readonly } = useActions()
  const e = state.effective
  const [form, setForm] = useState<SshSettings>({ passwordAuthentication: e.passwordAuthentication, permitRootLogin: e.permitRootLogin, allowUsers: e.allowUsers })
  const [users, setUsers] = useState(e.allowUsers.join(' '))
  useEffect(() => {
    setForm({ passwordAuthentication: e.passwordAuthentication, permitRootLogin: e.permitRootLogin, allowUsers: e.allowUsers })
    setUsers(e.allowUsers.join(' '))
  }, [e.passwordAuthentication, e.permitRootLogin, e.allowUsers])
  const next: SshSettings = { ...form, allowUsers: users.split(/[\s,]+/).filter(Boolean) }
  const changed = next.passwordAuthentication !== e.passwordAuthentication || next.permitRootLogin !== e.permitRootLogin || next.allowUsers.join(' ') !== e.allowUsers.join(' ')
  const errors = validateSettings(next)
  const withKeys = state.users.filter((u) => u.keys.length).map((u) => u.name)
  return (
    <section className="panel flex flex-col" aria-label={m.ssh_hardening_title()}>
      <h2 className="h2 px-[18px] pt-4 pb-2">{m.ssh_hardening_title()}</h2>
      <Row tone={e.passwordAuthentication ? 'warn' : 'ok'} label={m.ssh_hardening_password()} value={e.passwordAuthentication ? m.ssh_hardening_passwordOn() : m.ssh_hardening_passwordOff()} help={e.passwordAuthentication ? m.ssh_hardening_passwordOnHelp() : m.ssh_hardening_passwordOffHelp()} />
      <Row tone={e.permitRootLogin === 'yes' ? 'bad' : e.permitRootLogin === 'no' ? 'ok' : 'ok'} label={m.ssh_hardening_root()} value={pickMsg({ "yes": m.ssh_rootLabel_yes, "prohibit-password": m.ssh_rootLabel_prohibitpassword, "no": m.ssh_rootLabel_no }, e.permitRootLogin)} help={e.permitRootLogin === 'yes' ? m.ssh_hardening_rootYesHelp() : m.ssh_hardening_rootOtherHelp()} />
      <Row tone={e.allowUsers.length ? 'ok' : 'idle'} label={m.ssh_hardening_allowed()} value={e.allowUsers.length ? e.allowUsers.join(', ') : m.ssh_hardening_all()} help={m.ssh_hardening_allowedHelp()} />
      {!readonly && (
        <form
          className="flex flex-col gap-3 border-t border-line px-[18px] py-3"
          onSubmit={(ev) => {
            ev.preventDefault()
            onPreview({ change: { kind: 'settings', settings: next }, title: m.ssh_hardening_confirmTitle(), confirm: m.ssh_hardening_confirm(), done: m.ssh_hardening_done() })
          }}
        >
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" role="switch" checked={form.passwordAuthentication} onChange={(ev) => setForm((f) => ({ ...f, passwordAuthentication: ev.target.checked }))} aria-label={m.ssh_hardening_allowPassword()} />
            {m.ssh_hardening_allowPassword()}
          </label>
          {!form.passwordAuthentication && !withKeys.length && <p className="m-0 text-[12px] text-[#ff8a80]">{m.ssh_hardening_noKeys()}</p>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
              {m.ssh_hardening_root()}
              <select className="field" value={form.permitRootLogin} onChange={(ev) => setForm((f) => ({ ...f, permitRootLogin: ev.target.value as RootLogin }))}>
                <option value="no">{m.ssh_rootLabel_no()}</option>
                <option value="prohibit-password">{m.ssh_rootLabel_prohibitpassword()}</option>
                <option value="yes">{m.ssh_rootLabel_yes()}</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
              {m.ssh_hardening_allowedEmpty()}
              <input className="field font-mono" value={users} onChange={(ev) => setUsers(ev.target.value)} placeholder="tristan" />
            </label>
          </div>
          {errors.length > 0 && <p className="m-0 text-[13px] text-[#ff8a80]">{errors.join(' · ')}</p>}
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-subtle">
              {m.ssh_hardening_as()} <span className="font-mono">{state.dropIn}</span>
            </span>
            <button type="submit" className="btn primary sm" disabled={!changed || errors.length > 0}>
              {m.ssh_hardening_apply()}
            </button>
          </div>
          {!state.dropInActive && <p className="m-0 text-[12px] text-[#e3b341]">{m.ssh_hardening_noInclude()}</p>}
        </form>
      )}
    </section>
  )
}

// ---------- keys ----------

// ---------- logins ----------

function Logins({ state }: { state: SshState }) {
  const names = new Map(state.users.flatMap((u) => u.keys.map((k) => [k.fingerprint, k.comment] as const)))
  const active = state.logins.filter((l) => l.active).length
  return (
    <section className="panel flex flex-col" aria-label={m.ssh_logins_title()}>
      <div className="flex items-baseline gap-2 px-[18px] pt-4 pb-2">
        <h2 className="h2 grow">{m.ssh_logins_title()}</h2>
        <span className="text-[12px] text-muted">{active === 0 ? m.ssh_logins_nobody() : m.ssh_logins_connectedNow({ n: active })}</span>
      </div>
      {state.logins.length === 0 && <p className="m-0 border-t border-line px-[18px] py-3 text-[13px] text-muted">{m.ssh_logins_none()}</p>}
      {state.logins.slice(0, 8).map((l, i) => (
        <div key={i} className="flex flex-wrap items-center gap-x-3 border-t border-line px-[18px] py-[7px] text-[13px]" data-testid="ssh-login">
          {l.active ? <Dot tone="ok" label={m.ssh_logins_connected()} /> : <Dot tone="idle" label={m.ssh_logins_loggedOut()} />}
          <span className="font-medium">{l.user}</span>
          <span className="font-mono text-[12px] text-muted">{l.from}</span>
          <span className="text-[12px] text-subtle">{l.method === 'publickey' ? m.ssh_logins_key({ name: (l.fingerprint ? (names.get(l.fingerprint) ?? '') : '') }) : l.method === 'password' ? m.ssh_logins_password() : l.method}</span>
          <span className="ml-auto flex items-center gap-2 font-mono text-[12px] text-subtle" suppressHydrationWarning>
            {l.active && <span className="pill ok">{m.ssh_logins_connected()}</span>}
            {relative(l.ts)}
          </span>
        </div>
      ))}
      {state.failed.length > 0 && (
        <div className="border-t border-line px-[18px] py-2.5">
          <div className="mb-1 text-[12px] font-medium text-muted">{m.ssh_logins_failed()}</div>
          {state.failed.map((f) => (
            <div key={f.from} className="flex items-center gap-3 py-0.5 text-[13px]" data-testid="ssh-failed">
              <Dot tone={f.count > 50 ? 'bad' : 'warn'} />
              <span className="font-mono text-[12px]">{f.from}</span>
              <span className="text-muted">{f.count}×</span>
              <span className="ml-auto font-mono text-[12px] text-subtle" suppressHydrationWarning>
                {relative(f.last)}
              </span>
            </div>
          ))}
          {state.effective.passwordAuthentication && <p className="m-0 mt-1 text-[12px] text-[#e3b341]">{m.ssh_logins_failedHint()}</p>}
        </div>
      )}
    </section>
  )
}

// ---------- help ----------

function NewDevice({ state }: { state: SshState }) {
  const [host, setHost] = useState(state.hostname)
  useEffect(() => setHost(window.location.hostname || state.hostname), [state.hostname])
  const user = state.users.find((u) => u.uid !== 0)?.name ?? m.ssh_newDevice_user()
  const port = state.ports[0] && state.ports[0] !== 22 ? ` -p ${state.ports[0]}` : ''
  return (
    <section className="panel flex flex-col gap-2 p-[18px]" aria-label={m.ssh_newDevice_title()}>
      <h2 className="h2">{m.ssh_newDevice_title()}</h2>
      <ol className="m-0 flex list-decimal flex-col gap-2 pl-5 text-[13px] text-[#c9d1d9]">
        <li>
          {m.ssh_newDevice_step1()}
          <pre className="joblog mt-1 !min-h-0">
            ssh-keygen -t ed25519 -C "{user}@{m.ssh_newDevice_newDevice()}"
          </pre>
        </li>
        <li>
          {m.ssh_newDevice_step2()}{' '}
          {state.effective.passwordAuthentication ? (
            <>
              {m.ssh_newDevice_step2Password()}
              <pre className="joblog mt-1 !min-h-0">
                ssh-copy-id{port} {user}@{host}
              </pre>
            </>
          ) : (
            <>{m.ssh_newDevice_step2Key()}</>
          )}
        </li>
        <li>
          {m.ssh_newDevice_step3()}
          <pre className="joblog mt-1 !min-h-0">
            ssh{port} {user}@{host}
          </pre>
        </li>
      </ol>
    </section>
  )
}

// ---------- preview + apply ----------
