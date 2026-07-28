# ALPR Database Community product roadmap

This roadmap translates the community fork's feature requests into a staged
architecture. It is intentionally ordered so that advanced automation and AI
features are built on named users, immutable evidence, auditable changes, and
reliable background processing.

## Product principles

1. Preserve the original capture and OCR result. Corrections, overlays, and AI
   enrichment are derived records, never destructive replacements.
2. Make uncertain matching explainable. Show the observed plate, proposed
   match, score, and reason; do not present fuzzy or image similarity as proof.
3. Keep ingestion fast. Notifications, enrichment, exports, indexing, and
   cleanup run asynchronously after a read is committed.
4. Default to local processing and explicit opt-in for external services.
5. Authorize every server operation. Hiding a button is not access control.
6. Audit sensitive searches, exports, corrections, rule changes, and
   destructive maintenance.

## Release baseline — July 28, 2026

- Application `0.1.13` includes named users and roles, evidence-preserving plate
  review, filter-respecting exports, the searchable help center, local privacy
  controls, and viewport-safe date/help navigation. Monitored Plates now lives
  inside Known Plates with reason, priority, monitoring-since, and read-history
  context; the former `/flagged` route redirects to that view.
- Unified notifications now include migration preview, idempotent disabled
  copies, restricted disabled-rule editing, no-delivery simulation, shadow
  comparison, administrator approval evidence, atomic per-rule cutover, and
  immediate rollback. A July 24 production audit confirmed three MQTT rules
  active in the unified runtime with their legacy sources disabled. This
  release adds verified finalization: after a successful post-cutover delivery,
  credential-free source snapshots and audit evidence are retained while the
  legacy MQTT or Pushover rows are removed. Finalized or retired unified targets
  then return to the normal Notification Rules list instead of remaining hidden
  behind the completed migration workflow. Both separate legacy rule-management
  surfaces are gone; all new rules are created in Notifications. The
  two deleted Delivery-tag sources left disabled orphaned copies; this release
  adds audited retirement that preserves those rules and evidence while
  removing them from active migration workflows.
- A general-purpose notification builder is now available for new rules. It
  supports disabled drafts and versioned edits, six-level AND/OR/NOT groups,
  accepted-read, explicit/fuzzy plate, known-plate/name, tag, Monitored Plate,
  camera, confidence, read-count, and local schedule conditions, MQTT,
  Pushover, SMTP email, and signed webhook actions, cooldowns, recent-read no-delivery preview with traces, and separate audited
  atomic activation/deactivation. Disabled rules can now be deleted from the active workspace
  through an exact-name/version confirmation while immutable delivery and audit
  history remains available. Legacy-migrated copies that inherited UTC are
  normalized to the configured local timezone across rule, quiet-hours, and
  schedule settings. Existing migrated copies cannot bypass their
  guarded shadow-review, cutover, and finalization workflow. MQTT continues through its
  durable outbox. This release adds scheduled camera inactivity checks,
  explicit rule time zones and persisted event-time evaluation, quiet hours,
  durable unified Pushover/email/webhook retries and dead-letter state, full recent alert traces,
  direct channel tests, webhook HMAC signing and target safety controls,
  and Pushover quota visibility. Notification Rules is now a focused Rules and
  Activity workspace without channel-setup shortcuts. Settings links directly
  to MQTT, Pushover, SMTP email, and Webhook instead of using a separate
  Integrations overview. Every channel page uses functional header tabs; the
  Pushover Usage tab exposes monthly allowance and remaining-message metrics
  separately from credentials, defaults, and direct testing. New notification
  drafts resolve the browser-local time zone on every Create rule action so
  rule, quiet-hours, and Schedule clocks stay aligned. Live accepted-read
  evaluation now resolves tag membership independently from Known Plates,
  matching preview and historical-review semantics; MQTT, email, and webhook
  payloads preserve those event tags without falsely marking the plate as
  known. The former
  `/mqtt` address redirects to Settings > Integrations > MQTT, and MQTT no longer
  occupies a primary-sidebar slot. Migrated MQTT and Pushover
  copies use the same shadow approval, atomic cutover, rollback, and verified
  finalization workflow.
- Vehicle ReID visual search, uploaded-image queries, camera fallback profiles,
  calibration feedback, and the resumable safety-aware background index worker
  are available. Administrators can also configure camera-specific front/rear
  direction meanings with custom labels and a confidence threshold, then
  calibrate the local classifier from audited front/rear examples. Unconfigured,
  under-trained, and low-confidence captures remain Unknown. Original captures
  remain unchanged, ingestion does not wait, and this phase stores no clips.
  A paced, safety-aware historical direction backfill follows the existing
  Vehicle ReID index across all configured cameras, resumes from durable
  observations, preserves human reviews, tracks bounded failures, and exposes
  progress plus a one-batch administrator control. Administrators can preview
  and queue an explicit selected-camera or all-camera re-evaluation after
  improving calibration. Current machine results remain visible until each
  replacement is ready, human reviews remain authoritative, and the durable
  historical queue can be paused or resumed without stopping direction work
  for newly ingested reads. New live work is prioritized and appears as Pending
  rather than Unknown until analysis finishes.
  Historical evaluation does not emit notifications.
  Settings > Vehicle Setup now separates Cameras, Vehicle Views, Processing,
  and Calibration into clean route-backed pages. Camera-specific vehicle-view
  and re-evaluation controls include their own selectors and name the selected
  camera instead of depending on a selection hidden in another section. The
  Settings navigation collapses to an icon rail on desktop so future setup
  pages do not consume the working area.
  Blue Iris integration can now correlate a plate-read timestamp with continuous
  BVR metadata and sample a fixed 17-frame, half-second timeline window through the
  read-only JPEG endpoint. Local vehicle detection selects one best overview
  frame, stores only that derived JPEG on the read, and exposes Plate capture /
  Vehicle view controls without copying BVR files. Expired recordings become a
  terminal unavailable state; transient connection failures remain retryable.
  Accepted live reads enter a durable post-commit queue and are processed by a
  restart-safe background worker without slowing ingestion. Camera display names
  are resolved to Blue Iris camera identifiers before retrieval. Historical work
  remains explicitly administrator-queued by camera and optional date range,
  runs behind live work, and can be paused independently. Recognition Feed shows
  queued, processing, retry-pending, recording-unavailable,
  vehicle-not-visible, and camera-not-mapped states when no vehicle frame exists.
  Per-read color observations retain confidence and local algorithm provenance.
  Automatic local coarse vehicle-type observations classify car, van, truck,
  or bus with confidence and OpenVINO provider/model provenance. New reads are
  evaluated during indexing and the paced worker fills missing historical
  observations without manual labeling or external image transfer.
  Descriptor-only vehicle profiles exclude plate text, require conservative
  similarity and winner-margin gates, and expose bounded Confirm vehicle or
  Different vehicle review. Effective plates from human-confirmed members are
  proposed separately and require explicit audited confirmation or rejection;
  only confirmed associations become trusted future mismatch baselines.
  Automatic named-feature classification and mismatch alerts remain disabled.
- Administrators now have a read-only Storage Health view in Data & Privacy.
  It reports mounted-filesystem capacity, PostgreSQL and plate-read size,
  record/image-path counts, recent ingestion, visual-index state,
  index-confirmed missing sources, a bounded recent-file bytes/read sample,
  and estimated 70/80/90% capacity dates. It performs no cleanup or mutation.
- Administrators can now open Settings > Release to identify the installed
  application version, build- or deployment-provided Git SHA, release channel,
  and local release notes. The view is read-only and does not fetch source, run
  Git or Docker, apply migrations, restart services, or install updates.
- Read review now keeps operators in the Live Feed image dialog with a visible
  next-read action, continues across paginated results without wrapping to the
  first visible read, and opens image-backed reads focused on the detected
  plate. Known Plate values link directly to exact individual reads, and
  plate-oriented typography requests a slashed-zero glyph to distinguish `0`
  from `O`.
- Recurring plate-correction aliases now default to All cameras while retaining
  an explicit current-camera-only scope for camera-specific OCR errors. An
  alias-only save repairs mappings without changing historical reads, conflicts
  can be replaced through an audited retire-and-create confirmation, and review
  reversal can optionally disable its associated active alias.

Every production candidate must update this baseline and the in-app help model
in the same release. The exact deployed Git SHA belongs in deployment status
and release records, not in this source-controlled baseline: embedding the
candidate's own SHA would become stale as soon as the documentation commit is
created. Roadmap items below describe remaining work, not an assertion that
every item in a phase is already installed.

## Delivery phases

### Phase 1 — UX and fork baseline

- Sort every data column on Known Plates, including null-safe and stable
  ordering.
- Add accessible hover/focus labels to action icons in Recognition Feed,
  Database, Known Plates, Notifications, and MQTT administration.
- Clear and refocus the password field after a failed login.
- Point dashboard and release identity at this community fork.
- Align the Database filter contract with Recognition Feed and fix the SQL
  grouping defect before exposing dormant fuzzy controls.
- Replace the Download placeholder with filter-respecting CSV and JSON export;
  add background ZIP export for images after export authorization exists.
- Remove upstream telemetry, training uploads, automatic dashboard triggers,
  and network update checks. Retain a local **Data & Privacy** page for
  retention, export, integration status, audit, and deletion controls.

### Phase 2 — Identity, roles, and evidence review

- Add named users, database-backed sessions, roles, granular permissions,
  scoped API credentials, and append-only audit events.
- Start with Administrator, Operator, Viewer, and Auditor roles.
- Replace mutable OCR truth with `observed_plate` plus nullable
  `resolved_plate` and a computed effective plate.
- Replace the ambiguous `validated` flag with pending, confirmed, corrected,
  and rejected review states.
- Add reviewer, reason, timestamp, history, and undo support.
- Rename actions to **Confirm detected plate**, **Correct this read**, and
  **Batch-correct matching reads**. Batch changes require a preview and explicit
  scope.

### Phase 3 — Unified rules and notifications

Generalize the durable MQTT rule/outbox foundation into a channel-neutral
event, condition, and action engine. Migrate Pushover and MQTT into the same
model before adding email and webhooks. Those additional channels now use the
same protected configuration, delivery, attempt, retry, and operations-history
contracts.

**Partially delivered:** the normalized rule, nested-condition, channel/action,
execution, delivery, and attempt records are implemented with a deterministic,
explainable evaluator. Production also has read-only migration preview,
idempotently tracked disabled copies, restricted draft editing, no-delivery
  simulation, shadow comparison, administrator approval evidence, atomic
  per-rule cutover, rollback, and verified MQTT/Pushover finalization. Existing Pushover or MQTT delivery stays on its
  legacy path until that individual copy has positive evidence and an explicit
  cutover. After verified unified delivery, finalization archives the
  credential-free source configuration and deletes the legacy rule so
  Notifications is the only notification rule-management system. Disabled copies whose legacy source was intentionally removed can be
  retired with an audited, non-deleting workflow. The focused builder for new
  rules now covers accepted reads, the principal plate/context filters,
  schedules, MQTT/Pushover/email/webhook actions, cooldown, preview, and audited activation.
  The builder also includes persisted-event-time read-count metrics for
  same-plate, same-camera, and global lifetime/period thresholds; explicit
  exact, contains, wildcard, OCR-confusion, and bounded edit-distance plate
  strategies; six-level AND/OR/NOT visual composition; and expandable
  no-delivery preview traces. Scheduled camera checks, explicit rule clocks,
  quiet hours, durable Pushover/email/webhook delivery, and operations history
  are delivered. Live evaluation now shares the same independent tag versus
  Known Plate semantics as preview and shadow review, including delivery
  payloads for tagged plates that are not known. Remaining work is the
  additional conditions below.

Initial triggers and conditions:

- arrival and any accepted read;
- plate seen at least X times within Y minutes (builder/runtime delivered);
- no/fewer than X reads for a camera within Y minutes (delivered with scheduled checks);
- active weekdays and local-time windows, including overnight windows;
- camera/site/direction, known-plate name, tag, and monitored-plate state;
- lifetime or period read-count thresholds (accepted-read builder/runtime delivered);
- exact, contains, wildcard, OCR-confusion, and edit-distance plate matching
  (delivered); OCR-candidate matching remains dependent on candidate data;
- confidence thresholds and, when available, vehicle make/model/color/type.

Operational behavior:

- deeper visual AND/OR/NOT composition beyond the focused builder's former one
  nested group (delivered with a six-level safety bound);
- explicit rule timezone and event-time evaluation (delivered);
- quiet hours and durable delivery retries/dead-letter state for unified MQTT,
  Pushover, SMTP email, and signed webhook actions (delivered; migrated legacy
  sources use guarded cutover and verified finalization);
- expandable recent-read previews and full recent alert-history traces with
  per-attempt delivery detail (delivered);
- account-wide Pushover monthly quota visibility on Settings and Notifications
  so rule volume can be planned before the service rejects messages (delivered).
- email and webhook actions, using protected credential references, direct test
  delivery, bounded retries/dead-letter state, operations history, HMAC-signed
  webhook payloads, and conservative destination controls (delivered).

### Phase 4 — Operations, storage, and updates

**Partially delivered:** the administrator-only, read-only Storage Health view
provides direct filesystem/database measurements, bounded count queries, a
120-read asset-size sample, and clearly labeled growth projections. It reports
index-confirmed missing sources and records without image paths separately.
Retention and record-limit planning now runs outside ingestion in a scheduled,
PostgreSQL-lock-protected single-flight worker. The first rollout is strictly
dry-run: Storage Health reports the last result and next run, while database
rows and files remain untouched. Bounded, resumable filesystem reconciliation
now inventories the approved image, thumbnail, and derived roots; records exact
orphaned-file and missing-reference paths; defers post-snapshot files; and
reports progress, totals, bytes, errors, and a review sample in Storage Health.
It exposes no destructive maintenance action. Settings now also includes a
read-only Release view for the application version, build- or
deployment-provided Git SHA, release channel, and local release notes. Updates
remain externally orchestrated.

- Delivered foundation: move retention and record planning out of ingest into
  a scheduled, single-flight, dry-run-only maintenance worker with durable
  status reporting.
- Delivered foundation: bounded, reviewable, read-only filesystem
  reconciliation with durable exact orphan/missing-reference inventory.
- Add safe reconcile, prune, `VACUUM ANALYZE`, backup, restore-preflight, and
  backup-verification jobs. Do not expose an arbitrary SQL or shell console.
- Delivered foundation: display the current version, build- or
  deployment-provided Git SHA, release channel, and local release notes without
  host-control actions.
- Keep updates externally orchestrated: back up the database, sync an approved
  commit, build the application, preview/apply migrations, health-check, and
  roll back. The app should observe this process rather than controlling
  unrestricted Docker/host commands.

### Phase 5 — Vehicle intelligence and visual search

- Foundation implemented: local derived vehicle-region crops, source SHA-256,
  64-bit dHash, resumable newest-first indexing, existing-capture queries,
  camera/time filters, and explainable match labels and scores. Original
  captures remain unchanged and ingestion does not wait for indexing.
- Camera-specific crop setup implemented: Auto, Custom, and Full frame modes,
  live source-image preview, vehicle-context and vertical-position controls,
  versioned profiles, and camera-scoped reindexing.
- Transient uploaded-image queries implemented: drag-and-drop JPEG, PNG, or
  WebP images can use the existing camera/time filters without creating a
  plate read or storing the uploaded source.
- Plate-independent Vehicle ReID implemented with OpenVINO: a dedicated vehicle
  detector supplies a tight whole-vehicle crop and vehicle-reid-0001 supplies a
  normalized 512-value descriptor ranked by cosine similarity. Plate text is
  display metadata only and cannot affect result inclusion, score, order, or
  labels. SHA-256 remains a separate byte-for-byte duplicate check.
- Foundation search is deliberately bounded to recent filtered indexed
  captures. Its crop similarity is a candidate finder, not identity proof.
- Automatic backlog indexing implemented: a restart-safe background worker
  drains resumable batches, picks up new captures, supports persisted
  gentle/balanced/fast pacing and pause/resume controls, reports throughput and
  estimated completion, and yields when disk-space or CPU-load safety limits
  are reached.
- Calibration feedback foundation implemented: authorized reviewers can label
  stored capture pairs as the same or a different vehicle. Labels are bound to
  canonical read pairs and the exact embedding model, changes are audited, and
  a local accuracy summary can recommend—but does not automatically apply—an
  interpretation threshold after both classes have enough examples.
- Configurable single-frame direction foundation implemented: Settings >
  Vehicle Intelligence discovers current and future cameras dynamically,
  stores separate meanings for visible front and rear views, accepts custom
  compass/site labels, and applies a continuous confidence threshold. Audited
  per-camera examples calibrate a conservative ReID-assisted classifier; it
  remains collecting until both views have enough examples and preserves
  Unknown below threshold. Results include classifier/model/profile provenance,
  orientation confidence, and sample counts. No camera mappings are hard-coded
  and no video clips are stored.
- Read-only Blue Iris correlation foundation implemented: a dedicated settings
  surface stores replacement-only credentials, verifies the JSON API, lists
  cameras, and searches bounded alert metadata around a plate-read timestamp.
  New reads preserve the supplied alert clip/path/offset pointer while all BVR
  recordings and retention remain under Blue Iris on the existing DrivePool
  volumes. No drive is mounted and no video is copied into ALPR.
- Durable Blue Iris vehicle-frame processing implemented: every accepted live
  read is queued only after its database transaction commits, then a bounded
  worker samples 17 timeline JPEGs and retains one best vehicle view. Atomic
  claims, processing leases, capped transient retries, camera-name resolution,
  and explicit terminal reasons make the queue recover safely across restarts.
  Historical reads are opt-in by camera and optional date range, prioritized
  behind live work, and independently pausable in Vehicle Intelligence.
- Per-read vehicle color observations and reviewable vehicle profiles are
  implemented as an evidence-gathering phase. Color is stored with confidence
  and local algorithm provenance against the individual read, never copied onto
  a plate. Descriptor-only grouping excludes plate text and creates either a
  seed cluster or a reviewable suggested assignment. Effective-plate links are
  independently suggested and require audited confirmation or rejection.
  Vehicle Intelligence now has a dedicated top-level Needs Review tab that
  displays one independently paginated queue at a time for vehicle matches,
  plate associations, direction examples, or administrator setup attention.
  Server-side profile search, status, camera, and page controls ensure browsing
  is not limited to the newest 100 profiles.
  Recognition Feed shows assignment, direction, and color evidence in its image
  dialog. Confirmed associations are a baseline only; mismatch labels and alerts
  remain disabled.
- Expand the implemented asynchronous color, coarse-type, and direction
  observations to make/model/year with per-field confidence,
  provider/model/version provenance, raw result, status, and error.
- Store make, model, year range, alternate OCR candidates, and bounding boxes;
  expand current orientation observations with optional multiframe motion
  validation before speed claims.
- Validate automatic live best-frame selection and explicitly queued historical
  processing against a wider production sample before adding multiframe motion
  direction or speed estimation.
- Expand Vehicle ReID calibration with larger labeled local samples and
  camera-pair reporting before making stronger labels or applying thresholds.
- Consider pgvector only when the bounded in-process cosine scan no longer
  meets latency targets.
- Render configurable overlays at view/export time and cache derived assets;
  never burn overlays into the original capture.

## Fuzzy matching vocabulary

The UI must not use one unexplained **Fuzzy** checkbox for several behaviors.

| Mode | Example | Intended use |
| --- | --- | --- |
| Exact | `ABC123 = ABC123` | Lowest false-positive alerts |
| Contains/partial | `ABC` within `1ABC234` | Incomplete plate searches |
| Wildcard | `ABC*23` | User-controlled unknown positions |
| OCR confusion | `O/0`, `I/1`, `B/8` | Common recognition ambiguity |
| Edit distance | insertion/deletion/substitution/transposition | Broader approximate search |
| OCR candidate | alternate recognizer candidate matches | Uses model evidence directly |

Alert rules should default to exact matching. Broader modes require an explicit
sensitivity and a preview of likely matches. The existing MQTT ambiguity-safe
matcher should become the shared identity matcher rather than creating another
looser implementation.

## Proposed core records

The exact migration design will be reviewed separately, but these are the
required concepts:

- `users`, `roles`, `permissions`, `user_roles`, `sessions`,
  `api_credentials`, `audit_events`;
- immutable observed read plus resolved identity and `plate_read_reviews`;
- `notification_rules`, condition groups/conditions, actions/channels,
  executions, deliveries, and attempts;
- `vehicle_observations` and leased enrichment jobs;
- `capture_assets` for original/crop/thumbnail hashes and embeddings;
- export and maintenance jobs with progress, actor, result, and expiry;
- a numbered `schema_migrations` ledger.

## Commercial feature evidence

These links are first-party vendor documentation and product material. They
confirm feature availability, not independent accuracy claims.

- Plate Recognizer ParkPow documents count-within-period alerts, time/day
  schedules, tag/watchlist and vehicle conditions, email/webhook/MQTT actions,
  fuzzy camera matching, camera traffic anomaly detection, roles, and audit
  logs: [alert rules](https://guides.platerecognizer.com/docs/parkpow/user-guide/settings/alerts/),
  [camera matching and anomaly detection](https://guides.platerecognizer.com/docs/parkpow/user-guide/settings/cameras/),
  [users and roles](https://guides.platerecognizer.com/docs/parkpow/user-guide/settings/users/),
  [audit log](https://guides.platerecognizer.com/docs/parkpow/user-guide/activity-log-audit/).
- Rekor documents exact/lenient watchlists, active schedules, geofence and
  direction conditions, per-list permissions, advanced historical search,
  required search justification, and local FIFO image quotas:
  [alerts](https://docs.rekor.ai/scout/scout-dashboard/configuration/alerts),
  [advanced search](https://docs.rekor.ai/scout/scout-dashboard/advanced-search),
  [search audit](https://docs.rekor.ai/scout/scout-dashboard/search-audit),
  [storage quota](https://docs.rekor.ai/scout/agent/configuration/agent-properties).
- Flock describes uploaded-image Visual Search plus vehicle-description,
  multi-location, and convoy searches:
  [Enhanced LPR](https://www.flocksafety.com/enhanced-lpr-stop-crime-patterns-that-standard-lprs-cant-see).
- Avigilon documents Appearance Search from a description, uploaded photo, or
  selected recorded vehicle:
  [ACC 7 fact sheet](https://www.avigilon.com/fs/documents/Fact-Sheet_-ACC-7.pdf).
- Genetec documents configurable maybe-match behavior and human plate
  revalidation:
  [ALPR matcher](https://techdocs.genetec.com/r/en-US/Security-Center-Administrator-Guide-5.12/ALPR-matcher),
  [Image Manager](https://techdocs.genetec.com/api/khub/documents/IealteqorKx7XS9mFyUeDA/content).

The consistent commercial strengths are explainable searches, role-scoped
access, audited investigations, reliable alert delivery, camera/storage health,
retention controls, and preservation of original evidence.
