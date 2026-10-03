import { useEffect, useState } from 'react'
import { api } from '~/lib/api'
import { Modal } from './Modal'
import { IconPicker } from './ServiceDialog'
import { useToast } from './Toast'
import { m } from '~/paraglide/messages'

/** "Link hinzufügen": manual links to devices and services without Quadlet (router, printer, other hosts). */
export function AddLinkDialog({ open, onClose, groups }: { open: boolean; onClose: () => void; groups: string[] }) {
  const say = useToast()
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [icon, setIcon] = useState('')
  useEffect(() => {
    if (open) setIcon('')
  }, [open])
  return (
    <Modal open={open} onClose={onClose} title={m.overview_dialog_addLink()}>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault()
          const f = new FormData(e.currentTarget)
          setSaving(true)
          setError('')
          try {
            await api('/api/links', {
              body: { name: f.get('name'), url: f.get('url'), group: f.get('group'), icon, healthCheck: f.get('health') === 'on' },
            })
            say(m.overview_dialog_added({ name: (String(f.get('name'))) }))
            onClose()
          } catch (err) {
            setError((err as Error).message)
          } finally {
            setSaving(false)
          }
        }}
      >
        <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
          {m.common_name()}
          <input name="name" required maxLength={60} className="field" placeholder="Router" autoFocus />
        </label>
        <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
          URL
          <input name="url" required type="url" className="field font-mono" placeholder="http://192.168.1.1" />
        </label>
        <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
          {m.overview_dialog_group()}
          <input name="group" maxLength={40} className="field" placeholder="Links" list="link-groups" />
          <datalist id="link-groups">
            {groups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </label>
        <div className="flex flex-col gap-1 text-[12px] font-medium text-muted">
          Icon
          <IconPicker value={icon} onChange={setIcon} />
        </div>
        <label className="flex items-center gap-2 text-[13px]">
          <input name="health" type="checkbox" defaultChecked /> {m.overview_dialog_healthCheck()}
        </label>
        {error && (
          <p role="alert" className="m-0 text-[13px] text-[#ff8a80]">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            {m.common_cancel()}
          </button>
          <button type="submit" className="btn primary" disabled={saving}>
            {m.common_add()}
          </button>
        </div>
      </form>
    </Modal>
  )
}
