import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { m } from '~/paraglide/messages'
import { BusyButton } from './Busy'

/** Native <dialog> (focus trap, Esc, backdrop handled by the browser). While `busy`, Esc doesn't close it. */
export function Modal({ open, onClose, title, children, wide, busy }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean; busy?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId() // dialogs can stack (details → confirm)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      className={wide ? 'modal wide' : 'modal'}
      onClose={onClose}
      onCancel={(e) => {
        if (busy) e.preventDefault()
      }}
      aria-labelledby={titleId}
      aria-busy={busy || undefined}
    >
      {open && (
        <div className="flex flex-col gap-4 p-5">
          <h2 id={titleId} className="h2 font-cond text-[17px]">
            {title}
          </h2>
          {children}
        </div>
      )}
    </dialog>
  )
}

/**
 * Asks before an action. When `onConfirm` returns a promise, the dialog stays open with a spinner
 * on the button until it settles, then closes.
 */
export function ConfirmDialog(props: { open: boolean; title: string; body: ReactNode; confirm: string; busyLabel?: string; danger?: boolean; onConfirm: () => void | Promise<unknown>; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <Modal open={props.open} onClose={props.onClose} title={props.title} busy={busy}>
      <div className="text-[#c9d1d9]">{props.body}</div>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" disabled={busy} onClick={props.onClose}>
          {m.common_cancel()}
        </button>
        <BusyButton
          className={props.danger ? 'btn danger' : 'btn primary'}
          autoFocus
          busy={busy}
          busyLabel={props.busyLabel ?? m.common_working()}
          onClick={async () => {
            const r = props.onConfirm()
            if (r instanceof Promise) {
              setBusy(true)
              try {
                await r
              } catch {
                // the caller reports its own errors
              } finally {
                setBusy(false)
              }
            }
            props.onClose()
          }}
        >
          {props.confirm}
        </BusyButton>
      </div>
    </Modal>
  )
}
