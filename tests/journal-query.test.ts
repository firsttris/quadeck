import { describe, expect, it } from 'vitest'
import { journalSource } from '~/shared/journal'

// The demo data answers the queries (fixtures); everything else is pure.
process.env.QUADECK_FIXTURES = 'fixtures/demo'
const { escapeRegex, journalBoots, journalEntry, journalQueryArgs, PAGE, parseBoots, parseJournalQuery, parseSystemEntry, queryJournal } = await import('~/server/journal-query')

const q = (s: string) => parseJournalQuery(new URLSearchParams(s))

describe('journal query from the URL', () => {
  it('takes the known filters', () => {
    expect(q('')).toEqual({ scope: 'all' })
    expect(q('scope=kernel&boot=-1&since=60&prio=4&unit=sshd.service&ident=sudo&q=%20fail%20&before=s%3Dabc%3Bi%3D1')).toEqual({
      scope: 'kernel',
      boot: '-1',
      since: 60,
      prio: 4,
      unit: 'sshd.service',
      ident: 'sudo',
      q: 'fail',
      before: 's=abc;i=1',
    })
    expect(q('boot=3b1e9a7c5d2f4e6a8b0c1d2e3f4a5b6c').boot).toBe('3b1e9a7c5d2f4e6a8b0c1d2e3f4a5b6c')
  })

  it('refuses anything that could become an option or is out of range', () => {
    for (const bad of [
      'scope=everything',
      'boot=--all',
      'boot=xyz',
      'since=0',
      'since=abc',
      'prio=8',
      'prio=-1',
      'unit=--system',
      'unit=a b',
      'ident=-x',
      'before=--grep=x',
      `q=${'x'.repeat(201)}`,
      'q=a%0Ab',
    ])
      expect(() => q(bad), bad).toThrow()
  })
})

describe('journalctl arguments', () => {
  it('newest first, one page, every filter as its own argument', () => {
    const now = 1_700_000_000_000
    expect(journalQueryArgs({ scope: 'all' }, now)).toEqual(['journalctl', '-o', 'json', '--no-pager', '-r', '-n', String(PAGE)])
    const args = journalQueryArgs({ scope: 'auth', boot: '0', since: 60, prio: 3, unit: 'sshd.service', ident: 'sshd', q: 'a.b (c)', before: 's=1;i=2' }, now)
    expect(args).toEqual([
      'journalctl',
      '-o',
      'json',
      '--no-pager',
      '-r',
      '-n',
      String(PAGE),
      '--boot=0',
      `--since=@${Math.floor((now - 3_600_000) / 1000)}`,
      '--priority=0..3',
      '--unit=sshd.service',
      '--identifier=sshd',
      '--after-cursor=s=1;i=2',
      '--grep=a\\.b \\(c\\)',
      '--case-sensitive=false',
      'SYSLOG_FACILITY=4',
      'SYSLOG_FACILITY=10',
    ])
    // kernel messages by transport: -k would also pin the current boot
    expect(journalQueryArgs({ scope: 'kernel' }, now).at(-1)).toBe('_TRANSPORT=kernel')
    // without PCRE2 the search runs here instead
    expect(journalQueryArgs({ scope: 'all', q: 'x' }, now, false).some((a) => a.startsWith('--grep'))).toBe(false)
  })

  it('searches literally', () => {
    expect(escapeRegex('C++ [x]? 100% $HOME')).toBe('C\\+\\+ \\[x\\]\\? 100% \\$HOME')
  })
})

describe('journal output', () => {
  it('parses an entry with every field as text', () => {
    const line = JSON.stringify({
      __REALTIME_TIMESTAMP: '1700000000123456',
      __CURSOR: 's=a;i=1',
      PRIORITY: '3',
      MESSAGE: [104, 105], // binary-safe MESSAGE
      _SYSTEMD_UNIT: 'smartd.service',
      SYSLOG_IDENTIFIER: 'smartd',
      _PID: 812,
      _TRANSPORT: 'syslog',
    })
    const e = parseSystemEntry(line)!
    expect(e).toMatchObject({ ts: 1_700_000_000_123, priority: 3, message: 'hi', cursor: 's=a;i=1', unit: 'smartd.service', ident: 'smartd', pid: '812', transport: 'syslog' })
    expect(e.fields._PID).toBe('812')
    expect(parseSystemEntry('not json')).toBeUndefined()
    expect(journalSource(e)).toBe('smartd')
    expect(journalSource({ transport: 'kernel', ident: 'kernel' })).toBe('kernel')
    expect(journalSource({ ident: 'sudo' })).toBe('sudo')
  })

  it('reads the boots as JSON and as the older table', () => {
    expect(parseBoots('[{"index":-1,"boot_id":"8f2d0c41a6b94e0c9d1f3b7a5e6c2d10","first_entry":1700000000000000,"last_entry":1700003600000000}]')).toEqual([
      { offset: -1, id: '8f2d0c41a6b94e0c9d1f3b7a5e6c2d10', first: 1_700_000_000_000, last: 1_700_003_600_000 },
    ])
    const table = [
      'IDX BOOT ID                          FIRST ENTRY                 LAST ENTRY',
      ' -1 8f2d0c41a6b94e0c9d1f3b7a5e6c2d10 Mon 2024-01-01 10:00:00 UTC Mon 2024-01-01 12:00:00 UTC',
      '  0 3b1e9a7c5d2f4e6a8b0c1d2e3f4a5b6c Tue 2024-01-02 08:00:00 UTC—Tue 2024-01-02 09:30:00 UTC',
    ].join('\n')
    const boots = parseBoots(table)
    expect(boots.map((b) => [b.offset, b.id])).toEqual([
      [-1, '8f2d0c41a6b94e0c9d1f3b7a5e6c2d10'],
      [0, '3b1e9a7c5d2f4e6a8b0c1d2e3f4a5b6c'],
    ])
    expect(boots[1]!.last).toBe(Date.parse('2024-01-02 09:30:00'))
    const old = parseBoots(' -1 8f2d0c41a6b94e0c9d1f3b7a5e6c2d10 Mon 2024-01-01 10:00:00 UTC—Mon 2024-01-01 12:00:00 UTC')
    expect(old[0]).toMatchObject({ offset: -1, first: Date.parse('2024-01-01 10:00:00') })
  })
})

describe('demo journal (fixtures)', () => {
  const now = Date.now()

  it('filters by area, priority, time, boot, source and text', async () => {
    const all = await queryJournal({ scope: 'all' }, now)
    expect(all.entries.length).toBe(PAGE > 145 ? 145 : PAGE)
    expect(all.entries[0]!.ts).toBeGreaterThanOrEqual(all.entries.at(-1)!.ts) // newest first
    const kernel = await queryJournal({ scope: 'kernel' }, now)
    expect(kernel.entries.length).toBeGreaterThan(5)
    expect(kernel.entries.every((e) => e.transport === 'kernel')).toBe(true)
    const auth = await queryJournal({ scope: 'auth', q: 'failed password' }, now)
    expect(auth.entries.length).toBeGreaterThan(0)
    expect(auth.entries.every((e) => e.ident === 'sshd' && /failed password/i.test(e.message))).toBe(true)
    const errors = await queryJournal({ scope: 'all', prio: 3 }, now)
    expect(errors.entries.every((e) => e.priority <= 3)).toBe(true)
    const hour = await queryJournal({ scope: 'all', since: 60 }, now)
    expect(hour.entries.every((e) => e.ts >= now - 3_600_000)).toBe(true)
    const prev = await queryJournal({ scope: 'all', boot: '-1' }, now)
    expect(prev.entries.length).toBeGreaterThan(0)
    expect(prev.entries.every((e) => e.ts < now - 3 * 86_400_000)).toBe(true)
    expect((await queryJournal({ scope: 'all', unit: 'smartd' }, now)).entries.every((e) => e.unit === 'smartd.service')).toBe(true)
    expect((await queryJournal({ scope: 'all', ident: 'sudo' }, now)).entries.every((e) => e.ident === 'sudo')).toBe(true)
  })

  it('pages below a cursor and shows every field of one entry', async () => {
    const first = await queryJournal({ scope: 'all', prio: 6 }, now)
    const last = first.entries.at(-1)!
    const fields = await journalEntry(last.cursor, now)
    expect(fields).toMatchObject({ MESSAGE: last.message, __CURSOR: last.cursor, _HOSTNAME: 'nas-01' })
    await expect(journalEntry('s=missing', now)).rejects.toMatchObject({ status: 404 })
    await expect(journalEntry('--all', now)).rejects.toMatchObject({ status: 400 })
    const middle = first.entries[10]!
    const next = await queryJournal({ scope: 'all', prio: 6, before: middle.cursor }, now)
    expect(next.entries[0]!.cursor).toBe(first.entries[11]!.cursor)
  })

  it('lists the boots, this one first', async () => {
    const boots = await journalBoots(now)
    expect(boots.map((b) => b.offset)).toEqual([0, -1])
  })
})
