import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useActions } from '~/components/Actions'
import { Glyph } from '~/components/Glyph'
import { Modal } from '~/components/Modal'
import { PageHeader } from '~/components/PageHeader'
import { SshKeys, SshPreviewDialog, type SshPending } from '~/components/SshKeys'
import { Dot, Pill } from '~/components/Status'
import { useToast } from '~/components/Toast'
import { useGuardedApi } from '~/components/Unlock'
import { relative } from '~/lib/format'
import { localeOf, msg } from '~/shared/i18n'
import type { SshState } from '~/shared/ssh'
import { USER_NAME, changeProblem, describeChange, fullNameProblem, nameProblem, passwordProblem, type Account, type UserChange, type UsersState } from '~/shared/users'
import { m } from '~/paraglide/messages'

export const Route = createFileRoute('/_app/users')({
  validateSearch: (s: Record<string, unknown>): { user?: string } => ({ user: typeof s.user === 'string' && USER_NAME.test(s.user) ? s.user : undefined }),
  head: () => ({ meta: [{ title: msg('page_title_users') }] }),
  component: UsersPage,
})

const dateFmt = (ts: number) => new Date(ts).toLocaleString(localeOf(), { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })

function UsersPage() {
  const { user } = Route.useSearch()
  const navigate = useNavigate()
  const { readonly } = useActions()
  const say = useToast()
  const guarded = useGuardedApi()
  const [state, setState] = useState<UsersState | null>(null)
  const [ssh, setSsh] = useState<SshState | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState<{ change: UserChange; title: string; confirm: string; danger?: boolean; done: string } | null>(null)
  const [sshPending, setSshPending] = useState<SshPending | null>(null)
  const [creating, setCreating] = useState(false)
  const [password, setPassword] = useState<null | { name: string; samba: boolean }>(null)

  const load = useCallback(async () => {
    try {
      const [u, s] = await Promise.all([fetch('/api/users'), fetch('/api/ssh')])
      const d = (await u.json()) as UsersState & { error?: string }
      if (!u.ok) throw new Error(d.error ?? `HTTP ${u.status}`)
      setState(d)
      if (s.ok) setSsh((await s.json()) as SshState)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const apply = async (change: UserChange, done: string) => {
    try {
      const s = await guarded<UsersState>('/api/users', { body: { change } })
      if (!s) return false
      setState(s)
      say(done)
      if (change.kind === 'delete') void navigate({ to: '/users', search: {} })
      return true
    } catch (e) {
      say((e as Error).message, 'bad')
      return false
    }
  }

  const selected = state?.accounts.find((a) => a.name === user) ?? state?.accounts.find((a) => a.uid !== 0) ?? state?.accounts[0]

  return (
    <>
      <PageHeader title={m.users_title()} subtitle={m.users_subtitle()}>
        {!readonly && state && (
          <button type="button" className="btn sm primary" onClick={() => setCreating(true)}>
            <Glyph name="plus" size={13} /> {m.users_newUser()}
          </button>
        )}
      </PageHeader>
      {error && <p className="m-0 text-[13px] text-[#e3b341]">{error}</p>}
      {!state && !error && <p className="m-0 text-muted">{m.users_loading()}</p>}
      {state && (
        <div className="grid grid-cols-1 gap-[18px] lg:grid-cols-[320px_minmax(0,1fr)]">
          <section className="panel flex flex-col self-start" aria-label={m.users_accounts()}>
            {state.accounts.map((a) => (
              <Link
                key={a.name}
                to="/users"
                search={{ user: a.name }}
                data-testid="account"
                aria-current={selected?.name === a.name ? 'true' : undefined}
                className={`flex items-center gap-3 border-b border-line px-[18px] py-[10px] last:border-b-0 hover:bg-[rgba(255,255,255,.03)] ${selected?.name === a.name ? 'bg-[rgba(124,196,184,.10)]' : ''}`}
              >
                <Dot tone={a.locked ? 'bad' : 'ok'} label={a.locked ? m.users_locked() : m.users_active()} />
                <div className="min-w-0 grow">
                  <div className="font-medium">
                    {a.name}
                    {a.fullName && <span className="ml-2 text-[12px] font-normal text-muted">{a.fullName}</span>}
                  </div>
                  <div className="text-[12px] text-subtle" suppressHydrationWarning>
                    {a.lastLogin ? m.users_lastLogin({ when: relative(a.lastLogin) }) : m.users_noLogin()}
                  </div>
                </div>
                <div className="flex flex-wrap justify-end gap-1">
                  {a.admin && <span className="chip q">{m.users_admin()}</span>}
                  {a.locked && <Pill tone="bad">{m.users_locked()}</Pill>}
                </div>
              </Link>
            ))}
          </section>
          {selected && (
            <AccountDetail
              key={selected.name}
              a={selected}
              state={state}
              ssh={ssh}
              readonly={readonly}
              onChange={(change, title, confirm, done, danger) => setPending({ change, title, confirm, done, danger })}
              onPassword={(samba) => setPassword({ name: selected.name, samba })}
              onSshPreview={setSshPending}
            />
          )}
        </div>
      )}

      {pending && state && (
        <ConfirmChange
          state={state}
          pending={pending}
          onClose={() => setPending(null)}
          onConfirm={async (change) => {
            if (await apply(change, pending.done)) setPending(null)
          }}
        />
      )}
      {creating && state && (
        <CreateDialog
          state={state}
          onClose={() => setCreating(false)}
          onCreate={async (change) => {
            if (await apply(change, m.users_created({ name: change.name }))) {
              setCreating(false)
              void load()
              void navigate({ to: '/users', search: { user: change.name } })
            }
          }}
        />
      )}
      {password && state && (
        <PasswordDialog
          name={password.name}
          samba={password.samba}
          onClose={() => setPassword(null)}
          onSave={async (pw) => {
            const change: UserChange = password.samba ? { kind: 'samba-password', name: password.name, password: pw } : { kind: 'password', name: password.name, password: pw }
            const problem = changeProblem(state, change)
            if (problem) return say(problem, 'bad')
            if (await apply(change, password.samba ? m.users_sambaSet() : m.users_passwordSet())) setPassword(null)
          }}
        />
      )}
      <SshPreviewDialog
        pending={sshPending}
        onClose={() => setSshPending(null)}
        onDone={(s) => {
          setSsh(s)
          void load()
        }}
      />
    </>
  )
}

function AccountDetail({
  a,
  state,
  ssh,
  readonly,
  onChange,
  onPassword,
  onSshPreview,
}: {
  a: Account
  state: UsersState
  ssh: SshState | null
  readonly: boolean
  onChange: (c: UserChange, title: string, confirm: string, done: string, danger?: boolean) => void
  onPassword: (samba: boolean) => void
  onSshPreview: (p: SshPending) => void
}) {
  const [fullName, setFullName] = useState(a.fullName)
  const [shell, setShell] = useState(a.shell)
  const [admin, setAdmin] = useState(a.admin)
  const [groups, setGroups] = useState(a.groups.filter((g) => g !== state.adminGroup))
  const [removeHome, setRemoveHome] = useState(false)
  const dirty =
    fullName !== a.fullName ||
    shell !== a.shell ||
    admin !== a.admin ||
    [...groups].sort().join() !==
      a.groups
        .filter((g) => g !== state.adminGroup)
        .sort()
        .join()
  const offered = state.groups.filter((g) => g.name !== state.adminGroup)
  const history = state.history.filter((h) => h.user === a.name)
  const shells = state.shells.includes(a.shell) ? state.shells : [a.shell, ...state.shells]
  const label = 'flex flex-col gap-1 text-[12px] font-medium text-muted'
  return (
    <div className="flex min-w-0 flex-col gap-[18px]">
      <section className="panel flex flex-col gap-3 p-[18px]" aria-label={m.users_detail_account({ name: a.name })}>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="h2 grow">{a.name}</h2>
          <span className="font-mono text-[12px] text-muted">
            uid {a.uid} · {a.home}
          </span>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className={label}>
            {m.users_detail_fullName()}
            <input className="field" value={fullName} disabled={readonly} onChange={(e) => setFullName(e.target.value)} />
            {fullNameProblem(fullName) && <span className="font-normal text-[#ff8a80]">{fullNameProblem(fullName)}</span>}
          </label>
          <label className={label}>
            {m.users_detail_shell()}
            <select className="field" value={shell} disabled={readonly} onChange={(e) => setShell(e.target.value)}>
              {shells.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="flex items-start gap-2 text-[13px]">
          <input type="checkbox" className="mt-[3px]" checked={admin || a.uid === 0} disabled={readonly || a.uid === 0} onChange={(e) => setAdmin(e.target.checked)} />
          <span>
            <span className="font-medium">{m.users_detail_administrator()}</span> <span className="text-muted">{m.users_detail_group({ g: state.adminGroup })}</span>
            <span className="block text-[12px] text-muted">{m.users_detail_adminHelp()}</span>
          </span>
        </label>
        {offered.length > 0 && (
          <fieldset className="m-0 flex flex-col gap-1.5 rounded-[10px] border border-edge p-3">
            <legend className="px-1 text-[12px] font-medium text-muted">{m.users_detail_groups()}</legend>
            <div className="grid grid-cols-1 gap-1.5 md:grid-cols-2">
              {offered.map((g) => (
                <label key={g.name} className="flex items-start gap-2 text-[13px]">
                  <input type="checkbox" className="mt-[3px]" checked={groups.includes(g.name)} disabled={readonly} onChange={(e) => setGroups((x) => (e.target.checked ? [...x, g.name] : x.filter((n) => n !== g.name)))} />
                  <span>
                    <span className="font-mono">{g.name}</span>
                    {g.text && <span className="block text-[12px] text-muted">{g.text}</span>}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {!readonly && (
          <button
            type="button"
            className="btn sm primary self-end"
            disabled={!dirty || !!fullNameProblem(fullName)}
            onClick={() => onChange({ kind: 'update', name: a.name, fullName, shell, groups, admin }, m.users_detail_changeTitle({ name: a.name }), m.users_detail_save(), m.users_detail_saved())}
          >
            {m.users_detail_saveDots()}
          </button>
        )}
      </section>

      <section className="panel flex flex-col gap-2 p-[18px] text-[13px]" aria-label={m.users_login_title()}>
        <h2 className="h2">{m.users_login_title()}</h2>
        <div className="flex flex-wrap items-center gap-2">
          {a.locked ? <Pill tone="bad">{m.users_locked()}</Pill> : <Pill tone="ok">{m.users_active()}</Pill>}
          <span className="text-muted">{a.hasPassword ? m.users_login_passwordSet() : m.users_login_noPassword()}</span>
          <span className="text-muted">{m.users_login_keys({ n: a.keys })}</span>
        </div>
        {!a.hasPassword && !a.keys && !a.locked && <p className="m-0 text-[#e3b341]">{m.users_login_nothing()}</p>}
        {!readonly && (
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn sm" onClick={() => onPassword(false)}>
              {m.users_login_setPassword()}
            </button>
            {a.locked ? (
              <button type="button" className="btn sm" onClick={() => onChange({ kind: 'unlock', name: a.name }, m.users_login_unlockTitle({ name: a.name }), m.users_login_unlock(), m.users_login_unlocked({ name: a.name }))}>
                {m.users_login_unlockDots()}
              </button>
            ) : (
              <button type="button" className="btn sm" onClick={() => onChange({ kind: 'lock', name: a.name }, m.users_login_lockTitle({ name: a.name }), m.users_login_lock(), m.users_login_lockedToast({ name: a.name }), true)}>
                {m.users_login_lockDots()}
              </button>
            )}
          </div>
        )}
        {state.sambaAvailable && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-2">
            <span className="grow">
              {m.users_login_samba()} <span className="text-muted">{a.samba ? m.users_login_sambaSet() : m.users_login_sambaNone()}</span>
            </span>
            {!readonly && (
              <button type="button" className="btn sm" onClick={() => onPassword(true)}>
                {m.users_login_setSamba()}
              </button>
            )}
          </div>
        )}
      </section>

      {ssh?.users.some((u) => u.name === a.name) && <SshKeys state={ssh} only={a.name} onPreview={onSshPreview} />}

      <section className="panel flex flex-col" aria-label={m.users_history_title()}>
        <h2 className="h2 px-[18px] pt-4 pb-2">{m.users_history_title()}</h2>
        {history.length === 0 && <p className="m-0 border-t border-line px-[18px] py-3 text-[13px] text-muted">{m.users_history_none()}</p>}
        {history.slice(0, 15).map((h, i) => (
          <div key={i} className="flex flex-wrap items-center gap-x-3 border-t border-line px-[18px] py-[7px] text-[13px]" data-testid="login-record">
            <Dot tone={h.active ? 'ok' : 'idle'} label={h.active ? m.users_history_loggedIn() : m.users_history_ended()} />
            <span className="font-mono text-[12px]" suppressHydrationWarning>
              {dateFmt(h.start)}
            </span>
            <span className="text-[12px] text-muted" suppressHydrationWarning>
              {h.active ? m.users_history_loggedIn() : h.end ? m.users_history_until({ when: dateFmt(h.end) }) : ''}
            </span>
            <span className="ml-auto font-mono text-[12px] text-subtle">
              {h.tty}
              {h.from ? ` · ${h.from}` : ''}
            </span>
          </div>
        ))}
      </section>

      {!readonly && !a.protected && (
        <section className="panel flex flex-wrap items-center gap-3 p-[18px] text-[13px]" aria-label={m.users_remove_label()}>
          <label className="flex grow items-center gap-2">
            <input type="checkbox" checked={removeHome} onChange={(e) => setRemoveHome(e.target.checked)} /> {m.users_remove_alsoHome({ home: a.home })}
          </label>
          <button type="button" className="btn sm danger" onClick={() => onChange({ kind: 'delete', name: a.name, removeHome }, m.users_remove_title({ name: a.name }), m.users_remove_confirm(), m.users_remove_done({ name: a.name }), true)}>
            <Glyph name="trash" size={13} /> {m.users_remove_button()}
          </button>
        </section>
      )}
    </div>
  )
}

function ConfirmChange({ state, pending, onClose, onConfirm }: { state: UsersState; pending: { change: UserChange; title: string; confirm: string; danger?: boolean }; onClose: () => void; onConfirm: (c: UserChange) => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const problem = changeProblem(state, pending.change)
  return (
    <Modal open onClose={onClose} title={pending.title}>
      <p className="m-0 text-[13px]">{describeChange(pending.change, state.adminGroup)}</p>
      {problem && (
        <p role="alert" className="m-0 rounded-[10px] border border-[rgba(248,81,73,.5)] bg-[rgba(248,81,73,.08)] p-3 text-[13px] text-[#ffb4ab]">
          {problem}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={onClose}>
          {m.common_cancel()}
        </button>
        <button
          type="button"
          className={pending.danger ? 'btn danger' : 'btn primary'}
          disabled={busy || !!problem}
          onClick={async () => {
            setBusy(true)
            await onConfirm(pending.change)
            setBusy(false)
          }}
        >
          {pending.confirm}
        </button>
      </div>
    </Modal>
  )
}

function PasswordDialog({ name, samba, onClose, onSave }: { name: string; samba: boolean; onClose: () => void; onSave: (pw: string) => Promise<void> }) {
  const [pw, setPw] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const problem = pw ? passwordProblem(pw) : undefined
  return (
    <Modal open onClose={onClose} title={samba ? m.users_password_sambaTitle({ name }) : m.users_password_title({ name })}>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          await onSave(pw)
          setBusy(false)
        }}
      >
        {samba && <p className="m-0 text-[13px] text-muted">{m.users_password_sambaHelp()}</p>}
        <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
          {m.users_password_new()}
          <input className="field" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
        </label>
        <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
          {m.users_password_repeat()}
          <input className="field" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
        </label>
        {problem && <p className="m-0 text-[12px] text-[#e3b341]">{problem}</p>}
        {again && pw !== again && <p className="m-0 text-[12px] text-[#e3b341]">{m.users_password_mismatch()}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            {m.common_cancel()}
          </button>
          <button type="submit" className="btn primary" disabled={busy || !pw || !!problem || pw !== again}>
            {m.users_password_set()}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function CreateDialog({ state, onClose, onCreate }: { state: UsersState; onClose: () => void; onCreate: (c: Extract<UserChange, { kind: 'create' }>) => Promise<void> }) {
  const defaultShell = useMemo(() => state.shells.find((s) => /\/bash$/.test(s)) ?? state.shells[0] ?? '/bin/sh', [state.shells])
  const [name, setName] = useState('')
  const [fullName, setFullName] = useState('')
  const [admin, setAdmin] = useState(false)
  const [withPassword, setWithPassword] = useState(true)
  const [pw, setPw] = useState('')
  const [again, setAgain] = useState('')
  const [shell, setShell] = useState(defaultShell)
  const [groups, setGroups] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const change: Extract<UserChange, { kind: 'create' }> = { kind: 'create', name, fullName, admin, password: withPassword ? pw : undefined, shell, groups }
  const problem = !name ? undefined : (nameProblem(name) ?? (withPassword && pw ? (passwordProblem(pw) ?? (again && pw !== again ? m.users_create_mismatch() : undefined)) : undefined) ?? changeProblem(state, change))
  const ready = !!name && !problem && (!withPassword || (!!pw && pw === again))
  const label = 'flex flex-col gap-1 text-[12px] font-medium text-muted'
  return (
    <Modal open onClose={onClose} title={m.users_create_title()} wide>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          await onCreate(change)
          setBusy(false)
        }}
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className={label}>
            {m.users_create_name()}
            <input className="field font-mono" value={name} onChange={(e) => setName(e.target.value.toLowerCase().trim())} placeholder="anna" autoFocus autoComplete="off" />
          </label>
          <label className={label}>
            {m.users_create_fullName()}
            <input className="field" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder={m.users_create_fullNamePlaceholder()} />
          </label>
        </div>
        <label className="flex items-start gap-2 text-[13px]">
          <input type="checkbox" className="mt-[3px]" checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
          <span>
            <span className="font-medium">{m.users_create_administrator()}</span> <span className="text-muted">{m.users_create_adminGroup({ g: state.adminGroup })}</span>
          </span>
        </label>
        <div role="radiogroup" aria-label={m.users_create_login()} className="flex flex-wrap gap-1.5">
          <button type="button" role="radio" aria-checked={withPassword} className={`seg ${withPassword ? 'on' : ''}`} onClick={() => setWithPassword(true)}>
            {m.users_create_withPassword()}
          </button>
          <button type="button" role="radio" aria-checked={!withPassword} className={`seg ${!withPassword ? 'on' : ''}`} onClick={() => setWithPassword(false)}>
            {m.users_create_keyOnly()}
          </button>
        </div>
        {withPassword ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className={label}>
              {m.users_create_password()}
              <input className="field" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
            </label>
            <label className={label}>
              {m.users_create_repeat()}
              <input className="field" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
            </label>
          </div>
        ) : (
          <p className="m-0 text-[12px] text-muted">{m.users_create_noPassword({ admin: String(!!admin) })}</p>
        )}
        <label className={label}>
          {m.users_create_shell()}
          <select className="field" value={shell} onChange={(e) => setShell(e.target.value)}>
            {state.shells.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        {state.groups.filter((g) => g.name !== state.adminGroup).length > 0 && (
          <fieldset className="m-0 flex flex-col gap-1.5 rounded-[10px] border border-edge p-3">
            <legend className="px-1 text-[12px] font-medium text-muted">{m.users_create_moreGroups()}</legend>
            <div className="grid grid-cols-1 gap-1.5 md:grid-cols-2">
              {state.groups
                .filter((g) => g.name !== state.adminGroup)
                .map((g) => (
                  <label key={g.name} className="flex items-start gap-2 text-[13px]">
                    <input type="checkbox" className="mt-[3px]" checked={groups.includes(g.name)} onChange={(e) => setGroups((x) => (e.target.checked ? [...x, g.name] : x.filter((n) => n !== g.name)))} />
                    <span>
                      <span className="font-mono">{g.name}</span>
                      {g.text && <span className="block text-[12px] text-muted">{g.text}</span>}
                    </span>
                  </label>
                ))}
            </div>
          </fieldset>
        )}
        {problem && <p className="m-0 text-[12px] text-[#e3b341]">{problem}</p>}
        {ready && <p className="m-0 text-[12px] text-muted">{describeChange(change, state.adminGroup)}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            {m.common_cancel()}
          </button>
          <button type="submit" className="btn primary" disabled={!ready || busy}>
            {m.users_create_create()}
          </button>
        </div>
      </form>
    </Modal>
  )
}
