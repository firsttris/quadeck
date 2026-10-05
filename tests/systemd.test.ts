import { describe, expect, it } from 'vitest'
import { buildUnit, calendarOf, parseListUnits, parseShow, parseTimestamp, quadletOf, UnitCollector, type ListedUnit } from '~/server/collectors/systemd'
import { failureReason } from '~/shared/units'

describe('systemd', () => {
  it('parses busctl ListUnits JSON', () => {
    const json = JSON.stringify({
      type: 'a(ssssssouso)',
      data: [[['jellyfin.service', 'Jellyfin', 'loaded', 'active', 'running', '', '/org/freedesktop/systemd1/unit/jellyfin_2eservice', 0, '', '/']]],
    })
    expect(parseListUnits(json)).toEqual([{ name: 'jellyfin.service', description: 'Jellyfin', load: 'loaded', active: 'active', sub: 'running' }])
  })

  it('parses systemctl show blocks', () => {
    const out = parseShow('Id=a.service\nResult=success\n\nId=b.timer\nTimersCalendar={ OnCalendar=*-*-* 03:00:00 ; next_elapse=@1 }\n')
    expect(out).toHaveLength(2)
    expect(out[1]!.TimersCalendar).toContain('OnCalendar')
  })

  it('parses timestamps in unix and legacy format', () => {
    expect(parseTimestamp('@1700000000')).toBe(1_700_000_000_000)
    expect(parseTimestamp('n/a')).toBeUndefined()
    expect(parseTimestamp('')).toBeUndefined()
    expect(parseTimestamp('Mon 2024-01-01 10:00:00 UTC')).toBe(Date.parse('2024-01-01 10:00:00'))
  })

  it('recognises Quadlet units only by their source file', () => {
    expect(quadletOf('/etc/containers/systemd/jellyfin.container')).toEqual({ file: 'jellyfin.container', type: 'container' })
    expect(quadletOf('/home/u/.config/containers/systemd/media.network')).toEqual({ file: 'media.network', type: 'network' })
    expect(quadletOf('/etc/systemd/system/foo.container')).toBeUndefined()
    expect(quadletOf(undefined)).toBeUndefined()
    expect(calendarOf('{ OnCalendar=Sun *-*-* 04:00:00 ; next_elapse=… }')).toBe('Sun *-*-* 04:00:00')
  })

  it('builds a failed Quadlet unit with OOM reason', () => {
    const u = buildUnit(
      { name: 'immich-ml.service', description: 'Immich ML', load: 'loaded', active: 'failed', sub: 'failed' },
      { Id: 'immich-ml.service', SourcePath: '/etc/containers/systemd/immich-ml.container', Result: 'oom-kill', ExecMainStatus: '137', MemoryMax: String(2 * 1024 ** 3), MemoryCurrent: '[not set]', StateChangeTimestamp: '@1700000000', UnitFileState: 'generated' },
    )
    expect(u).toMatchObject({ kind: 'quadlet', quadlet: { type: 'container' }, result: 'oom-kill', exitStatus: 137, memory: undefined, since: 1_700_000_000_000 })
    expect(failureReason(u)).toBe('OOM-Kill: Speicherlimit MemoryMax=2G erreicht')
    expect(failureReason({ ...u, result: 'exit-code', exitStatus: 1 })).toBe('Prozess endete mit Exit 1')
    expect(failureReason({ ...u, active: 'active' })).toBeUndefined()
  })

  it('builds timers', () => {
    const t = buildUnit(
      { name: 'restic.timer', description: '', load: 'loaded', active: 'active', sub: 'waiting' },
      { Id: 'restic.timer', TimersCalendar: '{ OnCalendar=*-*-* 03:30:00 ; next_elapse=@1700003600 }', NextElapseUSecRealtime: '@1700003600', LastTriggerUSec: 'n/a', Unit: 'restic.service' },
    )
    expect(t.kind).toBe('timer')
    expect(t.timer).toEqual({ calendar: '*-*-* 03:30:00', next: 1_700_003_600_000, last: undefined, unit: 'restic.service' })
  })
})

describe('sockets', () => {
  it('reads all Listen= addresses and the triggered unit', () => {
    const [p] = parseShow('Id=sshd.socket\nListen=[::]:22 (Stream)\nListen=0.0.0.0:2222 (Stream)\nTriggers=sshd@.service\nUnitFileState=enabled\n')
    const u = buildUnit({ name: 'sshd.socket', description: 'OpenSSH Server Socket', load: 'loaded', active: 'active', sub: 'listening' } as Parameters<typeof buildUnit>[0], p!)
    expect(u).toMatchObject({ kind: 'socket', socket: { listen: ['[::]:22 (Stream)', '0.0.0.0:2222 (Stream)'], triggers: 'sshd@.service' }, unitFileState: 'enabled' })
    expect(buildUnit({ name: 'x.service', description: '', load: 'loaded', active: 'active', sub: 'running' } as Parameters<typeof buildUnit>[0], {}).socket).toBeUndefined()
  })
})

describe('UnitCollector', () => {
  const row = (name: string, active = 'active'): ListedUnit => ({ name, description: name, load: 'loaded', active, sub: active === 'active' ? 'running' : 'dead' })
  const setup = (timestamps = true) => {
    let units = [row('a.service'), row('b.service'), row('c.timer')]
    let t = 0
    const calls: string[][] = []
    const show = async (args: string[]) => {
      calls.push(args)
      if (!timestamps && args[0] === '--timestamp=unix') return { code: 1, stdout: '' }
      const names = args.slice(args.indexOf('--') + 1)
      return { code: 0, stdout: names.map((n) => `Id=${n}\nUnitFileState=enabled\nMemoryCurrent=${t}\n`).join('\n') }
    }
    const c = new UnitCollector({ refreshMs: 30_000, now: () => t, list: async () => units, show })
    return { c, calls, setTime: (v: number) => (t = v), setUnits: (u: ListedUnit[]) => (units = u) }
  }
  const shown = (args: string[]) => args.slice(args.indexOf('--') + 1)

  it('reads every unit once, then only the ones whose row changed, all again after refreshMs', async () => {
    const { c, calls, setTime, setUnits } = setup()
    expect((await c.collect()).map((u) => u.memory)).toEqual([0, 0, 0])
    expect(calls.map(shown)).toEqual([['a.service', 'b.service', 'c.timer']])
    calls.length = 0
    setTime(5_000)
    await c.collect()
    expect(calls).toEqual([]) // nothing changed: no systemctl show at all
    setUnits([row('a.service'), row('b.service', 'failed'), row('c.timer')])
    setTime(10_000)
    await c.collect()
    expect(calls.map(shown)).toEqual([['b.service']])
    calls.length = 0
    c.invalidate('a.service') // e.g. after "enable at boot"
    await c.collect()
    expect(calls.map(shown)).toEqual([['a.service']])
    calls.length = 0
    setTime(40_000)
    const all = await c.collect()
    expect(calls.map(shown)).toEqual([['a.service', 'b.service', 'c.timer']])
    expect(all.map((u) => u.memory)).toEqual([40_000, 40_000, 40_000])
  })

  it('learns once that systemd has no --timestamp', async () => {
    const { c, calls, setTime } = setup(false)
    await c.collect()
    setTime(40_000)
    await c.collect()
    expect(calls.map((a) => a[0] === '--timestamp=unix')).toEqual([true, false, false])
  })
})
