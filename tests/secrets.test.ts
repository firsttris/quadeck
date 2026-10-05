import { describe, expect, it } from 'vitest'
import { createSecret, removeSecret, secretsState } from '~/server/quadlets/secrets'
import { fixtureApi, type PodmanApi } from '~/server/quadlets/storage'
import { lintQuadlet } from '~/shared/ini'
import { findPlain, isSensitive, moveToSecret, plainValue, secretRefs, splitEnvironment, suggestName } from '~/shared/secrets'

const FILE = `[Unit]
Description=App

[Container]
Image=docker.io/library/postgres:16
# Environment=OLD_PASSWORD=commented
Environment=TZ=Europe/Berlin POSTGRES_PASSWORD=s3cr3t POSTGRES_USER=app
Environment="API_TOKEN=two words" LOG=debug
Environment=DB_PASSWORD_FILE=/run/secrets/db REDIS_PASSWORD=\${REDIS_PASSWORD}
Secret=existing,type=env,target=X

[Service]
Environment=SERVICE_PASSWORD=not-a-container-env
`

describe('finding passwords in plain text', () => {
  it('splits systemd Environment= values, quotes included', () => {
    expect(splitEnvironment('A=1 "B=two words"  C= \'D=x y\'')).toEqual([
      { raw: 'A=1', key: 'A', value: '1' },
      { raw: '"B=two words"', key: 'B', value: 'two words' },
      { raw: 'C=', key: 'C', value: '' },
      { raw: "'D=x y'", key: 'D', value: 'x y' },
    ])
    expect(splitEnvironment('novalue')).toEqual([])
  })
  it('reads quotes inside a word and escapes like systemd', () => {
    expect(splitEnvironment('FOO="hello world" B=\\"x\\" C=a\\ b')).toEqual([
      { raw: 'FOO="hello world"', key: 'FOO', value: 'hello world' },
      { raw: 'B=\\"x\\"', key: 'B', value: '"x"' },
      { raw: 'C=a\\ b', key: 'C', value: 'a b' },
    ])
    expect(plainValue('[Container]\nEnvironment=DB_PASSWORD="p w"\n', 'DB_PASSWORD')).toBe('p w')
  })
  it('keeps every other word of the line when moving one out', () => {
    expect(moveToSecret('[Container]\nEnvironment=DB_PASSWORD=x FOO="hello world" LONELY\n', 'DB_PASSWORD', 's')).toBe('[Container]\nEnvironment=FOO="hello world" LONELY\nSecret=s,type=env,target=DB_PASSWORD\n')
    expect(moveToSecret('[Container]\nEnvironment=A=1 DB_PASSWORD="two words" B=2\n', 'DB_PASSWORD', 's')).toBe('[Container]\nEnvironment=A=1 B=2\nSecret=s,type=env,target=DB_PASSWORD\n')
  })
  it('knows which keys hold credentials', () => {
    for (const k of ['DB_PASSWORD', 'POSTGRES_PASSWORD', 'MYSQL_ROOT_PASSWD', 'APP_SECRET', 'API_TOKEN', 'OPENAI_API_KEY', 'SMTP_PASS', 'PRIVATE_KEY']) expect(isSensitive(k)).toBe(true)
    for (const k of ['DB_PASSWORD_FILE', 'TZ', 'PASSWORD_MIN_LENGTH', 'TOKEN_TTL']) expect(isSensitive(k)).toBe(false)
  })
  it('lists them per file, not comments, not *_FILE, not ${VAR}, not [Service]', () => {
    const found = findPlain('app.container', FILE, new Set(['app-postgres-password']))
    expect(found.map((f) => [f.key, f.line, f.suggested])).toEqual([
      ['POSTGRES_PASSWORD', 7, 'app-postgres-password-2'],
      ['API_TOKEN', 8, 'app-api-token'],
    ])
    expect(secretRefs(FILE)).toEqual(['existing'])
    expect(plainValue(FILE, 'API_TOKEN')).toBe('two words')
    expect(plainValue(FILE, 'NOPE')).toBeUndefined()
    expect(suggestName('my app.container', 'X')).toBe('my-app-x')
  })
  it('rewrites only the one assignment into Secret=…', () => {
    const out = moveToSecret(FILE, 'POSTGRES_PASSWORD', 'app-db')
    const lines = out.split('\n')
    expect(lines[6]).toBe('Environment=TZ=Europe/Berlin POSTGRES_USER=app')
    expect(lines[7]).toBe('Secret=app-db,type=env,target=POSTGRES_PASSWORD')
    expect(out).not.toContain('s3cr3t')
    // every other line unchanged
    expect(lines.filter((_, i) => i !== 6 && i !== 7)).toEqual(FILE.split('\n').filter((_, i) => i !== 6))
    const only = moveToSecret('[Container]\nEnvironment="API_TOKEN=two words"\n', 'API_TOKEN', 't')
    expect(only).toBe('[Container]\nSecret=t,type=env,target=API_TOKEN\n')
    expect(() => moveToSecret(FILE, 'SERVICE_PASSWORD', 'x')).toThrow() // [Service] is not touched
  })
  it('the editor warns about them', () => {
    const d = lintQuadlet(FILE, 'container').filter((x) => /Klartext|plain text/.test(x.message))
    expect(d.map((x) => x.line)).toEqual([7, 8])
  })
})

describe('secrets through the Podman API', () => {
  const fresh = () => {
    delete (globalThis as { __qdPodmanFixture?: unknown }).__qdPodmanFixture
    return fixtureApi('fixtures/demo')
  }
  const quadlets = [
    { name: 'immich.container', content: '[Container]\nImage=x\nEnvironment=DB_USERNAME=immich DB_PASSWORD=immich-demo-1234\nSecret=paperless-db-password\n' },
    { name: 'immich.network', content: '[Network]\n' },
  ]

  it('lists names and users, never values; creates, replaces, refuses duplicates and bad input', async () => {
    const api = fresh()
    const calls: { url: string; body?: unknown }[] = []
    const spy: PodmanApi = (url, init) => {
      calls.push({ url, body: init?.body })
      return api(url, init)
    }
    let s = await secretsState(spy, quadlets)
    expect(s.secrets.map((x) => [x.name, x.usedBy])).toEqual([['paperless-db-password', ['immich.container']]])
    expect(s.plain.map((p) => [p.file, p.key, p.suggested])).toEqual([['immich.container', 'DB_PASSWORD', 'immich-db-password']])
    expect(JSON.stringify(s)).not.toContain('immich-demo-1234')

    await createSecret(spy, 'smtp-pass', 'p@ss word&x=1')
    const create = calls.find((c) => c.url.includes('/secrets/create'))!
    expect(create.url).not.toContain('p@ss') // the value only travels in the body
    expect(create.body).toBe('p@ss word&x=1')
    await expect(createSecret(spy, 'smtp-pass', 'again')).rejects.toMatchObject({ status: 409 })
    await createSecret(spy, 'smtp-pass', 'new value', true)
    await expect(createSecret(spy, '-bad', 'x')).rejects.toMatchObject({ status: 400 })
    await expect(createSecret(spy, 'a/b', 'x')).rejects.toMatchObject({ status: 400 })
    await expect(createSecret(spy, 'empty', '')).rejects.toMatchObject({ status: 400 })
    await expect(createSecret(spy, 'huge', 'x'.repeat(70_000))).rejects.toMatchObject({ status: 413 })
    s = await secretsState(spy, quadlets)
    expect(s.secrets.map((x) => x.name)).toEqual(['paperless-db-password', 'smtp-pass'])
    expect(s.secrets[1]!.created).toBeGreaterThan(0)

    await removeSecret(spy, 'smtp-pass')
    await expect(removeSecret(spy, 'smtp-pass')).rejects.toMatchObject({ status: 404 })
    await expect(removeSecret(spy, '../x')).rejects.toMatchObject({ status: 400 })
    expect((await secretsState(spy, quadlets)).secrets).toHaveLength(1)
  })
})
