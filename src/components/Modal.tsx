import { useEffect, useRef, type ReactNode } from 'react'

/** Native <dialog> (focus trap, Esc, backdrop handled by the browser). */
export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog ref={ref} className="modal" onClose={onClose} aria-labelledby="modal-title">
      {open && (
        <div className="flex flex-col gap-4 p-5">
          <h2 id="modal-title" className="h2 font-cond text-[17px]">
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
          Abbrechen
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
