import { useEffect, useState } from 'react'
import { useT } from '~/i18n'
import { api } from '~/lib/api'
import type { Service } from '~/shared/types'
import { Glyph } from './Glyph'
import { Modal } from './Modal'
import { useToast } from './Toast'

/** Icon picker over the dashboard-icons index; empty value = automatic. */
export function IconPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [query, setQuery] = useState(value)
  const [icons, setIcons] = useState<string[]>([])
  const [available, setAvailable] = useState(true)
  const t = useT().overview.dialog
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
          aria-label={t.searchIcon}
          placeholder={t.iconPlaceholder}
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
            {t.automatic}
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
              className={`flex h-10 items-center justify-center rounded-lg border ${slug === value ? 'border-accent bg-[rgba(124,196,184,.15)]' : 'border-[#2a323d] bg-[#0e1319]'}`}
            >
              <img src={`/api/icons/${slug}`} alt="" width={24} height={24} loading="lazy" className="h-6 w-6 object-contain" />
            </button>
          ))}
        </div>
      ) : (
        <p className="m-0 text-[12px] text-muted">{t.iconsOffline}</p>
      )}
    </div>
  )
}

const label = 'flex flex-col gap-1 text-[12px] font-medium text-muted'

/**
 * Edit a tile: discovered services get an override (empty field = follow
 * discovery), manual links are edited directly.
 */
export function ServiceDialog({ service, groups, onClose }: { service: Service | null; groups: string[]; onClose: () => void }) {
  const say = useToast()
  const tt = useT()
  const t = tt.overview.dialog
  const [error, setError] = useState('')
  const [icon, setIcon] = useState('')
  const s = service
  const manual = s?.manualId !== undefined
  useEffect(() => {
    setError('')
    setIcon(s?.overridden?.icon ?? (manual && s?.icon.kind === 'dash' ? s.icon.slug : ''))
  }, [s, manual])
  if (!s) return null

  const submit = async (f: FormData) => {
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
      say(t.saved(String(f.get('name') || s.name)))
      onClose()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const reset = async () => {
    try {
      await api('/api/services/override', { method: 'DELETE', body: { key: s.key } })
      say(t.automaticAgain(s.name))
      onClose()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const o = s.overridden ?? {}
  return (
    <Modal open onClose={onClose} title={manual ? t.editLink(s.name) : t.editService(s.name)}>
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
            {t.detectedFrom(s.source === 'caddy' ? 'Caddy' : t.sourceLabel)}
            {s.container ? ` · ${tt.overview.alert.container(s.container)}` : ''}
            {s.unit ? ` · ${s.unit}` : ''}
            {t.emptyFollows}
          </p>
        )}
        <label className={label}>
          {tt.common.name}
          <input name="name" maxLength={60} required={manual} className="field" defaultValue={manual ? s.name : (o.name ?? '')} placeholder={s.name} autoFocus />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className={label}>
            {t.group}
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
            <input name="health" type="checkbox" defaultChecked={s.healthCheck !== false} /> {t.healthCheck}
          </label>
        ) : (
          <div className="flex flex-wrap gap-4 text-[13px]">
            <label className="flex items-center gap-2">
              <input name="pinned" type="checkbox" defaultChecked={!!s.pinned} /> {t.pin}
            </label>
            <label className="flex items-center gap-2">
              <input name="hidden" type="checkbox" /> {t.hide}
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
            <button type="button" className="btn mr-auto" onClick={reset}>
              <Glyph name="restart" size={14} /> {t.resetAuto}
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            {tt.common.cancel}
          </button>
          <button type="submit" className="btn primary">
            {tt.common.save}
          </button>
        </div>
      </form>
    </Modal>
  )
}
