import { useEffect, useState, type ReactNode } from 'react'
import { LANGS, switchLang, useLang, type Lang } from '~/i18n'
import { Logo } from './Glyph'
import { m } from '~/paraglide/messages'

export function AuthCard({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <main className="auth relative flex min-h-screen flex-col items-center justify-center overflow-hidden p-4">
      <div className="auth-grid" aria-hidden />
      <div className="auth-glow -top-40 -left-32 bg-accent/20" aria-hidden />
      <div className="auth-glow -right-32 -bottom-40 bg-accent-2/15 [animation-delay:-6s]" aria-hidden />
      <div className="auth-card panel relative flex w-full max-w-[400px] flex-col gap-5 p-6">
        <div className="flex items-center gap-[10px]">
          <Logo />
          <div className="grow font-cond text-[21px] font-semibold tracking-[.01em]">Quadeck</div>
          <LangSelect />
        </div>
        <div>
          <h1 className="m-0 font-cond text-[24px] font-semibold">{title}</h1>
          <p className="mt-1 mb-0 text-[13px] leading-relaxed text-muted">{subtitle}</p>
        </div>
        {children}
      </div>
      <ContainerShip />
    </main>
  )
}

/** The error under a login form; a new key per attempt plays the shake again. */
export function AuthError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="auth-shake m-0 text-[13px] text-[#ff8a80]">
      {children}
    </p>
  )
}

// Stacks on deck, left to right (bottom first); the colors cycle through the theme.
const STACKS = [2, 3, 2, 3, 1]
const BOX = { w: 26, h: 12, x0: 34, gap: 2, deck: 62 }
const TONES = ['var(--color-accent)', 'var(--color-accent-deep)', 'var(--color-accent-2)', 'var(--color-glow-2)', 'var(--color-accent-soft)']
const BOXES = STACKS.flatMap((height, col) => Array.from({ length: height }, (_, row) => ({ col, row }))).sort((a, b) => a.row - b.row || a.col - b.col)

/**
 * The logo brought to life: a container ship on the waves, loaded one container after
 * the other, the lights on the containers blink like running services. Static
 * (fully loaded) when animations are off.
 */
function ContainerShip() {
  return (
    <svg className="auth-ship mt-8 h-auto w-[340px] max-w-full" viewBox="0 0 240 96" aria-hidden>
      <g className="auth-hull">
        {BOXES.map(({ col, row }, n) => {
          const x = BOX.x0 + col * (BOX.w + BOX.gap)
          const y = BOX.deck - (row + 1) * (BOX.h + 1)
          const tone = TONES[(col + row * 2) % TONES.length]
          return (
            <g key={`${col}-${row}`} className="auth-box" style={{ animationDelay: `${0.35 + n * 0.16}s` }}>
              <rect x={x} y={y} width={BOX.w} height={BOX.h} rx={1.5} fill={`color-mix(in srgb, ${tone} 28%, transparent)`} stroke={tone} strokeWidth={1} />
              <path d={`M${x + 7} ${y + 2.5}v7M${x + 13} ${y + 2.5}v7M${x + 19} ${y + 2.5}v7`} stroke={tone} strokeOpacity={0.45} strokeWidth={1} />
              <circle className="auth-led" cx={x + BOX.w - 3} cy={y + 3} r={1.2} fill="var(--color-ok)" style={{ animationDelay: `${(n * 0.73) % 2.4}s`, animationDuration: `${1.8 + (n % 3) * 0.5}s` }} />
            </g>
          )
        })}
        {/* bridge at the stern */}
        <rect x={180} y={38} width={20} height={24} rx={2} fill="var(--color-raised)" stroke="var(--color-rim-strong)" />
        <path d="M184 44h12M184 49h12" stroke="var(--color-accent)" strokeOpacity={0.7} strokeWidth={1.6} strokeLinecap="round" />
        <path d="M190 38v-8" stroke="var(--color-rim-strong)" strokeWidth={1.5} strokeLinecap="round" />
        {/* hull */}
        <path d="M22 62h196l-14 18H36z" fill="color-mix(in srgb, var(--color-accent-deep) 35%, var(--color-panel))" stroke="var(--color-accent-deep)" strokeLinejoin="round" />
        <path d="M30 70h180" stroke="var(--color-accent)" strokeOpacity={0.35} />
      </g>
      <path className="auth-wave" fill="none" d={wave(84, 3)} stroke="var(--color-accent)" strokeOpacity={0.45} />
      <path className="auth-wave slow" fill="none" d={wave(90, 2.4)} stroke="var(--color-accent-deep)" strokeOpacity={0.4} />
    </svg>
  )
}

/** A seamless wave (period 40) wider than the view, so it can slide by one period. */
function wave(y: number, amp: number) {
  let d = `M-40 ${y}`
  for (let x = -40; x < 280; x += 40) d += `q10 ${-amp} 20 0t20 0`
  return d
}

/** Small language switch (login card, sidebar footer). Reloads the page in the chosen language. */
export function LangSelect({ className = '' }: { className?: string }) {
  const lang = useLang()
  return (
    <select
      aria-label={m.shell_language()}
      title={m.shell_language()}
      value={lang}
      onChange={(e) => void switchLang(e.target.value as Lang)}
      className={`cursor-pointer rounded-md border border-rim bg-sunken px-1.5 py-1 text-[12px] text-muted hover:text-fg ${className}`}
    >
      {LANGS.map((l) => (
        <option key={l.id} value={l.id}>
          {l.label}
        </option>
      ))}
    </select>
  )
}

/**
 * False until React has taken over the server-rendered page. Login and setup
 * keep their submit button disabled until then: a click before hydration
 * would let the browser submit the form itself (password in the URL).
 */
export function useHydrated() {
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => setHydrated(true), [])
  return hydrated
}
