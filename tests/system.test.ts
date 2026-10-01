import { describe, expect, it } from 'vitest'
import { cpuUsage, parseLoadavg, parseMeminfo, parseNetDev, parseOsRelease, parseProcStat } from '~/server/collectors/system'

describe('system parsers', () => {
  it('computes CPU usage from two /proc/stat samples', () => {
    const a = parseProcStat('cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 1 2 3 4\n')!
    const b = parseProcStat('cpu  150 0 150 900 0 0 0 0 0 0\n')!
    expect(a).toEqual({ idle: 800, total: 1000 })
    expect(cpuUsage(a, b)).toBeCloseTo(0.5)
    expect(cpuUsage(b, b)).toBe(0)
  })

  it('counts iowait as idle', () => {
    const a = parseProcStat('cpu  0 0 0 0 0 0 0 0')!
    const b = parseProcStat('cpu  10 0 0 40 50 0 0 0')!
    expect(cpuUsage(a, b)).toBeCloseTo(0.1)
  })

  it('reads MemAvailable, with a fallback for old kernels', () => {
    expect(parseMeminfo('MemTotal:       16000 kB\nMemFree:  1000 kB\nMemAvailable:   8000 kB\n')).toEqual({ total: 16000 * 1024, available: 8000 * 1024 })
    expect(parseMeminfo('MemTotal: 100 kB\nMemFree: 10 kB\nBuffers: 5 kB\nCached: 20 kB\n')).toEqual({ total: 102400, available: 35 * 1024 })
  })

  it('parses loadavg, net/dev and os-release', () => {
    expect(parseLoadavg('0.52 0.58 0.59 1/467 12345\n')).toEqual([0.52, 0.58, 0.59])
    const net = parseNetDev(
      'Inter-|   Receive |  Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets\n    lo: 100 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0\n  eno1: 5000 10 0 0 0 0 0 0 7000 9 0 0 0 0 0 0\n',
    )
    expect(net.eno1).toEqual({ rx: 5000, tx: 7000 })
    expect(parseOsRelease('NAME="Fedora Linux"\nVERSION_ID=42\nPRETTY_NAME="Fedora Linux 42 (Server Edition)"\n')).toBe('Fedora Linux 42 (Server Edition)')
    expect(parseOsRelease('NAME="Alpine Linux"\nVERSION_ID=3.20.0\n')).toBe('Alpine Linux 3.20.0')
    expect(parseOsRelease('')).toBe('Linux')
  })
})
