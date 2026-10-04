import { Link } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { api } from '~/lib/api'
import { relative } from '~/lib/format'
import { SECRET_NAME, type PlainSecret, type PodmanSecret, type SecretsState } from '~/shared/secrets'
import { useActions } from './Actions'
import { Modal } from './Modal'
import { useToast } from './Toast'
import { useGuardedApi } from './Unlock'
import { m } from '~/paraglide/messages'

type Dialog = { kind: 'new' } | { kind: 'replace'; secret: PodmanSecret } | { kind: 'move'; plain: PlainSecret } | { kind: 'remove'; secret: PodmanSecret }

/** System → Podman: passwords for containers kept by Podman instead of in the Quadlet file. */
export function PodmanSecretsCard() {
  const say = useToast()
  const guarded = useGuardedApi()
  const { readonly } = useActions()
  const [s, setS] = useState<SecretsState | null>(null)
  const [error, setError] = useState('')
  const [dialog, setDialog] = useState<Dialog | null>(null)

  const load = useCallback(async () => {
    try {
      setS(await api<SecretsState>('/api/podman/secrets', { method: 'GET' }))
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  /** POST, keeps the new state; true when done. */
  const post = async (body: Record<string, unknown>, done: string) => {
    try {
      const r = await guarded<SecretsState | { state: SecretsState; write: { restarted: boolean; warning?: string } }>('/api/podman/secrets', { body })
      if (!r) return false
      if ('state' in r) {
        setS(r.state)
        if (r.write.warning) say(r.write.warning, 'bad')
      } else setS(r)
      say(done)
      return true
    } catch (e) {
      say((e as Error).message, 'bad')
      return false
    }
  }

  return (
    <section className="panel flex flex-col gap-3 p-[18px]" aria-label={m.secrets_title()}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex grow flex-col gap-0.5">
          <h2 className="h2">{m.secrets_title()}</h2>
          <span className="text-[12px] text-muted">{m.secrets_subtitle()}</span>
        </div>
        {!readonly && (
          <button type="button" className="btn sm" onClick={() => setDialog({ kind: 'new' })}>
            {m.secrets_new()}
          </button>
        )}
      </div>
      {error && <p className="m-0 text-[13px] text-[#e3b341]">{error}</p>}
      {!s && !error && <p className="m-0 text-muted">{m.secrets_loading()}</p>}

      {s && s.plain.length > 0 && (
        <div className="flex flex-col gap-2 rounded-[10px] border border-[#5a4316] bg-[#d29922]/[0.06] p-3" data-testid="secrets-plain">
          <span className="text-[13px] font-medium text-[#e3b341]">{m.secrets_plainTitle({ n: s.plain.length })}</span>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {s.plain.map((p) => (
              <li key={`${p.file}:${p.key}`} className="flex flex-wrap items-center gap-2 text-[13px]">
                <Link to="/quadlets" search={{ file: p.file }} className="font-mono">
                  {p.file}
                </Link>
                <span className="text-muted">{m.secrets_line({ line: p.line })}</span>
                <span className="font-mono">{p.key}=••••••</span>
                <span className="grow" />
                {!readonly && (
                  <button type="button" className="btn sm" onClick={() => setDialog({ kind: 'move', plain: p })} aria-label={m.secrets_moveFor({ key: p.key, file: p.file })}>
                    {m.secrets_move()}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {s && (
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>{m.secrets_col_name()}</th>
                <th>{m.secrets_col_usedBy()}</th>
                <th>{m.secrets_col_changed()}</th>
                <th>
                  <span className="sr-only">{m.secrets_col_actions()}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {s.secrets.length === 0 && (
                <tr>
                  <td colSpan={4} className="text-muted">
                    {m.secrets_none()}
                  </td>
                </tr>
              )}
              {s.secrets.map((x) => (
                <tr key={x.id} data-testid="secret-row">
                  <td className="font-mono text-[13px]">{x.name}</td>
                  <td className="text-[13px]">{x.usedBy.length ? x.usedBy.join(', ') : <span className="text-muted">{m.secrets_unused()}</span>}</td>
                  <td className="text-[12px] text-subtle">{relative(x.updated ?? x.created)}</td>
                  <td className="text-right">
                    {!readonly && (
                      <div className="flex justify-end gap-1.5">
                        <button type="button" className="btn sm" onClick={() => setDialog({ kind: 'replace', secret: x })} aria-label={m.secrets_replaceFor({ name: x.name })}>
                          {m.secrets_replace()}
                        </button>
                        <button type="button" className="btn sm danger" disabled={x.usedBy.length > 0} title={x.usedBy.length ? m.secrets_inUseHint() : undefined} onClick={() => setDialog({ kind: 'remove', secret: x })} aria-label={m.secrets_removeFor({ name: x.name })}>
                          {m.secrets_remove()}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="m-0 text-[12px] text-muted">
        {m.secrets_howto()} <span className="font-mono">Secret=name,type=env,target=DB_PASSWORD</span> {m.secrets_howtoOr()} <span className="font-mono">Secret=name</span> → <span className="font-mono">/run/secrets/name</span>
      </p>

      {dialog?.kind === 'new' && <ValueDialog title={m.secrets_newTitle()} onClose={() => setDialog(null)} onSubmit={(name, value) => post({ action: 'create', name, value }, m.secrets_created({ name }))} />}
      {dialog?.kind === 'replace' && <ValueDialog title={m.secrets_replaceTitle({ name: dialog.secret.name })} fixedName={dialog.secret.name} onClose={() => setDialog(null)} onSubmit={(name, value) => post({ action: 'replace', name, value }, m.secrets_replaced({ name }))} note={dialog.secret.usedBy.length ? m.secrets_replaceNote({ files: dialog.secret.usedBy.join(', ') }) : undefined} />}
      {dialog?.kind === 'move' && <MoveDialog plain={dialog.plain} onClose={() => setDialog(null)} onSubmit={(name, restart) => post({ action: 'move', file: dialog.plain.file, key: dialog.plain.key, name, restart }, m.secrets_moved({ key: dialog.plain.key, name }))} />}
      {dialog?.kind === 'remove' && (
        <Modal open title={m.secrets_removeTitle({ name: dialog.secret.name })} onClose={() => setDialog(null)}>
          <p className="m-0 text-[13px]">{m.secrets_removeText()}</p>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={() => setDialog(null)}>
              {m.common_cancel()}
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={async () => {
                if (await post({ action: 'remove', name: dialog.secret.name }, m.secrets_removed({ name: dialog.secret.name }))) setDialog(null)
              }}
            >
              {m.secrets_remove()}
            </button>
          </div>
        </Modal>
      )}
    </section>
  )
}

function ValueDialog({ title, fixedName, note, onClose, onSubmit }: { title: string; fixedName?: string; note?: string; onClose: () => void; onSubmit: (name: string, value: string) => Promise<boolean> }) {
  const [name, setName] = useState(fixedName ?? '')
  const [value, setValue] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const validName = SECRET_NAME.test(name)
  return (
    <Modal open title={title} onClose={onClose}>
      {!fixedName && (
        <label className="flex flex-col gap-1.5 text-[13px]">
          {m.secrets_name()}
          <input className="field font-mono" value={name} maxLength={63} placeholder="immich-db-password" onChange={(e) => setName(e.target.value)} autoComplete="off" />
          {name && !validName && <span className="text-[12px] text-[#e3b341]">{m.secrets_nameHelp()}</span>}
        </label>
      )}
      <label className="flex flex-col gap-1.5 text-[13px]">
        {m.secrets_value()}
        <span className="flex gap-2">
          <input className="field grow font-mono" type={show ? 'text' : 'password'} value={value} onChange={(e) => setValue(e.target.value)} autoComplete="new-password" />
          <button type="button" className="btn sm" onClick={() => setShow(!show)} aria-pressed={show}>
            {show ? m.secrets_hide() : m.secrets_show()}
          </button>
        </span>
        <span className="text-[12px] text-muted">{m.secrets_valueHelp()}</span>
      </label>
      {note && <p className="m-0 text-[12px] text-[#e3b341]">{note}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={onClose}>
          {m.common_cancel()}
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={busy || !validName || !value}
          onClick={async () => {
            setBusy(true)
            const ok = await onSubmit(name, value)
            setBusy(false)
            if (ok) onClose()
          }}
        >
          {m.common_save()}
        </button>
      </div>
    </Modal>
  )
}

function MoveDialog({ plain, onClose, onSubmit }: { plain: PlainSecret; onClose: () => void; onSubmit: (name: string, restart: boolean) => Promise<boolean> }) {
  const [name, setName] = useState(plain.suggested)
  const [restart, setRestart] = useState(true)
  const [busy, setBusy] = useState(false)
  const valid = SECRET_NAME.test(name)
  return (
    <Modal open title={m.secrets_moveTitle({ key: plain.key })} onClose={onClose}>
      <p className="m-0 text-[13px]">{m.secrets_moveText({ file: plain.file })}</p>
      <label className="flex flex-col gap-1.5 text-[13px]">
        {m.secrets_name()}
        <input className="field font-mono" value={name} maxLength={63} onChange={(e) => setName(e.target.value)} />
        {!valid && <span className="text-[12px] text-[#e3b341]">{m.secrets_nameHelp()}</span>}
      </label>
      <pre className="m-0 overflow-x-auto rounded-[8px] border border-line bg-[#0b0f14] p-3 font-mono text-[12px] leading-[19px]" aria-label={m.secrets_change()}>
        <span className="block text-[#f85149]">- Environment=… {plain.key}=•••••• …</span>
        <span className="block text-[#3fb950]">
          + Secret={name},type=env,target={plain.key}
        </span>
      </pre>
      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" checked={restart} onChange={(e) => setRestart(e.target.checked)} />
        {m.secrets_restart()}
      </label>
      <p className="m-0 text-[12px] text-muted">{m.secrets_moveNote()}</p>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={onClose}>
          {m.common_cancel()}
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={busy || !valid}
          onClick={async () => {
            setBusy(true)
            const ok = await onSubmit(name, restart)
            setBusy(false)
            if (ok) onClose()
          }}
        >
          {m.secrets_moveRun()}
        </button>
      </div>
    </Modal>
  )
}
