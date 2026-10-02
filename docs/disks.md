# Disks and files

The **Festplatten** page has two tabs: **SMART** for the health of every drive and **Dateien**, a
small file explorer for the data areas.

<img src="screenshot-disks.png" alt="Disks page: SMART verdict, temperature, hours and sector counters per disk, with advice" width="900">

## SMART

Quadeck reads every drive with `smartctl --json` from smartmontools: every 30 minutes, on
**Jetzt prüfen**, and when the page opens if the last reading is older. Sleeping disks are not
woken up (`-n standby`); their last values stay until they spin up on their own.

### Per disk

Model, serial, capacity, type (HDD, SSD, NVMe), temperature, power-on hours, wear level for SSDs,
reallocated and pending sectors, uncorrectable and CRC errors, the result of the last self-test,
and a verdict.

### The verdict

The assessment is the one from [snapraid-ui](https://github.com/firsttris/snapraid-ui):

| Level | When |
|---|---|
| **critical** | the drive reports itself as failing (`FAIL`), a pre-failure attribute is below its threshold now (`PREFAIL`), wear at 100 %, temperature at 60 °C or more |
| **warning** | a pre-failure attribute was below its threshold in the past, entries in the drive's error log, reallocated, pending or uncorrectable sectors (attributes 5, 197, 198), reported uncorrectable read errors (187), CRC errors (199), media errors on NVMe, wear above 80 %, temperature above 50 °C, a failed or aborted last self-test, SMART data not readable |
| **ok** | nothing of the above |

Every finding comes with what to do: *replace the disk* (status, sectors, read errors, wear,
failed test), *check the cable* (CRC errors and a filling error log are usually a cable, a port or
a power loss, not the disk), *cool it* (temperature), *check access* (SMART not readable). Virtual drives and USB bridges without SMART are
shown neutrally, not as a problem.

### History

Temperature, the sector and error counters and the wear level are sampled hourly and kept for a
year (daily averages beyond 30 days). A rising counter is the real warning sign, a single
reallocated sector that has been there for a year is not. The history opens per disk with 7, 30 or
365 days.

### Self-tests

**Kurzer Test** (a few minutes) and **Langer Test** (hours, the whole surface) start through the
helper and need the [unlock](security.md#unlock). Progress and the test log are shown on the disk.

### On the overview

The storage card shows a SMART dot per disk; the sidebar badge counts disks with a finding. Both
link here. SMART problems also go out as [notifications](notifications.md).

### Without smartmontools

The page shows an install button with the command for your distribution. Without SMART, the
storage card still shows usage and the file explorer works.

## File explorer

The **Dateien** tab is a small explorer for the data areas, meant for moving a download into the
media folder or cleaning up, not for administering the system.

### Areas

`/mnt`, `/srv`, `/media`, `/home`, `/data` and mounted data file systems outside those, each with
its free space. `QUADECK_FILE_ROOTS` replaces the list (comma-separated). System directories
(`/etc`, `/root`, `/boot`, `/usr`, `/var`, `/proc`, `/sys`, `/dev`, `/run`, …) are never reachable,
and symlinks are resolved before the check, so a link cannot lead out of an area.

### Working with files

Open folders, path bar, show or hide hidden files, sort by name, date or size. **Neuer Ordner**
(owned by the parent folder's owner), **Umbenennen**, **Kopieren / Ausschneiden / Einfügen**,
**Löschen**, also with Ctrl+C/X/V, Del and F2. Overwriting asks first; copying a folder into
itself or deleting an area is refused.

Copy, move and delete run as [jobs](updates.md#jobs) with live output (`cp -a --reflink=auto`,
`mv`, `rm -r --one-file-system`), so a large folder blocks nothing and a restart of Quadeck does not
interrupt it. Conflicts and paths outside the areas are refused before the job starts, not in a
failing job. Every change needs the [unlock](security.md#unlock). There is no trash: deleted is
deleted.
