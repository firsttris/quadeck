# Units and Quadlets

## Units page

**Units** lists everything systemd runs for you: Quadlet units with their container, plain
services, timers and containers without a unit. Filters: *Alle*, *Container*, *Services*, *Timer*
(this one opens the [timer editor](systemd.md#timers)) and *Fehlgeschlagen* (failed).

Per row: name and description, type (`quadlet · container`, `service`, `oneshot`, `timer`), status
(for a container with a healthcheck its health, otherwise the systemd state), CPU over the last
15 minutes as a sparkline, memory, time since the last state change, whether the unit starts at
boot, and the actions.

### Actions

- **Starten / Stopp / Neu starten** go through systemd over D-Bus (`StartUnit`, `StopUnit`,
  `RestartUnit`). A container with a Quadlet unit is always controlled through its unit: stopping
  the container directly would only make systemd restart it, and `--rm` containers would vanish.
  Only containers without a unit are started and stopped through the Podman API.
- Stop and restart ask for a confirmation that names the exact command. All three need the
  [unlock](security.md#unlock).
- **Journal** opens the journal filtered to the unit.
- **Bearbeiten** opens the Quadlet file for Quadlet units and the [systemd editor](systemd.md)
  for everything else.
- **+ Neue Unit** creates a plain systemd unit from a template.

Unit names are validated before anything is sent to systemd, and only units Quadeck has seen in
its own list can be acted on.

## Quadlet editor

The Quadlet editor is not a menu entry of its own; like the [systemd editor](systemd.md) it is
reached from the units page: **Bearbeiten** on a container, **+ Neuer Container** (template or
empty file) or **Quadlet-Dateien**. It lists every file in `/etc/containers/systemd`
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

**Prüfen** (and automatically before saving) runs two checks:

1. Quadeck's own lint with line numbers: unknown keys for the file type, duplicate single-value
   keys, a `.container` without `Image=`, references to `.network`, `.volume` or `.pod` files that
   do not exist.
2. A dry run of the real Quadlet generator (`quadlet -dryrun` on a copy of the directory with the
   edited file). Its errors are mapped back to lines; the generated systemd unit can be shown.

Errors block saving, warnings do not.

### Saving

**Speichern …** shows the diff against the file on disk, lets you choose whether the unit is
restarted afterwards, and writes through the root helper: atomic write, `systemctl daemon-reload`,
optionally `RestartUnit`. If the restart fails, the file stays saved and the error is shown with a
hint to the journal. Saving needs the [unlock](security.md#unlock).

### History

Every save is committed to a git repository that Quadeck keeps under
`/var/lib/quadeck-helper/quadlets.git` (the Quadlet directory itself stays clean, no `.git` in
`/etc`). **Verlauf** lists the versions, shows the diff of a version against the editor content
and can load it back into the editor. Without `git` on the host, everything except the history
works.

### New files and templates

**+ Neu** creates a file from a template: web service with a published port, PostgreSQL database,
empty container, network, volume, pod. The name becomes the file name and the generated unit name
(`name.container` → `name.service`, `name.network` → `name-network.service`).

### Compose import

**Compose-Import** turns a `docker-compose.yml` into Quadlet files: every service becomes a
`.container`, named volumes become `.volume` files, and one `.network` per project connects
them. Image, ports, volumes, environment, env files, command and entrypoint, user, working
directory, hostname, restart policy, devices, privileged, added capabilities, healthcheck,
labels, networks and dependencies are translated. Everything the importer cannot express (`build`
sections, deploy options, unknown keys) is listed as a warning next to the file instead of
disappearing silently. The result is a set of files in the editor; nothing is
written until you save each one.

### Deleting

**Löschen** stops the unit, deletes the file and commits the deletion to the history, so the file
can be restored from there.

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
