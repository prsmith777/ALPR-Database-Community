# Database migrations

Add new numbered SQL files; never edit a migration after releasing it. Each file
starts with `-- migration: VERSION` and records that version in `schema_migrations`.
Run `node scripts/build-migrations.mjs` and commit the generated `migrations.sql`.
`node scripts/build-migrations.mjs --check` rejects an outdated bundle.

The generated bundle is the runtime entry point on Windows, Docker and logical
imports. It contains every source, so older updaters still work without a bridge
release or extra files. Execute it in one transaction. An advisory transaction
lock serializes migrations. Completed versions are skipped and their SHA-256
checksums are verified. A failure rolls back both schema work and ledger updates.

On the first upgrade, existing legacy completion markers are adopted with their
source checksums, without replaying those migrations. The legacy native identity
marker is checked against its authority control before adoption. Unknown legacy
markers are retained. Historical migrations that were never completed still run;
the canonical transition only retires explicitly named image-based classifiers.
Blue Iris and Axis event observations are preserved. New corrections belong in
a new migration, including corrections to views created by older versions.

The files extracted from the legacy bundle retain their original statements and
markers, except for event-direction visibility and the corrected retirement
predicate needed when upgrading installations predating canonical identity. Backups, count validation
and rollback remain the responsibility of the existing deployment updater.
