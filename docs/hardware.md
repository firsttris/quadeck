# Hardware

A click on the host card at the top of the sidebar (hostname, OS, uptime) opens **Hardware**: a
spec sheet of the machine, read only. It is also in the command palette (Ctrl+K → Hardware).
The **Power** tab shows what the server draws and what that costs (see [below](#power)).

## On one screen

- **At a glance**: CPU, memory, GPUs, mainboard and BIOS.
- **Processor**: model, cores and threads, maximum clock, L3 cache, and whether hardware
  virtualisation (VT-x/AMD-V) is available for virtual machines.
- **Memory**: the slots as boxes – filled with size, type, speed and module, or free –
  plus the maximum the board supports and whether ECC is active. Useful to plan an upgrade
  without opening the case. Slots come from `dmidecode` (root, in the helper); without it only the
  total is shown.
- **Mainboard and BIOS**: vendor, model, form factor, BIOS version and date. A BIOS that is four
  years or older gets a hint to look for an update.
- **Graphics**: every GPU with driver and device nodes, and the ready-made Quadlet line
  (`AddDevice=/dev/dri/renderD128`) that gives a container such as Jellyfin or Immich the GPU for
  hardware transcoding, with a copy button.
- **Sensors**: temperatures (with a bar up to the critical value), fan speeds ("stopped" for a
  stopped fan), labelled voltages and power, grouped by chip, refreshed every 15 seconds.
- **USB devices**: name, maker, USB version, driver – and for serial devices (Zigbee and Z-Wave
  sticks) the stable path under `/dev/serial/by-id/…` with a copy button. That path survives
  reboots, unlike `ttyUSB0`, and belongs into Home Assistant, Zigbee2MQTT or `AddDevice=`.
- **SATA links**: per disk the negotiated speed. 3 Gbit/s on a 6 Gbit/s disk and port usually
  means a cable or port problem – the same cause as rising CRC errors on the
  [disks page](disks.md).
- **PCIe devices**: grouped (NVMe, storage controllers, network, graphics, …) with the kernel name
  (`nvme0`, `enp5s0`), driver and link (`x4 · PCIe 4.0`).

## Warnings

- An NVMe drive, storage controller or network card running with fewer lanes than it supports
  (runs at x1 instead of x2) or an NVMe drive on an older PCIe generation – usually a slot with fewer lanes
  or lanes shared with another slot (see the mainboard manual). GPUs are left out: they lower
  their link speed when idle.
- A SATA link slower than disk and port allow.
- A temperature within 5 °C of its critical value.
- An old BIOS (hint), and a note when Quadeck runs in a virtual machine, where all of this shows
  the virtual hardware.

## Where the data comes from

Everything is read from sysfs and procfs – `/sys/bus/pci`, `/sys/bus/usb`, `/sys/class/drm`,
`/sys/class/ata_link`, `/sys/class/hwmon`, `/sys/class/dmi/id`, `/proc/cpuinfo`, `lscpu` – so
`lspci` and `lsusb` are not needed. Device names come from `pci.ids`/`usb.ids` (package `hwdata`)
when installed, otherwise a built-in list names the usual vendors. Missing sensors usually mean a
missing kernel module for the board's sensor chip (`nct6775`, `it87`).

## Power

**Hardware → Power**: what the server draws now, per component, and what it used over time. There
is no meter at the wall socket, so the total is always marked *estimated*; each part says whether
it is measured or estimated.

- **CPU – measured** from the processor's own energy counter (RAPL, `/sys/class/powercap/intel-rapl:*`,
  Intel and AMD). Packages plus DRAM where Intel reports it apart; never `psys` (the whole
  platform) or the core/uncore sub-zones, which are inside the package. The counters are root-only,
  so the helper reads them every 30 s; watts are the difference over that time, so no short spike is
  missed. Without readable counters (VMs, ARM boards) the CPU is estimated from its load
  (4 W idle up to about 34 W) and marked so.
- **GPU – measured** as the driver reports it (`nvidia-smi power.draw`, amdgpu/i915 hwmon), the
  same value as on the GPU card. Integrated graphics without a power reading count as 0 W; an AMD
  APU's reading may include part of the CPU.
- **Disks – estimated** from type and state, because disks have no power sensor: a spinning hard
  disk 6 W, in standby 0.8 W (the state comes from `hdparm -C`, which does not wake the disk; disks
  behind USB are not asked every 30 s – some bridges wake them – and count as spinning), a SATA SSD
  1.2 W, an NVMe 3 W.
- **Rest – estimated**: a base value for mainboard, RAM, fans and network (15 W by default) plus the
  power supply loss (10 % of everything by default).

Below that:

- **Today, this month** (with a projection to the month's end) and **per year**, in kWh and euros
  from the electricity price you enter.
- **Usage** as stacked bars per component: 24 hours by the hour, 7 or 30 days by the day, 12 months
  by the month, with the peak.
- **Disks in detail**: type, state, estimated watts and standby hours today per disk, and how much
  disk standby saves a month (standby hours × the difference between spinning and standby), with
  a link to [the disks' energy saving](disks.md).

**Settings …**: the electricity price (€/kWh), the base value (W) and the power supply loss (%).
If you once measured the server with a meter at the socket, set the base value so that *Now* matches.

The overview gets a **Power** card (watts, kWh per day, € per month) once the first reading is in;
like the other cards it keeps a 7-day chart, its dialog links here.

Energy is stored as Wh per hour and component (plus standby seconds per disk) in SQLite and kept
for two years; the current hour is rewritten every 30 s, so a restart loses nothing. Time when the
server or Quadeck was off is not counted.
