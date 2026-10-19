import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { clientProposal, SystemBackup } from '~/server/backup/backend'
import { run } from '~/server/exec'
import { clientChangedBy, clientConnected, clientOnline } from '~/shared/backup'
import { clientSettings, inventoryHints, inventoryListing, parseClientReport, parseInventory, parsePoll, pollText, queueAction } from '~/shared/backup-agent'
import { defaultClientPlan, recommendedClientPlan } from '~/shared/backup-client'

const H = '/home/tris'
const scan = [
  `home\t${H}`,
  `d\t100\t${H}`,
  `d\t40\t${H}/Projekte`,
  `d\t30\t${H}/Projekte/app`,
  `d\t20\t${H}/Projekte/app/node_modules`,
  `d\t5\t${H}/Projekte/app/node_modules/x/node_modules`,
  `d\t10\t${H}/.cache`,
  `d\t2\t${H}/Dokumente`,
  `d\t1\t${H}/.ssh`,
  `m\t${H}/Projekte/app/.git`,
  `m\t${H}/Projekte/app/node_modules`,
  `m\t${H}/Projekte/app/node_modules/x/node_modules`,
  `m\t${H}/Dokumente/CACHEDIR.TAG`,
  `m\t${H}/Projekte/evil.sh`,
  'd\tx\t/../etc',
  'garbage line',
].join('\n')

describe('client scan', () => {
  it('reads folders under ~ with sizes and marks', () => {
    const inv = parseInventory(scan, 1000).inventory!
    expect(inv.home).toBe(H)
    const by = Object.fromEntries(inv.dirs.map((d) => [d.path, d]))
    expect(by['~']!.bytes).toBe(100 * 1024)
    expect(by['~/Projekte/app']!.marks).toEqual(['git'])
    expect(by['~/Projekte/app/node_modules']!.marks).toEqual(['dev'])
    expect(by['~/.cache']!.marks).toEqual(['caches']) // a known folder
    expect(by['~/Dokumente']!.marks).toEqual(['caches']) // CACHEDIR.TAG marks its folder
    expect(by['~/Projekte']!.marks).toBeUndefined()
    expect(inv.dirs.some((d) => d.path.includes('..'))).toBe(false)
    expect(parseInventory('d\t1\t/x').error).toBeTruthy() // no home
  })

  it('lists one folder level for the browser, hidden ones last', () => {
    const inv = parseInventory(scan, 1000).inventory!
    const l = inventoryListing(inv, '~')
    expect(l.path).toBe('~')
    expect(l.dirs).toEqual(['Dokumente', 'Projekte', '.cache', '.ssh'])
    expect(l.sizes!.Projekte).toBe(40 * 1024)
    expect(l.marks!['.cache']).toEqual(['caches'])
    expect(l.scannedAt).toBe(1000)
    expect(inventoryListing(inv, `${H}/Projekte`).dirs).toEqual(['app']) // absolute under the home
    const gone = inventoryListing(inv, '~/Projekte/nope/deeper')
    expect(gone).toMatchObject({ path: '~/Projekte', missing: true })
  })

  it('hints what a preset would leave out inside the chosen folders, outermost only', () => {
    const inv = parseInventory(scan, 1000).inventory!
    const hints = inventoryHints(inv, { folders: ['~/Projekte'], exclude: { presets: [], patterns: [] } })
    expect(hints).toEqual([{ preset: 'dev', bytes: 20 * 1024, paths: ['~/Projekte/app/node_modules'], on: false }])
    const home = inventoryHints(inv, { folders: ['~'], exclude: { presets: ['dev'], patterns: [] } })
    expect(home.map((h) => [h.preset, h.on])).toEqual([
      ['dev', true],
      ['caches', false],
    ])
  })
})

describe('client settings and reports', () => {
  it('settings are plain lines, one value each', () => {
    const plan = { ...defaultClientPlan(), folders: ['~/Dokumente', "~/Bob's $(rm -rf ~)"], exclude: { presets: ['caches' as const, 'nobackup' as const], patterns: ['*.iso'], maxSizeGB: 2 } }
    const t = clientSettings(plan, 7, true)
    expect(t.split('\n')).toEqual([
      'quadeck-settings 1',
      'version 7',
      'active 1',
      'calendar *-*-* 12:00:00',
      'appendonly 1',
      'preset caches',
      'preset nobackup',
      'maxsize 2048',
      'keep daily 7',
      'keep weekly 4',
      'keep monthly 12',
      'folder ~/Dokumente',
      "folder ~/Bob's $(rm -rf ~)",
      'exclude ~/.cache',
      'exclude *.iso',
      'end',
      '',
    ])
  })

  it('without a plan: version, active 0, no folders and no schedule', () => {
    expect(clientSettings(undefined, 0, true)).toBe('quadeck-settings 1\nversion 0\nactive 0\nappendonly 1\nend\n')
  })

  it('the poll answer: version and actions as lines, unknown words left out', () => {
    expect(pollText(3, ['run', 'scan'])).toBe('version=3\nactions=run scan\n')
    expect(pollText(0, [])).toBe('version=0\nactions=\n')
    expect(parsePoll(pollText(7, ['scan', 'sync']))).toEqual({ version: 7, actions: ['scan', 'sync'] })
    expect(parsePoll('version=x; rm -rf ~\nactions=run $(reboot) ../scan sync\n')).toEqual({ actions: ['run', 'sync'] })
    expect(parsePoll('')).toEqual({ actions: [] })
    // Each action once, in the order asked.
    expect(queueAction(undefined, 'run')).toEqual(['run'])
    expect(queueAction(['run', 'scan'], 'run')).toEqual(['scan', 'run'])
  })

  it('who changed the plan (older records say quadeck), online and connected', () => {
    expect(clientChangedBy('quadeck')).toBe('ui')
    expect(['ui', 'cli', 'client'].map(clientChangedBy)).toEqual(['ui', 'cli', 'client'])
    expect(clientChangedBy('mallory')).toBeUndefined()
    const now = 10_000_000
    expect(clientOnline({ lastSeen: now - 24 * 60_000 }, now)).toBe(true)
    expect(clientOnline({ lastSeen: now - 26 * 60_000 }, now)).toBe(false)
    expect(clientOnline({}, now)).toBe(false)
    expect(clientConnected({})).toBe(false)
    expect(clientConnected({ applied: { version: 0, at: 1 } })).toBe(true) // an older script, before the agent timer
    expect(recommendedClientPlan(false)).toMatchObject({ folders: ['~/Documents', '~/Pictures'], schedule: { every: 'weekly' } })
    expect(recommendedClientPlan(true).folders).toEqual(['~/Dokumente', '~/Bilder'])
  })

  it('a report becomes a run record', () => {
    const now = 1_800_000_000_000
    const text = [
      'code 3',
      `start ${now / 1000 - 60}`,
      `end ${now / 1000}`,
      'version 4',
      '{"message_type":"error","error":{"message":"permission denied"},"during":"archival","item":"/home/x/secret"}',
      '{"message_type":"summary","files_new":2,"files_changed":1,"total_files_processed":10,"total_bytes_processed":2048,"data_added":512,"snapshot_id":"abcdef12"}',
      'stderr some warning',
    ].join('\n')
    const { run: r, version } = parseClientReport(text, now)
    expect(version).toBe(4)
    expect(r).toMatchObject({ kind: 'backup', status: 'warning', files: 10, added: 512, snapshot: 'abcdef12', errors: ['/home/x/secret: permission denied'] })
    expect(parseClientReport('code 0\nstart 1\nend 2', now).error).toBeTruthy() // too old
    expect(parseClientReport('start 1', now).error).toBeTruthy()
    const failed = parseClientReport(`code 1\nstart ${now / 1000 - 5}\nend ${now / 1000}\nstderr Fatal: unable to open repository`, now).run!
    expect(failed).toMatchObject({ status: 'failed', message: 'Fatal: unable to open repository' })
    // Kept with the client and sent to every browser: no huge strings.
    const big = parseClientReport(
      `code 3\nstart ${now / 1000 - 5}\nend ${now / 1000}\n{"message_type":"summary","snapshot_id":"${'A'.repeat(100_000)}"}\n{"message_type":"error","error":{"message":"${'x'.repeat(100_000)}"},"item":"/a"}`,
      now,
    ).run!
    expect(big.snapshot).toBeUndefined()
    expect(big.errors[0]!.length).toBe(500)
  })

  it('a proposal from the client keeps the retention', () => {
    const current = { ...defaultClientPlan(), keep: { daily: 30, weekly: 0, monthly: 0 } }
    const p = clientProposal(JSON.stringify({ ...defaultClientPlan(), folders: ['~/x'], keep: { daily: 1, weekly: 0, monthly: 0 } }), current)
    expect(p.keep).toEqual({ daily: 30, weekly: 0, monthly: 0 })
    expect(p.folders).toEqual(['~/x'])
    // The edited output of `quadeck-backup plan show`: { name, version, plan, appendOnly }
    expect(clientProposal(JSON.stringify({ name: 'laptop', version: 3, plan: { ...defaultClientPlan(), folders: ['~/y'] }, appendOnly: false }), current).folders).toEqual(['~/y'])
    expect(() => clientProposal('nope', current)).toThrow()
    expect(() => clientProposal(JSON.stringify({ folders: ['../x'] }), current)).toThrow()
  })
})

describe('the client channel in the helper', () => {
  const setup = async () => {
    const root = mkdtempSync(join(tmpdir(), 'qd-agent-'))
    const b = new SystemBackup({ dir: join(root, 'state'), unitDir: root, exec: run, log: () => {} })
    await b.saveTarget({ dataDir: join(root, 'backups'), port: 8000, appendOnly: false, url: 'http://nas:8000' })
    await b.addClient('laptop', 3)
    await b.addClient('pc', undefined)
    const script = (await b.redeemClientLink((await b.clientLink('laptop', 'http://nas:8484')).token))!
    const token = /QUADECK_TOKEN='([A-Za-z0-9_-]{32})'/.exec(script)![1]!
    return { root, b, token }
  }

  it('only the right token of the right client gets in', async () => {
    const { b, token, root } = await setup()
    expect(await b.clientAgent('laptop', token, 'plan', '')).toMatchObject({ json: { name: 'laptop', version: 0 } })
    await expect(b.clientAgent('laptop', 'x'.repeat(32), 'plan', '')).rejects.toMatchObject({ status: 401 })
    await expect(b.clientAgent('pc', token, 'plan', '')).rejects.toMatchObject({ status: 401 }) // pc has no token yet
    await expect(b.clientAgent('nobody', token, 'plan', '')).rejects.toMatchObject({ status: 401 })
    await expect(b.clientAgent('laptop', '', 'plan', '')).rejects.toMatchObject({ status: 401 })
    const st = await b.targetState()
    expect(st.clients.find((c) => c.name === 'laptop')!.agent).toBe(true)
    expect(JSON.stringify(st)).not.toContain('agentHash')
    expect(readFileSync(join(root, 'state/target.json'), 'utf8')).not.toContain(token) // only the hash is stored
    await b.updateClient('laptop', { disabled: true })
    await expect(b.clientAgent('laptop', token, 'plan', '')).rejects.toMatchObject({ status: 403 })
    // A new script replaces the token.
    await b.updateClient('laptop', { disabled: false })
    await b.redeemClientLink((await b.clientLink('laptop', 'http://nas:8484')).token)
    await expect(b.clientAgent('laptop', token, 'plan', '')).rejects.toMatchObject({ status: 401 })
  })

  it('settings count as applied; a proposal raises the version; scan and report are kept', async () => {
    const { b, token } = await setup()
    await b.setClientPlan('laptop', { ...defaultClientPlan(), folders: ['~/a'] })
    const s = (await b.clientAgent('laptop', token, 'settings', '')) as { text: string }
    expect(s.text).toContain('version 1\n')
    expect(s.text).toContain('folder ~/a\n')
    let c = (await b.targetState()).clients.find((x) => x.name === 'laptop')!
    expect(c.applied?.version).toBe(1)
    expect(c.changed?.by).toBe('ui')

    const preview = (await b.clientAgent('laptop', token, 'preview', JSON.stringify({ ...defaultClientPlan(), folders: ['~/b'] }))) as { text: string }
    expect(preview.text).toContain('folder ~/b\n')
    expect((await b.targetState()).clients.find((x) => x.name === 'laptop')!.version).toBe(1) // not saved

    await b.clientAgent('laptop', token, 'propose', JSON.stringify({ ...defaultClientPlan(), folders: ['~/b'] }))
    c = (await b.targetState()).clients.find((x) => x.name === 'laptop')!
    expect(c).toMatchObject({ version: 2, changed: { by: 'client' }, plan: { folders: ['~/b'] } })
    await b.clientAgent('laptop', token, 'propose', JSON.stringify({ ...defaultClientPlan(), folders: ['~/b'] }))
    expect((await b.targetState()).clients.find((x) => x.name === 'laptop')!.version).toBe(2) // the same plan again: no new version

    const inv = (await b.clientAgent('laptop', token, 'inventory', `home\t${H}\nd\t1\t${H}/Dokumente\n`)) as { json: { dirs: unknown[] } }
    expect(inv.json.dirs).toHaveLength(1)
    expect((await b.clientInventory('laptop'))!.dirs[0]).toMatchObject({ path: '~/Dokumente', bytes: 1024 })
    expect(await b.clientInventory('pc')).toBeNull()

    const now = Math.floor(Date.now() / 1000)
    await b.clientAgent('laptop', token, 'report', `code 0\nstart ${now - 10}\nend ${now}\n{"message_type":"summary","total_files_processed":3}`)
    c = (await b.targetState()).clients.find((x) => x.name === 'laptop')!
    expect(c.runs).toHaveLength(1)
    expect(c.runs![0]).toMatchObject({ status: 'ok', files: 3 })
    expect(c.scannedAt).toBeGreaterThan(0)
    await expect(b.clientAgent('laptop', token, 'report', 'nonsense')).rejects.toMatchObject({ status: 400 })

    await b.removeClient('laptop', false)
    expect(await b.clientInventory('laptop')).toBeNull()
  })

  it('connected without a plan: settings without folders, actions handed out once by the poll, seen with every call', async () => {
    const { b, token, root } = await setup()
    const laptop = async () => (await b.targetState()).clients.find((x) => x.name === 'laptop')!
    expect((await laptop()).lastSeen).toBeUndefined() // fetching the script is not a call of the computer
    expect(((await b.clientAgent('laptop', token, 'settings', '')) as { text: string }).text).toBe('quadeck-settings 1\nversion 0\nactive 0\nappendonly 0\nend\n')
    expect(await b.clientAgent('laptop', token, 'plan', '')).toMatchObject({ json: { plan: null } })
    const seen = (await laptop()).lastSeen!
    expect(seen).toBeGreaterThan(Date.now() - 5000)

    // Nothing to back up yet: "back up now" is refused; a scan can be asked for.
    await expect(b.clientAction('laptop', 'run')).rejects.toMatchObject({ status: 409 })
    await b.clientAction('laptop', 'scan')
    await b.clientAction('laptop', 'scan')
    expect((await laptop()).actions).toEqual(['scan'])
    expect(await b.clientAgent('laptop', token, 'poll', '')).toEqual({ text: 'version=0\nactions=scan\n' })
    expect(await b.clientAgent('laptop', token, 'poll', '')).toEqual({ text: 'version=0\nactions=\n' }) // handed out once
    expect((await laptop()).actions).toBeUndefined()
    await expect(b.clientAction('nobody', 'scan')).rejects.toMatchObject({ status: 404 })

    // A plan set with the CLI: a new version for the poll, then run can be asked for.
    await b.setClientPlan('laptop', defaultClientPlan(), 'cli')
    await b.clientAction('laptop', 'run')
    expect(await b.clientAgent('laptop', token, 'poll', '')).toEqual({ text: 'version=1\nactions=run\n' })
    expect((await laptop()).changed?.by).toBe('cli')
    expect(readFileSync(join(root, 'state/target.json'), 'utf8')).not.toContain(token)

    // A record written before `ui` and `cli` were told apart.
    const file = join(root, 'state/target.json')
    writeFileSync(file, readFileSync(file, 'utf8').replace('"by": "cli"', '"by": "quadeck"'))
    expect((await laptop()).changed?.by).toBe('ui')
  })
})
