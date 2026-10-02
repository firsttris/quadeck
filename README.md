# Quadeck

Selbst-konfigurierendes Dashboard für Podman-Server mit Quadlets. Quadeck zeigt Platten, Container, Quadlets und systemd-Units und verlinkt alle Services automatisch aus Caddy. Es wird als **ein einzelnes Binary** ausgeliefert, das als systemd-Service direkt auf dem Host läuft – kein Container-Image, keine Socket-Mounts.

- **Zero-Config:** Binary installieren, Dienst starten, Dashboard ist befüllt. Konfiguration überschreibt nur.
- **systemd ist die Wahrheit:** Ein Container mit Quadlet-Unit wird immer über systemd gesteuert (`systemctl start|stop|restart` per D-Bus), nie an systemd vorbei. Nur Container ohne Unit gehen über die Podman-API.
- **Privilegien gekapselt:** Alle Root-Aktionen laufen über `PrivilegedActions` mit fester Liste (Start, Stopp, Neustart). Keine beliebigen Befehle.

## Installation

```sh
sudo systemctl enable --now podman.socket
curl -fsSL https://raw.githubusercontent.com/firsttris/quadeck/main/install.sh | sudo sh
```

Das Skript erkennt Architektur und libc, lädt das passende Binary aus den GitHub Releases nach `/usr/local/bin`, prüft die SHA-256-Summe, richtet `quadeck.service` ein und gibt den Link zur Ersteinrichtung aus (`http://<host>:8484/setup?token=…`). Dort wird das Admin-Passwort festgelegt.

| Binary | Für |
| --- | --- |
| `quadeck-linux-x64-baseline` | alle x86-Server, auch NAS-CPUs ohne AVX2 |
| `quadeck-linux-arm64` | Raspberry Pi, ARM-Server |
| `quadeck-linux-x64-musl` | Alpine und andere musl-Distros |
| `quadeck-linux-arm64-musl` | Alpine auf ARM |

Ohne systemd (Alpine, Void, Artix) läuft das Dashboard, der systemd-Teil bleibt leer.

### Befehle

```
quadeck [serve]        Server starten (Standard)
quadeck setup-token    Token für die Ersteinrichtung ausgeben
quadeck passwd         Passwort zurücksetzen (neue Einrichtung über /setup)
quadeck update         Neueste Version laden, Prüfsumme prüfen, Dienst neu starten
quadeck print-unit     systemd-Unit ausgeben
quadeck version
```

### Konfiguration (optional)

Umgebungsvariablen, z. B. in `/etc/quadeck/quadeck.env`:

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `QUADECK_HOST` / `QUADECK_PORT` | `0.0.0.0` / `8484` | Adresse und Port |
| `QUADECK_DATA_DIR` | `/var/lib/quadeck` | SQLite-Datenbank, Icon-Cache, Setup-Token |
| `QUADECK_READONLY` | `false` | Keine Aktionen am Server (Start/Stopp/Neustart); Dashboard-Layout und Links bleiben änderbar |
| `QUADECK_PODMAN_SOCKET` | `/run/podman/podman.sock` | Podman-API |
| `QUADECK_CADDY_ADMIN` | `http://localhost:2019` | Caddy-Admin-API |
| `QUADECK_CADDYFILE` | `/etc/caddy/Caddyfile` | Fallback, wenn die API nicht erreichbar ist |
| `QUADECK_SMB_CONF` | `/etc/samba/smb.conf` | SMB-Freigaben |
| `QUADECK_EXPORTS` | `/etc/exports` | NFS-Freigaben (dazu `/etc/exports.d/*.exports`) |
| `QUADECK_TRUSTED_PROXIES` | `127.,::1` | IP-Präfixe von Reverse-Proxys, deren `X-Forwarded-For` gilt (z. B. `10.88.` für Caddy in rootful Podman) |
| `QUADECK_PUBLIC_URL` | – | Öffentliche URL, falls ein Proxy den `Host`-Header umschreibt |

## Wie Services erkannt werden

1. **Caddy** liefert die öffentliche URL jedes Service: zuerst über die Admin-API (`GET /config/`), sonst über `caddy adapt`, sonst über einen eingebauten Caddyfile-Leser (für Caddy im Container).
2. Der **Upstream** (`jellyfin:8096`, `localhost:8096`) wird über Container-Name, Netzwerk-Alias, Container-IP oder veröffentlichten Port einem Podman-Container zugeordnet. Externe Ziele bleiben eigene Kacheln, es wird nie geraten.
3. Das Label **`PODMAN_SYSTEMD_UNIT`** verbindet den Container mit seiner Quadlet-Unit.
4. **Labels in der Quadlet-Datei** überschreiben die Erkennung:
   ```ini
   [Container]
   Label=quadeck.name=Jellyfin
   Label=quadeck.group=Medien
   Label=quadeck.icon=jellyfin          # Slug aus dashboard-icons, oder glyph:play
   Label=quadeck.url=https://jf.example.de
   Label=quadeck.hidden=true
   ```
5. **Overrides** aus der Datenbank haben die höchste Priorität.

Eigene Links zu Geräten ohne Quadlet (Router, Drucker, andere Hosts) legt man im Dashboard über „Link hinzufügen“ an; sie stehen in derselben Karte wie die erkannten Services.

Im Bearbeiten-Modus öffnet ein Klick auf eine Kachel den Dialog **Service bearbeiten**: Name, Gruppe, URL und Icon (Suche über die dashboard-icons-Sammlung) überschreiben die Erkennung, leere Felder folgen ihr weiter. Dazu Anpinnen und Ausblenden; ausgeblendete Services lassen sich in der Bearbeiten-Leiste wieder anzeigen. Eigene Links werden im selben Dialog direkt bearbeitet.

## Befehlspalette

**Strg+K** (⌘K) oder „Suchen“ in der Seitenleiste: Services öffnen, zu Seiten springen, Units neu starten oder stoppen (mit der üblichen Bestätigung) und ihr Journal öffnen.

## Freigaben

Die Karte „Freigaben“ liest SMB-Shares aus `smb.conf` (Pfad, lesen oder lesen/schreiben, Gast, `valid users`) und NFS-Exports aus `/etc/exports` und `/etc/exports.d` (Clients, `ro`). Quadeck liest die Dateien nur.

## Layout anpassen

Das Dashboard ist beim ersten Start fertig angeordnet. Mit **Bearbeiten** (oder Taste `E`) lässt es sich auf zwei Ebenen ändern:

- **Karten** (CPU, RAM, Temperatur, Netz, Services, Speicher, Timer): am Griff verschieben, an der Ecke unten rechts vergrößern oder verkleinern, ausblenden und wieder einblenden.
- **Kacheln** in der Services-Karte: innerhalb ihrer Gruppe verschieben und vergrößern (z. B. Jellyfin als 2×2-Kachel). Die Gruppe einer Kachel legt das Label `quadeck.group` fest.

Das Layout wird pro Bildschirmbreite (Desktop, Tablet, Handy) in SQLite gespeichert. Karten passen ihre Höhe automatisch an den Inhalt an, bis man sie selbst in der Größe ändert. „Auf Auto-Layout zurücksetzen“ stellt den Ausgangszustand wieder her.

**Icons** kommen aus [dashboard-icons](https://github.com/homarr-labs/dashboard-icons) (Kandidaten aus Image-Name, Unit-Name und Caddy-Host, inklusive Aliasen wie `ha` → `home-assistant`) und werden unter `/var/lib/quadeck/icons` zwischengespeichert. Ohne Treffer: Favicon des Service, danach ein neutrales Kategorie-Icon.

**Health:** Podman-Healthcheck, wenn vorhanden; sonst `HEAD` auf die Service-URL alle 60 s.

## Sicherheit

Quadeck besteht aus zwei Diensten:

- **`quadeck.service`** – die Web-App, als eigener Systembenutzer `quadeck` **ohne Root-Rechte**. Sie liest alles, was ohne root geht (systemd über D-Bus, Journal über die Gruppe `systemd-journal`, Platten, Freigaben).
- **`quadeck-helper.service`** – ein kleiner **Root-Helfer** mit fester Aktionsliste (Units starten/stoppen/neu starten, Podman lesen und Container ohne Unit steuern). Er lauscht nur auf `/run/quadeck/helper.sock`, den ausschließlich die Gruppe `quadeck` öffnen kann.

**Entsperren:** Aktionen am Server sind gesperrt, bis man sie mit dem Passwort eines Administrators (root oder Mitglied von `wheel`/`sudo`) freischaltet – dann für 15 Minuten, mit Countdown in der Seitenleiste. Die Prüfung (gegen `/etc/shadow` mit dem System-`crypt(3)`) und die Sperre sitzen im Helfer: Selbst eine übernommene Web-App kann ohne dieses Passwort nichts verändern.

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `QUADECK_UNLOCK` | `system` | `system`: Linux-Admin-Passwort · `none`: ohne Entsperren · `quadeck`: Quadeck-Passwort (nur wenn alles als root in einem Prozess läuft) |
| `QUADECK_UNLOCK_MINUTES` | `15` | Dauer der Freischaltung |
| `QUADECK_HELPER_SOCKET` | `/run/quadeck/helper.sock` | Socket des Helfers |

Ältere Installationen (alles als root in einem Dienst) laufen weiter; `install.sh` erneut ausführen stellt auf die Trennung um.

Außerdem:

- Login ab der ersten Version (argon2id). Die Ersteinrichtung braucht einen Setup-Token, den nur root lesen kann.
- Sitzungs-Cookie `HttpOnly`, `SameSite=Strict`; gespeichert wird nur ein Hash.
- CSRF-Schutz: jede schreibende Anfrage muss von derselben Herkunft kommen und den CSRF-Token der Sitzung mitsenden. Gefährliche Aktionen brauchen eine Bestätigung.
- Begrenzte Anmeldeversuche; Logout und Passwortwechsel beenden auch offene Live-Streams.
- Feste Aktionsliste, Unit-Namen werden geprüft; alle Prozesse werden ohne Shell gestartet.
- Read-only-Modus per `QUADECK_READONLY=true`: keine Eingriffe in systemd oder Podman.

**Nicht ungeschützt ins Internet stellen.** Quadeck ist für das LAN gedacht; von außen nur hinter VPN oder einem Reverse-Proxy mit zusätzlicher Authentifizierung.

## Entwicklung

```sh
bun install
QUADECK_DATA_DIR=.data QUADECK_FIXTURES=fixtures/demo bun run dev   # mit Beispieldaten
bun run typecheck
bun run test          # Vitest: Parser, Merge-Logik, Auth
bun run test:e2e      # Playwright gegen den Produktions-Build mit Fixtures
bun run compile       # Binary für die eigene Plattform nach ./release
```

Stack: Bun, TanStack Start, SQLite (`bun:sqlite`) + Drizzle, Tailwind, Server-Sent Events. Schemaänderungen: `src/server/db/schema.ts` anpassen, dann `bun run db:generate`.

Aufbau:

```
src/main.ts                 Binary-Einstieg: CLI, Bun.serve, statische Assets
src/server/collectors/      system, disks, podman, systemd
src/server/providers/       Discovery (Caddy); Schnittstelle für Traefik u. a.
src/server/privileged/      PrivilegedActions (D-Bus); später ein getrennter Root-Helfer
src/server/registry.ts      Merge: Caddy-Route → Container → Unit → Labels → Overrides
src/server/hub.ts           Intervalle, Snapshot, SSE-Push
src/routes/                 UI (Übersicht, Units, Journal) und /api-Routen
```

## Stand

v0.1 (MVP) laut Implementierungsplan: Collectors, Service-Kacheln mit Icons und Health-Checks, manuelle Links, Unit- und Container-Aktionen über systemd, Login und CSRF-Schutz, Standard-Layout, Live-Journal, Installationsskript und `update`-Befehl, CI und Release-Builds für vier Targets.

v0.2: Bearbeiten-Modus mit react-grid-layout (Karten und Kacheln), Services bearbeiten (Overrides, Icon-Picker, Ausblenden), Befehlspalette, Freigaben (SMB/NFS).

Noch nicht enthalten (v0.2/v0.3): SMART/SnapRAID, Forward-Auth, Quadlet-Editor, Timer-Editor, Image-Updates, rootless Quadlets, getrennter Root-Helfer.
