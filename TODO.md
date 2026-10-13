# Open points

Ideas that are not built yet, with what is known about them so far.

## Container image on Docker Hub

**Why:** people look for self-hosted apps on Docker Hub. Today Quadeck is only installed with
`install.sh` (binary from the GitHub releases), so it is hard to find.

**The catch:** Quadeck manages the host itself – `systemctl`, `journalctl`, `busctl`, `podman`,
the package manager, `smartctl`, and files like `/etc/fstab`, `smb.conf`, the Quadlet directory
and user accounts. Inside a normal container it would see the container's tools and `/etc`, not
the host's; `--privileged` alone does not change that.

**How it can work** (the way Cockpit's privileged container does it):

- run with `--privileged --pid=host` and a host directory mounted (e.g. `/var/lib/quadeck`)
- the entrypoint copies the right binary (glibc or musl, x64 or arm64 – same choice as
  `install.sh`) into that directory and starts it in the host's namespaces:
  `nsenter -t 1 -m -u -i -n -p -- /var/lib/quadeck/bin/quadeck serve`
- Quadeck then runs as on the host. As root it already does everything in one process
  (`src/server/privileged/index.ts`), so the app itself barely changes

**To do:**

- [ ] `quadeck:demo` image first: the app with the built-in demo data (`QUADECK_FIXTURES`), no host
      access at all – `docker run -p 8484:8484 …/quadeck:demo` to try it without risk; almost free
      and the best way to be found
- [ ] `quadeck:latest` image: Dockerfile with the release binaries, entrypoint script (~30 lines)
      that picks the binary and `nsenter`s into the host
- [ ] container mode: switch off the in-app self-update (`src/server/update.ts`) – the image is
      updated instead – and say so in the UI
- [ ] a ready-made Quadlet file (`quadeck.container`) so Quadeck can install itself as a Quadlet
- [ ] CI: build and push both images on every release (multi-arch); needs a Docker Hub account and
      a token as a GitHub secret (`DOCKERHUB_TOKEN`)
- [ ] docs: installation page section and the Docker Hub description, test on the distros of the
      install CI

**To say plainly in the description:**

- the container is root on the host – no isolation, it is a way of installing, not a sandbox
- the split into web app and root helper does not apply; everything runs as root
- needs Linux with systemd: not on Docker Desktop (Mac/Windows), limited on NAS systems without
  systemd (Unraid, Synology), as with the normal install
- most of Quadeck is about Podman and Quadlets; on a host with Docker only, much stays empty.
  Podman pulls from Docker Hub too, so the image still helps there

**Effort:** about half a day to a day, mostly testing across distros.
