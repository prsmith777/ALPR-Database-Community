# Personal deployment runbook

This repository uses a deliberately simple deployment process for one owner
and two self-hosted servers. GitHub stores the source, and the Git commit is the
release identifier. Containers are built from that source on each server.

## Server roles

- Staging: `alpr-staging` at `192.168.0.4`
- Production: `192.168.0.227`

Staging and production use separate credentials and tooling. A staging command
must never be redirected to production.

## Database version

The supported database image for this fork is `postgres:17.10`. PostgreSQL
major versions use different on-disk formats, so an existing PostgreSQL 13
volume must not be started with the PostgreSQL 17 image. Upgrade an existing
installation by creating a verified logical backup, restoring it into a fresh
PostgreSQL 17 volume, comparing database counts, and retaining the PostgreSQL
13 volume until the new database has passed acceptance testing.

Treat a database major-version upgrade as separate maintenance from an
ordinary application deployment. Test the complete backup, restore, health,
and rollback procedure on staging before production.

## Update flow

### 1. Prepare the update

Develop on a feature branch. For every production candidate, update
`lib/help-manual.mjs` and `docs/COMMUNITY_PRODUCT_ROADMAP.md` in the same
release. Bump the manual version/date/baseline, describe changed user behavior,
move newly delivered work out of planned-only guidance, and update the roadmap
production baseline plus remaining work.

Record the exact deployed SHA in the deployment result and runtime status. Do
not place the candidate's own SHA in its source-controlled roadmap baseline;
the documentation commit would immediately make that value stale. Use the
release date/version and delivered behavior for the in-repository baseline.

Then run:

```text
yarn test
yarn typecheck
yarn lint
yarn build
```

Commit and push only after these checks pass. Record the selected commit SHA.

### 2. Promote the commit to staging

Fast-forward the remote `staging` branch to the selected commit. Do not force
push over unrelated staging work.

After the owner approves a staging deployment, use the restricted staging
operations in this order:

1. `status`, `repo_status`, `stack_status`, and `health`
2. `sync`
3. `image_build`
4. `verify`
5. `deploy`
6. `stack_status` and `health`

The staging deployment builds from the clean checked-out commit, runs the
project validation, applies the migration once, starts the app, and requires a
healthy result. Report the deployed commit.

Synthetic fixtures are managed independently. Check their status when they
are relevant, but never load or clear fixtures as part of deployment.

### Optional host storage snapshot

The application measures source images, thumbnails, generated vehicle images,
and PostgreSQL without host-control access. Docker and rollback-backup totals
are accepted only from a current schema-versioned JSON snapshot mounted
read-only into the app container and named by `STORAGE_HOST_SNAPSHOT_PATH`.
Leave that variable blank when no restricted host collector is installed; the
Data & Privacy page will label Docker and backups unavailable.

The snapshot contract is:

```json
{
  "schemaVersion": 1,
  "measuredAt": "2026-07-29T18:00:00.000Z",
  "docker": {
    "imagesBytes": 0,
    "containersBytes": 0,
    "buildCacheBytes": 0,
    "totalBytes": 0
  },
  "backups": {
    "bytes": 0,
    "count": 0,
    "latestVerifiedAt": null
  }
}
```

Write snapshots atomically with restrictive ownership and permissions. Mount
the collector-owned directory, rather than a single file, read-only at
`/run/alpr-host-storage`; atomic rename can otherwise leave a single-file bind
mount attached to the prior inode. Set `STORAGE_HOST_SNAPSHOT_PATH` to
`/run/alpr-host-storage/storage-snapshot-v1.json`. Snapshot files larger than
64 KiB are rejected. Do not give the application the Docker
socket, a privileged container, or writable access to backup/release trees.
Docker volumes are excluded from `totalBytes` to avoid double-counting the
application storage and PostgreSQL categories.

Host-maintenance controls additionally require explicit, stable
`HOST_MAINTENANCE_ENVIRONMENT_ID` and `HOST_MAINTENANCE_DATABASE_IDENTITY`
values in `.env` and the separately installed worker. Give staging and
production different environment IDs. Leave both blank until the reviewed
worker is installed; controls then remain fail-closed. Do not infer either
identity from `ALPR_RELEASE_CHANNEL`, an image tag, hostname, or branch name.

### 3. Accept staging

Exercise the changed screens and important existing workflows. Check browser
errors and recent application/database logs. Record any known issues.

Do not proceed until the owner explicitly accepts staging for production.

#### Recorded Phase 3 staging acceptance — August 1, 2026

The Phase 3 manual-backup repair was accepted on staging with application
repository commit `aeeee932dd8b922b533e4ec17aa88d614ebdbd20`. The fixed host
worker was installed separately by staging plugin
`0.1.0+codex.20260801054957` as worker image
`sha256:b7cee3421981c37a1b30269d6580fb95286de2fa55959fbc96c02ead6f21ec2d`;
it is not part of the application repository commit.

The first authorized create attempt exposed an audit-vocabulary defect and
rolled back before enqueue without an artifact. After that defect was
corrected, one separately authorized August 1 staging request completed once.
The worker verified `alpr-postgres-20260801T120648Z-5.dump` at 59.2 MB; the UI
reported `Error: None`, the worker cycle succeeded with exit status 0, the timer
remained active, and the application and PostgreSQL remained healthy. No retry,
cleanup, deletion, or production access was performed.

This historical staging result closes the former retry-pending item. It is not
authorization to deploy or install the host adapter on production. Production
still requires the separate explicit approval and safeguards below.

### 4. Deploy production

Use production-specific credentials and a production-specific deployment
command. The production procedure must:

1. Confirm current health and free disk space.
2. Record the current commit/image for rollback.
3. Create and verify a PostgreSQL backup before migrations.
4. Update the checkout to the accepted source tree.
5. Build the application image from that source.
6. Run the required migration exactly once.
7. Restart the application and wait for health.
8. Check key pages and recent logs.
9. Confirm the deployed help version and roadmap baseline describe this
   production release.

Never load staging fixtures into production.

### 5. Roll back if necessary

Return the application to the recorded previous commit/image and restart it.
Application rollback does not undo database changes. Use a reverse migration
or restore the verified backup when database rollback is required.

## Intended permanent commands

The desired operator experience is:

```text
deploy-staging
deploy-production
```

These should be stable server-side operations installed once. Ordinary
releases should not modify or reinstall their command wrappers. The staging
connector already provides the equivalent fixed steps. Production needs its
own separately scoped operation before Codex should automate production
deployment.

## Deliberately omitted release machinery

This personal deployment process does not require a GHCR publishing workflow,
image attestations, provenance signing, or an immutable release manifest. Those
can be restored later if the project becomes multi-user or is distributed as a
maintained product.
