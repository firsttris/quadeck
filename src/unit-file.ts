// systemd units, printed by `quadeck print-unit [web|helper]` (used by install.sh).
//
// quadeck.service        – the web app as unprivileged user "quadeck"
// quadeck-helper.service – the root helper: fixed list of actions behind an
//                          unlock with an admin password, Unix socket for the
//                          "quadeck" group only

export const WEB_UNIT = `[Unit]
Description=Quadeck – Dashboard für Podman und Quadlets
Documentation=https://github.com/firsttris/quadeck
Wants=network-online.target quadeck-helper.service
After=network-online.target quadeck-helper.service

[Service]
Type=simple
User=quadeck
Group=quadeck
# Journal lesen
SupplementaryGroups=systemd-journal
ExecStart=/usr/local/bin/quadeck serve
Restart=on-failure
RestartSec=3
StateDirectory=quadeck
StateDirectoryMode=0700
UMask=0077
EnvironmentFile=-/etc/quadeck/quadeck.env
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ProtectHostname=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes

[Install]
WantedBy=multi-user.target
`

export const HELPER_UNIT = `[Unit]
Description=Quadeck Root-Helfer (feste Aktionsliste, Entsperren mit Admin-Passwort)
Documentation=https://github.com/firsttris/quadeck
After=podman.socket

[Service]
Type=simple
ExecStart=/usr/local/bin/quadeck helper
# Socket /run/quadeck/helper.sock gehört root:quadeck (0660)
Group=quadeck
RuntimeDirectory=quadeck
RuntimeDirectoryMode=0750
# temporäre pacman-Datenbanken für die Update-Prüfung
CacheDirectory=quadeck
Restart=on-failure
RestartSec=3
UMask=0077
EnvironmentFile=-/etc/quadeck/quadeck.env
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectHostname=yes
LockPersonality=yes

[Install]
WantedBy=multi-user.target
`

/** Kept for "quadeck print-unit" without argument (older install.sh). */
export const UNIT_FILE = WEB_UNIT
