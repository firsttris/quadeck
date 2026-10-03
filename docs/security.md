# Security

Quadeck controls a server, so its design starts from the question "what can go wrong when the web
app is compromised?" and makes sure the answer is "not much".

## Two processes

| | `quadeck.service` | `quadeck-helper.service` |
|---|---|---|
| what | the web app: HTTP, UI, collectors, database | a root helper with a fixed list of actions |
| user | `quadeck`, an unprivileged system user | root |
| talks to | Podman socket (read), D-Bus (read), journal, `/proc`, `/sys`, config files (read), the helper | systemd, Podman, package managers, the files it edits |
| reachable | TCP port 8484 | Unix socket `/run/quadeck/helper.sock`, `root:quadeck` 0660 |
| sandbox | `ProtectSystem=strict`, `ProtectHome=read-only`, `NoNewPrivileges`, `PrivateTmp`, kernel and cgroup protection, `UMask=0077` | `PrivateTmp`, kernel protection |

The web app reads everything that is readable without root. Everything that changes the server
is a request to the helper over the socket: one fixed route per action (`/unit`, `/jobs/start`,
`/quadlets/write`, `/shares/apply`, …), each with its own validation of names, paths and
contents. There is no "run this command" route. Processes are started with argument arrays, never
through a shell.

A compromised web app can therefore read what you can read in the dashboard and ask the helper
to do what the dashboard can do, and for the latter it needs the unlock.

## Unlock

Every change on the server (start, stop, save, install, delete) is locked until it is unlocked
with the password of a **Linux administrator**: root or a member of `wheel` or `sudo`. The check
happens inside the helper against `/etc/shadow` with the system's `crypt(3)`, so the web app never
sees the password hash, and the unlock token the helper hands out is bound to the session. The
unlock lasts 15 minutes (`QUADECK_UNLOCK_MINUTES`) with a countdown in the sidebar; **Lock**
ends it early. A failed unlock is rate-limited like a login.

`QUADECK_UNLOCK=none` switches the unlock off (every logged-in user may change everything);
`QUADECK_UNLOCK=quadeck` uses the Quadeck password instead, which only works when everything runs
as root in one process (installations from before the helper).

## Login

- One admin password, hashed with argon2id, set on the first start through `/setup` with a token
  that only root and the `quadeck` user can read (`quadeck setup-token`). `quadeck passwd` resets it.
- Sessions last 7 days. The cookie is `HttpOnly`, `SameSite=Strict`, `Secure` behind HTTPS; the
  database stores only a hash of the session token.
- After 5 failed attempts a client waits 30 seconds, doubling up to 15 minutes. The client address
  comes from `X-Forwarded-For` only for proxies listed in `QUADECK_TRUSTED_PROXIES`.
- Logout ends this session; setting a new password (`quadeck passwd`, then `/setup`) ends every
  session. Open live streams of an ended session close within 15 seconds.

## Requests

- Every write request must come from Quadeck's own origin and carry the session's CSRF token.
- Dangerous actions (stop, restart, delete, remove packages, overwrite files) ask for a
  confirmation that names what will happen.
- Names and paths are validated at every boundary: unit names against a pattern, Quadlet and unit
  file paths against their directories, file explorer paths against the data areas after resolving
  symlinks, package names against the manager's rules, URLs to `http(s)` only.
- Only Podman API reads from a short allowlist are proxied through the helper; containers are
  acted on by ID.

## What Quadeck writes and where

| What | Where | Safety net |
|---|---|---|
| Quadlet files | `/etc/containers/systemd` | generator dry run, git history in `/var/lib/quadeck-helper/quadlets.git` |
| own units, timers, overrides | `/etc/systemd/system` | `systemd-analyze verify`, history in `/var/lib/quadeck-helper/unit-history` |
| Podman config | `/etc/containers/*.conf`, drop-ins | TOML parse, `.quadeck-bak` |
| Samba | `smb.conf` | `testparm`, `.quadeck-bak`, reload without dropping connections |
| NFS | `/etc/exports`, `/etc/exports.d/quadeck.exports` | `exportfs -ra` with rollback |
| SSH | `/etc/ssh/sshd_config.d/01-quadeck.conf`, `authorized_keys` | `sshd -t` with rollback, lock-out guard |
| accounts | `/etc/passwd`, `/etc/shadow`, `/etc/group` via `useradd`, `usermod`, `chpasswd`, `userdel`; Samba via `smbpasswd` | names, shells and groups checked; passwords only on stdin; lock-out guard for the last administrator |
| mounts | `/etc/fstab` (data disks only; system entries are protected) | device, driver, `findmnt --verify`, systemd generator, test mount, confirmation for boot-critical entries, `.quadeck-bak`, history, rollback |
| packages | the package manager | protected package list, removal preview |
| files | the data areas only | conflicts refused before the job; text files: hash check, written next to the file and renamed over it |
| reverse proxy | the Caddyfile (`QUADECK_CADDYFILE`, a path picked in the UI, the Caddy Quadlet's mount, or `/etc/caddy/Caddyfile`) | admin API `/adapt` or `caddy validate`, history in `/var/lib/quadeck-helper/caddy-history`, reload, restore when the reload fails |
| boot | systemd-boot entries in `loader/entries`; EFI variables via `bootctl` (default, timeout, one-time entry) | entry check (kernel, files, `root=`), written next to the file and renamed, history in `/var/lib/quadeck-helper/boot-history`; default and running entry never edited in place |
| backups | `quadeck-backup(-check).service`/`.timer` in `/etc/systemd/system`; the plan, password and credentials in `/var/lib/quadeck-helper/backup` | plan checked twice (web app and helper): absolute paths, target not inside a backed-up folder and its parent existing, credentials only the names the target needs and without newlines; an existing repository is never initialised again; the clients' rest-server goes through the Quadlet checks, its `.htpasswd` (bcrypt, mode 600) lives in its data folder; a client's install script comes from a one-time link (30 minutes, 192 random bits, no login) and carries a freshly renewed access, never the repository password |
| package config files | the live file next to a `.pacnew`/`.pacsave`/`.rpmnew`/`.dpkg-dist` | both versions shown before keeping, replacing or merging; `sshd -t`/`testparm` where they apply |

Nothing is written outside these places. Quadeck's own units are read-only in the editor.

## Data and secrets

- `/var/lib/quadeck` (user `quadeck`, 0700): SQLite database with the password hash, sessions,
  layout, overrides, metric history, notification state and channel tokens; the icon cache; the
  setup token.
- `/var/lib/quadeck-helper` (root, 0700): the Quadlet git repository, the history of unit files,
  `/etc/fstab`, boot entries and the Caddyfile (`unit-history`, `fstab-history`, `boot-history`,
  `caddy-history`), `caddy.json` (the Caddyfile path picked in the UI) and `backup/` (0700: the
  restic repository password, the target's credentials, the backup plan and run records).
- `/var/cache/quadeck` (root): the copy of the pacman database for update checks.
- Notification tokens are returned masked by the API and never logged. The backup password is
  shown only after the unlock; the target's credentials never leave the helper.

## Read-only mode

`QUADECK_READONLY=true` refuses every change on the server in the web app before anything reaches
the helper. Dashboard layout, links and overrides stay editable.

## Reporting

If you find a security problem, please open an issue on GitHub or contact the maintainer directly
rather than publishing details first.
