import { useEffect } from 'react'

/**
 * Runs `load` now and every `ms`, but not while the tab is hidden: a page left open in a
 * background tab no longer asks the server every few seconds. Coming back loads at once.
 */
export function usePolling(load: () => unknown, ms: number) {
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    const start = () => {
      if (timer !== undefined) return
      void load()
      timer = setInterval(() => void load(), ms)
    }
    const stop = () => {
      clearInterval(timer)
      timer = undefined
    }
    const onVisibility = () => (document.hidden ? stop() : start())
    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [load, ms])
}
