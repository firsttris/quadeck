// The backup plan of a client computer, set in Quadeck and carried to the client by a shell script
// (one-time link): what to back up, exclusions, schedule, retention. The script installs restic's
// configuration, a systemd user timer and the `quadeck-backup` command. No I/O here.

import { msg } from './i18n'
import { m } from '~/paraglide/messages'

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
  keep: { daily: number; weekly: number; monthly: number }
  /** Off: the timer is stopped on the client, the access stays. */
  active: boolean
}

export const defaultClientPlan = (): ClientPlan => ({
  folders: ['~/Dokumente', '~/Bilder'],
  exclude: { presets: [...DEFAULT_CLIENT_PRESETS], patterns: [] },
  schedule: { every: 'daily', time: '12:00' },
  keep: { daily: 7, weekly: 4, monthly: 6 },
  active: true,
})

const CTRL = /[\x00-\x1f\x7f]/ // eslint-disable-line no-control-regex

/** `~`, `~/a/b` or `/a/b`: no empty, `.` or `..` segments, no trailing slash, not `/` itself. */
function folderProblem(f: unknown): string | undefined {
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
  const keep = { daily: num(k.daily), weekly: num(k.weekly), monthly: num(k.monthly) }
  if (Object.values(keep).some(Number.isNaN) || keep.daily + keep.weekly + keep.monthly === 0) return { error: msg(m.backup_error_keep) }
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
  plan: ClientPlan
  /** Settings version the script carries (shown on the client and in Quadeck). */
  version: number
  /** Where `quadeck-backup update` points to. */
  quadeckUrl: string
}

/** Exclude lines for the client; ~ is expanded by the script on the client. */
export function clientExcludes(plan: ClientPlan): string[] {
  return [...plan.exclude.presets.flatMap((p) => CLIENT_PRESET_PATTERNS[p]), ...plan.exclude.patterns]
}

export function clientForgetArgs(plan: ClientPlan): string {
  const k = plan.keep
  return [...(k.daily ? ['--keep-daily', k.daily] : []), ...(k.weekly ? ['--keep-weekly', k.weekly] : []), ...(k.monthly ? ['--keep-monthly', k.monthly] : [])].join(' ')
}

/** The install/update script the client runs with `curl … | sh`. POSIX sh, systemd user units. */
export function clientScript(i: ScriptInput): string {
  const p = i.plan
  const flags = [...(p.exclude.presets.includes('caches') ? ['--exclude-caches'] : []), ...(p.exclude.presets.includes('nobackup') ? ['--exclude-if-present .nobackup'] : []), ...(p.exclude.maxSizeGB ? [`--exclude-larger-than ${p.exclude.maxSizeGB}G`] : [])].join(' ')
  return `#!/bin/sh
# Quadeck backup client "${i.name}" – settings version ${i.version}.
# Installs or updates: ~/.config/quadeck-backup, ~/.local/bin/quadeck-backup and the systemd user
# timer quadeck-backup.timer. Run it again whenever Quadeck shows a new command; it only changes
# folders, exclusions and schedule. The repository password stays on this computer.
set -eu

NAME=${sq(i.name)}
VERSION=${i.version}
ACTIVE=${p.active ? 1 : 0}
CALENDAR=${sq(clientCalendar(p.schedule))}
FOLDERS=${sq(p.folders.join('\n'))}
EXCLUDES=${sq(clientExcludes(p).join('\n'))}

CONF="\${XDG_CONFIG_HOME:-$HOME/.config}/quadeck-backup"
UNITS="\${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
BIN="$HOME/.local/bin"
say() { printf '%s\\n' "$*"; }
die() { printf 'quadeck-backup: %s\\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || [ "\${QUADECK_ALLOW_ROOT:-}" = 1 ] || die "please run this as the user whose files are backed up, not as root (QUADECK_ALLOW_ROOT=1 to do it anyway)"
if ! command -v restic >/dev/null 2>&1; then
  for pm in pacman apt-get dnf zypper apk; do
    if command -v "$pm" >/dev/null 2>&1; then
      case "$pm" in
        pacman) hint="sudo pacman -S restic" ;; apt-get) hint="sudo apt install restic" ;; dnf) hint="sudo dnf install restic" ;;
        zypper) hint="sudo zypper install restic" ;; apk) hint="sudo apk add restic" ;;
      esac
      die "restic is not installed – install it first: $hint"
    fi
  done
  die "restic is not installed"
fi
command -v systemctl >/dev/null 2>&1 || die "systemd is needed for the schedule"

umask 077
mkdir -p "$CONF" "$UNITS" "$BIN"
chmod 700 "$CONF"

# Access to the server (renewed with every script) and where restic finds everything.
# Read with \`. env\` (CONF set before): every value quoted.
cat > "$CONF/env" <<'QUADECK_ENV'
${envFile(i, flags)}
QUADECK_ENV

# Folders and exclusions, ~ as this user's home.
printf '%s\\n' "$FOLDERS" | sed "s|^~|$HOME|" > "$CONF/folders"
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

# The repository: open it, or create it on the first run.
if ! out=$(restic cat config --no-lock 2>&1 >/dev/null); then
  case "$out" in
    *"wrong password"*|*"no key found"*) die "the repository exists but the password in $CONF/password does not open it" ;;
    *"Is there a repository"*|*"does not exist"*|*"no such file"*|*"unable to open config"*|*"404"*)
      say "Creating the repository on the server …"
      restic init >/dev/null ;;
    *) die "cannot reach the repository: $out" ;;
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

systemctl --user daemon-reload
if [ "$ACTIVE" = 1 ]; then
  systemctl --user enable --now quadeck-backup.timer >/dev/null || die "could not start the timer – is this a normal login session? (systemctl --user)"
  state="$CALENDAR"
else
  systemctl --user disable --now quadeck-backup.timer >/dev/null 2>&1 || true
  state="paused"
fi

say ""
say "Quadeck backup for $NAME is set up (settings version $VERSION, schedule $state)."
say "  quadeck-backup check    what would be backed up"
say "  quadeck-backup now      back up right now"
say "  quadeck-backup status   last backups and the next run"
case ":$PATH:" in *":$BIN:"*) ;; *) say "(add $BIN to your PATH, or call $BIN/quadeck-backup)" ;; esac
if command -v loginctl >/dev/null 2>&1 && [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)" = no ]; then
  say "The timer runs while you are logged in. For a computer that runs without anyone logged in: sudo loginctl enable-linger $(id -un)"
fi
`
}

function envFile(i: ScriptInput, flags: string): string {
  return [
    `RESTIC_REPOSITORY=${sq(i.repo)}`,
    `RESTIC_REST_USERNAME=${sq(i.user)}`,
    `RESTIC_REST_PASSWORD=${sq(i.access)}`,
    'RESTIC_PASSWORD_FILE="$CONF/password"',
    `QUADECK_NAME=${sq(i.name)}`,
    `QUADECK_VERSION=${i.version}`,
    `QUADECK_URL=${sq(i.quadeckUrl)}`,
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
[ -f "$CONF/env" ] || { echo "quadeck-backup: not set up (run the script from Quadeck)" >&2; exit 1; }
set -a
. "$CONF/env"
set +a

folders() {
  set --
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ -e "$f" ]; then set -- "$@" "$f"; else echo "skipped (missing): $f" >&2; fi
  done < "$CONF/folders"
  [ "$#" -gt 0 ] || { echo "quadeck-backup: none of the folders exists" >&2; exit 1; }
  for f in "$@"; do printf '%s\\n' "$f"; done
}

# The folders as arguments (works with restic older than 0.15, which has no --files-from-verbatim).
backup() {
  dry="\${1:-}"
  set --
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ -e "$f" ]; then set -- "$@" "$f"; else echo "skipped (missing): $f" >&2; fi
  done < "$CONF/folders"
  [ "$#" -gt 0 ] || { echo "quadeck-backup: none of the folders exists" >&2; exit 1; }
  # shellcheck disable=SC2086
  restic backup --tag quadeck --exclude-file "$CONF/excludes" $QUADECK_FLAGS $dry -- "$@"
}

case "\${1:-help}" in
  run)
    backup
    if [ "$QUADECK_APPEND_ONLY" = 1 ]; then
      echo "append-only target: old snapshots stay"
    elif [ -n "$QUADECK_FORGET" ]; then
      # shellcheck disable=SC2086
      restic forget --tag quadeck --prune $QUADECK_FORGET
    fi
    ;;
  now)
    echo "Backing up … (quadeck-backup.service)"
    systemctl --user start quadeck-backup.service && echo "done." || { journalctl --user -u quadeck-backup.service -n 20 --no-pager; exit 1; }
    ;;
  check)
    echo "Folders:"
    folders | while IFS= read -r f; do printf '  %s  %s\\n' "$(du -sh "$f" 2>/dev/null | cut -f1)" "$f"; done
    echo "Dry run (nothing is uploaded):"
    backup --dry-run
    ;;
  status)
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
  update)
    echo "Change the settings in Quadeck (Backups → Clients → $QUADECK_NAME), then run the new command it shows:"
    echo "  $QUADECK_URL/backups?tab=clients"
    ;;
  uninstall)
    systemctl --user disable --now quadeck-backup.timer 2>/dev/null || true
    rm -f "\${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/quadeck-backup.service" "\${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/quadeck-backup.timer"
    systemctl --user daemon-reload 2>/dev/null || true
    echo "Timer removed. Settings and the repository password stay in $CONF – delete them yourself if you are sure."
    rm -f "$0"
    ;;
  *)
    echo "quadeck-backup ($QUADECK_NAME, settings version $QUADECK_VERSION)"
    echo "  now        back up right now"
    echo "  check      what would be backed up (dry run)"
    echo "  status     last backups and the next run"
    echo "  mount [dir]           the backups as folders (needs fuse)"
    echo "  restore <path> [dir]  restore from the latest backup"
    echo "  update     how to get new settings from Quadeck"
    echo "  uninstall  remove the timer and this command"
    ;;
esac`
}

/** Quadeck's own address as the browser sees it (put into the script for `quadeck-backup update`). */
export const QUADECK_URL = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$|^https?:\/\/\[[0-9a-fA-F:]+\](:\d{1,5})?$/
