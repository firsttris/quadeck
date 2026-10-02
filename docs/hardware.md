# Hardware

A click on the host card at the top of the sidebar (hostname, OS, uptime) opens **Hardware**: a
spec sheet of the machine, read only. It is also in the command palette (Ctrl+K → Hardware).

## On one screen

- **At a glance**: CPU, memory, GPUs, mainboard and BIOS.
- **Prozessor**: model, cores and threads, maximum clock, L3 cache, and whether hardware
  virtualisation (VT-x/AMD-V) is available for virtual machines.
- **Arbeitsspeicher**: the slots as boxes – filled with size, type, speed and module, or free –
  plus the maximum the board supports and whether ECC is active. Useful to plan an upgrade
  without opening the case. Slots come from `dmidecode` (root, in the helper); without it only the
  total is shown.
- **Mainboard und BIOS**: vendor, model, form factor, BIOS version and date. A BIOS that is four
  years or older gets a hint to look for an update.
- **Grafik**: every GPU with driver and device nodes, and the ready-made Quadlet line
  (`AddDevice=/dev/dri/renderD128`) that gives a container such as Jellyfin or Immich the GPU for
  hardware transcoding, with a copy button.
- **Sensoren**: temperatures (with a bar up to the critical value), fan speeds ("steht" for a
  stopped fan), labelled voltages and power, grouped by chip, refreshed every 15 seconds.
- **USB-Geräte**: name, maker, USB version, driver – and for serial devices (Zigbee and Z-Wave
  sticks) the stable path under `/dev/serial/by-id/…` with a copy button. That path survives
  reboots, unlike `ttyUSB0`, and belongs into Home Assistant, Zigbee2MQTT or `AddDevice=`.
- **SATA-Anbindung**: per disk the negotiated speed. 3 Gbit/s on a 6 Gbit/s disk and port usually
  means a cable or port problem – the same cause as rising CRC errors on the
  [disks page](disks.md).
- **PCIe-Geräte**: grouped (NVMe, storage controllers, network, graphics, …) with the kernel name
  (`nvme0`, `enp5s0`), driver and link (`x4 · PCIe 4.0`).

## Warnings

- An NVMe drive, storage controller or network card running with fewer lanes than it supports
  (`x1 statt x2`) or an NVMe drive on an older PCIe generation – usually a slot with fewer lanes
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
