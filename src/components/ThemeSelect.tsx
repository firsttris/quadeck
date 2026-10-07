import { THEMES, THEME_SWATCH, setTheme, useTheme, type Theme } from '~/lib/theme'
import { pickMsg } from '~/i18n'
import { m } from '~/paraglide/messages'

export const themeLabel = (theme: Theme) => pickMsg({ quadeck: m.theme_quadeck, nord: m.theme_nord, ocean: m.theme_ocean, amethyst: m.theme_amethyst, copper: m.theme_copper }, theme)

/** Color theme: one swatch per theme (bottom of the sidebar, above the animations). */
export function ThemeSelect() {
  const theme = useTheme()
  return (
    <div className="flex flex-col gap-1.5">
      <div role="radiogroup" aria-label={m.theme_label()} className="flex justify-between rounded-[8px] border border-rim bg-sunken px-2 py-1.5">
        {THEMES.map((t) => (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={theme === t}
            aria-label={themeLabel(t)}
            title={themeLabel(t)}
            className={`grid size-[22px] place-items-center rounded-full border ${theme === t ? 'border-fg' : 'border-rim hover:border-subtle'}`}
            style={{ background: THEME_SWATCH[t].bg }}
            onClick={() => setTheme(t)}
          >
            <span className="size-2.5 rounded-full" style={{ background: THEME_SWATCH[t].accent }} />
          </button>
        ))}
      </div>
      <span className="text-[11px] leading-snug text-faint" suppressHydrationWarning>
        {m.theme_label()}: {themeLabel(theme)}
      </span>
    </div>
  )
}
