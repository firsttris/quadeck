// Pure parsers for package-manager output (unit-tested with captured output).

import type { InstalledPackage, PackageUpdate } from '~/shared/packages'

const UNITS: Record<string, number> = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4, K: 1024, M: 1024 ** 2, G: 1024 ** 3, k: 1000 }

/** "9.03 MiB" → bytes. */
export function parseSize(s: string | undefined): number | undefined {
  const m = s?.trim().match(/^([\d.,]+)\s*([A-Za-z]+)?$/)
  if (!m) return undefined
  const n = Number(m[1]!.replace(',', '.'))
  const unit = UNITS[m[2] ?? 'B']
  return Number.isFinite(n) && unit ? Math.round(n * unit) : undefined
}

const list = (v: string | undefined) => (!v || v.trim() === 'None' ? [] : v.trim().split(/\s{2,}|\n\s*/).map((s) => s.trim()).filter(Boolean))

/** `pacman -Qi` (several packages, LC_ALL=C) → one record per package. */
export function parsePacmanInfo(out: string): Record<string, string>[] {
  const records: Record<string, string>[] = []
  for (const block of out.split(/\n\s*\n/)) {
    const rec: Record<string, string> = {}
    let key = ''
    for (const line of block.split('\n')) {
      const m = line.match(/^(\S[^:]*?)\s*: (.*)$/)
      if (m) {
        key = m[1]!
        rec[key] = m[2]!
      } else if (key && /^\s+\S/.test(line)) {
        rec[key] += '\n' + line.trim()
      }
    }
    if (rec.Name) records.push(rec)
  }
  return records
}

export function pacmanRecordToPackage(r: Record<string, string>, foreign: Set<string>): InstalledPackage & { depends: string[]; requiredBy: string[]; optionalFor: string[]; url?: string; installedAt?: number } {
  const requiredBy = list(r['Required By'])
  const optionalFor = list(r['Optional For'])
  const reason = r['Install Reason']?.startsWith('Explicitly') ? 'explicit' : r['Install Reason'] ? 'dependency' : undefined
  const date = r['Install Date'] ? Date.parse(r['Install Date'].replace(/^\w{3} /, '')) : NaN
  return {
    name: r.Name!,
    version: r.Version ?? '',
    description: r.Description,
    size: parseSize(r['Installed Size']),
    reason,
    foreign: foreign.has(r.Name!),
    orphan: reason === 'dependency' && requiredBy.length === 0 && optionalFor.length === 0,
    depends: list(r['Depends On']),
    requiredBy,
    optionalFor,
    url: r.URL && r.URL !== 'None' ? r.URL : undefined,
    installedAt: Number.isFinite(date) ? date : undefined,
  }
}

/** `pacman -Qu` → updates ("name old -> new", maybe " [ignored]"). */
export function parsePacmanQu(out: string): PackageUpdate[] {
  return out
    .split('\n')
    .map((l) => l.match(/^(\S+) (\S+) -> (\S+)(\s+\[ignored\])?$/))
    .filter((m): m is RegExpMatchArray => !!m && !m[4])
    .map((m) => ({ name: m[1]!, from: m[2]!, to: m[3]! }))
}

/** `pacman -Sup --print-format "%r %n %v %s"` → repo + download size per package. */
export function parsePacmanPrint(out: string): Map<string, { repo: string; size?: number }> {
  const map = new Map<string, { repo: string; size?: number }>()
  for (const line of out.split('\n')) {
    const m = line.match(/^(\S+) (\S+) (\S+)(?: (\d+))?$/)
    if (m) map.set(m[2]!, { repo: m[1]!, size: m[4] ? Number(m[4]) : undefined })
  }
  return map
}

/** "name version" lines (pacman -Qm, pacman -Rsp --print-format "%n %v"). */
export function parseNameVersion(out: string) {
  return out
    .split('\n')
    .map((l) => l.trim().match(/^(\S+)(?: (\S+))?$/))
    .filter((m): m is RegExpMatchArray => !!m && !m[1]!.startsWith(':'))
    .map((m) => ({ name: m[1]!, version: m[2] }))
}

/** Last "starting full system upgrade" in pacman.log. */
export function lastPacmanUpgrade(log: string): number | undefined {
  const lines = log.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i]!.match(/^\[([^\]]+)\] \[PACMAN\] starting full system upgrade/)
    if (m) {
      // [2024-05-01T10:00:00+0200] – add the colon in the offset for Date.parse.
      const t = Date.parse(m[1]!.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
      return Number.isFinite(t) ? t : undefined
    }
  }
  return undefined
}

// ---------- apt ----------

/** dpkg-query -W -f='${Package}\t${Version}\t${Installed-Size}\t${db:Status-Abbrev}\t${binary:Summary}\n' */
export function parseDpkgList(out: string): InstalledPackage[] {
  const pkgs: InstalledPackage[] = []
  for (const line of out.split('\n')) {
    const [name, version, size, status, summary] = line.split('\t')
    if (!name || !status || !/^[ih]i/.test(status)) continue
    pkgs.push({ name, version: version ?? '', size: size ? Number(size) * 1024 : undefined, description: summary || undefined })
  }
  return pkgs
}

/** `apt-get -s …` → "Inst name [old] (new repo [arch])" and "Remv name [ver]". */
export function parseAptSim(out: string) {
  const inst: PackageUpdate[] = []
  const remv: { name: string; version?: string }[] = []
  for (const line of out.split('\n')) {
    const i = line.match(/^Inst (\S+) (?:\[([^\]]+)\] )?\((\S+) ([^ )]+)/)
    if (i) {
      const repo = i[4]!.split(',')[0]!
      inst.push({ name: i[1]!, from: i[2] ?? '', to: i[3]!, repo: repo.includes('/') ? repo.split('/').pop() : repo })
      continue
    }
    const r = line.match(/^Remv (\S+)(?: \[([^\]]+)\])?/)
    if (r) remv.push({ name: r[1]!, version: r[2] })
  }
  return { inst, remv }
}

/** `apt list --installed` → names marked [installed,local] (not in any repository). */
export function parseAptLocal(out: string): Set<string> {
  const s = new Set<string>()
  for (const line of out.split('\n')) {
    const m = line.match(/^([^/\s]+)\/\S+ .*\[installed,local\]/)
    if (m) s.add(m[1]!)
  }
  return s
}

/** Debian control fields (dpkg-query -s). */
export function parseControl(out: string): Record<string, string> {
  const rec: Record<string, string> = {}
  let key = ''
  for (const line of out.split('\n')) {
    const m = line.match(/^([A-Za-z0-9-]+): ?(.*)$/)
    if (m) {
      key = m[1]!
      rec[key] = m[2]!
    } else if (key && line.startsWith(' ')) rec[key] += '\n' + line.slice(1)
  }
  return rec
}

/** "a (>= 1), b | c, d:any" → package names. */
export function parseDebDepends(v: string | undefined): string[] {
  if (!v) return []
  return [...new Set(v.split(',').map((d) => d.split('|')[0]!.trim().split(/[\s(:]/)[0]!).filter(Boolean))]
}

/** `apt-cache rdepends --installed name`. */
export function parseRdepends(out: string): string[] {
  const lines = out.split('\n')
  const i = lines.findIndex((l) => l.startsWith('Reverse Depends:'))
  if (i < 0) return []
  return [...new Set(lines.slice(i + 1).map((l) => l.trim().replace(/^\|/, '')).filter(Boolean))]
}

// ---------- rpm / dnf / zypper ----------

/** rpm -qa --qf '%{NAME}\t%{EPOCHNUM}:%{VERSION}-%{RELEASE}\t%{SIZE}\t%{SUMMARY}\n' */
export function parseRpmList(out: string): InstalledPackage[] {
  const pkgs: InstalledPackage[] = []
  for (const line of out.split('\n')) {
    const [name, evr, size, summary] = line.split('\t')
    if (!name || name === 'gpg-pubkey' || !evr) continue
    pkgs.push({ name, version: evr.replace(/^0:/, ''), size: size ? Number(size) : undefined, description: summary || undefined })
  }
  return pkgs
}

const ARCH = /^(x86_64|noarch|aarch64|i686|armv7hl|ppc64le|s390x|src)$/

/** `dnf check-update` → "name.arch  version  repo" (long names wrap onto the next line). */
export function parseDnfCheckUpdate(out: string): { name: string; to: string; repo: string }[] {
  const body = out.split(/^Obsoleting Packages/m)[0]!
  const tokens = body
    .split('\n')
    .filter((l) => l.trim() && !/^(Last metadata|Updating|Repositories|Upgrades|Available upgrades|Security:)/i.test(l.trim()))
    .join(' ')
    .split(/\s+/)
    .filter(Boolean)
  const out2: { name: string; to: string; repo: string }[] = []
  for (let i = 0; i + 2 < tokens.length; ) {
    const m = tokens[i]!.match(/^(.+)\.([^.]+)$/)
    if (m && ARCH.test(m[2]!)) {
      out2.push({ name: m[1]!, to: tokens[i + 1]!, repo: tokens[i + 2]! })
      i += 3
    } else i++
  }
  return out2
}

/** Rows of a `dnf remove --assumeno` transaction table: name arch version repo size. */
export function parseDnfTransaction(out: string): { name: string; version?: string }[] {
  const seen = new Map<string, string | undefined>()
  for (const line of out.split('\n')) {
    const cols = line.trim().split(/\s+/)
    if (cols.length >= 4 && ARCH.test(cols[1]!)) seen.set(cols[0]!, cols[2])
  }
  return [...seen].map(([name, version]) => ({ name, version }))
}

/** zypper table output ("a | b | c") → rows of cells (header + separator dropped). */
export function parseZypperTable(out: string): string[][] {
  const rows = out
    .split('\n')
    .filter((l) => l.includes('|'))
    .map((l) => l.split('|').map((c) => c.trim()))
  return rows.slice(1).filter((r) => !r.every((c) => /^[-+]*$/.test(c)))
}

/** `zypper -n rm -u -D …` → package names after "going to be REMOVED:". */
export function parseZypperRemove(out: string): string[] {
  const m = out.match(/going to be REMOVED:\s*\n([\s\S]*?)(\n\s*\n|$)/)
  return m ? m[1]!.trim().split(/\s+/).filter(Boolean) : []
}

/** rpm -qi → fields. */
export function parseRpmInfo(out: string): Record<string, string> {
  const rec: Record<string, string> = {}
  let inDesc = false
  for (const line of out.split('\n')) {
    if (inDesc) {
      rec.Description = (rec.Description ? rec.Description + '\n' : '') + line
      continue
    }
    const m = line.match(/^([A-Za-z][A-Za-z ]*?)\s*: (.*)$/)
    if (m) {
      rec[m[1]!] = m[2]!
      if (m[1] === 'Description') inDesc = true
    }
  }
  return rec
}

/** rpm -qR → package-ish requirements (no rpmlib(), paths or sonames). */
export function parseRpmRequires(out: string): string[] {
  return [
    ...new Set(
      out
        .split('\n')
        .map((l) => l.trim().split(/\s/)[0]!)
        .filter((r) => r && !r.startsWith('rpmlib(') && !r.startsWith('/') && !r.includes('.so') && !r.includes('(')),
    ),
  ]
}

/** rpm-ostree upgrade --preview / db diff: "  bash 5.1-1.fc36 -> 5.2-1.fc37". */
export function parseOstreeDiff(out: string): PackageUpdate[] {
  return out
    .split('\n')
    .map((l) => l.match(/^\s+(\S+) (\S+) -> (\S+)\s*$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ name: m[1]!, from: m[2]!, to: m[3]! }))
}

// ---------- apk ----------

/** "name-1.2.3-r0" → name + version. */
export function splitApkPkg(s: string): { name: string; version: string } | undefined {
  const m = s.match(/^(.+)-([^-]+-r\d+)$/)
  return m ? { name: m[1]!, version: m[2]! } : undefined
}

/** `apk list -I` / `apk list -u`. */
export function parseApkList(out: string): { name: string; version: string; from?: string }[] {
  const res: { name: string; version: string; from?: string }[] = []
  for (const line of out.split('\n')) {
    const p = splitApkPkg(line.split(' ')[0] ?? '')
    if (!p) continue
    const from = line.match(/\[upgradable from: (\S+)\]/)?.[1]
    res.push({ ...p, from: from ? splitApkPkg(from)?.version : undefined })
  }
  return res
}

/** `apk info -d -w -s -R -r name` sections ("name-ver description:" + lines). */
export function parseApkInfo(out: string): Record<string, string[]> {
  const rec: Record<string, string[]> = {}
  for (const block of out.split(/\n\s*\n/)) {
    const [head, ...rest] = block.trim().split('\n')
    const m = head?.match(/ ([a-z ]+):$/)
    if (m) rec[m[1]!] = rest.map((l) => l.trim()).filter(Boolean)
  }
  return rec
}

/** `apk del -s …` → "(1/3) Purging name (1.2-r0)". */
export function parseApkPurge(out: string) {
  return [...out.matchAll(/Purging (\S+) \(([^)]+)\)/g)].map((m) => ({ name: m[1]!, version: m[2] }))
}

// ---------- podman ----------

/** `podman auto-update --dry-run --format json`. */
export function parseAutoUpdate(out: string) {
  const data = JSON.parse(out || '[]') as Record<string, string>[] | null
  return (data ?? []).map((d) => ({
    unit: d.Unit ?? '',
    container: d.ContainerName ?? (d.Container ?? '').replace(/^\S+ \((.*)\)$/, '$1'),
    image: d.Image ?? '',
    policy: d.Policy ?? '',
    updated: String(d.Updated ?? ''),
  }))
}

// ---------- Arch news ----------

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()

export function parseRss(xml: string) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .map((m) => {
      const tag = (t: string) => decode(m[1]!.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`))?.[1] ?? '')
      return { title: tag('title'), link: tag('link'), date: Date.parse(tag('pubDate')) }
    })
    .filter((i) => i.title && /^https:\/\//.test(i.link) && Number.isFinite(i.date))
}
