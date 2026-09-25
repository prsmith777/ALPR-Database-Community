# Community product roadmap

## Clean-history baseline

The Community repository starts from a reviewed source snapshot with no prior
Git history. The release gate requires:

- no credentials, password hashes, session data, database dumps, private LAN
  addresses, personal screenshots, or production-derived imagery;
- no private deployment scripts or privileged host-maintenance controls;
- no fixed installation-specific camera, radar, or network configuration;
- persistent authentication, configuration, log, image, and database storage;
- PostgreSQL 17 fresh-install and guarded PostgreSQL 13 or 17 imports from the
  pinned Original ALPR v0.1.9 or Community v0.1.20-plus schema baselines;
- passing sanitation, unit, lint, type, build, and isolated container checks.

## Initial Community release

The first clean release focuses on the portable ALPR application:

- authenticated plate ingestion;
- live feed, search, tags, corrections, known vehicles, and exports;
- multi-user role permissions;
- MQTT, Pushover, email, and signed webhook notifications;
- Blue Iris integration with user-supplied camera configuration;
- basic local visual search and vehicle profiles;
- application-level storage monitoring and guarded cleanup;
- guarded, resumable database migration from the supported Original and
  Community schema baselines;
- Docker Compose deployment on x86-64 with PostgreSQL 17.
- exact-tag routine updates on standard Linux hosts and Linux virtual machines,
  with a one-generation database/configuration rollback policy.

Experimental radar traffic correlation, fixed-camera recovery campaigns,
privileged host operations, advanced ReID conversion/cutover controls,
AI-assistant endpoints, and the TPMS prototype remain outside the Community
release boundary.

## Later work

- Add architecture-neutral image builds after native dependency validation.
- Improve first-run setup and empty-database diagnostics.
- Publish generic sample data that contains no real plates, people, locations,
  timestamps, or camera identifiers.
- Reintroduce advanced visual-search operations only after their configuration
  is portable, documented, default-off, and independently reviewed.
- Add automated container smoke tests for fresh install, restart persistence,
  ingestion, and logical database restore.
