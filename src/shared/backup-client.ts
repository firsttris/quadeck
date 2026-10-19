// The backup plan of a client computer and the shell script that connects the client (setup link):
// it installs restic's configuration, the `quadeck-backup` command, the backup timer and an agent
// timer that asks Quadeck every 10 minutes for a new plan or something to do. The plan (what to back
// up, exclusions, schedule, retention) can come later, set in Quadeck or on the client. No I/O here.

import { m } from '~/paraglide/messages'
import { sizeArg } from './backup'
import { msg } from './i18n'

export type ClientPreset = 'caches' | 'trash' | 'dev' | 'temp' | 'downloads' | 'vms' | 'games' | 'nobackup'
export const CLIENT_PRESETS: ClientPreset[] = ['caches', 'trash', 'dev', 'temp', 'downloads', 'vms', 'games', 'nobackup']
export const DEFAULT_CLIENT_PRESETS: ClientPreset[] = ['caches', 'trash', 'dev', 'temp', 'vms', 'games', 'nobackup']

/** Exclude lines per preset; ~ is the home folder of the user who runs the script. */
export const CLIENT_PRESET_PATTERNS: Record<ClientPreset, string[]> = {
  caches: ['~/.cache'],
  trash: ['~/.local/share/Trash'],
  dev: ['node_modules', '.venv', '__pycache__', '.gradle', '.tox', 'target/debug', 'target/release'],
  temp: ['*.tmp', '*.part', '*.swp', '.~lock.*'],
  downloads: ['~/Downloads'],
  vms: ['*.iso', '*.qcow2', '*.vdi', '*.vmdk', '*.img'],
  games: ['~/.local/share/Steam', '~/.steam'],
  nobackup: [],
}

export type ClientEvery = 'hourly' | '6h' | 'daily' | 'weekly'

export interface ClientPlan {
  /** `~/Dokumente` or absolute paths. */
  folders: string[]
  exclude: { presets: ClientPreset[]; patterns: string[]; maxSizeGB?: number }
  schedule: { every: ClientEvery; time: string }
  keep: { daily: number; weekly: number; monthly: number; yearly?: number }
  /** Off: the timer is stopped on the client, the access stays. */
  active: boolean
}

export const defaultClientPlan = (): ClientPlan => ({
  folders: ['~/Dokumente', '~/Bilder'],
  exclude: { presets: [...DEFAULT_CLIENT_PRESETS], patterns: [] },
  schedule: { every: 'daily', time: '12:00' },
  keep: { daily: 7, weekly: 4, monthly: 12 },
  active: true,
})

/** The plan offered for a connected client: Documents and Pictures under the UI language's names, weekly. */
export const recommendedClientPlan = (de: boolean): ClientPlan => ({
  ...defaultClientPlan(),
  folders: de ? ['~/Dokumente', '~/Bilder'] : ['~/Documents', '~/Pictures'],
  schedule: { every: 'weekly', time: '12:00' },
})

const CTRL = /[\x00-\x1f\x7f]/

/** `~`, `~/a/b` or `/a/b`: no empty, `.` or `..` segments, no trailing slash, not `/` itself. */
export function folderProblem(f: unknown): string | undefined {
  if (typeof f !== 'string' || f.length > 1024 || CTRL.test(f)) return msg(m.backup_error_path, { path: String(f) })
  if (f === '~') return undefined
  const rest = f.startsWith('~/') ? f.slice(2) : f.startsWith('/') ? f.slice(1) : undefined
  if (!rest || rest.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return msg(m.backup_error_path, { path: f })
  return undefined
}

export function parseClientPlan(v: unknown): { plan?: ClientPlan; error?: string } {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const folders = Array.isArray(o.folders) ? [...new Set((o.folders as unknown[]).map((f) => (typeof f === 'string' ? f.trim() : f)))] : []
  if (!folders.length) return { error: msg(m.backup_error_noPaths) }
  if (folders.length > 50) return { error: msg(m.backup_error_tooMany) }
  for (const f of folders) {
    const p = folderProblem(f)
    if (p) return { error: p }
  }
  const ex = (o.exclude && typeof o.exclude === 'object' ? o.exclude : {}) as Record<string, unknown>
  const presets = (Array.isArray(ex.presets) ? ex.presets : []).filter((x): x is ClientPreset => CLIENT_PRESETS.includes(x as ClientPreset))
  const patterns = (Array.isArray(ex.patterns) ? ex.patterns : []).map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean)
  if (patterns.length > 200 || patterns.some((x) => x.length > 300 || CTRL.test(x))) return { error: msg(m.backup_error_pattern) }
  let maxSizeGB: number | undefined
  if (ex.maxSizeGB !== undefined && ex.maxSizeGB !== null) {
    maxSizeGB = Number(ex.maxSizeGB)
    if (!Number.isFinite(maxSizeGB) || maxSizeGB <= 0 || maxSizeGB > 100_000) return { error: msg(m.backup_error_maxSize) }
  }
  const sched = (o.schedule && typeof o.schedule === 'object' ? o.schedule : {}) as Record<string, unknown>
  const every = sched.every as ClientEvery
  if (!['hourly', '6h', 'daily', 'weekly'].includes(every) || typeof sched.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(sched.time)) return { error: msg(m.backup_error_schedule) }
  const k = (o.keep && typeof o.keep === 'object' ? o.keep : {}) as Record<string, unknown>
  const num = (x: unknown) => (Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 1000 ? (x as number) : NaN)
  const yearly = k.yearly === undefined || k.yearly === null ? 0 : num(k.yearly)
  const keep = { daily: num(k.daily), weekly: num(k.weekly), monthly: num(k.monthly), ...(yearly ? { yearly } : {}) }
  if ([...Object.values(keep), yearly].some(Number.isNaN) || keep.daily + keep.weekly + keep.monthly + yearly === 0) return { error: msg(m.backup_error_keep) }
  return { plan: { folders: folders as string[], exclude: { presets, patterns, ...(maxSizeGB ? { maxSizeGB } : {}) }, schedule: { every, time: sched.time }, keep, active: o.active !== false } }
}

export function clientCalendar(s: ClientPlan['schedule']): string {
  const [h, m] = s.time.split(':') as [string, string]
  if (s.every === 'hourly') return `*-*-* *:${m}:00`
  if (s.every === '6h') return `*-*-* ${Number(h) % 6}/6:${m}:00`
  if (s.every === 'weekly') return `Sun *-*-* ${h}:${m}:00`
  return `*-*-* ${h}:${m}:00`
}

/** Single-quoted for sh: safe for any text without control characters. */
export const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

export interface ScriptInput {
  name: string
  /** restic repository, e.g. rest:http://nas.lan:8000/laptop/ */
  repo: string
  user: string
  /** The access password, renewed for every script. */
  access: string
  appendOnly: boolean
  /** None yet: the client connects, its backup timer stays off until a plan comes. */
  plan?: ClientPlan
  /** Settings version the script carries (shown on the client and in Quadeck). */
  version: number
  /** Where `quadeck-backup update` points to, and where the client talks to Quadeck. */
  quadeckUrl: string
  /** The client's token for /api/backup/agent/<name> (renewed with every script). */
  agentToken?: string
  /**
   * Caddy's local root CA (PEM) when Quadeck's address is served with a certificate of it: stored as
   * ca.crt and given to every curl to Quadeck. Safe to embed: the script itself came over a TLS
   * connection checked against this CA, whose fingerprint was in the command.
   */
  ca?: string
  /** The repository (rest:https://…) is served with that CA too: restic gets RESTIC_CACERT. */
  resticCa?: boolean
}

/** A setup link for the UI; `ca` when the command fetches and checks Caddy's local CA first. */
export interface ClientLink {
  token: string
  expires: number
  ca?: { sha256: string; fingerprint: string }
}

/** Where the setup command puts the CA before checking it (the script removes it again). */
export const CA_TMP = '/tmp/quadeck-ca.crt'

/**
 * The command that sets up a client: `curl … | sh`. With Caddy's local CA it first fetches the CA
 * without checking (-k), compares its SHA-256 with the one in the command and only then fetches the
 * script with it as the CA to trust: nothing that runs comes unchecked. Works in sh, bash and fish.
 */
export function setupCommand(origin: string, token: string, ca?: { sha256: string }): string {
  const url = `${origin}/api/backup/script/${token}`
  if (!ca) return `curl -fsSL ${url} | sh`
  return `curl -fsSLk ${origin}/ca.crt -o ${CA_TMP} && echo "${ca.sha256}  ${CA_TMP}" | sha256sum -c && curl -fsSL --cacert ${CA_TMP} ${url} | sh`
}

/** The same in steps, to read the script before it runs. */
export function reviewCommands(origin: string, token: string, ca?: { sha256: string }): string {
  const url = `${origin}/api/backup/script/${token}`
  return [
    ...(ca ? [`curl -fsSLk ${origin}/ca.crt -o ${CA_TMP}`, `echo "${ca.sha256}  ${CA_TMP}" | sha256sum -c`] : []),
    `curl -fsSL${ca ? ` --cacert ${CA_TMP}` : ''} ${url} -o quadeck-backup-setup.sh`,
    'less quadeck-backup-setup.sh',
    'sh quadeck-backup-setup.sh',
  ].join('\n')
}

/** What kind of exclusion a rule is, for the label next to it. */
export function ruleKind(rule: string): 'type' | 'pattern' | 'path' {
  if (/^\*\.[^/*?[\]]+$/.test(rule)) return 'type'
  return /[*?[]/.test(rule) ? 'pattern' : 'path'
}
/** A rule that would leave out everything, or that restic cannot take. */
export const ruleProblem = (rule: string) => !rule || rule.length > 300 || CTRL.test(rule) || ['/', '~', '*', '**', '~/*', '~/**', '/*', '/**'].includes(rule)

/** Exclude lines for the client; ~ is expanded by the script on the client. */
export function clientExcludes(plan: ClientPlan): string[] {
  return [...plan.exclude.presets.flatMap((p) => CLIENT_PRESET_PATTERNS[p]), ...plan.exclude.patterns]
}

export function clientForgetArgs(plan: ClientPlan | undefined): string {
  if (!plan) return ''
  const k = plan.keep
  return [
    ...(k.daily ? ['--keep-daily', k.daily] : []),
    ...(k.weekly ? ['--keep-weekly', k.weekly] : []),
    ...(k.monthly ? ['--keep-monthly', k.monthly] : []),
    ...(k.yearly ? ['--keep-yearly', k.yearly] : []),
  ].join(' ')
}

/** The install/update script the client runs with `curl … | sh`. POSIX sh, systemd user units. */
export function clientScript(i: ScriptInput): string {
  const p = i.plan
  const flags = p
    ? [
        ...(p.exclude.presets.includes('caches') ? ['--exclude-caches'] : []),
        ...(p.exclude.presets.includes('nobackup') ? ['--exclude-if-present .nobackup'] : []),
        ...(p.exclude.maxSizeGB ? [`--exclude-larger-than ${sizeArg(p.exclude.maxSizeGB)}`] : []),
      ].join(' ')
    : ''
  return `#!/bin/sh
# Quadeck backup client "${i.name}" – settings version ${i.version}${p ? '' : ' (no plan yet)'}.
# Installs or updates: ~/.config/quadeck-backup, ~/.local/bin/quadeck-backup, the systemd user
# timer quadeck-backup.timer (the backups, on the plan's schedule) and quadeck-backup-agent.timer
# (asks Quadeck every 10 minutes for a new plan or something to do). Running it again only renews
# the access and changes folders, exclusions and schedule. The repository password stays here.
set -eu

NAME=${sq(i.name)}
VERSION=${i.version}
PLAN=${p ? 1 : 0}
ACTIVE=${p?.active ? 1 : 0}
CALENDAR=${sq(clientCalendar(p?.schedule ?? defaultClientPlan().schedule))}
FOLDERS=${sq(p?.folders.join('\n') ?? '')}
EXCLUDES=${sq(p ? clientExcludes(p).join('\n') : '')}
CA=${sq(i.ca ?? '')}

CONF="\${XDG_CONFIG_HOME:-$HOME/.config}/quadeck-backup"
UNITS="\${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
BIN="$HOME/.local/bin"
say() { printf '%s\\n' "$*"; }
die() { printf 'quadeck-backup: %s\\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || [ "\${QUADECK_ALLOW_ROOT:-}" = 1 ] || die "please run this as the user whose files are backed up, not as root (QUADECK_ALLOW_ROOT=1 to do it anyway)"
# restic where it is now: the units run without the login shell's PATH (brew, ~/.local/bin).
if ! RESTIC=$(command -v restic 2>/dev/null); then
  hint=""
  if command -v brew >/dev/null 2>&1; then
    hint="brew install restic"
  elif [ -e /run/ostree-booted ]; then
    hint="rpm-ostree install restic, then reboot"
  else
    for pm in pacman apt-get dnf zypper apk; do
      if command -v "$pm" >/dev/null 2>&1; then
        case "$pm" in
          pacman) hint="sudo pacman -S restic" ;; apt-get) hint="sudo apt install restic" ;; dnf) hint="sudo dnf install restic" ;;
          zypper) hint="sudo zypper install restic" ;; apk) hint="sudo apk add restic" ;;
        esac
        break
      fi
    done
  fi
  [ -z "$hint" ] || die "restic is not installed – install it first: $hint"
  die "restic is not installed"
fi
case "$RESTIC" in /*) ;; *) RESTIC=restic ;; esac
command -v systemctl >/dev/null 2>&1 || die "systemd is needed for the schedule"

umask 077
mkdir -p "$CONF" "$UNITS" "$BIN"
chmod 700 "$CONF"

# Caddy's local CA, which Quadeck's certificate comes from: every call to Quadeck trusts it (this
# script came over a connection checked against it). Without one the system's CAs are enough.
if [ -n "$CA" ]; then printf '%s' "$CA" > "$CONF/ca.crt"; else rm -f "$CONF/ca.crt"; fi
if [ -f ${CA_TMP} ] && [ -O ${CA_TMP} ]; then rm -f ${CA_TMP}; fi

# Access to the server (renewed with every script) and where restic finds everything.
# Read with \`. env\` (CONF set before): every value quoted.
cat > "$CONF/env" <<'QUADECK_ENV'
${envFile(i, flags)}
QUADECK_ENV
printf "QUADECK_RESTIC='%s'\\n" "$(printf '%s' "$RESTIC" | sed "s/'/'\\\\''/g")" >> "$CONF/env"

# Folders and exclusions, ~ as this user's home.
printf '%s\\n' "$FOLDERS" | sed "s|^~|$HOME|" | grep -v '^$' > "$CONF/folders" || true
printf '%s\\n' "$EXCLUDES" | sed "s|^~|$HOME|" | grep -v '^$' > "$CONF/excludes" || true

set -a
. "$CONF/env"
set +a

# The repository password: asked once, never sent anywhere.
if [ ! -s "$CONF/password" ]; then
  if [ -n "\${QUADECK_REPO_PASSWORD:-}" ]; then
    pw="$QUADECK_REPO_PASSWORD"
  else
    [ -r /dev/tty ] || die "no terminal to ask for the repository password (or set QUADECK_REPO_PASSWORD)"
    say ""
    say "Repository password for $NAME: it encrypts the backups and stays on this computer."
    say "Without it the backups cannot be read, not even by the server – keep it in your password manager."
    printf 'Repository password: ' > /dev/tty
    stty -echo < /dev/tty 2>/dev/null || true
    read -r pw < /dev/tty
    stty echo < /dev/tty 2>/dev/null || true
    printf '\\n' > /dev/tty
  fi
  [ -n "$pw" ] || die "empty password"
  printf '%s\\n' "$pw" > "$CONF/password"
  chmod 600 "$CONF/password"
fi

# The repository: open it, or create it on the first run. Bounded: restic retries an unreachable
# server for minutes (0.17 and later) and says nothing meanwhile.
url=\${RESTIC_REPOSITORY#rest:}
say "Connecting to $url …"
code=0
if timeout 1 true >/dev/null 2>&1; then
  out=$(timeout 30 "$RESTIC" cat config --no-lock 2>&1 >/dev/null) || code=$?
else
  out=$("$RESTIC" cat config --no-lock 2>&1 >/dev/null) || code=$?
fi
if [ "$code" != 0 ]; then
  last=$(printf '%s\\n' "$out" | grep -iE 'fatal|error|refused|timeout' | tail -n 1 || true)
  [ -n "$last" ] || last=$(printf '%s\\n' "$out" | grep -v '^ *$' | tail -n 1 || true)
  [ "$code" != 124 ] || last="no answer within 30 s\${last:+ ($last)}"
  unreachable="cannot reach the backup server at $url – is the address right (Quadeck → Backups → Clients → Edit …) and the port open? restic: $last"
  case "$code:$out" in
    124:*) die "$unreachable" ;;
    *"wrong password"*|*"no key found"*) die "the repository exists but the password in $CONF/password does not open it" ;;
    *"connection refused"*|*"no such host"*|*"dial tcp"*|*"i/o timeout"*|*"network is unreachable"*|*"no route to host"*|*"deadline exceeded"*|*"connection reset"*|*"x509"*|*"tls:"*) die "$unreachable" ;;
    *"Is there a repository"*|*"does not exist"*|*"no such file"*|*"unable to open config"*|*"404"*)
      say "Creating the repository on the server …"
      "$RESTIC" init >/dev/null ;;
    *) die "$unreachable" ;;
  esac
fi
cat > "$BIN/quadeck-backup" <<'QUADECK_BIN'
${clientCommand()}
QUADECK_BIN
chmod 755 "$BIN/quadeck-backup"

cat > "$UNITS/quadeck-backup.service" <<QUADECK_SERVICE
# Written by the Quadeck backup script – changes are overwritten
[Unit]
Description=Quadeck: back up to the home server (restic)
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=$BIN/quadeck-backup run
Nice=10
IOSchedulingClass=idle
QUADECK_SERVICE

cat > "$UNITS/quadeck-backup.timer" <<QUADECK_TIMER
# Written by the Quadeck backup script – changes are overwritten
[Unit]
Description=Quadeck: backup schedule

[Timer]
OnCalendar=$CALENDAR
Persistent=true
RandomizedDelaySec=5min

[Install]
WantedBy=timers.target
QUADECK_TIMER

# The agent: asks Quadeck every 10 minutes for a new plan or something to do (back up now, send
# the folder list). It only fetches data; nothing from Quadeck is run as a command.
cat > "$UNITS/quadeck-backup-agent.service" <<QUADECK_AGENT_SERVICE
# Written by the Quadeck backup script – changes are overwritten
[Unit]
Description=Quadeck: ask the home server for a new backup plan or a task
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=$BIN/quadeck-backup poll
QUADECK_AGENT_SERVICE

cat > "$UNITS/quadeck-backup-agent.timer" <<QUADECK_AGENT_TIMER
# Written by the Quadeck backup script – changes are overwritten
[Unit]
Description=Quadeck: ask the home server every 10 minutes

[Timer]
OnCalendar=*:0/10
Persistent=true
RandomizedDelaySec=2min

[Install]
WantedBy=timers.target
QUADECK_AGENT_TIMER

systemctl --user daemon-reload
if [ "$ACTIVE" = 1 ]; then
  systemctl --user enable --now quadeck-backup.timer >/dev/null || die "could not start the timer – is this a normal login session? (systemctl --user)"
  state="schedule $CALENDAR"
elif [ "$PLAN" = 1 ]; then
  systemctl --user disable --now quadeck-backup.timer >/dev/null 2>&1 || true
  state="schedule paused"
else
  systemctl --user disable --now quadeck-backup.timer >/dev/null 2>&1 || true
  state="no plan yet"
fi

connected=0
if grep -q '^QUADECK_TOKEN=' "$CONF/env"; then
  # Tell Quadeck the setup is done (that also ends the setup link) and take its settings once more.
  if err=$("$BIN/quadeck-backup" sync 2>&1 >/dev/null); then
    connected=1
  else
    say "Note: could not talk to Quadeck at $QUADECK_URL – ${'$'}{err#quadeck-backup: }"
    say "      The backups work without it; changes made in Quadeck arrive once this computer reaches it."
  fi
  systemctl --user enable --now quadeck-backup-agent.timer >/dev/null 2>&1 || say "Note: could not start quadeck-backup-agent.timer – new plans arrive only with the next backup."
  # The folder list for Quadeck's folder browser, in the background (du over the home takes a while).
  (nohup "$BIN/quadeck-backup" scan >/dev/null 2>&1 &)
fi

say ""
if [ "$PLAN" = 1 ]; then
  say "Quadeck backup for $NAME is set up (settings version $VERSION, $state)."
  say "  quadeck-backup check    what would be backed up"
  say "  quadeck-backup now      back up right now"
  say "  quadeck-backup status   last backups and the next run"
  say "  quadeck-backup guide    how an AI agent can change this backup with you"
elif [ "$connected" = 1 ]; then
  say "$NAME is connected to Quadeck – no backup plan yet, so nothing is backed up so far."
  say "Choose what and when in Quadeck (Backups → Clients → $NAME → Set plan), or let an AI agent on"
  say "this computer do it with you: quadeck-backup guide. This computer takes the plan within about 10 minutes."
else
  say "$NAME is set up, but has no backup plan yet. Once it reaches Quadeck, set one there (Backups → Clients)."
fi
case ":$PATH:" in *":$BIN:"*) ;; *) say "(add $BIN to your PATH, or call $BIN/quadeck-backup)" ;; esac
# Without lingering the user's timers only run while the user is logged in: a hint, never a stop.
if command -v loginctl >/dev/null 2>&1 && [ "$(loginctl show-user "$(id -un)" -p Linger 2>/dev/null || true)" = Linger=no ]; then
  say "Note: the timers only run while you are logged in. To back up without anyone logged in: sudo loginctl enable-linger $(id -un)"
fi
`
}

function envFile(i: ScriptInput, flags: string): string {
  return [
    `RESTIC_REPOSITORY=${sq(i.repo)}`,
    `RESTIC_REST_USERNAME=${sq(i.user)}`,
    `RESTIC_REST_PASSWORD=${sq(i.access)}`,
    'RESTIC_PASSWORD_FILE="$CONF/password"',
    ...(i.ca && i.resticCa ? ['RESTIC_CACERT="$CONF/ca.crt"'] : []),
    `QUADECK_NAME=${sq(i.name)}`,
    `QUADECK_VERSION=${i.version}`,
    `QUADECK_URL=${sq(i.quadeckUrl)}`,
    ...(i.agentToken ? [`QUADECK_TOKEN=${sq(i.agentToken)}`] : []),
    `QUADECK_APPEND_ONLY=${i.appendOnly ? 1 : 0}`,
    `QUADECK_FLAGS=${sq(flags)}`,
    `QUADECK_FORGET=${sq(clientForgetArgs(i.plan))}`,
  ].join('\n')
}

/** `quadeck-backup`, installed on the client. Reads everything from ~/.config/quadeck-backup. */
export function clientCommand(): string {
  return `#!/bin/sh
# quadeck-backup – the client side of Quadeck's backups (written by the setup script).
set -eu
CONF="\${XDG_CONFIG_HOME:-$HOME/.config}/quadeck-backup"
UNITS="\${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
[ -f "$CONF/env" ] || { echo "quadeck-backup: not set up (run the script from Quadeck)" >&2; exit 1; }
set -a
. "$CONF/env"
set +a

# restic as found by the setup script (systemd user units have no brew or ~/.local/bin in PATH),
# else whatever PATH has.
if [ -n "\${QUADECK_RESTIC:-}" ] && [ -x "$QUADECK_RESTIC" ]; then RESTIC=$QUADECK_RESTIC; else RESTIC=restic; fi
restic() { command "$RESTIC" "$@"; }

# A standard folder under its name in the other language, or where xdg-user-dirs puts it
# (~/Dokumente on a German desktop, ~/Documents on an English one).
resolve() {
  [ -e "$1" ] && { printf '%s\\n' "$1"; return; }
  case "\${1#"$HOME"/}" in
    Dokumente|Documents) k=DOCUMENTS alt=Documents:Dokumente ;;
    Bilder|Pictures) k=PICTURES alt=Pictures:Bilder ;;
    Musik|Music) k=MUSIC alt=Music:Musik ;;
    Videos) k=VIDEOS alt=Videos ;;
    Schreibtisch|Desktop) k=DESKTOP alt=Desktop:Schreibtisch ;;
    Downloads) k=DOWNLOAD alt=Downloads ;;
    *) printf '%s\\n' "$1"; return ;;
  esac
  d=$(xdg-user-dir "$k" 2>/dev/null || true)
  if [ -n "$d" ] && [ "$d" != "$HOME" ] && [ -d "$d" ]; then printf '%s\\n' "$d"; return; fi
  for a in $(printf '%s' "$alt" | tr ':' ' '); do [ -e "$HOME/$a" ] && { printf '%s\\n' "$HOME/$a"; return; }; done
  printf '%s\\n' "$1"
}

# Folders and exclusions come from $SET (the installed settings, or a draft's in check --plan).
SET="$CONF"

folders() {
  [ -s "$SET/folders" ] || { echo "quadeck-backup: no backup plan yet – choose what and when in Quadeck (Backups → Clients → $QUADECK_NAME), or see quadeck-backup guide" >&2; exit 1; }
  n=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    f=$(resolve "$f")
    if [ -e "$f" ]; then printf '%s\\n' "$f"; n=$((n + 1)); else echo "skipped (missing): $f" >&2; fi
  done < "$SET/folders"
  [ "$n" -gt 0 ] || { echo "quadeck-backup: none of the folders exists" >&2; exit 1; }
}

# The folders as arguments (works with restic older than 0.15, which has no --files-from-verbatim).
backup() {
  extra="\${1:-}"
  list=$(folders)
  set --
  while IFS= read -r f; do set -- "$@" "$f"; done <<EOF
$list
EOF
  # shellcheck disable=SC2086
  restic backup --tag quadeck --exclude-file "$SET/excludes" $QUADECK_FLAGS $extra -- "$@"
}

human() { numfmt --to=iec --suffix=B "$1" 2>/dev/null || echo "$1 bytes"; }
field() { printf '%s' "$2" | sed -n 's/.*"'"$1"'":\\([0-9]*\\).*/\\1/p'; }
no_token() { echo "quadeck-backup: this computer was set up with an older script – run the setup command from Quadeck once more (Backups → Clients → $QUADECK_NAME → Show command)" >&2; return 1; }

# curl could not talk to Quadeck: why, for curl's exit code $1.
unreachable() {
  case "$1" in
    60|77)
      if [ -f "$CONF/ca.crt" ]; then
        echo "quadeck-backup: Quadeck's certificate at $QUADECK_URL no longer comes from the CA stored in $CONF/ca.crt – run the setup command from Quadeck once more (Backups → Clients → $QUADECK_NAME → Show command); it brings the current CA along" >&2
      else
        echo "quadeck-backup: this computer does not trust Quadeck's certificate at $QUADECK_URL – run the setup command from Quadeck once more (Backups → Clients → $QUADECK_NAME → Show command): when the certificate comes from Caddy's local CA, the command brings that CA along" >&2
      fi ;;
    *) echo "quadeck-backup: cannot reach Quadeck at $QUADECK_URL" >&2 ;;
  esac
  return 1
}

# curl for Quadeck: with the CA the setup script stored (Caddy's local CA), else the system's.
qcurl() {
  if [ -f "$CONF/ca.crt" ]; then curl --cacert "$CONF/ca.crt" "$@"; else curl "$@"; fi
}

# Quadeck's endpoint for this client: api GET|POST <what> [content type] (a POST body comes on stdin).
# Prints the answer; on an error prints Quadeck's message and fails.
api() {
  [ -n "\${QUADECK_TOKEN:-}" ] || no_token
  command -v curl >/dev/null 2>&1 || { echo "quadeck-backup: curl is needed to talk to Quadeck" >&2; return 1; }
  what=$2
  # The token goes to curl in a file, never on its command line (other users see that in ps).
  auth="$CONF/.auth"
  (umask 077 && printf 'Authorization: Bearer %s\\n' "$QUADECK_TOKEN" > "$auth")
  if [ "$1" = GET ]; then
    resp=$(qcurl -sS --max-time 30 -H @"$auth" -w '\\n%{http_code}' "$QUADECK_URL/api/backup/agent/$QUADECK_NAME?do=$what") || { unreachable $?; return 1; }
  else
    resp=$(qcurl -sS --max-time 300 -X POST -H @"$auth" -H "content-type: \${3:-text/plain}" --data-binary @- -w '\\n%{http_code}' "$QUADECK_URL/api/backup/agent/$QUADECK_NAME?do=$what") || { unreachable $?; return 1; }
  fi
  http=$(printf '%s\\n' "$resp" | tail -n 1)
  body=$(printf '%s\\n' "$resp" | sed '$d')
  case "$http" in
    2??) printf '%s\\n' "$body" ;;
    *) printf 'quadeck-backup: Quadeck says (%s): %s\\n' "$http" "$body" >&2; return 1 ;;
  esac
}

# Settings lines from Quadeck (stdin) into the folder $1: folders, excludes, and the values in \`vars\`.
# Every line is data and checked here: nothing from the server is run as shell code. Without a plan
# (active 0, no folders, no calendar) the folder list is empty and the backup timer stays off.
parse_settings() {
  d=$1
  : > "$d/folders.new"
  : > "$d/excludes.new"
  first=1 ended=0 version='' active='' calendar='' appendonly=0 flags='' forget='' size=''
  while IFS= read -r line; do
    key=\${line%% *}
    value=\${line#"$key"}
    value=\${value# }
    if [ "$first" = 1 ]; then
      [ "$line" = "quadeck-settings 1" ] || { echo "quadeck-backup: unexpected answer from Quadeck" >&2; return 1; }
      first=0
      continue
    fi
    case "$key" in
      version) case "$value" in ''|*[!0-9]*) return 1 ;; esac; version=$value ;;
      active) case "$value" in 0|1) active=$value ;; *) return 1 ;; esac ;;
      appendonly) case "$value" in 0|1) appendonly=$value ;; *) return 1 ;; esac ;;
      calendar) case "$value" in ''|*[!-0-9A-Za-z*:/,.\\ ]*) return 1 ;; esac; calendar=$value ;;
      preset)
        case "$value" in
          caches) flags="$flags --exclude-caches" ;;
          nobackup) flags="$flags --exclude-if-present .nobackup" ;;
          trash|dev|temp|downloads|vms|games) ;;
          *) return 1 ;;
        esac ;;
      maxsize) case "$value" in ''|*[!0-9]*) return 1 ;; esac; size="--exclude-larger-than \${value}M" ;; # MiB
      keep)
        rule=\${value%% *} n=\${value#* }
        case "$rule" in daily|weekly|monthly|yearly) ;; *) return 1 ;; esac
        case "$n" in ''|*[!0-9]*) return 1 ;; esac
        forget="$forget --keep-$rule $n" ;;
      folder) printf '%s\\n' "$value" >> "$d/folders.new" ;;
      exclude) printf '%s\\n' "$value" >> "$d/excludes.new" ;;
      end) ended=1 ;;
      *) ;; # newer keys: ignored
    esac
  done
  [ "$ended" = 1 ] && [ -n "$version" ] && [ -n "$active" ] || { echo "quadeck-backup: incomplete settings from Quadeck" >&2; return 1; }
  if [ "$active" = 1 ]; then
    [ -n "$calendar" ] || { echo "quadeck-backup: incomplete settings from Quadeck" >&2; return 1; }
    [ -s "$d/folders.new" ] || { echo "quadeck-backup: no folders in the settings" >&2; return 1; }
  fi
  sed "s|^~|$HOME|" "$d/folders.new" > "$d/folders"
  sed "s|^~|$HOME|" "$d/excludes.new" > "$d/excludes"
  rm -f "$d/folders.new" "$d/excludes.new"
  flags="\${flags# }\${size:+ $size}"
  flags="\${flags# }"
  forget="\${forget# }"
  printf "version=%s\\nactive=%s\\ncalendar='%s'\\nappendonly=%s\\nflags='%s'\\nforget='%s'\\n" "$version" "$active" "$calendar" "$appendonly" "$flags" "$forget" > "$d/vars"
}

# Fetches the settings and installs them: folders, exclusions, schedule, retention.
sync() {
  tmp=$(mktemp -d "$CONF/.sync.XXXXXX")
  if ! api GET settings > "$tmp/text"; then
    rm -rf "$tmp"
    return 1
  fi
  if ! parse_settings "$tmp" < "$tmp/text"; then
    echo "quadeck-backup: the settings from Quadeck do not pass the checks – nothing changed" >&2
    rm -rf "$tmp"
    return 1
  fi
  . "$tmp/vars"
  mv "$tmp/folders" "$CONF/folders"
  mv "$tmp/excludes" "$CONF/excludes"
  grep -v '^QUADECK_\\(VERSION\\|FLAGS\\|FORGET\\|APPEND_ONLY\\)=' "$CONF/env" > "$tmp/env" || true
  printf "QUADECK_VERSION=%s\\nQUADECK_APPEND_ONLY=%s\\nQUADECK_FLAGS='%s'\\nQUADECK_FORGET='%s'\\n" "$version" "$appendonly" "$flags" "$forget" >> "$tmp/env"
  chmod 600 "$tmp/env"
  mv "$tmp/env" "$CONF/env"
  if [ -f "$UNITS/quadeck-backup.timer" ]; then
    if [ -n "$calendar" ]; then
      sed "s|^OnCalendar=.*|OnCalendar=$calendar|" "$UNITS/quadeck-backup.timer" > "$tmp/timer"
      if ! cmp -s "$tmp/timer" "$UNITS/quadeck-backup.timer"; then
        mv "$tmp/timer" "$UNITS/quadeck-backup.timer"
        systemctl --user daemon-reload >/dev/null 2>&1 || true
      fi
    fi
    if [ "$active" = 1 ]; then
      systemctl --user is-enabled quadeck-backup.timer >/dev/null 2>&1 || systemctl --user enable --now quadeck-backup.timer >/dev/null 2>&1 || true
    else
      systemctl --user is-enabled quadeck-backup.timer >/dev/null 2>&1 && systemctl --user disable --now quadeck-backup.timer >/dev/null 2>&1 || true
    fi
  fi
  rm -rf "$tmp"
  set -a
  . "$CONF/env"
  set +a
  if [ -s "$CONF/folders" ]; then echo "settings version $version"; else echo "settings version $version (no backup plan yet)"; fi
}

# The agent timer's call: is there a new plan (version), and what Quadeck asks for (actions).
# Only these words are acted on; anything else in the answer is ignored.
poll() {
  answer=$(api GET poll) || return 1
  want='' todo=''
  while IFS= read -r line; do
    case "$line" in
      version=*) want=\${line#version=}; case "$want" in ''|*[!0-9]*) want='' ;; esac ;;
      actions=*) todo=\${line#actions=} ;;
    esac
  done <<EOF
$answer
EOF
  synced=0
  if [ -n "$want" ] && [ "$want" != "$QUADECK_VERSION" ]; then
    if sync; then synced=1; fi
  fi
  set -f
  for a in $todo; do
    case "$a" in
      run) systemctl --user start --no-block quadeck-backup.service || echo "quadeck-backup: could not start quadeck-backup.service" >&2 ;;
      scan) scan >/dev/null || true ;;
      sync) if [ "$synced" = 0 ] && sync; then synced=1; fi ;;
      *) ;; # newer actions: ignored
    esac
  done
  set +f
}

# The folders of the home with their size (du, 4 levels) and what marks them (caches, projects,
# node_modules …): names and sizes only, never file contents.
scan() {
  out="$CONF/scan"
  {
    printf 'home\\t%s\\n' "$HOME"
    nice du -x -k -d 4 "$HOME" 2>/dev/null | awk '{ printf "d\\t%s\\n", $0 }' || true
    nice find "$HOME" -xdev -maxdepth 6 \\( -name node_modules -o -name .venv -o -name __pycache__ -o -name .gradle -o -name .tox -o -name .git \\) -prune -print \\
      -o \\( -name CACHEDIR.TAG -o -name .nobackup \\) -print 2>/dev/null | head -n 2000 > "$out.marks" || true
    awk '{ printf "m\\t%s\\n", $0 }' "$out.marks"
    # Development folders deeper than du looked: their own size.
    grep -v '/\\.git$' "$out.marks" | grep -v '/CACHEDIR.TAG$' | grep -v '/\\.nobackup$' | head -n 300 | while IFS= read -r p; do
      nice du -x -sk "$p" 2>/dev/null | awk '{ printf "d\\t%s\\n", $0 }' || true
    done
  } > "$out"
  rm -f "$out.marks"
  api POST inventory < "$out"
}

# The run for Quadeck: exit code, times, restic's summary and errors, the end of stderr.
report() {
  {
    printf 'code %s\\nstart %s\\nend %s\\nversion %s\\n' "$1" "$2" "$3" "$QUADECK_VERSION"
    grep -E '"message_type": ?"(summary|error)"' "$CONF/last-run.json" 2>/dev/null | head -n 50 || true
    tail -n 20 "$CONF/last-run.err" 2>/dev/null | sed 's/^/stderr /' || true
  } | api POST report >/dev/null
}

# Option value after a flag: opt -f "$@"
opt() {
  want=$1
  shift
  while [ $# -gt 0 ]; do
    [ "$1" = "$want" ] && [ $# -gt 1 ] && { printf '%s\\n' "$2"; return 0; }
    shift
  done
  return 1
}
has() {
  want=$1
  shift
  for a in "$@"; do [ "$a" = "$want" ] && return 0; done
  return 1
}

# The guide for an agent, and the head that makes it a skill for Claude Code.
skill_head() {
  cat <<'SKILL'
---
name: quadeck-backup
description: Set up or change this computer's backup to the Quadeck server (restic) with the quadeck-backup command – look at the folders, suggest what to back up and what to leave out, check the size with a dry run and set the plan. Use when the person asks about backing up this computer, what is in its backup, or what to exclude.
---

SKILL
}
guide_text() {
  cat <<'GUIDE'
# Setting up this computer's backup with quadeck-backup

This computer backs up to a Quadeck server with restic. You can look at its folders, suggest what
to back up and what to leave out, and set the plan. Talk it through with the person before you set
anything: what goes in, what stays out and why, and how big it is.

1. \`quadeck-backup plan show\` – the current plan as JSON. \`plan\` is null while this computer is
   connected without a plan yet: then write one from the fields below.
   - \`folders\`: \`~/Documents\` or absolute paths (a standard folder is found under either language).
   - \`exclude.presets\`: caches, trash, dev (node_modules, .venv, __pycache__, target …), temp,
     downloads, vms (disk images), games (Steam), nobackup (folders with a .nobackup file).
   - \`exclude.patterns\`: restic patterns, e.g. \`*.iso\`, \`**/build\`, \`~/Videos/raw\`.
   - \`exclude.maxSizeGB\`: leave out files bigger than this (optional).
   - \`schedule\`: \`{ "every": "hourly" | "6h" | "daily" | "weekly", "time": "12:00" }\`.
   - \`active\`: false pauses the timer. \`keep\` (how long backups stay) is set in Quadeck only.
2. Look at the folders: \`quadeck-backup scan --json\` sends the folder list to Quadeck and prints it
   with sizes (bytes) and marks (caches, dev, git, games …). Use \`du -sh\`, \`ls\` and the like for a
   closer look; do not read file contents you do not need.
3. Write a draft (the JSON of \`plan show\`, changed) and try it:
   \`quadeck-backup check --plan draft.json --json\` – the size without and with the exclusions and
   what the first run would upload. \`check --plan draft.json --files\` lists the files.
4. When the person agrees: \`quadeck-backup plan set -f draft.json\` (a draft from scratch needs
   folders, exclude, schedule and active). Quadeck stores it (the person sees it there) and this
   computer takes it right away; a plan set in Quadeck arrives here within about 10 minutes.
5. \`quadeck-backup now\` backs up right away; \`quadeck-backup status\` shows the snapshots.

Never print or copy ~/.config/quadeck-backup/password: it is the key to the backups.
GUIDE
}

case "\${1:-help}" in
  run)
    # New settings from Quadeck first; without them the last ones are used.
    if [ -n "\${QUADECK_TOKEN:-}" ]; then sync >/dev/null || echo "quadeck-backup: no new settings from Quadeck – backing up with the last ones" >&2; fi
    start=$(date +%s)
    code=0
    RESTIC_PROGRESS_FPS=0.016 backup "--json" > "$CONF/last-run.json" 2> "$CONF/last-run.err" || code=$?
    end=$(date +%s)
    cat "$CONF/last-run.err" >&2
    sum=$(grep '"message_type":"summary"' "$CONF/last-run.json" | tail -n 1 || true)
    if [ -n "$sum" ]; then
      echo "backed up $(field total_files_processed "$sum") files ($(human "$(field total_bytes_processed "$sum")")), $(human "$(field data_added "$sum")") new"
    fi
    if [ -n "\${QUADECK_TOKEN:-}" ]; then report "$code" "$start" "$end" || echo "quadeck-backup: could not report the run to Quadeck" >&2; fi
    [ "$code" = 0 ] || exit "$code"
    if [ "$QUADECK_APPEND_ONLY" = 1 ]; then
      echo "append-only target: old snapshots stay"
    elif [ -n "$QUADECK_FORGET" ]; then
      # shellcheck disable=SC2086
      restic forget --tag quadeck --prune $QUADECK_FORGET
    fi
    # The folders for Quadeck's folder browser, once a day.
    if [ -n "\${QUADECK_TOKEN:-}" ] && { [ ! -f "$CONF/scan" ] || [ -n "$(find "$CONF/scan" -mtime +0 2>/dev/null)" ]; }; then
      scan >/dev/null || echo "quadeck-backup: could not send the folder list to Quadeck" >&2
    fi
    ;;
  now)
    echo "Backing up … (quadeck-backup.service)"
    systemctl --user start quadeck-backup.service && echo "done." || { journalctl --user -u quadeck-backup.service -n 20 --no-pager; exit 1; }
    ;;
  check)
    shift
    if draft=$(opt --plan "$@"); then
      # A draft plan (JSON) as Quadeck would turn it into settings, without saving it.
      SET=$(mktemp -d "$CONF/.check.XXXXXX")
      trap 'rm -rf "$SET"' EXIT
      api POST preview application/json < "$draft" > "$SET/text"
      parse_settings "$SET" < "$SET/text"
      . "$SET/vars"
      QUADECK_FLAGS=$flags
    fi
    list=$(folders)
    has --json "$@" || echo "Folders, without exclusions:"
    before=0
    while IFS= read -r f; do
      # the files' own size, like restic counts it (busybox du has no -b: disk blocks then)
      b=$(du -sb "$f" 2>/dev/null | cut -f1 || true)
      [ -n "$b" ] || b=$(($(du -sk "$f" 2>/dev/null | cut -f1 || echo 0) * 1024))
      before=$((before + b))
      has --json "$@" || printf '  %10s  %s\\n' "$(human "$b")" "$f"
    done <<EOF
$list
EOF
    if has --files "$@"; then
      echo "Dry run with the exclusions – what would be backed up:"
      backup "--dry-run -vv" || true
      exit 0
    fi
    has --json "$@" || echo "Dry run with the exclusions (nothing is uploaded) …"
    sum=$(backup "--dry-run --json" 2>/dev/null | grep '"message_type":"summary"' | tail -n 1 || true)
    [ -n "$sum" ] || { echo "quadeck-backup: the dry run failed – try: quadeck-backup check --files" >&2; exit 1; }
    after=$(field total_bytes_processed "$sum")
    files=$(field total_files_processed "$sum")
    added=$(field data_added "$sum")
    left=$((before - \${after:-0}))
    [ "$left" -ge 0 ] || left=0
    if has --json "$@"; then
      printf '{"without_exclusions":%s,"backed_up":%s,"files":%s,"left_out":%s,"to_upload":%s}\\n' "$before" "\${after:-0}" "\${files:-0}" "$left" "\${added:-0}"
      exit 0
    fi
    echo ""
    printf 'Without exclusions:  %s\\n' "$(human "$before")"
    printf 'Backed up:           %s in %s files (%s left out by the exclusions)\\n' "$(human "\${after:-0}")" "\${files:-0}" "$(human "$left")"
    printf 'New on the next run: %s to upload\\n' "$(human "\${added:-0}")"
    echo "Which files: quadeck-backup check --files"
    ;;
  scan)
    shift
    if has --json "$@"; then scan; else
      scan >/dev/null
      echo "Sent $(grep -c '^d' "$CONF/scan") folders to Quadeck: choose from them in Backups → Clients → $QUADECK_NAME."
    fi
    ;;
  poll) poll ;;
  sync|update)
    if [ -n "\${QUADECK_TOKEN:-}" ]; then sync; else
      echo "Change the settings in Quadeck (Backups → Clients → $QUADECK_NAME), then run the new command it shows:"
      echo "  $QUADECK_URL/backups?tab=clients"
    fi
    ;;
  plan)
    case "\${2:-}" in
      show) api GET plan ;;
      set)
        shift 2
        file=$(opt -f "$@" || printf '%s' "\${1:-}")
        [ -n "$file" ] && { [ -f "$file" ] || [ "$file" = - ]; } || { echo "usage: quadeck-backup plan set -f <plan.json>" >&2; exit 2; }
        if [ "$file" = - ]; then api POST propose application/json; else api POST propose application/json < "$file"; fi
        sync
        ;;
      *) echo "usage: quadeck-backup plan show | plan set -f <plan.json>" >&2; exit 2 ;;
    esac
    ;;
  status)
    echo "$QUADECK_NAME, settings version $QUADECK_VERSION"
    restic snapshots --tag quadeck --compact --latest 5 || true
    systemctl --user list-timers quadeck-backup.timer --no-pager || true
    ;;
  mount)
    dir="\${2:-$HOME/Backup}"
    mkdir -p "$dir"
    echo "Backups under $dir – press Ctrl+C to unmount."
    restic mount "$dir"
    ;;
  restore)
    [ -n "\${2:-}" ] || { echo "usage: quadeck-backup restore <path> [target folder]" >&2; exit 2; }
    target="\${3:-$HOME/restore}"
    restic restore latest --target "$target" --include "$2"
    echo "restored into $target"
    ;;
  uninstall)
    systemctl --user disable --now quadeck-backup.timer quadeck-backup-agent.timer 2>/dev/null || true
    rm -f "$UNITS/quadeck-backup.service" "$UNITS/quadeck-backup.timer" "$UNITS/quadeck-backup-agent.service" "$UNITS/quadeck-backup-agent.timer"
    systemctl --user daemon-reload 2>/dev/null || true
    echo "Timers removed. Settings and the repository password stay in $CONF – delete them yourself if you are sure."
    rm -f "$0"
    ;;
  guide)
    if [ "\${2:-}" = --skill ]; then skill_head; fi
    guide_text
    ;;
  skill)
    [ "\${2:-}" = install ] || { echo "usage: quadeck-backup skill install" >&2; exit 2; }
    dir="$HOME/.claude/skills/quadeck-backup"
    mkdir -p "$dir"
    { skill_head && guide_text; } > "$dir/SKILL.md.new"
    mv "$dir/SKILL.md.new" "$dir/SKILL.md"
    echo "Skill written to $dir/SKILL.md – Claude Code uses it when you ask about this computer's backup."
    ;;
  *)
    echo "quadeck-backup ($QUADECK_NAME, settings version $QUADECK_VERSION)"
    echo "  now        back up right now"
    echo "  check [--files] [--json] [--plan draft.json]   how big the backup is with the exclusions (dry run)"
    echo "  status     last backups and the next run"
    echo "  scan [--json]         send the folder list to Quadeck (for its folder browser)"
    echo "  plan show | plan set -f <plan.json>   the plan as JSON / set a new one"
    echo "  sync       fetch new settings from Quadeck now (also done before every backup)"
    echo "  poll       ask Quadeck for a new plan or a task (what quadeck-backup-agent.timer runs every 10 minutes)"
    echo "  mount [dir]           the backups as folders (needs fuse)"
    echo "  restore <path> [dir]  restore from the latest backup"
    echo "  guide [--skill]       how an agent goes about setting up this backup (as a SKILL.md)"
    echo "  skill install         that guide as a skill for Claude Code (~/.claude/skills)"
    echo "  uninstall  remove the timers and this command"
    ;;
esac`
}

/** Quadeck's own address as the browser sees it (put into the script for `quadeck-backup update`). */
export const QUADECK_URL = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$|^https?:\/\/\[[0-9a-fA-F:]+\](:\d{1,5})?$/
