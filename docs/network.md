# Network

The **Netzwerk** page shows the network side of the server and changes nothing: interfaces,
listening ports with who is behind them, the firewall's view on those ports, routes and DNS. It
answers "why can't I reach it?" and "what is listening on 8080?" without a terminal. Three tabs:
**Schnittstellen** (interfaces, routes and DNS), **Ports** and **Firewall**.

<img src="screenshot-network.png" alt="Network page: interfaces, listening ports with program, unit or container, firewall verdicts, routes and DNS" width="900">

## Interfaces

Every interface with its kind (LAN, WLAN, VPN, bridge, container, loopback, virtual), state,
IPv4 and IPv6 addresses (DHCP marked), the gateway on it, link speed, MAC, MTU and the bytes
received and sent since boot. Loopback and container-side veth interfaces are hidden by default;
a checkbox shows them.

Source: `ip -j -d addr`, `/sys/class/net`; without iproute2, Node's own interface list.

## Ports

Everything listening on TCP or UDP (`ss -tulpn`, run by the root helper so process names are
available), IPv4 and IPv6 sockets of the same program merged into one row:

- **port** and protocol, with a name for well-known ports (SSH, SMB, NFS, DNS, mDNS, HTTP, …);
- **reach**: *alle Schnittstellen* (0.0.0.0 or ::), *nur dieser Rechner* (loopback only) or a
  specific address;
- **program**, with the systemd unit it belongs to (from the process's cgroup; links to the
  [unit editor](systemd.md)) or the container (from the libpod cgroup, or because Podman published
  the port). Published container ports usually have no socket of their own in rootful Podman, so
  they are added from the container list;
- **firewall**: see below.

*nur aus dem Netz erreichbare* hides the loopback-only rows.

## Firewall

Quadeck detects **firewalld** (default zone, services resolved to their ports, open ports) and
**ufw** (allow rules, app profiles). For every port that is reachable from the network it says:

| Verdict | Meaning |
|---|---|
| **offen** | the firewall allows it, or there is no firewall |
| **blockiert** | something listens, but the firewall drops connections from the network |
| **offen (Podman)** | a published container port; Podman adds its own forwarding rules |
| **unklar** | hand-written nftables rules with a drop policy; Quadeck does not interpret them |

Ports that are listening but blocked are listed in the firewall tab with the command to open
them (`firewall-cmd --permanent --add-port=… && firewall-cmd --reload` or `ufw allow …`).
Whether that is what you want is your call; often a blocked port is exactly right.

Without a firewall the card explains what that means at home: everything that listens on all
interfaces is reachable in the LAN, and from the internet only what the router forwards.

## Routes and DNS

Hostname, default gateways for IPv4 and IPv6 with the interface, DNS servers (behind
`systemd-resolved` the real upstream servers from `resolvectl`), search domains, and the full
routing table on request.
