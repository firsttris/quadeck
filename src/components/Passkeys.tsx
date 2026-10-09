import { useEffect, useState } from 'react'
import { api } from '~/lib/api'
import { dateTime } from '~/lib/format'
import { createPasskey, passkeyErrorMessage, passkeysSupported } from '~/lib/passkeys'
import { m } from '~/paraglide/messages'
import type { PasskeyInfo } from '~/server/passkeys'
import { BusyButton } from './Busy'
import { Glyph } from './Glyph'
import { ConfirmDialog, Modal } from './Modal'
import { useToast } from './Toast'

/** The passkeys of the admin login: list, add (with the password once more), rename, delete. */
export function PasskeysDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast()
  const [list, setList] = useState<PasskeyInfo[] | null>(null)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [deleting, setDeleting] = useState<PasskeyInfo | null>(null)
  const supported = passkeysSupported()

  const load = () =>
    api<{ passkeys: PasskeyInfo[] }>('/api/auth/passkeys', { method: 'GET' })
      .then((r) => setList(r.passkeys))
      .catch((e) => setError((e as Error).message))

  useEffect(() => {
    if (!open) return
    setError('')
    setAdding(false)
    void load()
  }, [open])

  return (
    <>
      <Modal open={open} onClose={onClose} title={m.passkeys_title()} busy={busy}>
        <p className="m-0 text-[13px] text-muted">{m.passkeys_intro()}</p>
        {!supported && <p className="m-0 text-[13px] text-[#e3b341]">{m.passkeys_unsupported()}</p>}
        {list && list.length === 0 && <p className="m-0 text-[13px] text-faint">{m.passkeys_empty()}</p>}
        {!!list?.length && (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {list.map((p) => (
              <li key={p.id} className="flex items-center gap-3 rounded-[8px] border border-rim px-3 py-2">
                <Glyph name="key" size={16} />
                <div className="flex min-w-0 grow flex-col">
                  <span className="truncate text-[13px] font-medium">{p.name}</span>
                  <span className="text-[12px] text-faint">
                    {m.passkeys_host({ host: p.rpId })} · {m.passkeys_created({ date: dateTime(p.createdAt) })} ·{' '}
                    {p.lastUsedAt ? m.passkeys_lastUsed({ date: dateTime(p.lastUsedAt) }) : m.passkeys_neverUsed()}
                  </span>
                </div>
                <button type="button" className="btn" title={m.passkeys_rename()} aria-label={m.passkeys_rename()} onClick={() => setRenaming({ id: p.id, name: p.name })}>
                  <Glyph name="edit" size={14} />
                </button>
                <button type="button" className="btn" title={m.common_delete()} aria-label={m.common_delete()} onClick={() => setDeleting(p)}>
                  <Glyph name="trash" size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {adding ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={async (e) => {
              e.preventDefault()
              const form = new FormData(e.currentTarget)
              setBusy(true)
              setError('')
              try {
                await createPasskey(String(form.get('name') ?? ''), String(form.get('password') ?? ''))
                toast(m.passkeys_added())
                setAdding(false)
                await load()
              } catch (err) {
                setError(passkeyErrorMessage(err))
              } finally {
                setBusy(false)
              }
            }}
          >
            <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
              {m.passkeys_name()}
              <input name="name" required maxLength={64} autoFocus placeholder={m.passkeys_namePlaceholder()} className="field" />
            </label>
            <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
              {m.passkeys_password()}
              <input name="password" type="password" required autoComplete="current-password" className="field" />
            </label>
            {error && (
              <p role="alert" className="m-0 text-[13px] text-[#ff8a80]">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn" disabled={busy} onClick={() => setAdding(false)}>
                {m.common_cancel()}
              </button>
              <BusyButton type="submit" className="btn primary" busy={busy} busyLabel={m.common_working()}>
                {m.passkeys_create()}
              </BusyButton>
            </div>
          </form>
        ) : (
          <>
            {error && (
              <p role="alert" className="m-0 text-[13px] text-[#ff8a80]">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn" onClick={onClose}>
                {m.common_close()}
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={!supported}
                onClick={() => {
                  setError('')
                  setAdding(true)
                }}
              >
                <Glyph name="plus" size={14} /> {m.passkeys_add()}
              </button>
            </div>
          </>
        )}
      </Modal>
      <Modal open={!!renaming} onClose={() => setRenaming(null)} title={m.passkeys_rename()}>
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault()
            if (!renaming) return
            try {
              await api(`/api/auth/passkeys/${encodeURIComponent(renaming.id)}`, { method: 'PUT', body: { name: renaming.name } })
              toast(m.passkeys_renamed())
              setRenaming(null)
              await load()
            } catch (err) {
              toast((err as Error).message, 'bad')
            }
          }}
        >
          <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
            {m.passkeys_name()}
            <input required maxLength={64} autoFocus value={renaming?.name ?? ''} onChange={(e) => setRenaming((r) => r && { ...r, name: e.target.value })} className="field" />
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={() => setRenaming(null)}>
              {m.common_cancel()}
            </button>
            <button type="submit" className="btn primary">
              {m.common_save()}
            </button>
          </div>
        </form>
      </Modal>
      <ConfirmDialog
        open={!!deleting}
        title={m.passkeys_deleteTitle()}
        body={m.passkeys_deleteBody({ name: deleting?.name ?? '' })}
        confirm={m.common_delete()}
        busyLabel={m.common_deleting()}
        danger
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return
          try {
            await api(`/api/auth/passkeys/${encodeURIComponent(deleting.id)}`, { method: 'DELETE' })
            toast(m.passkeys_deleted())
            await load()
          } catch (err) {
            toast((err as Error).message, 'bad')
          }
        }}
      />
    </>
  )
}
