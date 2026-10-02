import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'

const Ctx = createContext<(msg: string, tone?: 'ok' | 'bad') => void>(() => {})

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ msg: string; tone: 'ok' | 'bad' } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const say = useCallback((msg: string, tone: 'ok' | 'bad' = 'ok') => {
    setToast({ msg, tone })
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setToast(null), tone === 'bad' ? 6000 : 3000)
  }, [])
  return (
    <Ctx.Provider value={say}>
      {children}
      <div role="status" aria-live="polite" className="pointer-events-none fixed bottom-6 left-1/2 z-30 -translate-x-1/2">
        {toast && (
          <div
            className="rounded-[10px] px-[18px] py-[10px] text-[13px] font-medium shadow-[0_10px_30px_rgba(0,0,0,.4)]"
            style={toast.tone === 'bad' ? { background: '#3a1416', color: '#ffb4ab', border: '1px solid rgba(248,81,73,.5)' } : { background: '#e6e8eb', color: '#0b0f14' }}
          >
            {toast.msg}
          </div>
        )}
      </div>
    </Ctx.Provider>
  )
}

export const useToast = () => useContext(Ctx)
