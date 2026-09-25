# Guided existing-system migration

This runbook migrates a supported existing ALPR database into a separate
PostgreSQL 17 Community target. The guided assistant remembers completed
checkpoints, but it deliberately does not stop the source, copy image files,
start the target application, switch traffic, or delete either system.
It never switches traffic or deletes the retained source on the operator's
behalf.

Supported database sources are:

- Original ALPR Database v0.1.9-compatible on PostgreSQL 13 or 17;
- ALPR Database Community v0.1.20 or newer on PostgreSQL 13 or 17.

The Community compatibility matrix is acceptance-tested from these exact
clean-history release states:

- v0.1.20: `4cb70c2c5cbe24c7451e5c468692250331b7cbd0`;
- v0.1.21: `c783fcafc62396f437c4fa811ce33bce658119b8`;
- v0.1.22: `316742ebbd6ba6fc2e2135a4b5c96b61bc160859`.

The matrix covers PostgreSQL 13 and 17 sources, always restores into
PostgreSQL 17, and includes a refused non-empty restore followed by a clean,
same-endpoint resume and rollback verification.

An older Original ALPR installation must first update its database to the
pinned v0.1.9 baseline. Unknown and partially updated schemas fail preflight.

## What you need

- Node.js 24 and this exact Community source checkout;
- PostgreSQL 17 `psql`, `pg_dump`, and `pg_restore` client utilities;
- credentials for the stopped-source database and the empty target database;
- a separate, empty PostgreSQL 17 target created from `template0` where
  practical;
- encrypted free space for the private dump and workflow-state files;
- the source and target image-storage locations, when images exist.

Do not initialize the target with `schema.sql`. Do not point the Community
application at it before restore and validation finish.

## 1. Configure a private terminal

Set these variables in a private terminal or secret manager. Do not put them
in Git, shell history, screenshots, support tickets, or the workflow-state
file.

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

ALPR_MIGRATION_DUMP_PATH
```

`ALPR_MIGRATION_DUMP_PATH` must be an absolute path outside the repository.
`ALPR_MIGRATION_STATE_PATH` is optional; by default the assistant creates
`<dump-path>.workflow.json` beside the dump. Both files are private.

When source and target storage are locally mounted, these optional variables
bind their paths to the workflow identity:

```text
ALPR_MIGRATION_SOURCE_STORAGE_PATH
ALPR_MIGRATION_TARGET_STORAGE_PATH
```

The paths must both be absolute, separate, and non-nested. The assistant
records the paths but never copies or deletes their contents.

On PowerShell 7, passwords can be entered without echoing them:

```powershell
$sourcePassword = Read-Host "Source database password" -MaskInput
$targetPassword = Read-Host "Target database password" -MaskInput
$env:ALPR_MIGRATION_SOURCE_PASSWORD = $sourcePassword
$env:ALPR_MIGRATION_TARGET_PASSWORD = $targetPassword
```

On Bash, use silent reads:

```bash
read -rsp "Source database password: " ALPR_MIGRATION_SOURCE_PASSWORD; echo
read -rsp "Target database password: " ALPR_MIGRATION_TARGET_PASSWORD; echo
export ALPR_MIGRATION_SOURCE_PASSWORD ALPR_MIGRATION_TARGET_PASSWORD
```

## 2. Start and inspect preflight

Run:

```text
npm run migrate:guided -- start
```

The assistant creates the private redacted state file, verifies PostgreSQL 17
clients, identifies the source application and schema fingerprint, confirms
the PostgreSQL version, and proves the target is distinct and empty. It then
stops before creating the dump.

Inspect the checkpoint at any time:

```text
npm run migrate:guided -- status
```

Passwords and acknowledgement values are never written to the state file.
Changing an endpoint, database name, dump path, state path, or recorded storage
path changes the workflow identity and cannot silently resume the old run.

## 3. Stop the source and create the dump

Stop the old application, plate ingestion, scheduled jobs, and every other
database writer. Keep all of them stopped until the complete migration and
acceptance process ends. Then set:

```text
ALPR_MIGRATION_SOURCE_QUIESCED=ALPR_SOURCE_QUIESCED
```

Resume:

```text
npm run migrate:guided -- resume
```

The assistant creates the logical dump and its format-3 manifest, then proves
the source schema, table inventory, and row counts did not change during the
dump. It stops again before target restore.

## 4. Confirm and restore the disposable target

Confirm that the target is the separate empty PostgreSQL 17 database you are
prepared to recreate if restore or migrations fail. Set:

```text
ALPR_MIGRATION_ACKNOWLEDGE=ALPR_TO_PG17_EMPTY_TARGET
```

Resume:

```text
npm run migrate:guided -- resume
```

The assistant rechecks the stopped source and dump, restores transactionally,
applies current migrations in a separate fail-closed transaction, reconciles
plate occurrence counts, and validates the resulting Community database.
Successful phases are not repeated on later `resume` commands.

If restore or migrations fail, leave the source stopped and unchanged. Remove
only the disposable target database or volume, create another empty
PostgreSQL 17 target at the same configured endpoint, correct the reported
cause, and run `resume` again. Never attempt to repair a partially tested
target in place.

## 5. Copy and verify image storage

The database dump contains image paths, not files. Copy the complete source
`storage/` contents while the source remains stopped. Preserve the relative
`images/`, `thumbnails/`, and `derived/` paths and make the target writable by
UID/GID `1000` on Linux.

For Linux, use the resumable copy and checksum dry run in
[Community deployment](DEPLOYMENT.md#image-storage-and-private-configuration).
The checksum dry run must report no file differences. On Windows, use a
resumable file-copy tool followed by a checksum-capable comparison; the Node
assistant itself works on Windows, but it intentionally does not select or run
a platform-specific storage-copy program.

Do not blindly copy `.env`, `auth/`, or `config/`. Re-enter credentials and
integration secrets on the new installation.

## 6. Validate the isolated target application

Point an isolated Community application at the restored target. Before any
traffic cutover, verify all of the following:

- database and application health checks pass;
- administrator sign-in works;
- expected plate totals, searches, tags, roles, and audit history are present;
- image and thumbnail samples load from copied storage;
- one controlled plate-ingestion test succeeds;
- application and database restarts preserve records and images;
- the legacy image migration page appears only when the source marker says it
  was unfinished.

The assistant cannot truthfully infer these operator observations, so it will
not record final acceptance without explicit acknowledgements.

## 7. Record acceptance

Only after database validation, storage comparison, application checks, and
restart persistence all succeed, set:

```text
ALPR_MIGRATION_STORAGE_VERIFIED=ALPR_STORAGE_VERIFIED
ALPR_MIGRATION_APPLICATION_VERIFIED=ALPR_APPLICATION_VERIFIED
ALPR_MIGRATION_ACCEPTANCE=ALPR_MIGRATION_ACCEPTED
```

Then run:

```text
npm run migrate:guided -- accept
```

This records acceptance in the private state file. It still does not switch
traffic, stop the retained source database, or delete anything. Perform
cutover separately using the deployment method for the target host.

## 8. Preserve rollback until the observation window closes

Before cutover and throughout the rollback window, run:

```text
npm run migrate:guided -- rollback-check
```

The check proves the retained source still matches the dump manifest and that
the dump remains intact. If target acceptance later fails, stop the target and
restart the unchanged source with its matching application and storage.

Keep the source, dump, manifest, and workflow state until the chosen rollback
window closes. Remove private migration artifacts only under the operator's
backup-retention policy.

## Commands at a glance

```text
npm run migrate:guided -- start
npm run migrate:guided -- resume
npm run migrate:guided -- status
npm run migrate:guided -- accept
npm run migrate:guided -- rollback-check
```

The lower-level `npm run migrate:database -- <command>` interface remains
available for diagnosis and advanced automation.

## Maintainer acceptance matrix

Maintainers with complete clean-history Git objects, Docker, Node.js 24, and
PostgreSQL 17 client utilities can reproduce the supported Community upgrade
matrix without using an installed ALPR database:

```text
npm run test:community-upgrades
```

Use `npm run test:community-upgrades -- --only 0.1.22` to isolate one baseline.
The harness creates uniquely named disposable PostgreSQL containers on random
loopback ports, stores dumps in a private operating-system temporary
directory, and removes its containers and artifacts on success or failure. It
does not discover, stop, or modify an existing ALPR stack.
