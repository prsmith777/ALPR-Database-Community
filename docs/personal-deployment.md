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

### 3. Accept staging

Exercise the changed screens and important existing workflows. Check browser
errors and recent application/database logs. Record any known issues.

Do not proceed until the owner explicitly accepts staging for production.

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
