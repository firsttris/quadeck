// The systemd unit, printed by `quadeck print-unit` (used by install.sh).
// Root is needed for systemd/Podman control; the rest is locked down.
export const UNIT_FILE = `[Unit]
Description=Quadeck – Dashboard für Podman und Quadlets
Documentation=https://github.com/firsttris/quadeck
Wants=network-online.target
After=network-online.target podman.socket

[Service]
Type=simple
ExecStart=/usr/local/bin/quadeck serve
Restart=on-failure
RestartSec=3
StateDirectory=quadeck
StateDirectoryMode=0700
UMask=0077
EnvironmentFile=-/etc/quadeck/quadeck.env
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=read-only
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectHostname=yes
RestrictRealtime=yes
LockPersonality=yes

[Install]
WantedBy=multi-user.target
`
