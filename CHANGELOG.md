# Changelog

## Unreleased

## 0.1.28 — 2026-09-24

- Corrected the Community update guide so new deployments use the current
  exact release and `./alpr-community install` instead of the historical
  v0.1.23 updater baseline.
- Clarified that exact v0.1.23 installations can update directly through the
  guarded updater while releases before v0.1.23 do not contain that tool.
- Updated the public repository status, current product boundary, and embedded
  manual to describe the published Community release rather than a candidate.
- Updated release information and the Community user guide to version 1.9.

## 0.1.27 — 2026-09-24

- Fetched canonical `main` through an explicit remote-tracking refspec during
  release discovery instead of relying on the clone's saved branch refspec.
- Enabled exact-tag installations and tag-only clones to prove that a requested
  stable release belongs to canonical `origin/main`.
- Added regression and public-tooling coverage for the explicit main fetch.
- Updated release information and the Community user guide to version 1.8.

## 0.1.26 — 2026-09-24

- Prevented rollback from re-running migrations after an exact logical restore,
  avoiding seed rows that were absent from the recorded pre-update database.
- Kept the verified dump authoritative for both prior schema and data before
  exact row-count and application-health validation.
- Added regression coverage proving rollback does not invoke the migration
  service after restoring the source snapshot.
- Updated release information and the Community user guide to version 1.7.

## 0.1.25 — 2026-09-24

- Fixed rollback for databases containing PostgreSQL partitioned tables by
  restoring a freshly recreated `public` schema inside one transaction.
- Preserved the standard `public` schema owner and access grants, restored
  extension objects from the verified dump, and removed only container-local
  temporary restore files.
- Added regression coverage proving rollback does not use the incompatible
  `pg_restore --clean` path that can reject inherited partition constraints.
- Updated release information and the Community user guide to version 1.6.

## 0.1.24 — 2026-09-24

- Added `./alpr-community install` for guided fresh installation on Linux
  x86-64 Docker Compose hosts and Linux virtual machines.
- Added canonical exact-tag, prerequisite, disk, port, existing-data, Compose
  resource, and commit-qualified image validation before changing host state.
- Added a hidden user-chosen administrator password prompt and automatic
  high-entropy database password generation in an owner-only `.env` file.
- Added transactional schema migration, public health, exact image revision,
  empty application data, absent fixture tables, and clean migration-marker
  completion gates.
- Added narrow failed-install cleanup and explicit recovery that operate only
  on recorded resources and refuse a completed installation or modified
  configuration.
- Added generic Linux/VM installation and first-login documentation and
  updated the Community user guide to version 1.5.

## 0.1.23 — 2026-09-24

- Added a guided host-side updater for standard Linux Docker Compose systems
  and Linux virtual machines, independent of the underlying hypervisor.
- Required clean exact stable tags from the canonical repository and built
  commit-qualified local images instead of using a moving `latest` tag.
- Added pre-update database/configuration backup, transactional migration,
  health and row-count validation, manual acceptance, exact rollback, and a
  bounded one-generation retention policy.
- Kept Docker control outside the application container, excluded the image
  library from per-update copies, and prohibited broad Docker pruning.
- Documented supported hosts, deliberate first-release platform refusals, and
  interactive and non-interactive update workflows in user guide 1.4.

- Reduced the production Docker image to the standalone application runtime,
  public assets, and required visual-search models. Test suites, synthetic
  fixture tooling, CI files, and development payloads remain in the source
  repository but are no longer copied into the runtime image.
- Added release gates that inspect the runtime image and prove a freshly
  initialized database contains no plates, reads, tags, notifications, or
  staging-fixture registry.
- Clarified the first-run login mode so new administrators are told to leave
  the username blank and use the configured administrator password.
- Marked the legacy image migration complete in newly initialized databases so
  clean installations proceed directly to the dashboard after sign-in while
  restored legacy databases preserve their migration requirement.
- Generalized the guarded database importer for validated PostgreSQL 13 and 17
  sources, pinned Original ALPR v0.1.9 as the legacy application baseline,
  added application-schema fingerprinting, repaired and verified derived plate
  occurrence counts during import, added resumable image-storage transfer
  guidance, and updated the Community user guide to version 1.3.
- Added a cross-platform guided migration assistant with redacted resumable
  state, endpoint-drift protection, explicit source-quiesce and empty-target
  checkpoints, non-repeating successful phases, separate storage/application
  acceptance, rollback verification, and a step-by-step operator runbook.
- Added a disposable Community upgrade matrix that recreates the exact stable
  v0.1.20, v0.1.21, and v0.1.22 database baselines, proves PostgreSQL 13/17 to
  PostgreSQL 17 imports, exercises failed-restore resume, verifies count
  reconciliation, and confirms the retained source remains rollback-ready.

## 0.1.22 — 2026-09-24

- Simplified Storage & Privacy for first-time Community administrators and
  moved specialist diagnostics and cleanup controls under Advanced Maintenance.
- Hid optional Docker and backup measurements when no host snapshot is
  configured, and suppressed that expected first-run warning.
- Replaced impractical long-range capacity dates with a stable status.
- Clarified that retention and record-limit values are planning inputs only and
  never automatically delete plate reads or source images.
- Added Email and Webhook readiness guidance and corrected the privacy page's
  integration inventory.
- Updated the Community user guide to version 1.1.

## 0.1.21 — 2026-09-24

- Removed radar-only speed columns, filters, details, and query paths from the
  Community recognition feed.
- Corrected confidence precision and nested integration section headings.
- Redirected already-completed migration pages to the dashboard.
- Made date and time rendering hydration-safe and stabilized Live Viewer
  refresh requests.
- Added accessible labels to dashboard time-distribution links and regression
  coverage for the corrected behavior.

## 0.1.20 — clean Community baseline

- Started from a source archive without inherited Git history.
- Removed audited screenshots, sample imagery, runtime configuration, personal
  deployment documentation, and data examples.
- Removed private-only TPMS, AI chat, radar/traffic, privileged host
  maintenance, and advanced ReID rollout interfaces.
- Generalized fixed camera names and replaced private network examples with
  documentation-safe values.
- Persisted application authentication, configuration, logs, and image storage
  in Compose.
- Standardized Community time-zone defaults on UTC.
- Added a repository sanitation test and public PostgreSQL 17 deployment guide.
- Restored legacy visual search for the default `v2_shadow` compatibility mode
  used by clean Community installations.
- Redirected successful manual image migrations to the dashboard only after
  the database update-completion marker is confirmed.
