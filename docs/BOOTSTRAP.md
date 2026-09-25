# Automated Community bootstrap

The bootstrap prepares a supported host and then hands control to the guarded
Community installer or migration assistant. It has three modes:

- **New installation** installs prerequisites, checks out the newest exact
  stable release, and starts `./alpr-community install`.
- **Migration preparation** installs the additional PostgreSQL 17, SSH, and
  `rsync` tools, checks out a separate target, and prints the migration command.
- **Compatibility check** is read-only and reports missing requirements without
  changing packages, Docker, or ALPR.

## Supported automatic path

Automatic package installation currently supports a normal, non-root account
on **Ubuntu Server 24.04 LTS x86-64** with internet access and `sudo` rights.
ARM is not supported. The VM or physical host should have:

- 4 logical CPUs and 8 GiB RAM recommended (2 CPUs and 4 GiB are enforced
  minimums);
- 100 GiB disk recommended, with at least 20 GiB free before application data;
- local Linux storage for the checkout and bind mounts; and
- outbound HTTPS access to GitHub, Docker, Node.js, the Yarn registry, and the
  OpenVINO model host.

The physical hypervisor does not matter. Ubuntu guests on Unraid, Proxmox,
VMware, Hyper-V, VirtualBox, TrueNAS, and other VM platforms use the same path.

## Download and verify

Download the bootstrap and its checksum from the latest Community release. Do
not pipe a remote script directly into a shell.

```bash
command -v curl >/dev/null || { sudo apt-get update && sudo apt-get install -y curl; }
curl -fL https://github.com/prsmith777/ALPR-Database-Community/releases/latest/download/alpr-community-bootstrap.sh \
  -o alpr-community-bootstrap.sh
curl -fL https://github.com/prsmith777/ALPR-Database-Community/releases/latest/download/alpr-community-bootstrap.sh.sha256 \
  -o alpr-community-bootstrap.sh.sha256
sha256sum --check alpr-community-bootstrap.sh.sha256
less alpr-community-bootstrap.sh
bash alpr-community-bootstrap.sh
```

The release workflow creates both assets from the exact published tag. The
interactive menu offers all three modes. Direct commands are also available:

```bash
bash alpr-community-bootstrap.sh --new
bash alpr-community-bootstrap.sh --migrate
bash alpr-community-bootstrap.sh --check new
bash alpr-community-bootstrap.sh --check migration
```

Use `--release vMAJOR.MINOR.PATCH` to select an exact stable release and
`--install-dir /absolute/path` to choose the target directory. `--dry-run`
prints package and repository changes without applying them.

## What it installs

For both install paths, the bootstrap installs or validates:

- Git;
- Docker Engine from Docker's signed Ubuntu repository;
- Docker Compose v2 and Docker Buildx;
- CA certificates, `curl`, GnuPG, and archive utilities; and
- a checksum-verified Node.js 24 runtime private to the ALPR account.

Migration preparation also installs PostgreSQL 17 `psql`, `pg_dump`, and
`pg_restore`, plus `rsync` and the OpenSSH client. It does not modify the source
installation, create a dump, create the target database, or switch traffic.

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

For unsupported distributions and existing systems, use the
[compatibility paths](COMPATIBILITY.md). Fresh-install details continue in
[INSTALL.md](INSTALL.md); migrations continue in
[MIGRATION_GUIDE.md](MIGRATION_GUIDE.md).
