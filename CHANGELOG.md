# Changelog

## Unreleased

## 0.1.51 — Windows update database validation (2026-10-07)

- Skip replaying byte-identical verified Windows schema/migration files on existing installations, preserving predictions generated since the original migration.
- Check all database table counts before restarting workers; distinguish consumed direction work and expired authentication state from record loss afterward. Retain failed counts and affected table names through automatic rollback.
- Exercise populated native database updates with 119 reads, 99 distinct plates and 105 direction observations, including 15 unbound predictions, through isolated real Windows services.

## 0.1.50 — Windows update file-lock recovery (2026-10-07)

- Retry temporary Windows sharing and access failures for up to 30 seconds when moving verified release folders. Recheck the selected release and real directories before every attempt. Persistent failures preserve the active release and all staged copies.
- Exercise the failure and recovery using a real Windows file handle that denies delete sharing, as well as bounded permanent-denial and selected-release race fixtures.

## 0.1.49 — Reliable Windows update retries (2026-10-06)

- Retry Windows updates when an earlier attempt already copied the target release: verify and reuse complete copies, stage new copies privately, and preserve incomplete copies for diagnosis. Never replace the active release during staging.
- Stop graphical Setup when the update engine reports a failure, even if its process returns zero. Require the expected installed release and owned running listener before showing completion.
- Exercise successful, failed and unverified application installs through compiled disposable installer fixtures.

## 0.1.48 — Windows updates from Settings (2026-10-06)

- Enable native Windows updates in Settings → Software Updates through a separate Windows service, with stable release discovery, verified downloads, visible progress, recovery backup, restart, technical checks, acceptance and rollback.
- Update existing Windows installations in place using graphical Setup, preserving data and credentials and enabling future UI updates without uninstalling.
- Attempt automatic recovery after update failure or interruption, and preserve accepted recovery copies when another release arrives during the retention window.
- Fix a PowerShell 5.1 process exit-code bug that falsely reported successful migration backups as failed.

## 0.1.47 — Native Windows installation and portable vehicle images (2026-10-06)

- Add guided recovery of data retained after uninstall: preserve passwords, API key, settings, records, images and network preference, and verify a protected recovery backup before reconnecting the database.
- Exercise native version upgrade, transactional rollback and retained-data reinstall through isolated real Windows services.
- Handle both unique constraints when concurrent reads register the same canonical vehicle image, retaining strict content and metadata validation.
- Close active live-feed responses during server shutdown so a browser left open cannot hold service maintenance until the wrapper timeout.
- Run Windows migration backup from the selected release so its bundled dependencies resolve after installation; preview repair refreshes the shortcut launcher while retaining its previous copy.

- Correct WinSW 2.12's presence-based delayed-start setting: omit the XML element, enforce normal automatic startup and verify Windows service configuration in setup and preview repair.

- Remove the unpatched `braces` dependency by upgrading to Tailwind 4, replacing build-time directory globbing and excluding the build-only NFT tracer from shipped runtimes. Update Next.js and available image-processing, IP-parsing, source-map and selector security fixes; keep the dependency gate enabled.
- Keep checked-out source line endings consistent across operating systems and exercise logical migration with the native Windows CI runtime.

- Expose per-direction vehicle-source timing tolerance (0.25–3 seconds), explicit saved/unsaved state, recorded-frame diagnostics, and Blue Iris direction observations in the shared Linux/Windows Vehicle Setup screen.
- Add a bounded front/rear training screen using current canonical crops; refuse changed embeddings and monochrome nighttime training before saving.
- Preserve the Home Assistant whitelist enable setting when saving its IP list as a partial update.

## 0.1.47 — Portable vehicle images and Windows migration preview (2026-10-05)

- Add a shared Vehicle image source setup for each saved camera direction. Use whole-vehicle recordings from the LPR camera itself or an explicitly selected overview camera; changing the primary source disables the prior mapping transactionally.
- Require usable color, temporal association, and a complete, unambiguous vehicle for LPR recording frames before the existing canonical crop and ReID pipeline accepts them.
- Add verified portable migration bundles and a native Windows setup import option for supported Original ALPR and Community databases on PostgreSQL 13 or 17. Preserve original records and image files, validate exact restored counts and checksums, migrate the target schema, and reset destination setup login while retaining integration keys and named accounts.
- Add an installed Windows Migration Backup shortcut and real download percentages with animated installation and removal progress.
- Advance the embedded manual and document Linux-to-Windows backup preparation, destination validation, and source retention.

## 0.1.46 — Resilient Community updates (2026-09-29)

- Retry transient DNS, timeout, connection, rate-limit, and server failures while downloading the pinned OpenVINO runtime during an image build; permanent client responses still fail immediately and the downloaded archive remains checksum verified.
- If an image build or another apply step fails before database migration starts, automatically restore the exact previous tag, environment, and application container without replacing the unchanged database.
- Preserve the failed operation and rollback artifacts for diagnosis while returning the installation to a usable, retryable prior-release state.
- Add simulated DNS-failure and pre-migration application-recovery regressions, update the maintenance launcher, and advance the manual, update guide, roadmap, release notes, installation examples, and issue template.

## 0.1.45 — Local-time filter correctness (2026-09-29)

- Fix the desktop Recognition Feed hour picker so selected local hours are not converted a second time to UTC and remain visible after navigation.
- Apply the installation's configured IANA time zone explicitly to Recognition Feed, Database, and export date/hour queries instead of depending on the PostgreSQL session zone.
- Preserve local calendar dates through URL and saved-filter restoration. Start a clean filter-preference generation and clear legacy dated hour links so converted pre-fix hours are not silently reused.
- Add America/Phoenix query coverage, timezone-aware database filter checks, picker-state regressions, and documentation for local-time filtering.
- Update Nodemailer and the MQTT proxy IP parser to their supported security-fixed releases after the dependency gate identified newly published advisories.
- Update manual 3.10, release notes, installation/update examples, issue guidance, and roadmap.

## 0.1.44 — Native ReID update recovery (2026-09-27)

- Fix the host updater falsely treating intentionally retired identity tables as lost user data during the native ReID upgrade.
- Record stopped-source schema and exact eligible direction-retirement counts; require target schema/control attestation and an unchanged backup checksum. Preserve normal loss checks for original data, Blue Iris observations, bound examples, and images.
- Execute host-agent commands and installed-release validation in fresh processes instead of retaining old updater imports across checkout.
- Supply a checksum-verified, exact-tag maintenance launcher for hosts on v0.1.43 or earlier. Failed v0.1.43 updates must first be rolled back; the launcher does not bypass validation, accept a release, or delete recovery data.
- Add real PostgreSQL dump/migration/transactional-rollback/retry regression coverage and fresh-process/maintenance-control tests. Git, image, and application lifecycle boundaries in that database test are simulated.
- Update manual 3.9, release notes, README, update/recovery and installation guides, release checklist, and roadmap.

## 0.1.43 — Native ReID V2 (2026-09-27)

- Make ReID V2 the only Community identity pipeline; fresh installs initialize it directly.
- Automatically catalog eligible whole-vehicle images, crop, embed, and extract attributes in bounded background jobs.
- Enable permission-checked, audited pair decisions directly in Vehicle Search.
- Add processing status, pause/resume, and bounded failure retries to Vehicle Setup.
- Bind direction calibration and predictions to exact-current canonical crop evidence.
- Remove obsolete index, grouping, mode-selection, and conversion code. Upgrades retire derived caches while retaining original reads, images, users, tags, and corrections.
- Update the manual, installation/update/migration guidance, roadmap, and isolated PostgreSQL regression coverage.


## 0.1.42 — 2026-09-27

- Fixed repeated Recognition Feed identity validation on imported databases
  already using ReID 2 primary mode. Relevant profile evidence is checked as
  sets, including members outside the visible page; stale or conflicting
  evidence still prevents an authoritative identity from being displayed.
- Split page selection, metadata, and identities into bounded queries within
  one read-only, repeatable-read snapshot. Filters, sorting, pagination, and
  legacy identity behavior are preserved. Missing or invalid authority control
  now reports an error instead of silently falling back to legacy identity.
- Added slow-query stage timings without plate numbers or query parameters,
  and synthetic PostgreSQL regression tests for the application query,
  evidence lifecycle, merges, off-page conflicts, and reduced database work.
- No database conversion, authority-mode change, or data deletion is required.
  Updated the user guide to 3.7, roadmap, migration/update troubleshooting,
  release information, and exact-tag installation examples.

## 0.1.41 — 2026-09-26

- Completed a repository-wide accuracy review of the embedded manual,
  roadmap, installation, migration, deployment, update, security,
  contribution, issue-reporting, and release guidance.
- Corrected Docker build-cache documentation: temporary builders are removed,
  but Docker can retain unused engine-side cache after loading a locally built
  image. Added bounded inspection and dedicated-host cleanup instructions
  without recommending broad Docker pruning.
- Clarified that supported installations require the `docker compose` CLI
  plugin, version 2 or newer, so current Compose releases are represented
  accurately.
- Added a maintainer release-documentation checklist and automated checks that
  keep package versions, changelog entries, exact-tag examples, issue forms,
  manual coverage, and public links synchronized.
- Updated the Community repository homepage to the current Community README,
  retained the official Blue Iris vendor-manual reference, and advanced the
  embedded Community user guide to version 3.6.

## 0.1.40 — 2026-09-26

- Reworked **Settings → Software Updates** into a guided **Check → Install →
  Technical system checks → Accept** workflow with a visible progress guide.
- Added a prominent **Update installed — acceptance required** message that
  explains the five real-use checks and final **Accept update** action.
- Prevented update checks and newer installations while the current release is
  unfinished, avoiding a late backend rejection after an installation phrase
  has already been entered.
- Preserved the active update release separately from a newly discovered tag
  so acceptance and release-note messages identify the correct version.
- Renamed the normal post-install verification step to **Technical system
  checks**, moved repeat checks into troubleshooting, and synchronized the
  updater CLI, embedded user guide, update guide, deployment guide, and roadmap.
- Updated the embedded Community user guide to version 3.5.

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
  Intelligence navigation with clearer identity explanations.
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
- Restored Vehicle Search access for the then-default compatibility configuration
  used by clean Community installations.
- Redirected successful manual image migrations to the dashboard only after
  the database update-completion marker is confirmed.
