import { useState } from 'react'
import type { Service } from '~/shared/types'
import { Glyph } from './Glyph'
import { Dot, healthTone } from './Status'

const HEALTH_LABEL = { ok: 'erreichbar', warn: 'eingeschränkt', bad: 'nicht erreichbar', unknown: 'unbekannt' } as const

export function ServiceIcon({ s }: { s: Service }) {
  const [failed, setFailed] = useState(false)
  const src = s.icon.kind === 'dash' ? `/api/icons/${s.icon.slug}` : s.icon.kind === 'favicon' ? `/api/favicon/${encodeURIComponent(s.icon.key)}` : undefined
  const style = {
    color: s.color,
    background: `radial-gradient(circle at 30% 25%, ${s.color}38, ${s.color}14)`,
    boxShadow: `inset 0 0 0 1px ${s.color}44, 0 0 18px ${s.color}22`,
  }
  return (
    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl @min-[260px]:h-16 @min-[260px]:w-16" style={style}>
      {src && !failed ? (
        <img
          src={src}
          alt=""
          width={26}
          height={26}
          className="h-[26px] w-[26px] object-contain @min-[260px]:h-10 @min-[260px]:w-10"
          onError={() => setFailed(true)}
          // The image may already have failed before hydration attached onError.
          ref={(img) => {
            if (img?.complete && img.naturalWidth === 0) setFailed(true)
          }}
        />
      ) : (
        <Glyph name={s.icon.kind === 'glyph' ? s.icon.glyph : s.iconFallback} size={22} />
      )}
    </span>
  )
}

/** In edit mode the tile is not a link, so dragging it never opens the service. */
export function ServiceTile({ s, onDelete, editing }: { s: Service; onDelete?: () => void; editing?: boolean }) {
  const body = (
    <>
      <div className="flex items-center justify-between">
        <ServiceIcon s={s} />
        <span title={s.healthNote ?? HEALTH_LABEL[s.health]}>
          <Dot tone={healthTone(s.health)} label={`${HEALTH_LABEL[s.health]}${s.healthNote ? ` – ${s.healthNote}` : ''}`} />
        </span>
      </div>
      <div className="truncate font-medium text-fg @min-[260px]:text-[17px]">{s.name}</div>
      <div className="truncate font-mono text-[11px] text-muted">{s.host}</div>
    </>
  )
  return (
    <div className="group @container relative h-full">
      {editing ? (
        <div className="tile h-full cursor-grab select-none @min-[260px]:justify-center" data-testid="service-tile">
          {body}
        </div>
      ) : (
        <a href={s.url} target="_blank" rel="noopener noreferrer" className="tile h-full @min-[260px]:justify-center" data-testid="service-tile">
          {body}
        </a>
      )}
      {onDelete && (
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Link ${s.name} entfernen`}
          className="no-drag absolute right-2 bottom-2 hidden h-7 w-7 items-center justify-center rounded-md border border-[#2a323d] bg-[#161c24] text-muted group-focus-within:flex group-hover:flex hover:text-[#ff8a80]"
        >
          <Glyph name="trash" size={14} />
        </button>
      )}
    </div>
  )
}
