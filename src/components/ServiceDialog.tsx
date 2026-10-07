import { useEffect, useState } from 'react'
import { api } from '~/lib/api'
import type { Service } from '~/shared/types'
import { BusyButton, useBusy } from './Busy'
import { Glyph } from './Glyph'
import { Modal } from './Modal'
import { useToast } from './Toast'
import { m } from '~/paraglide/messages'
import { fieldLabel } from '~/lib/classes'

/** Icon picker over the dashboard-icons index; empty value = automatic. */
export function IconPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [query, setQuery] = useState(value)
  const [icons, setIcons] = useState<string[]>([])
  const [available, setAvailable] = useState(true)
  useEffect(() => {
    const t = setTimeout(() => {
      fetch(`/api/icons/search?q=${encodeURIComponent(query)}`)
        .then((r) => r.json())
        .then((d: { available: boolean; icons: string[] }) => {
          setAvailable(d.available)
          setIcons(d.icons)
        })
        .catch(() => setAvailable(false))
    }, 200)
    return () => clearTimeout(t)
  }, [query])
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <input
          className="field grow font-mono"
          aria-label={m.overview_dialog_searchIcon()}
          placeholder={m.overview_dialog_iconPlaceholder()}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            onChange(e.target.value.trim().toLowerCase())
          }}
        />
        {value && (
          <button
            type="button"
            className="btn sm self-center"
            onClick={() => {
              setQuery('')
              onChange('')
            }}
          >
            {m.overview_dialog_automatic()}
          </button>
        )}
      </div>
      {available ? (
        <div className="grid max-h-[148px] grid-cols-8 gap-1.5 overflow-y-auto" role="listbox" aria-label="Icons">
          {icons.map((slug) => (
            <button
              key={slug}
              type="button"
              role="option"
              aria-selected={slug === value}
              title={slug}
              aria-label={slug}
              onClick={() => {
                setQuery(slug)
                onChange(slug)
              }}
              className={`flex h-10 items-center justify-center rounded-lg border ${slug === value ? 'border-accent bg-accent/15' : 'border-rim bg-sunken'}`}
            >
              <img src={`/api/icons/${slug}`} alt="" width={24} height={24} loading="lazy" className="h-6 w-6 object-contain" />
            </button>
          ))}
        </div>
      ) : (
        <p className="m-0 text-[12px] text-muted">{m.overview_dialog_iconsOffline()}</p>
      )}
    </div>
  )
}

const label = fieldLabel

/**
 * Edit a tile: discovered services get an override (empty field = follow
 * discovery), manual links are edited directly.
 */
export function ServiceDialog({ service, groups, onClose }: { service: Service | null; groups: string[]; onClose: () => void }) {
  const say = useToast()
  const [error, setError] = useState('')
  const [icon, setIcon] = useState('')
  const work = useBusy<'save' | 'reset'>()
  const s = service
  const manual = s?.manualId !== undefined
  // Reset when another service opens, not on every live update of the same one (the service
  // object is new on each tick, which used to undo a picked icon and hide errors).
  const serverIcon = s?.overridden?.icon ?? (manual && s?.icon.kind === 'dash' ? s.icon.slug : '')
  useEffect(() => {
    setError('')
    setIcon(serverIcon)
  }, [s?.key])
  if (!s) return null

  const submit = (f: FormData) =>
    work.run('save', async () => {
      setError('')
      try {
        if (manual) {
          await api(`/api/links/${s.manualId}`, {
            method: 'PUT',
            body: { name: f.get('name'), url: f.get('url'), group: f.get('group'), icon, healthCheck: f.get('health') === 'on' },
          })
        } else {
          await api('/api/services/override', {
            body: { key: s.key, name: f.get('name'), group: f.get('group'), url: f.get('url'), icon, pinned: f.get('pinned') === 'on', hidden: f.get('hidden') === 'on' },
          })
        }
        say(m.overview_dialog_saved({ name: (String(f.get('name') || s.name)) }))
        onClose()
      } catch (e) {
        setError((e as Error).message)
      }
    })

  const reset = () =>
    work.run('reset', async () => {
      try {
        await api('/api/services/override', { method: 'DELETE', body: { key: s.key } })
        say(m.overview_dialog_automaticAgain({ name: s.name }))
        onClose()
      } catch (e) {
        setError((e as Error).message)
      }
    })

  const o = s.overridden ?? {}
  return (
    <Modal open onClose={onClose} title={manual ? m.overview_dialog_editLink({ name: s.name }) : m.overview_dialog_editService({ name: s.name })} busy={!!work.busy}>
      <form
        key={s.key}
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          void submit(new FormData(e.currentTarget))
        }}
      >
        {!manual && (
          <p className="m-0 text-[12px] text-muted">
            {m.overview_dialog_detectedFrom({ source: (s.source === 'caddy' ? 'Caddy' : m.overview_dialog_sourceLabel()) })}
            {s.container ? ` · ${m.overview_alert_container({ name: s.container })}` : ''}
            {s.unit ? ` · ${s.unit}` : ''}
            {m.overview_dialog_emptyFollows()}
          </p>
        )}
        <label className={label}>
          {m.common_name()}
          <input name="name" maxLength={60} required={manual} className="field" defaultValue={manual ? s.name : (o.name ?? '')} placeholder={s.name} autoFocus />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className={label}>
            {m.overview_dialog_group()}
            <input name="group" maxLength={40} className="field" defaultValue={manual ? s.group : (o.group ?? '')} placeholder={s.group} list="service-groups" />
            <datalist id="service-groups">
              {groups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </label>
          <label className={label}>
            URL
            <input name="url" type="url" required={manual} className="field font-mono" defaultValue={manual ? s.url : (o.url ?? '')} placeholder={s.url} />
          </label>
        </div>
        <div className={label}>
          Icon
          <IconPicker value={icon} onChange={setIcon} />
        </div>
        {manual ? (
          <label className="flex items-center gap-2 text-[13px]">
            <input name="health" type="checkbox" defaultChecked={s.healthCheck !== false} /> {m.overview_dialog_healthCheck()}
          </label>
        ) : (
          <div className="flex flex-wrap gap-4 text-[13px]">
            <label className="flex items-center gap-2">
              <input name="pinned" type="checkbox" defaultChecked={!!s.pinned} /> {m.overview_dialog_pin()}
            </label>
            <label className="flex items-center gap-2">
              <input name="hidden" type="checkbox" /> {m.overview_dialog_hide()}
            </label>
          </div>
        )}
        {error && (
          <p role="alert" className="m-0 text-[13px] text-[#ff8a80]">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {!manual && (s.overridden || s.pinned) && (
            <BusyButton className="btn mr-auto" busy={work.is('reset')} busyLabel={m.common_working()} disabled={!!work.busy} onClick={() => void reset()}>
              <Glyph name="restart" size={14} /> {m.overview_dialog_resetAuto()}
            </BusyButton>
          )}
          <button type="button" className="btn" disabled={!!work.busy} onClick={onClose}>
            {m.common_cancel()}
          </button>
          <BusyButton type="submit" className="btn primary" busy={work.is('save')} busyLabel={m.common_saving()} disabled={!!work.busy}>
            {m.common_save()}
          </BusyButton>
        </div>
      </form>
    </Modal>
  )
}
