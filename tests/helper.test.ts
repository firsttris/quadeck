import { FixtureHardware } from '../src/server/hardware/collect'
import { FixtureUsers } from '../src/server/users/backend'
import { FixtureBoot } from '../src/server/boot/backend'
import { FixtureFstabHost, FstabManager } from '../src/server/fstab/backend'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { crypt, isAdmin, suggestedUser, verifySystemPassword } from '~/server/privileged/crypt'
import { Gate } from '~/server/privileged/gate'
import { HelperClient } from '~/server/privileged/helper-client'
import { serveHelper } from '~/server/privileged/helper-server'
import { LocalPrivileged } from '~/server/privileged/local'
import { FixtureMaintenance } from '~/server/packages/maintenance'
import { FixturePodmanAdmin } from '~/server/quadlets/backend'
import { FixtureShares } from '~/server/shares/backend'
import { FixtureSsh } from '~/server/ssh/backend'
import { FixtureSmart } from '~/server/smart/backend'
import { FixtureFiles } from '~/server/files/backend'
import { FixtureTimers } from '~/server/timers/backend'
import { FixtureUnitEditor } from '~/server/systemd/editor'
import { FixtureNetwork } from '~/server/network/collect'
import { CaddyManager, FixtureCaddyHost } from '~/server/caddy/backend'
import { FixtureBackup } from '~/server/backup/backend'
import { FixturePower } from '~/server/smart/power'

// sha512-crypt of "geheim-123"
const HASH = '$6$quadeckt$pgIhFnbK6xs46yd0LWpDYqO6iRlF44QJuqBQ7i2j0gU.Rxvby3N1AG9aVgJxVbQQawFROmuIr9MJ9V3/.cG9w.'
const files = {
  shadow: ['root:' + HASH + ':19000:0:99999:7:::', 'tristan:' + HASH + ':19000::::::', 'locked:!:19000::::::', 'guest:' + HASH + ':19000::::::'].join('\n'),
  group: ['root:x:0:', 'wheel:x:998:tristan', 'quadeck:x:961:'].join('\n'),
}

describe('system password check (crypt + /etc/shadow)', () => {
  it('uses the system crypt(3)', () => {
    expect(crypt('geheim-123', HASH)).toBe(HASH)
    expect(crypt('falsch', HASH)).not.toBe(HASH)
  })

  it('accepts root and wheel/sudo members only', () => {
    expect(verifySystemPassword(files, 'root', 'geheim-123')).toBe('ok')
    expect(verifySystemPassword(files, 'tristan', 'geheim-123')).toBe('ok')
    expect(verifySystemPassword(files, 'tristan', 'nope')).toBe('wrong')
    expect(verifySystemPassword(files, 'guest', 'geheim-123')).toBe('not-admin')
    expect(verifySystemPassword(files, 'locked', 'x')).toBe('not-admin')
    expect(verifySystemPassword({ ...files, group: files.group + '\nsudo:x:27:locked' }, 'locked', 'x')).toBe('no-password')
    expect(verifySystemPassword(files, '../etc', 'x')).toBe('wrong')
    expect(isAdmin(files, 'tristan')).toBe(true)
    expect(suggestedUser(files)).toBe('tristan')
  })
})

describe('gate', () => {
  it('hands out a token for the right password and expires it', async () => {
    const g = new Gate('system', 15, { authFiles: () => files })
    await expect(g.unlock('tristan', 'nope')).rejects.toThrow(/falsch/)
    await expect(g.unlock('guest', 'geheim-123')).rejects.toThrow(/kein Administrator/)
    const { token, expiresAt } = await g.unlock('tristan', 'geheim-123')
    expect(expiresAt - Date.now()).toBeGreaterThan(14 * 60_000)
    expect(() => g.check(token)).not.toThrow()
    expect(() => g.check(undefined)).toThrow(/Gesperrt/)
    expect(() => g.check('forged')).toThrow(/Gesperrt/)
    g.lock(token)
    expect(() => g.check(token)).toThrow(/Gesperrt/)
  })

  it('throttles after five failures, counting before the check', async () => {
    const g = new Gate('system', 15, { authFiles: () => files })
    await Promise.allSettled(Array.from({ length: 5 }, () => g.unlock('root', 'x')))
    await expect(g.unlock('root', 'geheim-123')).rejects.toThrow(/warten/)
  })

  it('supports the Quadeck password and "none"', async () => {
    const q = new Gate('quadeck', 5, { verifyQuadeck: async (pw) => pw === 'qd-pass-123' })
    await expect(q.unlock('ignored', 'wrong')).rejects.toThrow()
    expect((await q.unlock('ignored', 'qd-pass-123')).token).toBeTruthy()
    const n = new Gate('none', 15)
    expect(() => n.check(undefined)).not.toThrow()
  })
})

describe('helper over a Unix socket', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quadeck-helper-'))
  const socket = join(dir, 'helper.sock')
  const server = serveHelper(socket, new LocalPrivileged(new Gate('system', 15, { authFiles: () => files }), join(dir, 'no-podman.sock'), new FixtureMaintenance('fixtures/demo'), new FixturePodmanAdmin('fixtures/demo'), new FixtureShares('fixtures/demo'), new FixtureSsh('fixtures/demo'), new FixtureSmart('fixtures/demo'), new FixtureFiles(), new FixtureTimers('fixtures/demo'), new FixtureUnitEditor('fixtures/demo'), new FixtureNetwork('fixtures/demo'), new FstabManager(new FixtureFstabHost('fixtures/demo')), new FixtureBoot('fixtures/demo'), new FixtureUsers('fixtures/demo'), new FixtureHardware('fixtures/demo'), new CaddyManager(new FixtureCaddyHost('fixtures/demo')), new FixtureBackup(), new FixturePower()))
  const client = new HelperClient(socket)
  afterAll(() => server.stop(true))

  it('creates the socket for owner and group only', () => {
    expect(statSync(socket).mode & 0o777).toBe(0o660)
  })

  it('reports the unlock mode and the suggested account', async () => {
    expect(await client.info()).toEqual({ mode: 'system', suggestedUser: 'tristan', minutes: 15 })
  })

  it('refuses actions without unlock, with 423', async () => {
    await expect(client.unit(undefined, 'restart', 'jellyfin.service')).rejects.toMatchObject({ status: 423 })
    await expect(client.podmanContainer('forged', 'abcdefabcdef', 'stop')).rejects.toMatchObject({ status: 423 })
  })

  it('validates after unlock and keeps Podman reads on the allowlist', async () => {
    const { token } = await client.unlock('tristan', 'geheim-123')
    expect(await client.unlockedUntil(token)).toBeGreaterThan(Date.now())
    await expect(client.unit(token, 'restart', '--evil.service')).rejects.toMatchObject({ status: 400 })
    await expect(client.podmanContainer(token, '../../x', 'stop')).rejects.toMatchObject({ status: 400 })
    await expect(client.podmanGet('/containers/abc/kill')).rejects.toMatchObject({ status: 400 })
    await client.lock(token)
    expect(await client.unlockedUntil(token)).toBeNull()
  })

  it('streams files from the data areas, with ranges; secrets only after unlocking', async () => {
    const res = await client.fileResponse(undefined, '/mnt/disk2/Fotos/2024/IMG_0001.jpg', {})
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(res.headers.get('content-disposition')).toMatch(/^inline; filename="IMG_0001.jpg"/)
    const all = new Uint8Array(await res.arrayBuffer())
    expect([...all.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]) // a real JPEG
    const part = await client.fileResponse(undefined, '/mnt/disk2/Fotos/2024/IMG_0001.jpg', { range: 'bytes=10-19' })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe(`bytes 10-19/${all.length}`)
    expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([...all.subarray(10, 20)])
    await expect(client.fileResponse(undefined, '/srv/scripts/.env', {})).rejects.toMatchObject({ status: 423 })
    await expect(client.fileResponse(undefined, '/etc/shadow', {})).rejects.toMatchObject({ status: 403 })
    const { token } = await client.unlock('tristan', 'geheim-123')
    expect(await (await client.fileResponse(token, '/srv/scripts/.env', { download: true })).text()).toBe('RESTIC_PASSWORD=demo-secret\n')
    await client.lock(token)
  })

  it('scans the LAN through the helper (active only when asked for)', async () => {
    const active = await client.scanDevices(true)
    const passive = await client.scanDevices(false)
    expect(active).toMatchObject({ active: true, subnets: ['192.168.1.0/24'], selfIps: ['192.168.1.20'] })
    expect(passive.active).toBe(false)
    expect(passive.devices.length).toBeLessThan(active.devices.length)
  })

  it('removes nothing from Podman and sets no cleanup timer without unlock', async () => {
    await expect(client.cleanPodman(undefined, [{ kind: 'image', id: 'abc' }])).rejects.toMatchObject({ status: 423 })
    await expect(client.setPodmanPrune('forged', 'weekly')).rejects.toMatchObject({ status: 423 })
  })

  it('hands out power samples (RAPL and disk states) without unlocking', async () => {
    const s = await client.powerSample()
    expect(s.rapl.some((z) => z.name === 'package-0')).toBe(true)
    expect(s.disks.map((d) => d.kind)).toContain('nvme')
  })

  it('creates, removes or moves no secret without unlock', async () => {
    await expect(client.createSecret(undefined, 'x', 'v', false)).rejects.toMatchObject({ status: 423 })
    await expect(client.removeSecret('forged', 'x')).rejects.toMatchObject({ status: 423 })
    await expect(client.moveSecret(undefined, 'immich.container', 'DB_PASSWORD', 'x', true)).rejects.toMatchObject({ status: 423 })
  })

  it('reports a missing helper clearly', async () => {
    await expect(new HelperClient(join(dir, 'missing.sock')).info()).rejects.toMatchObject({ status: 503 })
  })
})
