# Updating ALPR Database Community

The Community host updater is for standard x86-64 Linux systems that run the
bundled Docker Compose stack. The automatic bootstrap supports the maintained
Ubuntu, Debian, RHEL, Rocky Linux, AlmaLinux, CentOS Stream, and Fedora
releases listed in [Host compatibility](COMPATIBILITY.md). Other Docker-capable
x86-64 Linux distributions can use the documented manual prerequisite path.
Unraid is only one possible host and is not required. The updater runs on the
Linux host or guest, and the application container never receives the Docker
socket or unrestricted host access.

Linux virtual machines are supported regardless of whether the VM runs on
Proxmox, VMware, Hyper-V, VirtualBox, Unraid, TrueNAS, or another hypervisor.
The updater evaluates the Linux guest and its Docker Compose installation; it
does not depend on or control the underlying VM host.

Windows Docker installations are not supported by the Linux updater. The
[native Windows preview](WINDOWS_NATIVE.md) has separate package verification,
native service control, backup, validation, acceptance, and rollback commands.
Browser installation and automatic Windows release discovery remain disabled
during preview acceptance. Do not run the Linux updater through WSL against
a Windows Docker installation.

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

The current updater does not update external-database deployments, Compose
override files, Kubernetes installations, Docker Desktop on Windows, Synology
Container Manager, or QNAP Container Station. Those platforms need dedicated
adapters because their service control, paths, and recovery behavior differ.

## Install the current release

New installations should clone the repository and check out the release tag
shown on the GitHub Releases page, rather than deploying moving `main`:

```bash
git clone https://github.com/prsmith777/ALPR-Database-Community.git
cd ALPR-Database-Community
git checkout --detach v0.1.47
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
v0.1.23 must use the one-time maintenance launcher below to reach the current
native release.

## One-time upgrade from v0.1.43 or earlier

**Do not use the older browser agent or terminal updater to cross into native
ReID.** Those versions keep old updater code loaded during installation and
incorrectly reject the derived tables intentionally retired by v0.1.43. Use the
verified current-release maintenance launcher below once. Fresh v0.1.44 or
later installations normally use the browser or terminal workflow.

If v0.1.43 already failed with **post-update row counts decreased**, do not accept
it, delete its backup, or edit recorded counts. On **Settings → Software Updates**,
use **Rollback** and type `ROLL BACK AND DISCARD NEW WRITES`. This restores the
previous application and its pre-update database; newer database writes are
discarded. Preserve anything needed before approving rollback. Wait for rollback
success and confirm the prior release works. If rollback fails, stop and retain
the backup for support.

Then SSH into the Linux installation host as its normal installation owner (not
root), change into the existing checkout, and run:

```bash
cd /path/to/ALPR-Database-Community
alpr_native_update() (
  set -Eeuo pipefail
  download_dir="$(mktemp -d /tmp/alpr-maintenance-download.XXXXXX)"
  trap 'rm -rf -- "$download_dir"' EXIT
  asset_base="https://github.com/prsmith777/ALPR-Database-Community/releases/download/v0.1.47"
  curl -fLsS --retry 3 "$asset_base/community-maintenance.sh" -o "$download_dir/community-maintenance.sh"
  curl -fLsS --retry 3 "$asset_base/community-maintenance.sh.sha256" -o "$download_dir/community-maintenance.sh.sha256"
  (cd "$download_dir" && sha256sum --check --strict community-maintenance.sh.sha256)
  bash "$download_dir/community-maintenance.sh"
)
alpr_native_update
unset -f alpr_native_update
```

The launcher verifies the canonical repository and exact released tag, loads the
fixed tools outside your checkout, and asks for **INSTALL v0.1.47**. It uses the
same guarded backup/install workflow and does not reset or reinstall your system.
It temporarily stops only this installation's matching per-user systemd update
agent, then restarts it with the installed code. Keep the terminal open and do
not operate the browser update controls meanwhile. If using a foreground or
non-systemd agent, stop that agent yourself first and restart it afterward.

When the launcher reports Technical system checks passed, refresh Software
Updates, complete the five real-use checks, and select **Accept update**.
Acceptance is not automatic. Neither is rollback or backup cleanup. The launcher
records the outcome in the browser's update state so it does not leave a stale
rollback result. Keep the backup if any step fails and share the error with
support; do not bypass checks.

The new validator records exact stopped-source retirement counts before backup.
Only explicitly retired derived tables and crop-unbound derived direction data
may decrease during the native transition; Blue Iris direction observations,
crop-bound examples, original records, and image storage remain protected.
Later native-to-native updates receive no historical retirement allowance.

## Browser update page

Release v0.1.29 adds **Settings → Software Updates** for administrators. The
page guides administrators through **Check → Install → Technical system checks
→ Accept**, and also provides guarded rollback and expired-backup cleanup. It
does not run Git, Docker, or a shell inside the web
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
exact target release, acceptance requires all five real-use checkboxes, rollback
requires typing `ROLL BACK AND DISCARD NEW WRITES`, and cleanup requires its
own typed confirmation. The agent accepts no arbitrary command, argument, or
filesystem path from the browser.

Installation automatically runs **Technical system checks** for database
readiness, the exact running image, application health, protected row counts
(with the narrowly recorded native retirement allowance), and storage inventory.
Passing those checks does not accept the
release. The page then displays **Update installed — acceptance required** at
the top. Test the five real-use items and select **Accept update** to finish.
The page blocks checking for or installing another release while an update is
unfinished, so a newer release is never offered as an installable action over
an unaccepted one. **Run Technical system checks again** is a troubleshooting
action, not a normal extra step.

## Guided menu

From the installation directory, open the maintenance menu:

```bash
./alpr-community
```

The menu can check for a newer stable release, install it, repeat Technical
system checks, accept it, roll it back, or remove an expired rollback
generation. A check is
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
`./alpr-community update` to select it through the guided menu after the
one-time transition. The `--to` option accepts an exact newer stable tag;
older installations must use the maintenance launcher above instead. The
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
   builder, removes that builder, and runs real OpenVINO CPU inference with all
   bundled detection, attribute, and ReID models instead of using `latest`;
10. applies `migrations.sql` through the transactional Compose migration
    service;
11. starts the app and runs Technical system checks for database readiness, the exact running image,
    `/api/health-check`, protected table counts, and storage inventory;
12. stops for manual acceptance.

The pinned OpenVINO runtime download retries bounded transient DNS, timeout,
connection, rate-limit, and server failures. It never bypasses the size limit
or SHA-256 verification. If the image build or another apply step still fails
before database migration begins, the updater restores the exact previous tag,
private environment, and application container automatically. The database is
unchanged, so that recovery does not replace it with the backup. The failed
operation and private rollback artifacts remain recorded for diagnosis, and a
new update can be attempted after correcting the host network or DNS problem.

If a release older than v0.1.46 was performing the failed update, its already-
loaded updater may not contain this automatic recovery. Keep the backup and
use the guarded rollback action before retrying with the current maintenance
launcher. Do not delete updater state or edit the database manually.

The updater does not copy, archive, delete, or otherwise mutate `storage/`.
That directory can be much larger than the database and should be protected by
the operator's normal host or NAS backup. The updater only records its file
count and total bytes to detect unexpected loss during an update.

## Docker build cache

Removing the temporary BuildKit builder does not guarantee that every Docker
Engine and Buildx combination removes cache associated with loading the final
image. Repeated local builds can therefore increase the **Build Cache** value
reported by:

```bash
docker system df
```

Build cache is not the PostgreSQL database, image library, current application
image, or retained rollback image. On a VM or Docker host dedicated to ALPR,
after confirming that no install, migration, update, or other Docker build is
running, unused build cache can be removed with:

```bash
docker builder prune --all --force
```

Run `docker system df` and `df -h /` again afterward. The next image build may
take longer because dependencies must be downloaded or rebuilt. On a shared
Docker host, do not run this command without coordinating with the owners of
the other projects: it removes all unused build cache on that Docker daemon.
It does not replace the updater's rollback cleanup, and operators must not use
`docker system prune`, `docker image prune`, or `docker volume prune` as an
ALPR update step.

## Complete real-use acceptance

Technical system checks cannot prove the complete user workflow. Before accepting,
sign in and verify:

- Dashboard and Recognition Feed load;
- search returns expected records;
- a controlled test read can be ingested;
- stored plate and vehicle images display;
- roles and integrations needed by the installation still work;
- the application and database survive one controlled restart.

Then select **Accept update** on the page or in the menu. This is a separate
step from Technical system checks: it closes the current update and permits a
later release to be installed. The updater retains the immediately
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

Version 0.1.43 introduced native ReID V2; v0.1.44 fixes its update validation.
Use the one-time launcher above when leaving an older host. The updater stops the application,
verifies its backup, and applies the database upgrade before restart. It retires
obsolete derived identity indexes, not original plate reads or image files.
Eligible whole-vehicle images are processed in the background; Vehicle Setup
shows processing status. Recheck Vehicle Search, Profiles, feed navigation,
filters, pagination, and both image views before accepting. See
[Vehicle identity and upgrades](VEHICLE_IDENTITY.md) and
[Recognition Feed troubleshooting](REID_FEED_PERFORMANCE.md).
Do not run an older application against the upgraded database; rollback uses
the verified database/image recovery bundle and discards newer records.

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
