# Repository operating instructions

These instructions apply to the entire repository.

## Owner's deployment policy

This is a single-user, self-hosted application. Prefer a simple, recoverable
source deployment over enterprise release machinery.

Do not require GHCR publication, immutable registry digests, provenance
attestations, signing, or per-release Codex plugin changes unless the owner
explicitly asks to restore that workflow.

GitHub and the selected Git commit are the release source of truth. Record the
commit deployed to each server.

## Normal update workflow

1. Make changes on a feature branch.
2. For every production candidate, update `lib/help-manual.mjs` and
   `docs/COMMUNITY_PRODUCT_ROADMAP.md` in the same release. Bump the manual
   version/date/baseline, document changed behavior, and keep delivered versus
   planned roadmap status accurate. Record exact deployed SHAs in release and
   deployment status rather than embedding a self-referential candidate SHA in
   the roadmap.
3. Run `yarn test`, `yarn typecheck`, `yarn lint`, and `yarn build`.
4. Commit and push the validated changes.
5. Fast-forward the remote `staging` branch to the selected commit.
6. With explicit staging approval, deploy to `alpr-staging` (`192.168.0.4`)
   using the existing restricted `alpr-staging-ssh` operations:
   `status`/`repo_status`/`stack_status`/`health`, then `sync`, `image_build`,
   `verify`, and `deploy`.
7. Perform staging health and browser acceptance checks. Keep synthetic
   fixtures separate from deployment and never load them automatically.
8. After the owner accepts staging, merge or fast-forward the tested tree to
   `main`.
9. Deploy production (`192.168.0.227`) only with a separate production tool
   and explicit production approval. Back up PostgreSQL, record the previous
   commit/image, update to the accepted source, build, migrate once, restart,
   and health-check.

Do not use the staging connector, staging SSH key, or staging fixtures against
production.

## Rollback expectations

- Application rollback returns to the previously recorded commit/image and
  restarts the app.
- A failed application deployment may restore runtime files and the previous
  app image, but database changes already applied by a migration are not
  automatically reversed.
- Before a production migration, create and verify a database backup or have a
  tested reverse migration.

## Working style for future Codex tasks

- Do not reinstall or rewrite deployment plugins during an ordinary release.
- Prefer the existing fixed staging operations over arbitrary remote commands.
- Keep the process proportional to this personal project: validated commit,
  staging acceptance, production backup, production deployment, health check.
- Report the exact commit and health result after every deployment.
- See `docs/personal-deployment.md` for the human-readable runbook.
