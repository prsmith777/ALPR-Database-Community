# Automated Community bootstrap

The bootstrap prepares a supported host and then hands control to the guarded
Community installer or migration wizard. It has three modes:

- **New installation** installs prerequisites, checks out the newest exact
  stable release, and starts `./alpr-community install`.
- **Migration preparation** installs the additional PostgreSQL 17, SSH, and
  `rsync` tools, checks out a separate target, and prints the automated wizard
  command.
- **Compatibility check** is read-only and reports missing requirements without
  changing packages, Docker, or ALPR.

## Supported automatic paths

Automatic package installation supports a normal, non-root account with
internet access and `sudo` rights on this explicit x86-64 matrix:

| Package family | Automatic releases |
| --- | --- |
| Ubuntu | 22.04 LTS (Jammy), 24.04 LTS (Noble), 26.04 LTS (Resolute) |
| Debian | 12 (Bookworm), 13 (Trixie) |
| Red Hat Enterprise Linux | Current, fully patched releases in major versions 8, 9, and 10 |
| Rocky Linux and AlmaLinux | Current, fully patched releases in major versions 8, 9, and 10 |
| CentOS | Stream 9 and Stream 10 |
| Fedora | 43 and 44; supported by the adapter, but not recommended for a long-lived server because of Fedora's short support cycle |

Release CI executes the real base-package adapter in disposable Ubuntu 24.04,
Debian 12, Rocky Linux 9, and AlmaLinux 9 containers. The other rows have OS
routing coverage but are not represented as complete clean-host installations;
container checks also cannot reproduce systemd, SELinux enforcement, or a
first-login Docker group transition. Ubuntu Server 24.04 is the recommended and
most thoroughly exercised target.

ARM is not supported. A version outside this table receives only the read-only
compatibility check and manual prerequisite guidance. The VM or physical host
should have:

- 4 logical CPUs and an 8 GiB allocation recommended (2 CPUs and a 4 GiB
  allocation are minimums; Linux must report at least 3500 MiB usable RAM);
- 100 GiB disk recommended, with at least 20 GiB free before application data;
- at least 10 GiB free on Docker's data-root filesystem;
- local Linux storage for the checkout and bind mounts; and
- outbound HTTPS access to GitHub, Docker, Node.js, the Yarn registry, and the
  OpenVINO model host.

The physical hypervisor does not matter. Supported Linux guests on Unraid,
Proxmox, VMware, Hyper-V, VirtualBox, TrueNAS, and other VM platforms use the
same path.

## Download and verify

Download the bootstrap and its checksum from the latest Community release. Do
not pipe a remote script directly into a shell.

```bash
alpr_bootstrap() (
  set -Eeuo pipefail
  command -v curl >/dev/null || {
    if command -v apt-get >/dev/null; then sudo apt-get update && sudo apt-get install -y curl
    elif command -v dnf >/dev/null; then sudo dnf -y install curl
    else echo "Install curl with this distribution's package manager first." >&2; exit 1; fi
  }
  release_url="$(curl -fLsS -o /dev/null -w '%{url_effective}' \
    https://github.com/prsmith777/ALPR-Database-Community/releases/latest)"
  release_tag="${release_url##*/}"
  [[ "${release_tag}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]
  download_dir="$(mktemp -d)"
  trap 'rm -rf -- "${download_dir}"' EXIT
  asset_base="https://github.com/prsmith777/ALPR-Database-Community/releases/download/${release_tag}"
  curl -fLsS --retry 3 "${asset_base}/alpr-community-bootstrap.sh" -o "${download_dir}/alpr-community-bootstrap.sh"
  curl -fLsS --retry 3 "${asset_base}/alpr-community-bootstrap.sh.sha256" -o "${download_dir}/alpr-community-bootstrap.sh.sha256"
  (cd "${download_dir}" && sha256sum --check --strict alpr-community-bootstrap.sh.sha256)
  bash "${download_dir}/alpr-community-bootstrap.sh" --release "${release_tag}" "$@"
)
alpr_bootstrap --new
unset -f alpr_bootstrap
```

The function stops before execution if release discovery, either download, or
checksum validation fails. It passes the same published release tag into the
bootstrap, so a newer tag cannot be selected between download and checkout.
The block above starts a new installation directly. For another task, replace
the `alpr_bootstrap --new` invocation near the end with one of:

```bash
alpr_bootstrap --new
alpr_bootstrap --migrate
alpr_bootstrap --check new
alpr_bootstrap --check migration
```

Run `alpr_bootstrap` without an option only when you want the explanatory menu.
Invalid menu choices are shown again instead of terminating the bootstrap.

Use `--release vMAJOR.MINOR.PATCH` to select an exact stable release and
`--install-dir /absolute/path` to choose the target directory. `--dry-run`
prints package and repository changes without applying them.

### Retry after the v0.1.36 early-checkout failure

Bootstrap v3 in release v0.1.36 could stop immediately after creating Git
metadata without checking out files. That state cannot be distinguished with
certainty from a user who deliberately staged deletion of every tracked file.
Current bootstraps therefore refuse to overwrite or automatically repair it.
Review the reported directory and preserve it by moving the entire directory
aside, then rerun the current fail-closed download block. Do not remove or
reset an ambiguous checkout merely to satisfy the bootstrap.

Any checkout containing runtime state, staged changes, a different origin, or
other modifications fails closed and requires manual review.

## What it installs

For both install paths, the bootstrap installs or validates:

- Git;
- Docker Engine from Docker's signed repository for the detected Debian,
  Ubuntu, RHEL-compatible, CentOS, or Fedora family;
- Docker Compose v2 and Docker Buildx;
- CA certificates, `curl`, GnuPG, and archive utilities; and
- a checksum-verified Node.js 24 runtime private to the ALPR account.

Migration preparation also installs PostgreSQL 17 `psql`, `pg_dump`, and
`pg_restore` from the PostgreSQL project's APT or RPM repository, plus `rsync`
and the OpenSSH client. The launcher detects both Debian-style and RPM-style
PostgreSQL 17 binary locations. Migration preparation does not modify the
source installation, create a dump, create the target database, or switch
traffic.

OpenVINO, ReID, and the pinned visual models are application-image components,
not host prerequisites. Every newly built ALPR image must perform real CPU
inference with all three models before installation or update continues.

## Safety boundaries

The bootstrap refuses root execution, ARM hosts, insufficient resources,
unsafe network filesystems, conflicting container packages, a dirty or
noncanonical checkout, and any target that already contains an ALPR
installation. It never removes Docker packages, containers, volumes, images,
or an existing ALPR directory.

Image builds use a dedicated temporary BuildKit builder. Its cache is removed
after each success or failure while the final versioned image remains. The
installer and updater never invoke a broad Docker prune.

The bootstrap reuses a complete working Docker installation. If Docker is
partial, vendor-packaged, or conflicts with Docker CE, it stops instead of
removing or replacing packages. On Fedora, heed the short-lifecycle warning;
for a long-lived ALPR server, a supported LTS or enterprise distribution is
the better choice. Docker must be a local Linux x86-64 daemon reached through a
Unix socket; SSH and TCP contexts are rejected because bind paths would resolve
on the daemon host rather than on the ALPR host.

For unsupported distributions and existing systems, use the
[compatibility paths](COMPATIBILITY.md). Fresh-install details continue in
[INSTALL.md](INSTALL.md); migrations continue in
[MIGRATION_GUIDE.md](MIGRATION_GUIDE.md).
