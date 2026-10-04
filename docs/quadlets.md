# Units and Quadlets

## Units page

**Units** lists everything systemd runs for you: Quadlet units with their container, plain
services, timers, sockets and containers without a unit. Filters: *All*, *Containers*,
*Services*, *Timers* (this one opens the [timer editor](systemd.md#timers)), *Sockets* and
*Failed*.

Per row: name and description (for a socket: what it listens on and which service it starts),
status (for a container with a healthcheck its health, otherwise the systemd state), memory and
time since the last state change. On wider screens also CPU over the last 15 minutes as a
sparkline, the type (`container`, `pod`, `service`, `oneshot`, `timer`, `socket`, `podman` for
containers without a unit; Quadlets are highlighted) and whether the unit starts at boot.

### Actions

Each row has one button for the likely next step – **Start** for a stopped unit, **Restart** for a running or failed one – and a **⋯** menu with the rest. The unit name itself
opens the journal.

- **Start / Stop / Restart** go through systemd over D-Bus (`StartUnit`, `StopUnit`,
  `RestartUnit`). A container with a Quadlet unit is always controlled through its unit: stopping
  the container directly would only make systemd restart it, and `--rm` containers would vanish.
  Only containers without a unit are started and stopped through the Podman API.
- Stop and restart ask for a confirmation that names the exact command. All of them need the
  [unlock](security.md#unlock).
- **Journal** opens the journal filtered to the unit.
- **Edit Quadlet / Edit unit** opens the Quadlet file for Quadlet units and the
  [systemd editor](systemd.md) for everything else.
- **Start at boot** enables or disables the unit (`systemctl enable/disable`); only shown
  for units that have an install section.
- **Delete Quadlet …** removes a Quadlet container for good, see [Deleting](#deleting).
- **+ New unit** creates a plain systemd unit from a template.

The timer view uses the same pattern: **Run now** plus a menu for changing the schedule,
the journal and the unit files.

Unit names are validated before anything is sent to systemd, and only units Quadeck has seen in
its own list can be acted on.

## Quadlet editor

The Quadlet editor is not a menu entry of its own; like the [systemd editor](systemd.md) it is
reached from the units page: **Edit Quadlet** on a container, **+ New container** (template or
empty file) or **Quadlet files**. It lists every file in `/etc/containers/systemd`
(`QUADECK_QUADLET_DIR`): `.container`,
`.pod`, `.network`, `.volume`, `.kube`, `.image` and `.build`, including one level of
subdirectories, each with the state of the unit it generates.

<img src="screenshot-quadlets.png" alt="Quadlet editor: jellyfin.container as a form" width="900">

### Form and text, same file

The form shows the keys that matter with a short explanation: image, container name, published
ports, volumes, environment and environment files, network, auto-update, labels, exec, user,
healthcheck, pod, devices, timezone, and the `[Unit]`, `[Service]` and `[Install]` keys that
usually need touching (description, after, requires, restart, start timeout, wanted by).

The form edits the file line by line: changing a field changes only that `Key=` line, comments,
the order of lines and keys the form does not know stay exactly as they were. Keys that can appear
several times (ports, volumes, environment, labels) are lists in the form. **Text** shows the whole
file with line numbers; both views work on the same content.

### Validation

**Check** (and automatically before saving) runs two checks:

1. Quadeck's own lint with line numbers: unknown keys for the file type, duplicate single-value
   keys, a `.container` without `Image=`, references to `.network`, `.volume` or `.pod` files that
   do not exist.
2. A dry run of the real Quadlet generator (`quadlet -dryrun` on a copy of the directory with the
   edited file). Its errors are mapped back to lines; the generated systemd unit can be shown.

Errors block saving, warnings do not.

### Saving

**Save …** shows the diff against the file on disk, lets you choose whether the unit is
restarted afterwards, and writes through the root helper: atomic write, `systemctl daemon-reload`,
optionally `RestartUnit`. If the restart fails, the file stays saved and the error is shown with a
hint to the journal. Saving needs the [unlock](security.md#unlock).

### History

Every save is committed to a git repository that Quadeck keeps under
`/var/lib/quadeck-helper/quadlets.git` (the Quadlet directory itself stays clean, no `.git` in
`/etc`). **History** lists the versions, shows the diff of a version against the editor content
and can load it back into the editor. Without `git` on the host, everything except the history
works.

### New files and templates

**New** creates a file from a template: web service with a published port, PostgreSQL database,
empty container, network, volume, pod. The name becomes the file name and the generated unit name
(`name.container` → `name.service`, `name.network` → `name-network.service`).

### Compose import

**Compose import** turns a `docker-compose.yml` into Quadlet files: every service becomes a
`.container`, named volumes become `.volume` files, and one `.network` per project connects
them. Image, ports, volumes, environment, env files, command and entrypoint, user, working
directory, hostname, restart policy, devices, privileged, added capabilities, healthcheck,
labels, networks and dependencies are translated. Everything the importer cannot express (`build`
sections, deploy options, unknown keys) is listed as a warning above the preview instead of
disappearing silently. **Convert** shows the files first; **Create N files** writes them all
(networks and volumes first, existing files are marked "will be overwritten") and, if chosen,
starts the units.

### Deleting

**Delete** in the editor, or **Delete Quadlet …** in the unit's row menu, stops the unit, deletes
the file, commits the deletion to the history (the file can be restored from there) and reloads
systemd, so the generated service is gone and does not come back at the next boot. Stopping alone
is **Stop …** in the row menu; a Quadlet unit then starts again at the next boot if its file has
an `[Install]` section.

For a `.container` the dialog offers two more boxes, both off by default:

- **Also remove the image**: `podman rmi` after the container is gone. Not offered when another
  Quadlet uses the same image; if Podman still refuses (another container outside the Quadlets
  uses it), the file is deleted anyway and a warning names the image.
- **Also delete the volumes**: the named volumes of `Volume=` lines, with `podman volume rm`. A
  volume from a `.volume` file is removed together with that file. Volumes another Quadlet mounts
  too are listed as kept. The data is gone afterwards; the history only keeps the files.

Folders on the host (`Volume=/srv/app:/config`) are never deleted; the dialog lists them so you
know what is left. `.network` files and other Quadlets the container referred to stay as well.

## Podman settings

The **Podman** tab on the System page (next to the container image updates):

- **`podman-auto-update.timer`**: on/off and schedule. Custom schedules are written as a drop-in
  `/etc/systemd/system/podman-auto-update.timer.d/50-quadeck.conf` after
  `systemd-analyze calendar` accepted them; the vendor timer file stays untouched.
- **Auto-update for all containers** (Podman 5 and newer): a Quadlet drop-in
  `container.d/50-quadeck-autoupdate.conf` with `AutoUpdate=registry`, so every `.container` file
  takes part in `podman auto-update` without editing each one.
- **`containers.conf`** and **`registries.conf`**: a form for the common settings plus a text editor.
  The file is parsed as TOML before it is written; the previous version is kept next to it as
  `.quadeck-bak`.
- **`storage.conf`** is shown read-only: changes there can make existing containers unusable.

### Storage & cleanup

What Podman keeps on disk and what uses it, on the same tab:

- **Overview**: images, volumes and containers with their size and what could be freed, where
  Podman stores them (`graphRoot`) and how full that disk is. Read from the Podman API
  (`system/df`, which measures every volume – on a large server that takes a moment).
- **Images**: name, size (only what this image holds alone, shared layers excluded), age and
  **used by** – containers, or the Quadlet whose `Image=` names it (also while that service is
  stopped). Untagged images are shown as *old version of …*: what an update leaves behind.
- **Volumes**: size, created, used by, the Quadlet `.volume` file that creates it, the folder on
  disk. Volumes no container uses come first.
- **Stopped containers**: state, exit code, since when. Containers of a Quadlet or a pod are not
  removed here – their unit or pod decides.
- **Delete** next to anything nobody uses; volumes ask first, they hold data.

**Clean up …** opens a dialog with a live preview of exactly what goes and how much it frees:

- *Safe* (on by default): stopped containers without a Quadlet or pod, old image versions
  (untagged), networks without containers (never the default network, never one from a `.network`
  file).
- *More thorough* (off): all images no container and no Quadlet uses; they are pulled again when
  needed.
- *Volumes without a container* (off, in a red box): picked one by one.

Images, volumes and networks that only the removed containers used are freed with them. Right
before deleting, Quadeck reads everything again and drops whatever is in use by now; every item is
deleted on its own through the Podman API **without force**, so Podman itself refuses anything in
use. The result lists what was freed and what was not, with Podman's reason. Needs unlocking; off in
read-only mode.

**Clean up regularly** creates the timer `quadeck-podman-prune.timer` (weekly on Sunday or
monthly on the 1st, 04:00, persistent, low priority): `podman container prune` for stopped
containers without a `PODMAN_SYSTEMD_UNIT` label and `podman image prune` for untagged images,
both only older than a week. It never touches volumes, tagged images or networks. The timer also
shows under Units → Timers with its journal.
