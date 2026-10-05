import { describe, expect, it } from 'vitest'
import { buildCalendar, cronToCalendar, describeCalendar, emptySpec, execQuote, execUnquote, parseCalendar, parseSpec, renderService, renderTimer, specErrors, specFromService, type TimerSpec } from '~/shared/timers'
import { FixtureTimers, calendarsOf, execOf, monotonicOf, parseCalendarOutput, parseSave, verifyUnits } from '~/server/timers/backend'
import { calendarLabel } from '~/lib/format'

const spec = (o: Partial<TimerSpec> = {}): TimerSpec => ({ ...emptySpec(), name: 'backup', description: 'Backup', command: '/usr/local/bin/backup.sh', ...o })
const hasAnalyze = !!Bun.which('systemd-analyze')

describe('ExecStart quoting', () => {
  it('escapes quotes, backslashes, $ and % and round-trips', () => {
    const cmd = 'echo "hi $HOME" 100% \\ok\nfor f in *; do echo $f; done\tx'
    const q = execQuote(cmd)
    expect(q).toBe('"echo \\"hi $$HOME\\" 100%% \\\\ok\\nfor f in *; do echo $$f; done\\tx"')
    expect(execUnquote(q)).toBe(cmd)
  })
})

describe('timer units are checked before they are written', () => {
  it.skipIf(!Bun.which('systemd-analyze'))('reports what systemd-analyze refuses, with plain file names', async () => {
    const service = { name: 'qd-check.service', content: '[Unit]\nDescription=x\n[Service]\nType=oneshot\nExecStart=/bin/true\n' }
    expect(await verifyUnits([service, { name: 'qd-check.timer', content: '[Timer]\nOnCalendar=daily\n[Install]\nWantedBy=timers.target\n' }])).toEqual([])
    const bad = await verifyUnits([service, { name: 'qd-check.timer', content: '[Timer]\nOnCalendar=garbage\n' }])
    expect(bad.join('\n')).toContain('qd-check.timer')
    expect(bad.join('\n')).not.toContain('quadeck-timer-')
  })
})

describe('unit files', () => {
  it('renders service and timer and reads the spec back', () => {
    const s = spec({ user: 'tristan', workingDirectory: '/srv', lowPriority: true, network: true, randomDelay: 10, description: '50% Rabatt' })
    const svc = renderService(s)
    expect(svc).toContain('Description=50%% Rabatt')
    expect(svc).toContain('User=tristan')
    expect(svc).toContain('Nice=10\nIOSchedulingClass=idle')
    expect(svc).toContain('After=network-online.target')
    expect(svc).toContain('ExecStart=/bin/sh -c "/usr/local/bin/backup.sh"')
    const tmr = renderTimer(s)
    expect(tmr).toContain('OnCalendar=*-*-* 03:00:00\nPersistent=true\nRandomizedDelaySec=10min')
    expect(tmr).toContain('WantedBy=timers.target')
    expect(specFromService(svc)).toEqual(s)
    expect(specFromService('[Unit]\nDescription=x\n')).toBeUndefined()
  })

  it('rejects bad specs', () => {
    expect(specErrors(spec())).toEqual([])
    expect(specErrors(spec({ name: 'a b' }))).toHaveLength(1)
    expect(specErrors(spec({ name: 'x.service' }))).toHaveLength(1)
    expect(specErrors(spec({ command: ' ' }))).toEqual(['Befehl fehlt'])
    expect(specErrors(spec({ description: 'a\nb' }))).toHaveLength(1)
    expect(specErrors(spec({ user: 'Root;' }))).toHaveLength(1)
    expect(specErrors(spec({ workingDirectory: 'srv' }))).toHaveLength(1)
    expect(specErrors(spec({ calendar: 'daily; rm' }))).toHaveLength(1)
    expect(() => parseSpec({ name: '../x', command: 'true', calendar: 'daily' })).toThrow(/Name/)
    expect(() => parseSave({ spec: spec(), previous: '../etc' })).toThrow(/bisheriger/)
    expect(parseSave({ spec: { ...spec(), command: 'a\r\nb  \n' } }).spec.command).toBe('a\nb')
  })

  it.skipIf(!hasAnalyze)('passes systemd-analyze verify', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(`${tmpdir()}/qd-timer-`)
    const s = spec({ command: 'echo "a $b" | tr a b\nsleep 1', lowPriority: true, network: true, randomDelay: 5 })
    writeFileSync(`${dir}/backup.service`, renderService(s))
    writeFileSync(`${dir}/backup.timer`, renderTimer(s))
    const p = Bun.spawnSync(['systemd-analyze', 'verify', `${dir}/backup.service`, `${dir}/backup.timer`])
    expect(p.stderr.toString()).not.toMatch(/backup\.(service|timer)/)
  })
})

describe('schedule builder', () => {
  const cases: [string, string][] = [
    ['*-*-* *:00/15:00', 'alle 15 Minuten'],
    ['*-*-* *:05:00', 'stündlich um :05'],
    ['*-*-* 00/6:00:00', 'alle 6 Stunden'],
    ['*-*-* 03:30:00', 'täglich 03:30'],
    ['Mon..Fri *-*-* 07:00:00', 'Mo–Fr 07:00'],
    ['Mon,Wed *-*-* 21:15:00', 'Mo, Mi 21:15'],
    ['*-*-01 04:00:00', 'monatlich am 1. um 04:00'],
  ]
  it.each(cases)('%s → %s and back', (expr, label) => {
    expect(describeCalendar(expr)).toBe(label)
    expect(buildCalendar(parseCalendar(expr))).toBe(expr)
  })

  it('understands shorthand and leaves the rest custom', () => {
    expect(parseCalendar('daily')).toEqual({ kind: 'daily', time: '00:00' })
    expect(parseCalendar('*:0/15')).toEqual({ kind: 'minutes', every: 15 })
    expect(parseCalendar('Sat,Sun *-*-* 9:00')).toEqual({ kind: 'weekly', days: ['Sat', 'Sun'], time: '09:00' })
    expect(parseCalendar('*-01-01 00:00:00').kind).toBe('custom')
    expect(parseCalendar('Mon *-*-1..7 03:00').kind).toBe('custom')
    expect(buildCalendar({ kind: 'weekly', days: ['Fri', 'Mon', 'Tue', 'Wed', 'Thu'], time: '6:05' })).toBe('Mon..Fri *-*-* 06:05:00')
    expect(calendarLabel('Sun *-*-* 04:00:00')).toBe('So 04:00')
  })

  it.skipIf(!hasAnalyze)('builds expressions systemd accepts', () => {
    for (const [expr] of cases) expect(Bun.spawnSync(['systemd-analyze', 'calendar', expr]).exitCode).toBe(0)
  })
})

describe('cron', () => {
  const cases: [string, string, string?][] = [
    ['30 3 * * * /usr/local/bin/backup.sh', '*-*-* 03:30:00', '/usr/local/bin/backup.sh'],
    ['*/15 * * * *', '*-*-* *:00/15:00'],
    ['0 */6 * * *', '*-*-* 00/6:00:00'],
    ['0 7 * * 1-5 echo hi', 'Mon..Fri *-*-* 07:00:00', 'echo hi'],
    ['0 9 * * sat,sun', 'Sat,Sun *-*-* 09:00:00'],
    ['0 0 1 */3 *', '*-01/3-01 00:00:00'],
    ['5 4 * * 0', 'Sun *-*-* 04:05:00'],
    ['0 22 * * 0-2', 'Sun,Mon..Tue *-*-* 22:00:00'],
    ['0 0 1-15/2 jan,jul *', '*-01,07-01..15/2 00:00:00'],
  ]
  it.each(cases)('%s', (line, cal, cmd) => {
    const r = cronToCalendar(line)
    expect(r.error).toBeUndefined()
    expect(r.calendar).toBe(cal)
    expect(r.command).toBe(cmd)
    if (hasAnalyze) expect(Bun.spawnSync(['systemd-analyze', 'calendar', r.calendar!]).exitCode).toBe(0)
  })

  it('handles specials, warnings and errors', () => {
    expect(cronToCalendar('@daily /bin/true')).toEqual({ calendar: '*-*-* 00:00:00', command: '/bin/true' })
    expect(cronToCalendar('@reboot x').error).toMatch(/@reboot/)
    expect(cronToCalendar('0 3 1 * 1').warning).toMatch(/ODER/)
    expect(cronToCalendar('61 * * * *').error).toMatch(/61/)
    expect(cronToCalendar('* * *').error).toMatch(/fünf/)
    expect(cronToCalendar('0 0 * * */2').error).toMatch(/Schritte/)
  })
})

describe('systemctl/systemd-analyze parsing', () => {
  it('reads properties', () => {
    expect(calendarsOf('{ OnCalendar=*-*-* 03:00:00 ; next_elapse=@1 } { OnCalendar=Sun *-*-* 04:00:00 ; next_elapse=@2 }')).toEqual(['*-*-* 03:00:00', 'Sun *-*-* 04:00:00'])
    expect(monotonicOf('{ OnBootUSec=15min ; next_elapse=0 } { OnUnitActiveUSec=1d ; next_elapse=0 }')).toEqual(['OnBootSec=15min', 'OnUnitActiveSec=1d'])
    expect(execOf('{ path=/bin/sh ; argv[]=/bin/sh -c "echo a; b" ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }')).toBe('/bin/sh -c "echo a; b"')
  })

  it('reads systemd-analyze calendar output in local time', () => {
    const out = `  Original form: daily
Normalized form: *-*-* 00:00:00
    Next elapse: Sat 2026-10-03 00:00:00 CEST
       From now: 10h left
   Iteration #2: Sun 2026-10-04 00:00:00 CEST
       From now: 1 day 10h left`
    expect(parseCalendarOutput(out)).toEqual({ normalized: '*-*-* 00:00:00', next: [new Date(2026, 9, 3).getTime(), new Date(2026, 9, 4).getTime()] })
  })
})

describe('FixtureTimers', () => {
  it('creates, renames, overrides, runs and deletes', async () => {
    const t = new FixtureTimers('fixtures/demo')
    let s = await t.timersState()
    expect(s.timers.find((x) => x.name === 'podman-cleanup.timer')?.managed).toBeTruthy()
    s = await t.saveTimer(spec(), undefined, true)
    expect(s.timers.find((x) => x.name === 'backup.timer')).toMatchObject({ enabled: true, command: '/usr/local/bin/backup.sh' })
    await expect(t.saveTimer(spec({ name: 'restic-backup' }), undefined, true)).rejects.toThrow(/gibt es schon/)
    s = await t.saveTimer(spec({ name: 'backup2' }), 'backup', false)
    expect(s.timers.some((x) => x.name === 'backup.timer')).toBe(false)
    expect(s.timers.find((x) => x.name === 'backup2.timer')?.enabled).toBe(false)
    s = await t.setTimerSchedule('restic-backup.timer', '*-*-* 01:00:00')
    expect(s.timers.find((x) => x.name === 'restic-backup.timer')).toMatchObject({ override: '*-*-* 01:00:00', calendars: ['*-*-* 01:00:00'] })
    expect(await t.timerFiles('restic-backup.timer')).toContain('50-quadeck.conf')
    s = await t.setTimerSchedule('restic-backup.timer', '')
    expect(s.timers.find((x) => x.name === 'restic-backup.timer')).toMatchObject({ override: undefined, calendars: ['*-*-* 03:30:00'] })
    await expect(t.setTimerSchedule('backup2.timer', 'daily')).rejects.toThrow(/Bearbeiten/)
    await expect(t.deleteTimer('restic-backup.timer')).rejects.toThrow(/nicht von Quadeck/)
    s = await t.timerAction('backup-offsite.timer', 'run')
    expect(s.timers.find((x) => x.name === 'backup-offsite.timer')?.result).toBe('success')
    s = await t.deleteTimer('backup2.timer')
    expect(s.timers.some((x) => x.name === 'backup2.timer')).toBe(false)
    await expect(t.timerAction('../x.timer', 'run')).rejects.toThrow(/Ungültig/)
  })
})

describe('only calendars systemd accepts', () => {
  it('lists the days of a weekday range across the weekend', () => {
    expect(cronToCalendar('0 0 * * 5-1 cmd').calendar).toBe('Fri,Sat,Sun,Mon *-*-* 00:00:00')
    expect(cronToCalendar('0 0 * * sat-tue cmd').calendar).toBe('Sat,Sun,Mon,Tue *-*-* 00:00:00')
    expect(cronToCalendar('0 0 * * 0-2 cmd').calendar).toBe('Sun,Mon..Tue *-*-* 00:00:00')
  })

  it('refuses a step of 0 and reversed ranges', () => {
    for (const l of ['*/0 * * * * x', '1-31/0 * * * * x', '0 */0 * * * x', '0 22-2 * * * x']) expect(cronToCalendar(l).error).toBeTruthy()
  })

  it('builds no step 0 or out-of-range values', () => {
    expect(buildCalendar({ kind: 'minutes', every: 0 })).toBe('*-*-* *:*:00')
    expect(buildCalendar({ kind: 'hours', every: 0, minute: 75 })).toBe('*-*-* *:59:00')
    expect(buildCalendar({ kind: 'monthly', day: 40, time: '03:00' })).toBe('*-*-31 03:00:00')
    expect(parseCalendar('*-*-* 00/0:00:00').kind).toBe('custom')
    expect(parseCalendar('*-*-* *:00/0:00').kind).toBe('custom')
  })
})
