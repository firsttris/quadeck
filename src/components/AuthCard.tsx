import { useEffect, useState, type ReactNode } from 'react'
import { LANGS, switchLang, useLang, useT, type Lang } from '~/i18n'
import { Logo } from './Glyph'

export function AuthCard({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="panel flex w-full max-w-[400px] flex-col gap-5 p-6">
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
    </main>
  )
}

/** Small language switch (login card, sidebar footer). Reloads the page in the chosen language. */
export function LangSelect({ className = '' }: { className?: string }) {
  const t = useT().shell
  const lang = useLang()
  return (
    <select
      aria-label={t.language}
      title={t.language}
      value={lang}
      onChange={(e) => void switchLang(e.target.value as Lang)}
      className={`cursor-pointer rounded-md border border-[#2a323d] bg-[#0e1319] px-1.5 py-1 text-[12px] text-muted hover:text-fg ${className}`}
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
