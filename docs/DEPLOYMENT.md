# Community deployment

The Community edition is intended for self-hosted x86-64 systems with Docker
Engine and Docker Compose. Copy `.env.example` to `.env`, set unique
`ADMIN_PASSWORD` and `DB_PASSWORD` values, build the application image from the
reviewed source tree, and start the stack with `docker compose up -d`.
The Docker build context explicitly excludes `.env` files, so host credentials
are not copied into image layers. Keep `.env.example` as the public template.

The Compose files default to UTC and persist authentication state, application
configuration, logs, uploaded images, and PostgreSQL data. Keep `.env`, the
runtime data directories, and database backups out of source control.
Before the first start, create `auth/`, `config/`, and `storage/` and make them
writable by UID/GID `1000`, as shown in the README quick start. These paths are
bind-mounted and intentionally do not come from the repository or image.
On startup, Compose waits for PostgreSQL's first-time schema initialization,
then applies `migrations.sql` in one transaction before it starts the app.
A newly initialized database is marked as not needing the legacy base64 image
migration and proceeds directly to the dashboard after first sign-in.

## PostgreSQL 17 upgrades

The bundled database image is PostgreSQL 17.10. A PostgreSQL 13 data directory
must not be started with the PostgreSQL 17 image. Upgrade by taking a verified
logical dump from PostgreSQL 13 and restoring it into a fresh PostgreSQL 17 volume.
Keep the PostgreSQL 13 volume unchanged until the restored database and
application have both passed validation.
The rollback plan depends on retaining the PostgreSQL 13 volume until that
validation is complete.

The repository includes a guarded migration helper:

```text
npm run migrate:postgres -- preflight
npm run migrate:postgres -- dump
npm run migrate:postgres -- restore
npm run migrate:postgres -- validate
npm run migrate:postgres -- rollback-check
```

Install the PostgreSQL 17 versions of `pg_dump`, `pg_restore`, and `psql`, or
set `ALPR_PG_BIN_DIR` to their directory. A PostgreSQL 17 client can dump a
PostgreSQL 13 server. Do not use a PostgreSQL 13 `pg_dump` client for this
workflow.

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

Stop plate ingestion, the application, and every other PostgreSQL 13 writer
before creating the dump; keep them stopped through database validation. After
doing so, set:

```text
ALPR_MIGRATION_SOURCE_QUIESCED=PG13_SOURCE_QUIESCED
```

`preflight` refuses a target with user relations and refuses a source and target
that identify the same database. `dump` records a SHA-256 digest and exact
public-table row counts in a companion manifest. `restore` verifies that
manifest, refuses a non-empty target, restores without owner or ACL changes,
and then applies the current `migrations.sql`. It also requires this deliberate
acknowledgement:

```text
ALPR_MIGRATION_ACKNOWLEDGE=PG13_TO_PG17_EMPTY_TARGET
```

The restore includes the source database's `devmgmt` migration marker. An
installation with unfinished base64 image conversion therefore still opens the
guided migration page; an installation that previously completed it proceeds
to the dashboard. If a very old source has no marker table, `migrations.sql`
creates it as incomplete so the user must verify the migration rather than
silently skipping it.

`validate` rechecks the dump digest and compares every PostgreSQL 13 public
table count with the live source, manifest, and PostgreSQL 17 target. This
database check is necessary but not sufficient. Before cutover, also verify
database readiness, the application health endpoint, sign-in, plate ingestion,
search, roles, audit history, and image persistence across an application and
database restart.

If acceptance fails, run `rollback-check`, stop the PostgreSQL 17 target, and
return to the unchanged PostgreSQL 13 volume and its matching application
release. The helper intentionally never switches or deletes volumes; the
operator must perform the environment-specific cutover only after validation.

## External database

Use `docker-compose.without-database.yml` when PostgreSQL is managed elsewhere.
Set `DB_HOST`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD` in `.env`; do not commit
that file. The external database must already contain the schema and migrations
from this release.
