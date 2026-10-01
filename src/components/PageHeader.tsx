import type { ReactNode } from 'react'

export function PageHeader({ title, subtitle, children }: { title: string; subtitle: ReactNode; children?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end gap-[14px]">
      <div className="min-w-0 grow">
        <h1 className="m-0 font-cond text-[28px] font-semibold tracking-[-.005em]">{title}</h1>
        <p className="mt-0.5 mb-0 text-muted">{subtitle}</p>
      </div>
      {children}
    </header>
  )
}
