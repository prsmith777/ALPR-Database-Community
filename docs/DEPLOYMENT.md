# Community deployment

The Community edition is intended for self-hosted x86-64 Linux systems and
Linux virtual machines. On Ubuntu Server 24.04, the verified release bootstrap
installs Git, Docker Engine, Compose, Buildx, and private Node.js 24, then runs
`./alpr-community install` for a
new empty installation. The guided installer verifies the canonical tagged
source, generates the database password, collects the administrator password
without echoing it, builds a commit-qualified image, and proves both health and
an empty database before completion. Follow the complete
[bootstrap guide](BOOTSTRAP.md) and [fresh-install guide](INSTALL.md).

The Docker build context explicitly excludes `.env` files, so host credentials
are not copied into image layers. Keep `.env.example` as the public template;
the installer writes the private `.env` with owner-only permissions.

The Compose files default to UTC and persist authentication state, application
configuration, logs, uploaded images, and PostgreSQL data. Keep `.env`, the
runtime data directories, and database backups out of source control.
The installer creates `auth/`, `config/`, `storage/`, and `update-control/`.
Application data paths are writable by container UID/GID `1000`; the restricted
update-control path is shared with the installing host account's primary group.
The installer refuses to reuse nonempty paths. These paths
are bind-mounted and intentionally do not come from the repository or image.
On startup, Compose waits for PostgreSQL's first-time schema initialization,
then applies `migrations.sql` in one transaction before it starts the app.
A newly initialized database is marked as not needing the legacy base64 image
migration and proceeds directly to the dashboard after first sign-in.

## Routine Community updates

Deploy an exact stable tag rather than moving `main`. Beginning with v0.1.23,
the repository includes a host-side updater for standard Linux Docker Compose
installations, including Linux virtual machines. Compatibility depends on the
Linux guest, Docker Engine, and Compose—not the physical server or hypervisor.
Unraid is one supported Linux example, not a requirement.

From v0.1.29, run `./alpr-community agent install` once on a systemd-based
Linux host, then use **Settings → Software Updates** to check, install,
validate, accept, roll back, or clean up an update. The terminal menu at
`./alpr-community` remains supported. The restricted agent keeps Docker host
access outside the application container, creates one private rollback
generation, uses commit-qualified images, and never copies the image-storage
library or invokes broad Docker pruning. Follow the complete
[Community update guide](UPDATES.md) before the first update.

Each new image is built with a dedicated temporary BuildKit builder whose cache
is removed after the build. The versioned runtime image remains available for
the updater's one-generation rollback policy. OpenVINO, ReID, and their pinned
models are bundled in that image and verified with real CPU inference; they are
not separate host installations.

The first updater release intentionally refuses external-database deployments,
Compose overrides, native Windows Docker, and appliance-managed container
stacks until their platform-specific service and recovery behavior is
implemented and tested.

## Import an existing ALPR database

The bundled database image is PostgreSQL 17.10. The guarded import helper
accepts validated PostgreSQL 13 and PostgreSQL 17 sources and always restores
into PostgreSQL 17. A PostgreSQL 13 data directory must never be started with
the PostgreSQL 17 image. The helper uses a logical dump instead of copying a
database volume between PostgreSQL versions.

The supported original-application baseline is
[**ALPR Database v0.1.9**](https://github.com/algertc/ALPR-Database/releases/tag/v0.1.9),
tag `v0.1.9`, commit
`aeb72baf6f0435c8d42ed07422f1b2f3a703e6ac`. Users of an earlier original
ALPR release must first update its database to the v0.1.9 schema. Do not use a
moving `main` checkout or assume the old `latest` container tag identifies a
release. The import preflight independently checks the v0.1.9 table, column,
and primary-key signature. It also accepts an existing Community v0.1.20 or
newer database carrying the Community baseline migration marker. An unknown or
partially updated schema is rejected before a dump is created.

Keep the complete source installation unchanged until the imported database,
application, and image storage have all passed validation. Rollback depends on
retaining that source and the verified logical dump.

On a separate supported Linux target, use the automated resumable wizard:

```text
./alpr-community migrate wizard
./alpr-community migrate wizard status
./alpr-community migrate wizard resume
./alpr-community migrate wizard accept
./alpr-community migrate wizard activate
```

It creates its own empty PostgreSQL 17 target, performs the guarded database
migration, copies and checksums local or SSH image storage, and validates an
outbound-isolated application plus restart persistence. It stops for an
operator-confirmed source shutdown and browser review, never stores passwords
in state, and never stops, switches, or deletes the retained source. Follow the
complete [automated migration runbook](MIGRATION_GUIDE.md).

For unusual external-database or cross-platform arrangements, the lower-level
guided assistant remains available:

```text
./alpr-community migrate start
./alpr-community migrate resume
./alpr-community migrate status
./alpr-community migrate accept
./alpr-community migrate rollback-check
```

This assistant stores redacted state outside the repository but deliberately
does not create the target, copy storage, or start the application.

The lower-level guarded migration helper remains available for diagnosis and
advanced automation:

```text
npm run migrate:database -- preflight
npm run migrate:database -- dump
npm run migrate:database -- restore
npm run migrate:database -- validate
npm run migrate:database -- rollback-check
```

Install the PostgreSQL 17 versions of `pg_dump`, `pg_restore`, and `psql`, or
set `ALPR_PG_BIN_DIR` to their directory. A PostgreSQL 17 client can dump the
supported PostgreSQL 13 and PostgreSQL 17 sources. Do not use a PostgreSQL 13
`pg_dump` client for this workflow.

Set the following in a private shell session or secret manager. Do not save
passwords in the repository:

```text
ALPR_MIGRATION_SOURCE_HOST
ALPR_MIGRATION_SOURCE_PORT
ALPR_MIGRATION_SOURCE_DATABASE
ALPR_MIGRATION_SOURCE_USER
ALPR_MIGRATION_SOURCE_PASSWORD
ALPR_MIGRATION_SOURCE_SSLMODE

ALPR_MIGRATION_TARGET_HOST
ALPR_MIGRATION_TARGET_PORT
ALPR_MIGRATION_TARGET_DATABASE
ALPR_MIGRATION_TARGET_USER
ALPR_MIGRATION_TARGET_PASSWORD
ALPR_MIGRATION_TARGET_SSLMODE
```

`ALPR_MIGRATION_DUMP_PATH` is also required and must be an absolute path
outside the repository. The dump contains private ALPR data. Store it on an
encrypted volume with restricted permissions and remove it according to your
backup-retention policy only after the rollback window closes.

The target must be a separate, empty PostgreSQL 17 database on a fresh volume.
Create it from `template0` where practical, and do not start the application or
run `schema.sql` against it before the restore.

The bundled `docker-compose-dbonly.yml` initializes `schema.sql`, so it is not
an empty restore target for this helper. Use a separately managed fresh
PostgreSQL 17 instance or an isolated raw PostgreSQL container for the target.

Stop plate ingestion, the source application, and every other source-database
writer before creating the dump; keep them stopped through database and
storage validation. After doing so, set:

```text
ALPR_MIGRATION_SOURCE_QUIESCED=ALPR_SOURCE_QUIESCED
```

`preflight` refuses a target with user relations, refuses a source and target
that identify the same database, and reports the detected application profile
and schema fingerprint. `dump` records that profile, the schema fingerprint, a
SHA-256 digest, and exact public-table row counts in a companion manifest.
`restore` proves the stopped source still has the same application profile,
schema, table inventory, and row counts; refuses a non-empty target; restores
without owner or ACL changes; and then applies the current `migrations.sql`.
The same migration transaction recalculates `plates.occurrence_count` from the
restored reads, including creating a missing aggregate row or resetting a stale
count to zero. Validation independently proves those derived counts agree.
Restore also requires this deliberate acknowledgement:

```text
ALPR_MIGRATION_ACKNOWLEDGE=ALPR_TO_PG17_EMPTY_TARGET
```

The logical restore and the current migrations each run transactionally. If
either phase fails, do not try to repair or reuse that target. Remove only the
disposable target database or volume, create another empty PostgreSQL 17
target, correct the reported cause, and rerun `restore`. The source and the
verified dump remain unchanged.

The restore includes the source database's `devmgmt` migration marker. An
installation with unfinished base64 image conversion therefore still opens the
guided migration page; an installation that previously completed it proceeds
to the dashboard. If a very old source has no marker table, `migrations.sql`
creates it as incomplete so the user must verify the migration rather than
silently skipping it.

### Image storage and private configuration

The logical dump includes database records, users, tags, notification rules,
and image path references. It does not include files from the source
installation's `storage/` directory. Copy that directory separately while the
source application remains stopped. The target storage directory must preserve
the same relative paths (`images/`, `thumbnails/`, and `derived/`) and be
writable by UID/GID `1000` before the target application starts.

On Linux, `rsync` provides a resumable transfer. Run the first command to copy
the files, then the checksum dry run; the second command must produce no file
differences before cutover:

```bash
rsync --archive --human-readable --partial --info=progress2 \
  /path/to/source/storage/ /path/to/target/storage/
rsync --archive --checksum --dry-run --itemize-changes \
  /path/to/source/storage/ /path/to/target/storage/
```

Do not blindly copy `auth/`, `config/`, or `.env`. They can contain session
keys, API keys, database credentials, and integration secrets. Start with new
target credentials and re-enter integrations through Settings. If preserving a
configuration file is necessary, review it privately and copy it only after
the database and storage import have passed validation.

`restore` verifies exact source row counts immediately after the transactional
restore and before applying current migrations. `validate` then rechecks the
dump digest, proves the stopped source is unchanged, rejects any post-migration
source-table row loss, and reports rows legitimately added by current schema
seeds. These database checks are necessary but not sufficient. Before cutover,
also verify
database readiness, the application health endpoint, sign-in, plate ingestion,
search, roles, audit history, storage reconciliation, and image persistence
across an application and database restart.

If acceptance fails, run `rollback-check`, stop the PostgreSQL 17 target, and
return to the unchanged source database, storage, and matching application
release. The helper intentionally never switches or deletes volumes; the
operator must perform the environment-specific cutover only after validation.

## External database

Use `docker-compose.without-database.yml` when PostgreSQL is managed elsewhere.
Set `DB_HOST`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD` in `.env`; do not commit
that file. The external database must already contain the schema and migrations
from this release.
