# Shares

The shares card on the overview lists SMB shares and NFS exports; **Manage** opens the
**Shares** page, where they are created, changed and removed. Existing configuration written by
hand appears there too and is edited in place.

## SMB (Samba)

A share has a name, a path, a description, read-only or read/write, allowed users and groups,
guest access and whether it is browseable. **New share** creates one, the pencil edits it
(renaming included), the bin removes it.

Only the share's own `[section]` in `smb.conf` is touched. `[global]`, comments, other shares and
options the form does not know (`create mask`, `vfs objects`, `force user`, …) stay exactly as
they are; synonyms Samba accepts (`writable`, `writeable`, `read only`) are recognised and
replaced consistently.

Before writing, `testparm` checks the new file; after writing, `smbcontrol smbd reload-config`
makes Samba pick it up without dropping open connections. The previous file is kept as
`smb.conf.quadeck-bak`. Active connections from `smbstatus` are shown per share.

Samba users need their own Samba password (`smbpasswd -a <name>` on the console); creating Samba
users is not part of the UI.

## NFS

An export has a path and one or more clients (a host, a network such as `192.168.1.0/24`, or `*`),
each with access (`ro`/`rw`), root handling (`root_squash`, `no_root_squash`, `all_squash`),
`sync`/`async` and the other options from `exports(5)`; every option is validated against that
list.

New exports are written to `/etc/exports.d/quadeck.exports`; existing ones are changed in the file
they came from (`/etc/exports` or any `/etc/exports.d/*.exports`). After writing, `exportfs -ra`
applies the change; if it refuses, the previous file is restored and the error shown.

## Services

`smb`/`nmb` (or `smbd`/`nmbd` on Debian) and `nfs-server`: state, start, stop, restart and enable
at boot. Missing packages get an install button with the command for your distribution.

## What every change does

1. The dialog shows a **diff** of the file that will be written, with warnings where they matter:
   guests with write access, `*` with `rw`, `no_root_squash`, a path that does not exist.
2. The change needs the [unlock](security.md#unlock).
3. The helper validates (`testparm` or `exportfs`), writes atomically, keeps the previous version
   as `.quadeck-bak`, and reloads the service.

System directories (`/`, `/etc`, `/root`, `/boot`, `/proc`, `/sys`, `/dev`, `/run`, Quadeck's and
Podman's data) cannot be shared.

## Environment

| Variable | Default |
|---|---|
| `QUADECK_SMB_CONF` | `/etc/samba/smb.conf` |
| `QUADECK_EXPORTS` | `/etc/exports` (plus `/etc/exports.d/*.exports`) |
