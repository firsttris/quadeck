import { MOTION_LEVELS, setMotion, useMotion, type Motion } from '~/lib/motion'
import { pickMsg } from '~/i18n'
import { m } from '~/paraglide/messages'

export const motionLabel = (level: Motion) => pickMsg({ off: m.motion_off, subtle: m.motion_subtle, strong: m.motion_strong }, level)
const motionHint = (level: Motion) => pickMsg({ off: m.motion_hint_off, subtle: m.motion_hint_subtle, strong: m.motion_hint_strong }, level)

/** Animations: off · subtle · strong (bottom of the sidebar, like SnapRAID UI). */
export function MotionSelect() {
  const motion = useMotion()
  return (
    <div className="flex flex-col gap-1.5">
      <div role="radiogroup" aria-label={m.motion_label()} className="grid grid-cols-3 rounded-[8px] border border-rim bg-sunken p-0.5">
        {MOTION_LEVELS.map((level) => (
          <button
            key={level}
            type="button"
            role="radio"
            aria-checked={motion === level}
            className={`rounded-[6px] px-1 py-1 text-[11.5px] ${motion === level ? 'bg-raised font-medium text-fg' : 'text-muted hover:text-fg'}`}
            onClick={() => setMotion(level)}
          >
            {motionLabel(level)}
          </button>
        ))}
      </div>
      <span className="text-[11px] leading-snug text-faint" suppressHydrationWarning>
        {m.motion_label()}: {motionHint(motion)}
      </span>
    </div>
  )
}
