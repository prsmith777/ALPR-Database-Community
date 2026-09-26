# Community product roadmap

Last reviewed: September 26, 2026

This roadmap distinguishes capabilities that are available now from work that
may be considered later. It is not a promise of dates. GitHub Releases and the
changelog are the source of truth for a specific installed version.

## Published Community baseline

The Community repository was created from a reviewed source snapshot with no
inherited Git history. Every release gate requires:

- no credentials, password hashes, session data, database dumps, private LAN
  addresses, personal screenshots, or production-derived imagery;
- no private deployment scripts or operator-specific unrestricted host tools;
- no fixed installation-specific camera, radar, or network configuration;
- persistent authentication, configuration, logs, images, and database data;
- PostgreSQL 17 fresh-install validation and guarded PostgreSQL 13 or 17 imports
  from a recognized Original ALPR v0.1.9 or Community v0.1.20-plus baseline;
- passing sanitation, unit, lint, type, build, runtime-image, migration, and
  isolated-container checks applicable to the release.

## Available now

### Core ALPR workflow

- API-key-authenticated plate ingestion, including Blue Iris JSON and image
  macros;
- an event-driven Recognition Feed, searchable database, dashboard, tags,
  known and monitored plates, audited corrections, recurring OCR aliases, and
  bounded CSV/JSON exports;
- named users with Administrator, Operator, Viewer, and Auditor roles;
- configurable fuzzy plate-matching profiles with an interactive profile test;
- no radar-dependent speed fields in Community.

### Vehicle images and direction

- locally stored vehicle views, local OpenVINO/ReID inference, basic visual
  similarity search, and vehicle profiles;
- per-camera front/rear semantic labels and confidence thresholds;
- manual Front view and Rear view training labels plus local ReID fallback;
- optional Blue Iris ordered-zone crossing mappings with fail-closed handling
  for missing, ambiguous, conflicting, and unsuitable nighttime evidence;
- read-only Blue Iris camera, alert, playback, and best-frame retrieval tests.

Visual similarity and direction are review aids, not identity proof.

### Notifications and integrations

- draft-first notification rules with preview and explicit activation;
- MQTT brokers, per-camera topics, test messages, and delivery activity;
- Pushover credentials, defaults, usage, and direct tests;
- SMTP email transport, sender identity, and direct tests;
- HMAC-SHA256-signed webhooks with explicit HTTP and private-network policy;
- an optional Home Assistant iframe authentication-bypass whitelist for exact
  trusted client IP addresses.

Integrations are inactive until an administrator supplies endpoints and
credentials and enables them. They do not require extra ALPR host packages.

### Storage, privacy, and operations

- application storage, PostgreSQL, image-index, and growth observations;
- configurable capacity and scheduler-liveness alerts through a ready email or
  webhook integration;
- bounded read-only reconciliation and preview-first cleanup restricted to
  reconciliation-confirmed generated derived orphans;
- optional separately approved automatic derived-orphan cleanup with a circuit
  breaker; it cannot delete source images or plate-read rows;
- local-only operation by default, no usage telemetry, and no upload of plate
  images or annotations for model training;
- in-app release identity, searchable Help Center, downloadable PDF guide,
  GitHub Discussions, structured issue forms, and private vulnerability
  reporting.

### Installation, migration, and updates

- Docker Compose deployment on x86-64 Linux with PostgreSQL 17;
- fail-closed APT and RPM bootstrap adapters for selected maintained Ubuntu,
  Debian, RHEL, Rocky Linux, AlmaLinux, CentOS Stream, and Fedora x86-64
  releases, including Git, Docker Engine, Compose, Buildx, private Node.js 24,
  and migration-only PostgreSQL 17 client utilities;
- executable control-flow coverage plus real disposable-container base-package
  tests for Ubuntu 24.04, Debian 12, Rocky Linux 9, and AlmaLinux 9; other
  listed releases have adapter-routing coverage but are not represented as
  complete clean-host installations;
- guided fresh installation with collision checks, generated database
  credentials, a user-selected administrator password, forgiving plain-language
  prompts, detected browser addresses, empty-database proof, persistent storage,
  and narrow failed-install recovery;
- bundled OpenVINO, ReID code, and pinned models with real CPU inference checks
  on each final image;
- an automated resumable migration wizard that creates a separate PostgreSQL
  17 target, imports a recognized Original or Community database, copies and
  checksums local or SSH image storage, and starts an outbound-isolated review
  target without deleting the source;
- exact-tag updates on standard Linux hosts and Linux VMs, available through
  both `./alpr-community` and an optional restricted browser-to-host service;
- verified database/configuration backups, guided Technical system checks,
  explicit real-use acceptance, exact rollback, and a one-generation rollback
  policy. The browser workflow keeps the required next action prominent and
  blocks a newer installation until the current release is accepted or rolled
  back.

The Linux guest and Docker environment determine compatibility, not the
hypervisor. Supported Linux VMs on Unraid, Proxmox, VMware, Hyper-V,
VirtualBox, TrueNAS, and similar servers use the same path.

## Intentionally not shipped

- production data, real plates, sample plate reads, or sample images in a fresh
  installation;
- runtime test fixtures in the production application image;
- private deployment credentials or operator-specific host automation;
- radar traffic correlation, speed columns, AI-assistant endpoints, or the
  TPMS prototype;
- automatic deletion driven by record-limit or image-retention planning values;
- unrestricted Docker socket access from the application container;
- automatic source shutdown, traffic switching, or source deletion during
  migration;
- native Windows Docker, ARM images, or appliance-specific installers.

Synthetic fixtures remain development and validation tools only. They are not
downloaded into a new user's database or image library.

## Prioritized later work

1. Keep the in-app manual synchronized with every visible Settings route and
   expand task-specific troubleshooting as real Community feedback arrives.
2. Continue performance and reliability regression coverage for ingestion,
   live views, image processing, notifications, updates, migration, and
   rollback.
3. Maintain the explicit Linux package matrix as upstream Docker and
   PostgreSQL repositories add or retire distribution releases. Unsupported
   hosts will continue to receive read-only compatibility results and manual
   prerequisite guidance.
4. Consider a native Windows or PowerShell deployment path only when its
   service management, path validation, backup, update, and rollback behavior
   can meet the same release gates.
5. Consider advanced visual-search or ReID administration only after it is
   portable, documented, default-off, privacy-reviewed, and recoverable.

ARM support is deferred and has no committed release. New roadmap work must not
weaken the sanitation, least-privilege, transactional restore, rollback, or
outbound-isolation guarantees already shipped.
