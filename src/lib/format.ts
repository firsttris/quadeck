// Number/size/time formatting for the UI, in the viewer's language.

import { describeCalendar } from '~/shared/timers'
import { localeOf, tr } from '~/shared/i18n'

const nf = (digits: number) => new Intl.NumberFormat(localeOf(), { maximumFractionDigits: digits, minimumFractionDigits: digits })

export function bytes(n: number | undefined, digits = 1): string {
  if (n === undefined || !Number.isFinite(n)) return '–'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${nf(i === 0 || v >= 100 ? 0 : digits).format(v)} ${units[i]}`
}

/** Disk sizes like vendors print them (decimal TB/GB). */
export function diskSize(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let i = 0
  let v = n
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000
    i++
  }
  return `${nf(v >= 100 || i === 0 ? 0 : 1).format(v)} ${units[i]}`
}

export function rate(bps: number): string {
  const mb = bps / 1e6
  if (mb >= 10) return `${nf(0).format(mb)} MB/s`
  if (mb >= 0.1) return `${nf(1).format(mb)} MB/s`
  return `${nf(0).format(bps / 1e3)} KB/s`
}

export function pct(v: number, digits = 0) {
  return `${nf(digits).format(v * 100)} %`
}

export function num(v: number, digits = 0) {
  return nf(digits).format(v)
}

export function duration(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d) return `${d} d ${h} h`
  if (h) return `${h} h ${m} min`
  return `${m} min`
}

const span = (abs: number) => (abs < 3600 ? `${Math.round(abs / 60)} min` : abs < 86400 ? `${Math.round(abs / 3600)} h` : `${Math.round(abs / 86400)} d`)

/** "vor 12 min", "in 3 h" / "12 min ago", "in 3 h" */
export function relative(ts: number | undefined, now = Date.now()): string {
  if (!ts) return '–'
  const diff = ts - now
  const abs = Math.abs(diff) / 1000
  if (abs < 60) return tr('gerade', 'just now')
  const fmt = span(abs)
  return diff < 0 ? tr(`vor ${fmt}`, `${fmt} ago`) : tr(`in ${fmt}`, `in ${fmt}`)
}

/** Short age without preposition, as in the units table ("23 d"). */
export function age(ts: number | undefined, now = Date.now()): string {
  if (!ts) return '–'
  const abs = Math.abs(ts - now) / 1000
  return abs < 60 ? tr('gerade', 'just now') : span(abs)
}

export function clock(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  const mon = tr('Jan Feb Mär Apr Mai Jun Jul Aug Sep Okt Nov Dez', 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec').split(' ')[d.getMonth()]
  return `${mon} ${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function weekdayTime(ts: number | undefined): string {
  if (!ts) return '–'
  const d = new Date(ts)
  const day = tr('So Mo Di Mi Do Fr Sa', 'Sun Mon Tue Wed Thu Fri Sat').split(' ')[d.getDay()]
  return `${day} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Friendly OnCalendar= rendering for common expressions. */
export function calendarLabel(cal: string | undefined): string {
  return describeCalendar(cal?.trim())
}
