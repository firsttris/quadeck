// `quadeck update`: downloads the newest release binary for this platform
// from GitHub Releases, verifies its SHA-256 against SHA256SUMS, swaps it in
// atomically and restarts the systemd unit.

import { existsSync, readdirSync, renameSync, chmodSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { run } from './exec'

export const REPO = 'firsttris/quadeck'

export function isMusl(): boolean {
  if (existsSync('/etc/alpine-release')) return true
  try {
    return readdirSync('/lib').some((f) => f.startsWith('ld-musl-'))
  } catch {
    return false
  }
}

export function assetName(arch: string = process.arch, musl = isMusl()): string {
  const a = arch === 'arm64' ? 'arm64' : 'x64'
  if (musl) return `quadeck-linux-${a}-musl`
  return a === 'x64' ? 'quadeck-linux-x64-baseline' : 'quadeck-linux-arm64'
}

/** Compares "1.2.3" style versions (a leading "v" is ignored). */
export function newer(latest: string, current: string): boolean {
  const p = (v: string) => v.replace(/^v/, '').split(/[.-]/).map((x) => Number(x) || 0)
  const a = p(latest)
  const b = p(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return false
}

export async function selfUpdate(current: string, force = false) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json' } })
  if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`)
  const rel = (await res.json()) as { tag_name: string; assets: { name: string; browser_download_url: string }[] }
  if (!force && !newer(rel.tag_name, current)) {
    console.log(`Quadeck ${current} ist aktuell.`)
    return
  }
  const name = assetName()
  const bin = rel.assets.find((a) => a.name === name)
  const sums = rel.assets.find((a) => a.name === 'SHA256SUMS')
  if (!bin || !sums) throw new Error(`Release ${rel.tag_name} enthält kein ${name} oder SHA256SUMS`)
  console.log(`Lade ${rel.tag_name} (${name}) …`)
  const data = new Uint8Array(await (await fetch(bin.browser_download_url)).arrayBuffer())
  const expected = (await (await fetch(sums.browser_download_url)).text()).split('\n').find((l) => l.trim().endsWith(` ${name}`) || l.trim().endsWith(`*${name}`))?.split(/\s+/)[0]
  const actual = new Bun.CryptoHasher('sha256').update(data).digest('hex')
  if (!expected || expected !== actual) throw new Error('Prüfsumme stimmt nicht – Update abgebrochen')

  const target = process.execPath
  const tmp = join(dirname(target), `.quadeck-update-${process.pid}`)
  writeFileSync(tmp, data, { mode: 0o755 })
  chmodSync(tmp, 0o755)
  const check = await run([tmp, 'version'])
  if (check.code !== 0) {
    rmSync(tmp, { force: true })
    throw new Error(`Neues Binary startet nicht: ${check.stderr}`)
  }
  renameSync(tmp, target) // atomic on the same filesystem
  console.log(`Installiert: ${target} → ${check.stdout.trim()}`)
  const restart = await run(['systemctl', 'try-restart', 'quadeck-helper.service', 'quadeck.service'])
  console.log(restart.code === 0 ? 'Quadeck neu gestartet.' : 'Bitte quadeck-helper.service und quadeck.service neu starten.')
  const helper = await run(['systemctl', 'cat', 'quadeck-helper.service'])
  if (helper.code !== 0) console.log('Hinweis: Diese Installation läuft noch komplett als root. Für den getrennten Root-Helfer install.sh erneut ausführen.')
}
