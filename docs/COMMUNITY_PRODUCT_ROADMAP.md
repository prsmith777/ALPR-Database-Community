# Community product roadmap

## Published clean-history baseline

The Community repository was published from a reviewed source snapshot with no
prior Git history. Every release gate requires:

- no credentials, password hashes, session data, database dumps, private LAN
  addresses, personal screenshots, or production-derived imagery;
- no private deployment scripts or operator-specific unrestricted host controls;
- no fixed installation-specific camera, radar, or network configuration;
- persistent authentication, configuration, log, image, and database storage;
- PostgreSQL 17 fresh-install and guarded PostgreSQL 13 or 17 imports from the
  pinned Original ALPR v0.1.9 or Community v0.1.20-plus schema baselines;
- passing sanitation, unit, lint, type, build, and isolated container checks.

## Current Community release boundary

The published Community releases focus on the portable ALPR application:

- authenticated plate ingestion;
- live feed, search, tags, corrections, known vehicles, and exports;
- multi-user role permissions;
- MQTT, Pushover, email, and signed webhook notifications;
- Blue Iris integration with user-supplied camera configuration;
- basic local visual search and vehicle profiles;
- application-level storage monitoring and guarded cleanup;
- guarded, resumable database migration from the supported Original and
  Community schema baselines;
- Docker Compose deployment on x86-64 with PostgreSQL 17;
- guided fresh installation with generated database credentials, collision
  checks, empty-database proof, and narrow failed-install recovery;
- a verified Ubuntu 24.04 x86-64 bootstrap for new installations and migration
  targets, plus read-only compatibility reporting for other Linux hosts;
- final-image CPU inference checks for the bundled OpenVINO detection,
  attribute, and ReID models, with isolated per-build cache cleanup;
- exact-tag routine updates on standard Linux hosts and Linux virtual machines,
  with a restricted browser-to-host agent and one-generation
  database/configuration rollback policy;
- automated container checks for fresh installation, restart persistence,
  ingestion, logical database restore, and reversible synthetic fixtures.

Experimental radar traffic correlation, fixed-camera recovery campaigns,
privileged host operations, advanced ReID conversion/cutover controls,
AI-assistant endpoints, and the TPMS prototype remain outside the Community
release boundary.

## Later work

- Add separately tested automatic package adapters for additional x86-64 Linux
  distributions and native Windows deployment only when their service and
  rollback behavior can be supported safely.
- Add architecture-neutral image builds after native dependency validation.
- Publish generic sample data that contains no real plates, people, locations,
  timestamps, or camera identifiers.
- Reintroduce advanced visual-search operations only after their configuration
  is portable, documented, default-off, and independently reviewed.
