# Users

**Benutzer** manages the accounts on the server: the people who log in over SSH or at the
console, not Quadeck's own login. It shows root and regular users (uid 1000 and up); system
accounts such as `http` or `quadeck` are left alone.

## The list

Every account with its full name, whether it is an administrator (member of `wheel`, or `sudo`
on Debian), whether it is locked, and the last login from `last`.

## An account

- **Voller Name, Shell** (from `/etc/shells`) and **Administrator**: membership in the admin group,
  which allows sudo and unlocking Quadeck.
- **Groups**: the groups worth having on a home server are listed with what they give – `video`
  and `render` for hardware transcoding, `systemd-journal` to read all logs, `storage`, serial
  devices for Zigbee sticks (`uucp`/`dialout`), `libvirt`, and your own groups (gid 1000 and up,
  for example a `family` group for shared folders). Personal groups (same name as a user) are not
  offered. New groups apply from the next login.
- **Anmeldung**: password set or not, number of SSH keys, **Passwort setzen**, **Sperren** /
  **Entsperren**. Locking sets `!` in front of the password and expires the account
  (`usermod -L -e 1`), so neither a password nor an SSH key gets in; running sessions continue.
- **Samba**: if Samba is installed, **Samba-Passwort setzen** creates the Samba user
  (`smbpasswd -a`). SMB shares need this separate password; without it a user reaches shares only
  as a guest.
- **SSH-Schlüssel**: the account's `authorized_keys`, the same as on the [SSH page](ssh.md), with
  add and remove.
- **Anmeldeverlauf**: logins from `last` (start, end, terminal, address); a green dot means still
  logged in.
- **Konto löschen** (`userdel`, optionally with the home directory). The Samba user goes too.
  An account that is logged in or runs processes cannot be deleted; the message says so.

## New user

Name (lowercase letters, digits, `-` and `_`), full name, administrator or not, and either a
password or **Nur SSH-Schlüssel**: then the account gets `*` as password – no password login,
but not locked, so a key works. The key is added in the account's details afterwards. Shell and
groups can be chosen right away. `useradd -m` creates the home directory; if setting the password
fails, the account is removed again.

## Safety

- Passwords go to `chpasswd` and `smbpasswd` on stdin, never on a command line (where `ps` could
  show them), and are not stored or logged by Quadeck.
- **Lock-out guard**: a change that would leave no administrator (or root) with a password and an
  unlocked account is refused – locking, deleting or demoting the last one. Without such an
  account, Quadeck could not be unlocked any more and sudo would not work. The dialog explains it.
- root cannot be deleted. Names, shells and groups are checked against the rules and the files
  on the machine before anything runs; every change needs the [unlock](security.md#unlock).
