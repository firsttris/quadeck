import { describe, expect, it } from 'vitest'
import { calendarLabel, relative } from '~/lib/format'
import { journalArgs, parseJournalLine } from '~/server/journal'
import { validateLink } from '~/server/links'
import { assertUnitName } from '~/server/privileged/actions'
import { assetName, newer } from '~/server/update'

describe('privileged action guard', () => {
  it('accepts unit names and rejects anything else', () => {
    expect(() => assertUnitName('jellyfin.service')).not.toThrow()
    expect(() => assertUnitName('getty@tty1.service')).not.toThrow()
    expect(() => assertUnitName('backup.timer')).not.toThrow()
    for (const bad of ['--help.service', 'x.service; rm -rf /', '../x.service', 'multi-user.target', 'a b.service', '']) expect(() => assertUnitName(bad)).toThrow()
  })
})

describe('journal', () => {
  it('parses journalctl JSON lines incl. binary messages', () => {
    const e = parseJournalLine(JSON.stringify({ __REALTIME_TIMESTAMP: '1700000000123456', _SYSTEMD_UNIT: 'jellyfin.service', PRIORITY: '3', MESSAGE: [104, 105] }))
    expect(e).toMatchObject({ ts: 1_700_000_000_123, unit: 'jellyfin', priority: 3, message: 'hi' })
    expect(parseJournalLine(JSON.stringify({ __REALTIME_TIMESTAMP: '1', CONTAINER_NAME: 'immich-ml', _SYSTEMD_UNIT: 'immich-ml.service', MESSAGE: 'x' }))!.unit).toBe('immich-ml')
    expect(parseJournalLine('not json')).toBeUndefined()
  })
  it('builds safe journalctl arguments', () => {
    expect(journalArgs({ unit: 'jellyfin.service', priority: 3 })).toEqual(['journalctl', '-o', 'json', '--no-pager', '-f', '-n', '200', '-u', 'jellyfin.service', '-p', '0..3'])
    expect(() => journalArgs({ unit: '--since=yesterday' })).toThrow()
    expect(() => journalArgs({ unit: 'a b' })).toThrow()
  })
})

describe('manual links', () => {
  it('validates input', () => {
    expect(validateLink({ name: ' Router ', url: 'http://192.168.1.1', healthCheck: false })).toEqual({ name: 'Router', url: 'http://192.168.1.1/', group: undefined, icon: undefined, healthCheck: false })
    expect(() => validateLink({ name: 'x', url: 'javascript:alert(1)' })).toThrow(/http/)
    expect(() => validateLink({ name: 'x', url: 'nope' })).toThrow(/ungültig/)
    expect(() => validateLink({ name: '', url: 'http://a' })).toThrow(/Name/)
    expect(() => validateLink({ name: 'x', url: 'http://a', icon: '../etc' })).toThrow(/Icon/)
  })
})

describe('self update', () => {
  it('picks the right release asset', () => {
    expect(assetName('x64', false)).toBe('quadeck-linux-x64-baseline')
    expect(assetName('arm64', false)).toBe('quadeck-linux-arm64')
    expect(assetName('x64', true)).toBe('quadeck-linux-x64-musl')
    expect(assetName('arm64', true)).toBe('quadeck-linux-arm64-musl')
    // never an x64 binary for a 32-bit ARM board
    expect(() => assetName('arm', false)).toThrow(/architecture \(arm\)/)
    expect(() => assetName('riscv64', true)).toThrow(/x64, arm64/)
  })
  it('compares versions', () => {
    expect(newer('v0.2.0', '0.1.9')).toBe(true)
    expect(newer('v0.1.0', '0.1.0')).toBe(false)
    expect(newer('0.10.0', '0.9.0')).toBe(true)
    expect(newer('0.1.0', '0.2.0')).toBe(false)
  })
})

describe('format', () => {
  it('renders relative times and calendars in German', () => {
    const now = 1_700_000_000_000
    expect(relative(now - 12 * 60_000, now)).toBe('vor 12 min')
    expect(relative(now + 13 * 3600_000, now)).toBe('in 13 h')
    expect(relative(now + 3 * 86400_000, now)).toBe('in 3 d')
    expect(relative(undefined, now)).toBe('–')
    expect(calendarLabel('*-*-* 03:00:00')).toBe('täglich 03:00')
    expect(calendarLabel('Sun *-*-* 04:00:00')).toBe('So 04:00')
    expect(calendarLabel('daily')).toBe('täglich 00:00')
  })
})

describe('systemd units', () => {
  it('lets the helper write system files readable for everyone, the web app root only', async () => {
    const { HELPER_UNIT, WEB_UNIT } = await import('~/unit-file')
    expect(HELPER_UNIT).toMatch(/^UMask=0022$/m)
    expect(WEB_UNIT).toMatch(/^UMask=0077$/m)
  })
})
