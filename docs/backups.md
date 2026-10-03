# Backups

The **Backups** page (in the menu under Storage) backs up the server with
[restic](https://restic.net): encrypted, deduplicated, on a schedule, with snapshots you can browse
and restore from the page. Without restic the page offers to install it.

## Setting up

**Set up backup …** opens one dialog in five steps:

1. **Where**: a second disk or folder, SFTP (a NAS or another server), S3 or compatible (MinIO,
   Wasabi …), Backblaze B2 or a restic REST server.
   - For a local folder, the parent folder must exist. When the disk is not mounted, nothing is
     created on the system disk by mistake. The target must not lie inside a folder that is backed
     up, nor the other way round.
   - SFTP runs as root: root needs an SSH key without passphrase for the target (`ssh-copy-id` as
     root).
   - Credentials (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, `B2_ACCOUNT_ID`/`B2_ACCOUNT_KEY`,
     `RESTIC_REST_USERNAME`/`RESTIC_REST_PASSWORD`) are stored in a file only root can read. They
     never travel back to the browser; an empty field keeps the stored value.
2. **What**: suggested from your Quadlets.
   - Every container's folders (`Volume=/host/path:…`) and named volumes (`Volume=name:…`,
     `Volume=x.volume:…`) are offered, plus `/etc`.
   - Folders a container mounts read-only (a media library, say) are listed but not preselected.
     Sockets, `/run`, `/dev` and system files handed in read-only (`/etc/localtime`) are left out.
   - Named volumes are resolved to their folder on the host (`podman volume inspect`) at every run.
3. **Exclusions**:
   - Caches (folders marked with `CACHEDIR.TAG`), temporary files, logs, and folders containing a
     `.nobackup` file.
   - What an app rebuilds by itself, found from the Quadlets: the Jellyfin cache with its
     transcodes, Immich thumbnails and transcoded videos.
   - Your own restic patterns, and an optional size limit per file.
   - **Measure size** runs `du` on the selected folders and shows how much the left-out folders
     save.
4. **During the backup**: containers with a database (Postgres, MariaDB, MySQL, MongoDB …) are
   suggested to be stopped while restic reads their files, so the files match each other. Only
   what was running is stopped, and it starts again right after, also when the backup fails.
5. **When and how long**:
   - Schedule: daily, every 6 hours, or weekly, at a time you choose.
   - Retention: how many daily, weekly and monthly snapshots stay (`restic forget --prune` after
     each backup).
   - Repository check: `restic check` monthly or weekly, reading 5 % of the data each time.

**Set up** creates the repository (`restic init`) when there is none yet at the target. An existing
repository is opened, never replaced: if it cannot be opened (for example a wrong password), saving
stops with restic's message.

## The repository password

Quadeck generates the password when the backup is first set up and stores it readable only for
root. **Show password …** displays it after the unlock, to copy or download. Keep it somewhere
other than this server, in a password manager or on paper. With the password and the target, the
backups open with restic on any computer. Without it, they cannot be read at all. Until you confirm
**Stored safely**, the page reminds you.

To read the repository by hand on another machine:

```bash
export RESTIC_REPOSITORY=/mnt/backup/restic   # or sftp:…, s3:…, b2:…, rest:…
restic snapshots          # asks for the password
restic restore latest --target /tmp/restore --include /srv/immich/upload
```

## Status and runs

- **Status**: the last backup with its result, duration and new data; the next run; the repository
  size and snapshot count; the target with its free space.
- **Back up now** and **Check repository** start the systemd units right away.
- **Recent runs**: a bar per backup for the new data, each run with its duration, and the messages
  of a run that finished with warnings (files that could not be read).
- **Snapshots**: every snapshot with the number of files, new and total data. The list is read
  from the repository after every run; **Read again** reads it now.

## Browsing and restoring

**Browse** opens a snapshot like a file browser:

- Each entry is compared with the server today: **deleted**, **changed** or unchanged.
- **Download** gets a single file. A folder comes as a zip (`restic dump`). Downloads need the
  unlock, because a backup holds files only root may read.
- **Restore …** runs as a job with live output (`restic restore`):
  - **Into a new folder** (default `/srv/restore/<date>`): the files land there with their full
    path.
  - **In place**: overwrites today's files with the snapshot's. It asks first, and stops the
    containers of the plan and those whose folders are restored, starting them again afterwards.

## How it runs

- Two systemd units in `/etc/systemd/system`, visible on the units page:
  - `quadeck-backup.service` with its `.timer` runs `quadeck backup run`.
  - `quadeck-backup-check.service` with its `.timer` runs `quadeck backup check`.
  - The timers are `Persistent=true`: a run missed while the server was off is caught up after
    booting.
- `quadeck backup run`:
  1. stops the selected units,
  2. runs `restic backup` with the exclusions, tagged `quadeck`,
  3. starts the units again,
  4. applies the retention (`restic forget --prune --tag quadeck`),
  5. records the run and reads the snapshot list.

  Its output is in the unit's journal.
- **Switch backups off** removes the schedule. The repository with all snapshots, the password and
  the credentials stay, so switching on again continues with the same repository.
- Files: `/var/lib/quadeck-helper/backup/` (mode 700) holds `plan.json`, `password`, `env`
  (credentials), the generated exclude file, the run records and restic's cache. Set
  `QUADECK_BACKUP_DIR` to move it.

## Backup target for clients

The **Clients** tab turns the server into the backup target for the other computers at home: one
[restic rest-server](https://github.com/restic/rest-server) for all of them, each with its own
repository and its own access.

**Set up backup target …** asks for:

- **Data folder**: one folder per client below it. The parent folder must exist.
- **Port**: the rest-server is published on it.
- **Address for the clients**: what the computers use, e.g. `http://nas.lan:8000`. For HTTPS, add a
  domain in the [reverse proxy](network.md#reverse-proxy) pointing at `localhost:<port>` and enter
  it here.
- **Append only**: optional. Clients can add snapshots but not delete them, so an infected computer
  cannot destroy its backups. Clients then cannot remove old snapshots either.

It writes `quadeck-rest-server.container` (image `restic/rest-server`, `--private-repos`) through the
Quadlet editor's checks and history, and starts it.

**+ Add client** creates the client: a name and after how many days without a backup to warn.
The client dialog opens right away.

### The client's plan and its command

The client dialog holds the client's plan:

- **What to back up**: folders such as `~/Dokumente` (`~` is the home of the user who runs the
  script) or absolute paths.
- **Exclusions**: caches, trash, development folders (`node_modules`, `.venv`, `target` …),
  temporary files, downloads, VM images, Steam, folders with `.nobackup`, own patterns and a size
  limit.
- **Schedule**: hourly, every 6 hours, daily or weekly, with the retention.
- **Active**: off pauses the timer on the client.

**Save and create command** shows a one-liner for the client:

```bash
curl -fsSL http://nas.lan:8484/api/backup/script/<one-time link> | sh
```

- The link works **once** and for **30 minutes**. It needs no login: the link itself (192 random
  bits) is the authorisation.
- A used or expired link answers with a message to create a new one.
- **Review first** shows the same as download, check, run.

The script is POSIX `sh` and is run as the normal user, not as root. It:

1. checks that restic and systemd are there (and names the install command if restic is
   missing),
2. writes `~/.config/quadeck-backup/` (mode 700): the access (renewed with every script, so only
   the newest script's access works), the folders and the exclusions,
3. asks **once** for the repository password and keeps it in `~/.config/quadeck-backup/password`.
   It encrypts the backups and never leaves the computer. On a later run the script only checks
   that it still opens the repository,
4. creates the repository on the first run (`restic init`),
5. installs `~/.local/bin/quadeck-backup` and the user units `quadeck-backup.service` and
   `quadeck-backup.timer` (`Persistent=true`: a run missed while the computer was off is caught
   up), then enables the timer, or pauses it.

When the plan changes in Quadeck, the table shows **change not run yet** until the computer runs a
new command. Running it again changes nothing but folders, exclusions and schedule.

On the client:

| | |
|---|---|
| `quadeck-backup now` | back up right now |
| `quadeck-backup check` | dry run: folder sizes and what would be uploaded |
| `quadeck-backup status` | the last backups and the next run |
| `quadeck-backup mount [dir]` | the backups as folders under `~/Backup` (needs FUSE) |
| `quadeck-backup restore <path> [dir]` | restore from the latest backup |
| `quadeck-backup update` | where to get new settings |
| `quadeck-backup uninstall` | remove the timer and the command (settings and password stay) |

On an append-only target the clients skip `forget`; old snapshots stay.

### By hand

**Renew access** in the row menu shows a new access password **once**, with the repository
address and the restic commands. Use it for a computer you set up yourself (Windows, macOS,
[Backrest](https://github.com/garethgeorge/backrest)).

- The access goes to `.htpasswd` in the data folder as a bcrypt hash; the rest-server picks up
  changes by itself.
- `--private-repos` keeps every user inside its own folder.
- On the client, `restic init` asks for the **repository password**. It encrypts the backups and
  stays on the client: the server cannot read them, and without that password nobody can.

Per client the table shows the last backup, the size, the number of snapshots, when to warn, and
whether the computer runs the current settings.
The server reads the time without any password: every backup writes a new file into the
repository's `snapshots/` folder. **Measure sizes** runs `du` on the repositories. The row menu has:

- **Edit …**: the client's plan, its warning and a new command.
- **Renew access**: a new access password, shown once; the old one stops working.
- **Disable**: removes the access but keeps the repository. **Enable** brings the same access back.
- **Delete …**: removes the access; optionally deletes the client's backups too.

**Switch off** deletes the Quadlet and stops the rest-server. The repositories and the list of
clients stay, so setting it up again brings everything back.

## Notifications

The rule **Backup failed or too old** (on by default) reports when the last server backup failed,
when none has succeeded for a number of days (2 by default), and when a client with a warning
setting has not backed up for that many days. See [Notifications](notifications.md).
