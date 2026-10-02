import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useT } from '~/i18n'
import { api } from '~/lib/api'
import { relative } from '~/lib/format'
import type { SshChange, SshKey, SshPreview, SshState } from '~/shared/ssh'
import { useActions } from './Actions'
import { Glyph } from './Glyph'
import { Modal } from './Modal'
import { DiffView } from './QuadletEditor'
import { Pill } from './Status'
import { useToast } from './Toast'
import { useGuardedApi } from './Unlock'

// SSH keys per user and the preview/confirm dialog for SSH changes – shared by
// the SSH page and the users page.

export type SshPending = { change: SshChange; title: string; confirm: string; danger?: boolean; done: string }

export function keyLabel(k: SshKey) {
  const t = k.type.replace('ssh-', '').replace('sk-', '').replace('@openssh.com', ' (Hardware)').replace('ecdsa-sha2-nistp', 'ECDSA ')
  return `${t.toUpperCase().startsWith('ED25519') ? 'ED25519' : t}${k.type === 'ssh-rsa' && k.bits ? ` ${k.bits}` : ''}`
}

/** authorized_keys of the users; with `only` just that user (users page). */
export function SshKeys({ state, onPreview, only }: { state: SshState; onPreview: (p: SshPending) => void; only?: string }) {
  const { readonly } = useActions()
  const T = useT()
  const t = T.ssh.keys
  const initial = only ?? state.users.find((u) => u.uid !== 0 && u.keys.length)?.name ?? state.users.find((u) => u.uid !== 0)?.name ?? state.users[0]?.name ?? ''
  const [userName, setUserName] = useState(initial)
  const [newKey, setNewKey] = useState('')
  const user = state.users.find((u) => u.name === userName) ?? state.users[0]
  if (!user) return null
  return (
    <section className="panel flex flex-col" aria-label={only ? t.sshKeys : t.keys}>
      <div className="flex flex-wrap items-center gap-2 px-[18px] pt-4 pb-2">
        <h2 className="h2 grow">{only ? t.sshKeys : t.keys}</h2>
        <div role="group" aria-label={t.user} className={`flex flex-wrap gap-1.5 ${only ? 'hidden' : ''}`}>
          {state.users.map((u) => (
            <button key={u.name} type="button" className={`seg ${u.name === user.name ? 'on' : ''}`} aria-pressed={u.name === user.name} onClick={() => setUserName(u.name)}>
              {u.name}
              <span className="opacity-60">{u.keys.length}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-line px-[18px] py-1.5 text-[11px] text-subtle">
        <span className="grow font-mono">{user.home}/.ssh/authorized_keys</span>
        {!only && (
          <Link to="/users" search={{ user: user.name }} className="text-accent">
            {t.account(user.name)}
          </Link>
        )}
      </div>
      {user.problems.map((p) => (
        <p key={p} role="alert" className="m-0 border-t border-line px-[18px] py-2 text-[13px] text-[#ff8a80]">
          {p}
        </p>
      ))}
      {user.keys.length === 0 && <p className="m-0 border-t border-line px-[18px] py-3 text-[13px] text-muted">{t.none(user.name)}</p>}
      {user.keys.map((k) => (
        <div key={k.fingerprint} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-[18px] py-[10px]" data-testid="ssh-key">
          <span className="chip q w-[92px] text-center">{keyLabel(k)}</span>
          <div className="min-w-0 grow">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-medium">{k.comment || t.unnamed}</span>
              {k.options && <span className="chip" title={k.options}>{t.withOptions}</span>}
              {k.weak && <Pill tone="warn">{t.weak}</Pill>}
            </div>
            <div className="truncate font-mono text-[11px] text-muted" title={k.fingerprint}>
              {k.fingerprint}
            </div>
            {k.weak && <div className="text-[11px] text-[#e3b341]">{k.weak}</div>}
          </div>
          <span className="text-[12px] text-subtle" suppressHydrationWarning>
            {k.lastUsed ? t.lastUsed(relative(k.lastUsed)) : t.unused}
          </span>
          {!readonly && (
            <button
              type="button"
              className="btn sm danger"
              aria-label={t.removeLabel(k.comment || k.fingerprint)}
              onClick={() => onPreview({ change: { kind: 'remove-key', user: user.name, fingerprint: k.fingerprint }, title: t.removeTitle(k.comment || keyLabel(k), user.name), confirm: t.remove, danger: true, done: t.removed })}
            >
              <Glyph name="trash" size={13} />
            </button>
          )}
        </div>
      ))}
      {!readonly && (
        <form
          className="flex flex-col gap-2 border-t border-line px-[18px] py-3"
          onSubmit={(e) => {
            e.preventDefault()
            onPreview({ change: { kind: 'add-key', user: user.name, key: newKey.trim() }, title: t.addTitle(user.name), confirm: t.add, done: t.added(user.name) })
            setNewKey('')
          }}
        >
          <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
            {t.addLabel}
            <textarea className="field h-[64px] font-mono text-[12px]" spellCheck={false} value={newKey} onChange={(e) => setNewKey(e.target.value.replace(/\r?\n/g, ' '))} placeholder={t.placeholder} />
          </label>
          <button type="submit" className="btn sm self-end" disabled={!newKey.trim()}>
            <Glyph name="plus" size={13} /> {t.check}
          </button>
        </form>
      )}
    </section>
  )
}

export function SshPreviewDialog({ pending, onClose, onDone }: { pending: SshPending | null; onClose: () => void; onDone: (s: SshState) => void }) {
  const say = useToast()
  const guarded = useGuardedApi()
  const T = useT()
  const t = T.ssh.preview
  const [preview, setPreview] = useState<SshPreview | null>(null)
  const [error, setError] = useState('')
  const [force, setForce] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setPreview(null)
    setError('')
    setForce(false)
    if (!pending) return
    api<SshPreview>('/api/ssh', { body: { change: pending.change, preview: true } })
      .then(setPreview)
      .catch((e: Error) => setError(e.message))
  }, [pending])
  const apply = async () => {
    if (!pending) return
    setBusy(true)
    try {
      const st = await guarded<SshState>('/api/ssh', { body: { change: { ...pending.change, force } } })
      if (!st) return
      onDone(st)
      say(st.error ?? pending.done, st.error ? 'bad' : undefined)
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open={!!pending} onClose={onClose} title={pending?.title ?? ''} wide>
      {!preview && !error && <p className="m-0 text-muted">{t.checking}</p>}
      {preview && (
        <>
          <p className="m-0 text-[12px] text-muted">
            {t.changeIn} <span className="font-mono">{preview.file}</span> {t.keptAs} <span className="font-mono">.quadeck-bak</span>):
          </p>
          <DiffView before={preview.before} after={preview.after} />
          {preview.warnings.map((w) => (
            <p key={w} className="m-0 text-[13px] text-[#e3b341]">
              {w}
            </p>
          ))}
          {preview.blocked && (
            <div role="alert" className="flex flex-col gap-2 rounded-[10px] border border-[rgba(248,81,73,.5)] bg-[rgba(248,81,73,.08)] p-3 text-[13px] text-[#ffb4ab]">
              <span>{preview.blocked}</span>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> {t.force}
              </label>
            </div>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="m-0 text-[13px] text-[#ff8a80]">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={onClose}>
          {T.common.cancel}
        </button>
        <button type="button" className={pending?.danger || preview?.blocked ? 'btn danger' : 'btn primary'} disabled={!preview || busy || (!!preview.blocked && !force)} onClick={apply}>
          {busy ? t.saving : pending?.confirm}
        </button>
      </div>
    </Modal>
  )
}
