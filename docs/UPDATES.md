# Updating ALPR Database Community

The Community host updater is for standard Linux systems that run the bundled
Docker Compose stack. Ubuntu, Debian, Fedora, other Docker-capable Linux
distributions, and Unraid are examples. Unraid is not required. The updater
runs on the host and the application container never receives the Docker
socket or unrestricted host access.

Linux virtual machines are supported regardless of whether the VM runs on
Proxmox, VMware, Hyper-V, VirtualBox, Unraid, TrueNAS, or another hypervisor.
The updater evaluates the Linux guest and its Docker Compose installation; it
does not depend on or control the underlying VM host.

Windows Docker installations are not supported by this first updater release.
A PowerShell launcher and Windows-specific path validation are planned. Do not
run the Linux updater through WSL against a Windows Docker installation.

## Requirements

- a Linux x86-64 host with Docker Engine, Docker Compose, and Docker Buildx;
- Git and Node.js 24 on the host, or the private Node.js 24 runtime installed
  by the Community bootstrap;
- the canonical `prsmith777/ALPR-Database-Community` repository;
- an installation checked out at an exact stable `vMAJOR.MINOR.PATCH` tag;
- no tracked local source changes;
- the bundled `app`, `db`, and `migrate` Compose services running from
  `docker-compose.yml`;
- enough free space for one compressed PostgreSQL dump plus 512 MiB of
  headroom.

The first release does not update external-database deployments, Compose
override files, Kubernetes installations, Docker Desktop on Windows, Synology
Container Manager, or QNAP Container Station. Those platforms need dedicated
adapters because their service control, paths, and recovery behavior differ.

## Install the current release

New installations should clone the repository and check out the release tag
shown on the GitHub Releases page, rather than deploying moving `main`:

```bash
git clone https://github.com/prsmith777/ALPR-Database-Community.git
cd ALPR-Database-Community
git checkout --detach v0.1.35
./alpr-community install
```

The guided installer collects the administrator password, generates the
database password, creates the private runtime directories, builds a
commit-qualified image, initializes PostgreSQL 17, and proves the empty
installation is healthy. Follow the complete
[fresh-install guide](INSTALL.md). The updater included in the release handles
later Community-to-Community updates.

Do not install v0.1.23 as a new deployment merely because it was the first
release containing the updater. A retained installation already running exact
v0.1.23 can update directly to the newest stable tag with the guarded workflow
below.

## Browser update page

Release v0.1.29 adds **Settings → Software Updates** for administrators. The
page can check, install, validate, accept, roll back, and clean up an expired
rollback generation. It does not run Git, Docker, or a shell inside the web
container. Instead, it places a versioned, fixed-operation request in the
private `update-control/` bind mount for a restricted worker running as the
normal installation owner on the Linux host.

On a systemd-based Linux host, install that worker once:

```bash
cd /path/to/ALPR-Database-Community
./alpr-community agent install
sudo loginctl enable-linger "$USER"
./alpr-community agent status
```

The linger setting lets the per-user service start after a reboot without an
interactive login. On a Linux host without systemd, run
`./alpr-community agent run` under the host's existing service supervisor.
The page stays disabled while the agent heartbeat is absent. Requests expire
after five minutes so an abandoned request cannot unexpectedly run after a
much later restart.

Every mutating page action remains explicit. Installation requires typing the
exact target release, acceptance requires all manual-check boxes, rollback
requires typing `ROLL BACK AND DISCARD NEW WRITES`, and cleanup requires its
own typed confirmation. The agent accepts no arbitrary command, argument, or
filesystem path from the browser.

## Guided menu

From the installation directory, open the maintenance menu:

```bash
./alpr-community
```

The menu can check for a newer stable release, install it, repeat validation,
accept it, roll it back, or remove an expired rollback generation. A check is
read-only except for fetching Git tags. Installation always shows the exact
source and target tags before it asks for confirmation.

The equivalent individual commands are:

```text
./alpr-community check
./alpr-community update
./alpr-community validate
./alpr-community accept
./alpr-community rollback
./alpr-community cleanup
./alpr-community status
```

Run `./alpr-community check` to discover the newest stable release and
`./alpr-community update` to select it through the guided menu. A retained
exact-v0.1.23 installation can use
`./alpr-community update --to v0.1.35` to select this release explicitly. The
updater refuses `latest`, branches, prereleases, tags that are not on canonical
`origin/main`, and a tag whose package version does not match. It fetches
canonical `main` explicitly, so verification also works when the installation
was originally cloned with a tag-only Git refspec.

## What installation does

The guarded workflow:

1. proves the checkout is a clean exact tag from the canonical repository;
2. proves the configured and running app images agree;
3. checks the bundled app and PostgreSQL services;
4. stops the app so the logical backup has no application writers;
5. records public-table row counts and the image-storage file/byte inventory;
6. creates a private compressed PostgreSQL dump plus copies of `.env`, `auth/`,
   and `config/` outside the source repository;
7. verifies and records the dump SHA-256 digest;
8. checks out the exact target tag and verifies its commit did not move;
9. builds a commit-qualified local image in an isolated temporary BuildKit
   builder, removes its cache, and runs real OpenVINO CPU inference with all
   bundled detection, attribute, and ReID models instead of using `latest`;
10. applies `migrations.sql` through the transactional Compose migration
    service;
11. starts the app and validates database readiness, the exact running image,
    `/api/health-check`, non-decreasing table counts, and storage inventory;
12. stops for manual acceptance.

The updater does not copy, archive, delete, or otherwise mutate `storage/`.
That directory can be much larger than the database and should be protected by
the operator's normal host or NAS backup. The updater only records its file
count and total bytes to detect unexpected loss during an update.

## Complete manual acceptance

Automated checks cannot prove the complete user workflow. Before accepting,
sign in and verify:

- Dashboard and Recognition Feed load;
- search returns expected records;
- a controlled test read can be ingested;
- stored plate and vehicle images display;
- roles and integrations needed by the installation still work;
- the application and database survive one controlled restart.

Then select **Accept update** in the menu. The updater retains the immediately
previous database/configuration backup and image for 14 days by default.
Set `ALPR_UPDATER_RETENTION_DAYS` to an integer from 1 through 90 to choose a
different window.

## Backup location and storage policy

The default private backup directory is
`../ALPR-Database-Community-backups`, next to the repository. Select a dedicated
backup disk or share by setting an absolute host path for the command:

```bash
ALPR_UPDATER_BACKUP_DIR=/srv/backups/alpr-community ./alpr-community
```

An Unraid operator can instead use a private share such as
`/mnt/user/backups/alpr-community`. This is only an example; ordinary Linux
paths are fully supported.

Only one accepted rollback generation is retained. The preceding generation
temporarily overlaps while a new update is being installed so that an
interruption cannot erase the last known-good recovery path. It is removed
after the new update is accepted. A failed or rolled-back update may retain
both generations until its explicit cleanup step. Manual cleanup removes only
paths and exact images recorded in the private state file. The updater never
invokes `docker system prune`, removes unrelated images, or deletes Docker
volumes.

## Rollback

Rollback is available after an apply or validation failure, while awaiting
acceptance, or during the retained rollback window. It:

1. verifies the saved dump checksum;
2. stops the updated application;
3. checks out the exact prior tag and verifies its recorded commit;
4. restores the prior `.env`, `auth/`, and `config/`;
5. transactionally replaces the application `public` schema and restores the
   pre-update PostgreSQL dump, including partitioned tables and extensions;
6. verifies the restored database directly without re-running migrations or
   introducing seed rows that were absent from the recorded source;
7. starts the prior app image;
8. verifies exact pre-update table counts and application health.

Rollback restores the database snapshot taken before the update. Any writes
made after that snapshot are discarded. Keep ingestion paused until the update
is accepted if preserving those writes is important.

If rollback itself stops, do not delete its private backup. Read
`./alpr-community status`, correct the reported host problem, and retry. The
state file records only phase codes and paths; it never records passwords or
command error text.

## Non-interactive use

The menu is recommended. Automation must supply the exact acknowledgement for
each mutating boundary:

```text
ALPR_UPDATE_ACKNOWLEDGE=ALPR_UPDATE_APPROVED
ALPR_UPDATE_ACCEPTANCE=ALPR_UPDATE_ACCEPTED
ALPR_UPDATE_ROLLBACK=ALPR_UPDATE_ROLLBACK
ALPR_UPDATE_CLEANUP=ALPR_UPDATE_CLEANUP
```

These acknowledgements prevent an unattended typo from installing, accepting,
rolling back, or deleting rollback assets. They are not passwords.
