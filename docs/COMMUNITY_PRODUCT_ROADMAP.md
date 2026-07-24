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

## Release baseline — July 24, 2026

- Application `0.1.9` includes named users and roles, evidence-preserving plate
  review, filter-respecting exports, the searchable help center, local privacy
  controls, and viewport-safe date/help navigation. Monitored Plates now lives
  inside Known Plates with reason, priority, monitoring-since, and read-history
  context; the former `/flagged` route redirects to that view.
- Unified notifications now include migration preview, idempotent disabled
  copies, restricted disabled-rule editing, no-delivery simulation, shadow
  comparison, administrator approval evidence, atomic per-rule cutover, and
  immediate rollback. A July 24 production audit confirmed three retained MQTT
  rules active in the unified runtime with their legacy sources disabled. The
  two deleted Delivery-tag sources left disabled orphaned copies; this release
  adds audited retirement that preserves those rules and evidence while
  removing them from active migration workflows.
- A general-purpose notification builder is now available for new rules. It
  supports disabled drafts and versioned edits, six-level AND/OR/NOT groups,
  accepted-read, explicit/fuzzy plate, known-plate/name, tag, Monitored Plate,
  camera, confidence, read-count, and local schedule conditions, MQTT and
  Pushover actions, cooldowns, recent-read no-delivery preview with traces, and separate audited
  atomic activation/deactivation. Existing migrated copies cannot bypass their
  guarded shadow-review and cutover workflow. MQTT continues through its
  durable outbox; Pushover remains best-effort after the read transaction
  commits.
- Vehicle ReID visual search, uploaded-image queries, camera fallback profiles,
  calibration feedback, and the resumable safety-aware background index worker
  are available. Original captures remain unchanged.
- Administrators now have a read-only Storage Health view in Data & Privacy.
  It reports mounted-filesystem capacity, PostgreSQL and plate-read size,
  record/image-path counts, recent ingestion, visual-index state,
  index-confirmed missing sources, a bounded recent-file bytes/read sample,
  and estimated 70/80/90% capacity dates. It performs no cleanup or mutation.
- Read review now keeps operators in the Live Feed image dialog with a visible
  next-read action and opens image-backed reads focused on the detected plate.
  Known Plate values link directly to exact individual reads, and plate-oriented
  typography requests a slashed-zero glyph to distinguish `0` from `O`.

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
model before adding email and webhooks.

**Partially delivered:** the normalized rule, nested-condition, channel/action,
execution, delivery, and attempt records are implemented with a deterministic,
explainable evaluator. Production also has read-only migration preview,
idempotently tracked disabled copies, restricted draft editing, no-delivery
simulation, shadow comparison, administrator approval evidence, atomic
per-rule cutover, and rollback. Existing Pushover or MQTT delivery stays on its
  legacy path until that individual copy has positive evidence and an explicit
  cutover. Disabled copies whose legacy source was intentionally removed can be
  retired with an audited, non-deleting workflow. The focused builder for new
  rules now covers accepted reads, the principal plate/context filters,
  schedules, MQTT/Pushover actions, cooldown, preview, and audited activation.
  The next builder increment adds persisted-event-time read-count metrics for
  same-plate, same-camera, and global lifetime/period thresholds; explicit
  exact, contains, wildcard, OCR-confusion, and bounded edit-distance plate
  strategies; six-level AND/OR/NOT visual composition; and expandable
  no-delivery preview traces. Remaining work is scheduled camera inactivity,
  durable channel-neutral delivery, and additional channels below.

Initial triggers and conditions:

- arrival and any accepted read;
- plate seen at least X times within Y minutes (builder/runtime delivered);
- no/fewer than X reads for a camera within Y minutes;
- active weekdays and local-time windows, including overnight windows;
- camera/site/direction, known-plate name, tag, and monitored-plate state;
- lifetime or period read-count thresholds (accepted-read builder/runtime delivered);
- exact, contains, wildcard, OCR-confusion, and edit-distance plate matching
  (delivered); OCR-candidate matching remains dependent on candidate data;
- confidence thresholds and, when available, vehicle make/model/color/type.

Operational behavior:

- deeper visual AND/OR/NOT composition beyond the focused builder's former one
  nested group (delivered with a six-level safety bound);
- explicit rule timezone and event-time evaluation;
- quiet hours and channel-neutral delivery retries/dead-letter state (MQTT
  already has durable retry and deduplication; Pushover is currently
  best-effort after commit);
- expandable recent-read preview traces are delivered; full alert-history
  trace presentation remains;
- account-wide Pushover monthly quota visibility so rule volume can be planned
  before the service rejects messages.

### Phase 4 — Operations, storage, and updates

**Partially delivered:** the administrator-only, read-only Storage Health view
provides direct filesystem/database measurements, bounded count queries, a
120-read asset-size sample, and clearly labeled growth projections. It reports
index-confirmed missing sources and records without image paths separately.
It does not recursively reconcile the filesystem or expose any maintenance
action.

- Move retention and record pruning out of ingest into a scheduled,
  single-flight maintenance worker.
- Add bounded, reviewable filesystem reconciliation for exact orphaned-file
  inventory before any cleanup workflow is considered.
- Add safe reconcile, prune, `VACUUM ANALYZE`, backup, restore-preflight, and
  backup-verification jobs. Do not expose an arbitrary SQL or shell console.
- Display current version, git SHA, release channel, and release notes.
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
- Add asynchronous vehicle observations with per-field confidence,
  provider/model/version provenance, raw result, status, and error.
- Store plate jurisdiction/region, make, model, color, body type, year range,
  orientation, alternate OCR candidates, and bounding boxes.
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
