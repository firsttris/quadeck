import { useEffect, useId, useRef, type ReactNode } from 'react'
import { m } from '~/paraglide/messages'

/** Native <dialog> (focus trap, Esc, backdrop handled by the browser). */
export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId() // dialogs can stack (details → confirm)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog ref={ref} className={wide ? 'modal wide' : 'modal'} onClose={onClose} aria-labelledby={titleId}>
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

export function ConfirmDialog(props: { open: boolean; title: string; body: ReactNode; confirm: string; danger?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Modal open={props.open} onClose={props.onClose} title={props.title}>
      <div className="text-[#c9d1d9]">{props.body}</div>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={props.onClose}>
          {m.common_cancel()}
        </button>
        <button
          type="button"
          className={props.danger ? 'btn danger' : 'btn primary'}
          autoFocus
          onClick={() => {
            props.onConfirm()
            props.onClose()
          }}
        >
          {props.confirm}
        </button>
      </div>
    </Modal>
  )
}
