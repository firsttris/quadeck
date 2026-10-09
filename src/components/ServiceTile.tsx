import { useState } from 'react'
import type { IconSize } from '~/shared/layout'
import type { Service } from '~/shared/types'
import { Glyph } from './Glyph'
import { Dot, healthTone } from './Status'
import { m } from '~/paraglide/messages'
import { pickMsg } from '~/i18n'

/** Box and image per icon size; wide tiles (≥ 260 px) get the larger pair. */
const SIZES: Record<IconSize, { box: string; img: string; px: number; glyph: number }> = {
  sm: { box: 'h-8 w-8 rounded-lg @min-[260px]:h-11 @min-[260px]:w-11 @min-[260px]:rounded-xl', img: 'h-5 w-5 @min-[260px]:h-7 @min-[260px]:w-7', px: 20, glyph: 17 },
  md: { box: 'h-11 w-11 rounded-xl @min-[260px]:h-16 @min-[260px]:w-16', img: 'h-[26px] w-[26px] @min-[260px]:h-10 @min-[260px]:w-10', px: 26, glyph: 22 },
  lg: { box: 'h-14 w-14 rounded-2xl @min-[260px]:h-20 @min-[260px]:w-20', img: 'h-[34px] w-[34px] @min-[260px]:h-[52px] @min-[260px]:w-[52px]', px: 34, glyph: 28 },
}

export function ServiceIcon({ s, size = 'md' }: { s: Service; size?: IconSize }) {
  const src = s.icon.kind === 'dash' ? `/api/icons/${s.icon.slug}` : s.icon.kind === 'favicon' ? `/api/favicon/${encodeURIComponent(s.icon.key)}` : undefined
  // Remembers which source failed, so a newly picked icon is tried again (a plain flag kept the
  // fallback glyph until reload once the automatic favicon had failed).
  const [failedSrc, setFailedSrc] = useState<string>()
  const failed = !!src && failedSrc === src
  const z = SIZES[size]
  const style = {
    color: s.color,
    background: `radial-gradient(circle at 30% 25%, ${s.color}38, ${s.color}14)`,
    boxShadow: `inset 0 0 0 1px ${s.color}44, 0 0 18px ${s.color}22`,
  }
  return (
    <span className={`flex shrink-0 items-center justify-center ${z.box}`} style={style} data-icon={s.icon.kind === 'dash' ? s.icon.slug : undefined} data-size={size}>
      {src && !failed ? (
        <img
          src={src}
          alt=""
          width={z.px}
          height={z.px}
          className={`object-contain ${z.img}`}
          onError={() => setFailedSrc(src)}
          // The image may already have failed before hydration attached onError.
          ref={(img) => {
            if (img?.complete && img.naturalWidth === 0) setFailedSrc(src)
          }}
        />
      ) : (
        <Glyph name={s.icon.kind === 'glyph' ? s.icon.glyph : s.iconFallback} size={z.glyph} />
      )}
    </span>
  )
}

/** In edit mode the tile is not a link, so dragging it never opens the service. */
export function ServiceTile({ s, size, onDelete, onEdit, editing }: { s: Service; size?: IconSize; onDelete?: () => void; onEdit?: () => void; editing?: boolean }) {
  const body = (
    <>
      <div className="flex items-center justify-between">
        <ServiceIcon s={s} size={size} />
        <span title={s.healthNote ?? pickMsg({ "ok": m.overview_tile_health_ok, "warn": m.overview_tile_health_warn, "bad": m.overview_tile_health_bad, "unknown": m.overview_tile_health_unknown }, s.health)}>
          <Dot tone={healthTone(s.health)} label={`${pickMsg({ "ok": m.overview_tile_health_ok, "warn": m.overview_tile_health_warn, "bad": m.overview_tile_health_bad, "unknown": m.overview_tile_health_unknown }, s.health)}${s.healthNote ? ` – ${s.healthNote}` : ''}`} />
        </span>
      </div>
      <div className="truncate font-medium text-fg @min-[260px]:text-[17px]">{s.name}</div>
      <div className="truncate font-mono text-[11px] text-muted">{s.host}</div>
    </>
  )
  return (
    <div className="group @container relative h-full">
      {editing ? (
        <div
          className="tile h-full cursor-grab select-none @min-[260px]:justify-center"
          data-testid="service-tile"
          role="button"
          tabIndex={0}
          aria-label={m.overview_tile_edit({ name: s.name })}
          onClick={onEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onEdit?.()
            }
          }}
        >
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
          aria-label={m.overview_tile_removeLink({ name: s.name })}
          className="no-drag absolute right-2 bottom-2 hidden h-7 w-7 items-center justify-center rounded-md border border-rim bg-surface text-muted group-focus-within:flex group-hover:flex hover:text-[#ff8a80]"
        >
          <Glyph name="trash" size={14} />
        </button>
      )}
    </div>
  )
}
