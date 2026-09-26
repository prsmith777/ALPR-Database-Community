# Automated existing-system migration

The Community migration wizard moves a supported existing ALPR database and
image library into a separate PostgreSQL 17 Community target. It creates the
target, remembers completed checkpoints, verifies the database and files, and
starts an outbound-isolated application for review.

The wizard never switches traffic and does **not** stop or delete the old
system. It also does not change
DNS, a reverse proxy, router rules, VM settings, or the old application's
service definition. Those boundaries require the operator because the correct
commands differ by deployment.

Supported database sources are:

- Original ALPR Database v0.1.9-compatible on PostgreSQL 13 or 17;
- ALPR Database Community v0.1.20 or newer on PostgreSQL 13 or 17.

An older Original ALPR installation must first update its database to the
pinned v0.1.9 baseline. Unknown or partially updated schemas fail before a dump
is created. The maintainer acceptance matrix covers exact Community v0.1.20,
v0.1.21, and v0.1.22 sources on PostgreSQL 13 and 17.

## Recommended target

Use a separate host or VM from the automatic x86-64 Linux matrix in
[Host compatibility](COMPATIBILITY.md); Ubuntu Server 24.04 LTS remains the
simplest recommended target. Download and verify the release bootstrap as
described in [Automated Community bootstrap](BOOTSTRAP.md), then choose
**Prepare migration from an existing ALPR installation**. It selects the APT
or RPM adapter, installs Git, Docker Engine, Compose, Buildx, private Node.js
24, PostgreSQL 17 clients, `rsync`, and OpenSSH, and checks out an exact stable
release.

The target needs access to the source PostgreSQL endpoint. If the old database
is bound only to loopback, use an authenticated SSH tunnel or another narrowly
scoped private connection; do not expose PostgreSQL to the internet. Image
storage can be a local/mounted absolute path or an SSH `rsync` source. SSH use
requires key-based access and a verified host key.

Run the wizard from the prepared target checkout:

```bash
cd ~/alpr-community-target
./alpr-community migrate wizard
```

The interactive wizard asks for:

- source PostgreSQL host, port, database, user, password, and SSL mode;
- a new Community administrator password, time zone, application port, and
  local database port;
- either a locally mounted source image-storage path,
  `user@host:/absolute/storage`, or confirmation that no image files exist.

Passwords are never written to wizard state. The database and administrator
passwords remain private. The
generated target database password is kept only in the owner-readable target
`.env`. If the command must be resumed in a later terminal, the source database
password is requested again.

## What the wizard automates

The wizard performs these guarded stages:

1. Verifies the exact canonical release, Linux x86-64 host, Node.js 24, Docker,
   Compose, Buildx, available ports, free space, and clean target resources.
2. Generates the target database credential, builds the commit-qualified
   runtime image, creates private runtime directories, starts PostgreSQL 17,
   and recreates its application database from `template0` as an empty target.
3. Identifies the supported source schema and proves the target is distinct
   and empty.
4. Pauses until the operator stops the source application, ingestion, jobs,
   and every other database writer.
5. Creates a PostgreSQL custom-format dump and manifest, proving the source
   schema, public-table inventory, and row counts did not change during it.
6. Restores transactionally, applies current migrations transactionally,
   reconciles derived occurrence counts, and compares every source table count
   with the target.
7. Copies local or SSH image storage with resumable `rsync`, then runs a
   checksum dry comparison that must report no differences.
8. Starts the target on a Docker network marked `internal`, verifies public
   health and the exact runtime image, restarts the application and database,
   and verifies health again.
9. Stops at browser review. It never treats automated checks as permission to
   cut over.

The isolated Docker network prevents SMTP, MQTT, webhook, Pushover, Blue Iris,
and other outbound connections while migrated settings are reviewed. The
published application port remains available from the target host or LAN.

## Source-stop checkpoint

When prompted, stop the old ALPR application and all database writers. Keep its
database and image storage intact and leave the writers stopped through target
acceptance. Type the exact acknowledgement printed by the wizard:

```text
ALPR_SOURCE_QUIESCED
```

For non-interactive operation, set the value only after the stop is complete:

```bash
export ALPR_MIGRATION_SOURCE_QUIESCED=ALPR_SOURCE_QUIESCED
./alpr-community migrate wizard resume
```

This acknowledgement does not stop anything itself.

## Browser review and acceptance

After automated checks pass, open the printed target address and verify:

- administrator sign-in works;
- dashboard totals, database search, tags, roles, and audit history are
  plausible;
- representative plate and vehicle images display;
- a controlled non-sensitive plate read can be ingested and found;
- the legacy image-migration page appears only when the source marker says the
  old migration was unfinished.

Then accept the isolated target:

```bash
export ALPR_MIGRATION_ACCEPTANCE=ALPR_MIGRATION_ACCEPTED
./alpr-community migrate wizard accept
```

Acceptance rechecks the unchanged source and verified dump needed for rollback.
It does not enable outbound networking or switch live traffic.

## Activation and service cutover

Before activation, review every integration and notification setting and plan
the host-specific traffic change. The wizard first proves that the stopped
source and retained dump still match. Activating then replaces only its
internal Docker network with the standard Community network, reruns the
idempotent migration service, and verifies health:

```bash
export ALPR_MIGRATION_ACTIVATION=ALPR_ACTIVATE_MIGRATED_TARGET
./alpr-community migrate wizard activate
```

Activation allows configured outbound integrations to operate. It still does
not change DNS, reverse proxies, router rules, or source services. Perform that
final host-specific cutover only after the activation health check passes.
If activation validation fails, the wizard attempts to return the target to
its outbound-isolated network and records whether that safety recovery
succeeded. Do not cut over when the wizard reports an activation failure.

## Resume, status, and recovery

Successful stages are not repeated:

```bash
./alpr-community migrate wizard status
./alpr-community migrate wizard resume
```

If restore or migration fails, `resume` recreates only the wizard-owned
disposable target database, retains a previously verified dump, rewinds the
target restore/validation checkpoints, and tries them again. It never repairs
or rewrites the stopped source.

The default owner-readable state is
`~/.local/state/alpr-community/migration-wizard.json`; set an absolute
`ALPR_MIGRATION_WIZARD_STATE_PATH` to choose another private location. Dumps,
manifests, and guided database state default below
`~/.local/share/alpr-community/migrations/`. All remain outside the Git
checkout.

If target preparation fails before acceptance, guarded recovery removes only
the recorded target Compose project, volumes, private `.env`, runtime
directories, and a wizard-created image. It retains the old source and private
dump artifacts:

```bash
export ALPR_MIGRATION_RECOVERY=ALPR_RECOVER_MIGRATION_TARGET
./alpr-community migrate wizard recover
```

Recovery refuses an accepted target or a `.env` modified after creation.

## Non-interactive configuration

Automation can set these values privately rather than answering prompts:

```text
ALPR_INSTALL_ADMIN_PASSWORD
ALPR_INSTALL_TIMEZONE
ALPR_INSTALL_APP_PORT
ALPR_INSTALL_DB_PORT
ALPR_INSTALL_PROJECT_NAME

ALPR_MIGRATION_SOURCE_HOST
ALPR_MIGRATION_SOURCE_PORT
ALPR_MIGRATION_SOURCE_DATABASE
ALPR_MIGRATION_SOURCE_USER
ALPR_MIGRATION_SOURCE_PASSWORD
ALPR_MIGRATION_SOURCE_SSLMODE
```

Choose exactly one storage input:

```text
ALPR_MIGRATION_SOURCE_STORAGE_PATH=/absolute/local/or/mounted/storage
ALPR_MIGRATION_SOURCE_STORAGE_SSH=user@source-host:/absolute/storage
ALPR_MIGRATION_NO_STORAGE=ALPR_NO_IMAGE_STORAGE
```

`ALPR_MIGRATION_ARTIFACT_DIR` and `ALPR_MIGRATION_WIZARD_STATE_PATH` are
optional absolute paths outside the repository. Do not put passwords in shell
history, screenshots, support tickets, or Git.

## Rollback retention

Keep the stopped source, its matching application and image storage, the dump,
manifest, and wizard state until the observation window closes. If the target
fails after cutover, stop its application, return traffic to the unchanged
source, and restart the old application using the source platform's service
controls. The wizard never deletes the rollback source.

## Advanced guided interface

The earlier redacted checkpoint assistant remains available for unusual
external-database or cross-platform arrangements:

```text
./alpr-community migrate start
./alpr-community migrate resume
./alpr-community migrate status
./alpr-community migrate accept
./alpr-community migrate rollback-check
```

That lower-level interface does not create the target, copy storage, start the
application, activate networking, switch traffic, or delete anything. See
[Community deployment](DEPLOYMENT.md) for its full environment contract.

Maintainers can reproduce the supported clean-history database matrix with:

```bash
npm run test:community-upgrades
```

The harness uses disposable containers on random loopback ports and removes
its private temporary dumps and containers after success or failure. It never
discovers or changes an installed ALPR system.
