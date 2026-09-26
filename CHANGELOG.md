# Changelog

## Unreleased

## 0.1.39 — 2026-09-26

- Introduced bootstrap v6 with a streamlined first-time-user experience while
  retaining bootstrap v5's fail-closed safety and platform checks.
- Removed the automatic `less` script viewer from the documented bootstrap
  command so verified downloads proceed directly to setup.
- Made the public quick-start command select a new installation explicitly,
  while migration instructions select the separate migration path explicitly.
- Added plain-language bootstrap choices, forgiving menu input, visible setup
  stages, a pre-change summary, and conventional `y`/`yes` confirmation.
- Made the fresh installer retry invalid passwords, time zones, and ports,
  detect the host time zone, summarize the installation before it starts, and
  print usable detected browser addresses at completion.
- Updated the installation, bootstrap, migration, update, roadmap, and release
  guidance for the streamlined first-time-user flow.

## 0.1.38 — 2026-09-25

- Hardened bootstrap v5 against RPM `curl-minimal` conflicts and duplicate APT
  repository definitions, with bounded retries for exact artifact downloads.
- Made release discovery use GitHub's published stable release, preserved the
  selected mode and destination across Docker group refresh, and rejected
  invalid environment-supplied release tags.
- Corrected usable-memory checks, migration dependency checks, custom Node
  runtime handoff, interrupted-install guidance, and pre-mutation destination
  validation.
- Replaced ambiguous automatic v3 checkout recovery with fail-closed review,
  and made the documented checksum/download sequence prevent execution after a
  failed verification.
- Added executable bootstrap control-flow tests and real disposable-container
  package tests for Ubuntu 24.04, Debian 12, Rocky Linux 9, and AlmaLinux 9.
- Updated installation, compatibility, release, roadmap, and embedded Help
  guidance; the Community user guide is now version 3.4.

## 0.1.37 — 2026-09-25

- Fixed the automated bootstrap so a fresh clone materializes its working tree
  before the clean-checkout gate.
- Added narrow automatic recovery for the exact unmaterialized canonical clone
  left by the v0.1.36 bootstrap failure. Recovery still refuses `.env`, files
  outside `.git`, indexed paths, modified files, and noncanonical origins.
- Updated the fresh-install, bootstrap, update, release, and embedded Help
  guidance; the Community user guide is now version 3.3.

## 0.1.36 — 2026-09-25

- Restored the mobile **More** menu and added permission-aware Help access to
  both the desktop sidebar and mobile menu.
- Corrected Software Updates so a successful no-update check identifies the
  installed release as current, records the last check, and links directly to
  exact release notes and update guidance.
- Made Docker environment-owned Database and Blue Iris fields visibly
  read-only and reject forged submissions instead of reporting ignored changes
  as saved.
- Replaced misleading `Legacy` prefixes in the active Community Vehicle
  Intelligence navigation while preserving explicit ReID v1 explanations.
- Updated the embedded Community user guide to version 3.2 and added regression
  coverage for navigation, update state, and environment-owned settings.

## 0.1.35 — 2026-09-25

- Expanded the automatic x86-64 bootstrap from Ubuntu 24.04 to an explicit
  maintained-release matrix covering Ubuntu, Debian, RHEL, Rocky Linux,
  AlmaLinux, CentOS Stream, and Fedora with separate APT and RPM adapters.
- Added distribution-specific Docker repositories, PostgreSQL 17 migration
  clients, RPM PostgreSQL path discovery, fail-closed conflict checks, and
  synchronized installation, compatibility, roadmap, and in-app guidance.
- Updated the embedded Community user guide to version 3.1.

## 0.1.34 — 2026-09-25

- Fixed the Software Updates page so an open tab polls through a stable,
  authenticated status endpoint and performs a cache-busted full navigation
  after the application restarts onto a different release.

## 0.1.33 — 2026-09-25

- Added guided GitHub bug and feature forms, Discussions routing for questions
  and general feedback, and private vulnerability-reporting guidance.
- Added contribution and sanitization guidance plus direct feedback links in
  the README and in-app Help Center.
- Rebuilt the embedded Community user guide as version 3.0 with exact coverage
  for every visible Settings page, complete Blue Iris ingestion and direction
  setup, integration tests, update/rollback flow, and security boundaries.
- Added Settings-route documentation contracts so a new visible Settings page
  or a missing critical instruction fails automated tests.
- Reconciled the public product roadmap with the shipped Community feature set,
  supported deployment boundary, and current backlog.

## 0.1.32 — 2026-09-25

- Fixed multi-second Live Feed query planning when ReID v2 is in shadow mode by
  omitting authoritative-only v2 views and asset joins from the generated SQL.
- Preserved the authoritative ReID projection when v2 is primary and added
  regression coverage for every supported ReID authority mode.
- Replaced five-second full-page Live Feed polling with authenticated
  server-sent change events and bounded changed-row hydration.
- Replaced the separate Recognition Feed viewer's three-second database poll
  with the same event-driven changed-row path while retaining manual refresh.
- Coalesced concurrent browser-session checks, cached update state briefly,
  and removed update checks from image and other subresource requests.
- Added private immutable image caching with conditional requests, removed the
  artificial ingestion delay, and published completed visual-processing rows.
- Added Server-Timing measurements for middleware, changed-row queries, and
  image delivery plus focused performance regression coverage.

## 0.1.31 — 2026-09-25

- Added a resumable `./alpr-community migrate wizard` that creates a separate
  PostgreSQL 17 target and automates guarded dump, restore, current migrations,
  reconciliation, and source/target validation.
- Added local and SSH `rsync` image-storage transfer with checksum verification
  plus exact state, artifact, and password-handling boundaries.
- Started migrated applications on an outbound-isolated Docker network and
  added automated image, health, database restart, and persistence checks.
- Added explicit browser acceptance, rollback verification, network activation,
  and narrow pre-acceptance target recovery without automatic source stop,
  traffic switching, or source deletion.
- Updated the bootstrap, deployment documentation, and embedded Community user
  guide to version 2.2.

## 0.1.30 — 2026-09-25

- Added one verified Ubuntu 24.04 x86-64 bootstrap with new-install,
  migration-preparation, and read-only compatibility-check modes.
- Automated Git, Docker Engine, Compose, Buildx, private Node.js 24, and
  migration-only PostgreSQL 17/SSH/rsync prerequisite setup without replacing
  an existing ALPR or Docker installation.
- Added real OpenVINO CPU inference gates for every fresh-install and update
  image, covering the bundled detection, attribute, and ReID models.
- Moved image builds to isolated temporary BuildKit builders that remove their
  own cache without broad Docker pruning or sacrificing the versioned rollback
  image.
- Added exact-tag release assets and checksums for the bootstrap, plus host,
  capacity, distribution, VM, Windows, ARM, and migration compatibility paths.
- Updated the embedded Community user guide to version 2.1.

## 0.1.29 — 2026-09-24

- Added **Settings → Software Updates** for checking and installing exact
  stable releases through the existing guarded updater workflow.
- Added a restricted host-side update agent with an allow-listed, expiring,
  private-file request protocol; the web container receives no Docker socket
  or arbitrary shell access.
- Added browser-visible validation, manual acceptance, guarded rollback, and
  rollback-retention cleanup controls with explicit confirmations.
- Added a portable foreground agent mode and per-user systemd installation for
  unattended Linux hosts and virtual machines.
- Updated installation, deployment, update, release, and embedded user-guide
  documentation to version 2.0.

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
