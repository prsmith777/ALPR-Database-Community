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

## Release candidate baseline — August 13, 2026

- Application `0.1.19` candidate includes named users and roles, evidence-preserving plate
  review, filter-respecting exports, the searchable help center, local privacy
  controls, and viewport-safe date/help navigation. Monitored Plates now lives
  inside Known Plates with reason, priority, monitoring-since, and read-history
  context; the former `/flagged` route redirects to that view.
- Structured operational logs now reach the protected System Logs page without
  discarding request, read, camera, component, Blue Iris trigger type, evaluated
  direction status, duration, and outcome
  fields. The page queries the bounded active file server-side, presents newest
  records first, keeps its filter panel collapsed by default, summarizes active
  filters in a compact toolbar, and keeps collapsed entries on one line so more
  rows remain visible. Camera, trigger, evaluated direction, and the first read
  ID remain inline when space permits; component, request, direction-error, and
  complete read context remain in the expanded entry as secondary tags. Expanded
  controls support level and correlation filters, pagination, and manual refresh.
  Default-on live updating refreshes the newest page every five seconds and pauses
  on older pages, hidden browser tabs, or while any entry is expanded for inspection.
  Rows expose sanitized JSON immediately below their secondary tags without a
  redundant nested disclosure, and each tag jumps to and highlights
  its exact field without returning credentials, plate values, image data, or paths.
  Accepted Blue Iris `text/plain` JSON is an
  informational compatibility event rather than a warning. Background MQTT and
  storage activity uses the sanitizer, broker credentials are not logged, and
  MQTT connects without Node's deprecated legacy URL parser.
- Dashboard Time Distribution columns now open Live Feed with the exact selected
  Last 24 Hours, Last 3 Days, Last 7 Days, Last 30 Days, or All Time window,
  browser-local hour, and every selected camera filter. The dashboard camera
  control accepts multiple cameras while an empty selection means All cameras;
  that selection drives every dashboard card, chart, preview, and result link.
  Camera and time-frame selections persist in the browser across refreshes and
  application restarts, with removed camera names pruned after configuration loads.
  One Tag Distribution card compares two side-by-side views: Tagged Vehicles
  counts each corrected plate identity once per tag, while Tagged Plate Reads
  counts every matching capture. Their slices, legends, and center totals drill into
  corresponding unique-vehicle or all-read Live Feed results while preserving
  the active time window and every selected camera.
  Total Reads, Unique Vehicles, and New Vehicles are also linked to matching
  Live Feed result sets. Unique and new result sets show one latest read per
  corrected/effective plate identity while preserving the original OCR evidence.
  Top Plates quick-look previews use the newest available Vehicle View from the
  same four recent reads in the bottom-right tile. That thumbnail is framed
  around the stored vehicle detection while the original full-resolution overview
  remains unchanged; four plate captures remain when none has an overview.
  Live Feed now resolves saved page-size and matching preferences on the first
  server response, reserves a stable two-line timestamp layout before hydration,
  and pages inexpensive read identities before joining tags, direction, vehicle
  attributes, and image presentation data. Initial loads and filter changes no
  longer aggregate the complete read history before applying the page limit.
  Live Feed review identifies the camera in its popup summary. Live Feed and Plate Database repeat result counts and
  Previous/Next controls above and below their tables, with page-top and
  page-bottom jumps in both rows.
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
  pages do not consume the working area. Settings pages now load only the
  configuration, identity, or storage-maintenance inventory used by the active
  section. Each Vehicle Setup route likewise loads only its own direction,
  overview-queue, processing, or calibration workload. The main Vehicle
  Intelligence workspace defers optional per-camera detector preview scans
  until after its primary controls paint and does not repeat those scans during
  routine status polling. Vehicle Profiles now selects its requested page
  before aggregating capture, plate, and attribute details for those profiles,
  and Needs Review requests only the selected review queue; neither route waits
  for the other profile and review workloads before it can render.
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
  Data & Privacy now separates Storage Health, Monitoring, Cleanup, and Privacy
  into route-backed top tabs so operational controls, read-only measurements,
  and policy explanations no longer form one continuous page.
- Release `0.1.15` closes the legacy Docker-image
  retention gap without weakening fail-closed inventory checks. An explicit
  fixed-worker installation may adopt only exact pre-control-plane identities
  whose rollback references are fully accounted for; production leaves unknown
  application images protected and fails the preview closed. Adoption deletes
  nothing and starts grace at the adoption time. Application and worker images
  have separate append-only ledgers, the currently attested worker remains
  protected between one-shot timer runs, and unknown images still block the
  entire manual preview. The
  retirement grace remains seven days by default but is now an audited,
  typed-confirmation Administrator setting from one to 365 days. Image cleanup
  stays manual-only, exact-preview bound, and capped at 10 images or 10 GiB per
  run. Pending and processing host requests now update automatically in the
  Cleanup page and survive server refreshes; a retry control appears only if
  automatic updates pause. Pending previews display as calculating, and both
  the browser and serialized control plane prevent duplicate category requests.
  Image receipts distinguish logical preview size from conservative
  Docker-accounted reclamation measured from the locked layer store; shared
  layers can make the reclaimed result smaller, including zero.
- Administrators can now open Settings > Release to identify the installed
  application version, build- or deployment-provided Git SHA, release channel,
  and local release notes. The view is read-only and does not fetch source, run
  Git or Docker, apply migrations, restart services, or install updates.
- Read review now keeps operators in the Live Feed image dialog with Previous
  Read and Next read actions that continue across paginated results without
  wrapping. Confirm and Next advances only after a successful confirmation,
  skips already confirmed reads across result pages, and stops when no later
  unconfirmed read remains. Both popup action rows use aligned fixed-width
  columns, so conditional review and optional actions never shift neighboring
  controls. The last Plate capture or Vehicle view choice is
  retained in the browser across sign-out and sign-in, with a temporary plate
  fallback when no vehicle image exists. Plate corrections preserve the cursor
  position while typing. Known Plate values link directly to exact individual
  reads, and plate-oriented typography requests a slashed-zero glyph to
  distinguish `0` from `O`.
- The application now contains a distinct, no-input manual database-backup
  request/status control plane. It can request only a PostgreSQL custom-format
  backup in a worker-owned approved root and reports only sanitized status,
  time, basename, verified size, and error state. It exposes no path, command,
  arguments, schedule, or restore operation. The button fails closed unless a
  fresh worker explicitly advertises `database-backup-create-v1`. The reviewed
  fixed adapter and runtime tooling are installed on staging and production and
  passed the capability-present and capability-absent PostgreSQL 17 heartbeat
  gates. Its
  role has only narrow SELECT/UPDATE access to the dedicated request queue and
  no application-table read or dump privileges; the adapter uses fixed Docker
  execution against the exact database container. The first authorized request
  exposed an audit-vocabulary defect and rolled back before enqueue without an
  artifact. After that defect was corrected, one separately authorized August 1
  staging request completed once and verified a 59.2 MB custom-format backup
  with no reported error. Phase 3 staging acceptance is complete. After the
  separately approved production installation and activation, an August 2
  production request completed and verified the 64,806,352-byte custom-format
  backup `alpr-postgres-20260802T164636Z-1.dump`. Pending and processing backup
  status now refresh automatically in the page, with a manual status-check
  fallback after repeated transport failures.
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

**Partially delivered:** the administrator Storage Health view provides direct
filesystem/database measurements, exact source-image, thumbnail, and derived
asset totals, configurable warning/critical thresholds, and clearly labeled
growth projections. It reports index-confirmed missing sources and records
without image paths separately. Retention and record-limit planning runs
outside ingestion in a scheduled, PostgreSQL-lock-protected single-flight
worker. Bounded, resumable filesystem reconciliation inventories the approved
image, thumbnail, and derived roots; records exact orphaned-file and
missing-reference paths; defers post-snapshot files; and reports progress,
totals, bytes, errors, and a review sample.

Storage maintenance now records run status, duration, reclaimed space,
scheduler heartbeat, next run, failures, and rate-limited SMTP/signed-webhook
alert state. Maintenance webhook destinations are write-only in browser state,
survive unrelated policy saves, and have separate Replace, Test, and Clear
controls; credential changes are audited. New alert queue entries omit the
destination, legacy entries are scrubbed during migration, current values are
resolved at send time, and unsent webhook work is retired when the destination
is cleared; a request already in flight during Replace or Clear may still reach
the prior destination. Administrators can
request a safe preview and separately confirm a
manual cleanup of generated `derived/` files that remain unreferenced after
an execution-time database and filesystem identity check. Automatic cleanup
now has a separate, append-only Administrator approval history and remains
off by default. Its sole approved implementation category is generated
derived orphans. Scheduled runs require fresh zero-error reconciliation
provenance, enforce file/byte/time caps, revalidate approval and all reference
and filesystem safeguards, make reconciliation due afterward, and suspend on
the first failure until a newer successful reconciliation and Administrator
acknowledgement. Source images, thumbnails,
database rows, referenced captures, Docker objects, current releases, and
verified rollback backups have no application deletion path. Docker and backup
measurements use an optional stale-checked read-only host snapshot; the app
never receives the Docker socket or writable backup access.

Phase 3 now supplies a fail-closed database intent/receipt control plane for
three independent host categories: dedicated ALPR Docker build cache,
worker-ledger-confirmed retired ALPR images, and verified rollout backups.
Candidate discovery and opaque preview tokens are worker-owned; previews are
short-lived, single-use, exact-set and environment/policy/generation bound.
Cache and backup schedules remain separately approved and default off, while
unused-image automation remains unsupported. These controls remain unavailable
until the documented fixed host service is independently installed. That
service is installed and active on staging and production. See
`docs/host-maintenance-worker-contract.md`.

The Cleanup UI now exposes the existing protected recovery transaction when a
host category's safety breaker is open. An Administrator must type that
category's displayed acknowledgement phrase. The server locks the current
breaker, binds the failed destructive receipt that opened it, requires newer
healthy worker heartbeat and inventory evidence, and appends immutable actor
and worker evidence before closing only that breaker. Acknowledgement deletes
nothing, leaves all host schedules disabled, and requires a separately queued
read-only preview before any cleanup request.

The repo-side manual database-backup increment uses its own one-active-request
queue rather than a cleanup category. A fixed adapter must create and verify a
PostgreSQL custom-format dump in the approved backup root, then return only a
bound basename, size, checksum, verification marker, and timing receipt. The
operation has a fixed 50 GiB output ceiling. The UI stays disabled until the
worker heartbeat advertises the exact versioned
capability. Staging now has the separately reviewed fixed adapter and runtime
image using fixed Docker execution against the exact database container. Its
installer extends the restricted ACL only with SELECT/UPDATE access to the
dedicated request queue, without application-table read or dump privilege.
Capability gating, identity binding, one locked worker cycle, timer activation,
and preview-only maintenance validation passed on staging. The first authorized
backup request rolled back atomically on an audit-vocabulary constraint before
enqueue and created no artifact. After the browser and worker audit events were
corrected, one separately authorized August 1 staging request completed once
and verified a 59.2 MB custom-format backup with `Error: None`. Phase 3 staging
acceptance is complete. The separately approved production worker installation,
activation, and application recreate then completed successfully. One August 2
production request verified the 64,806,352-byte custom-format backup
`alpr-postgres-20260802T164636Z-1.dump`. Read-only backup catalog integration is
now under local development: the application models immutable, path-free worker
snapshots and redacted retention previews while hard-disabling rollback-backup
execution and scheduling. Catalog-bound expiring approval, destructive
retention, in-app restore, and automatic backup scheduling remain deferred;
restore remains an external recovery procedure.

Settings also includes a read-only Release view for the application version,
build- or deployment-provided Git SHA, release channel, and local release
notes. Updates remain externally orchestrated.

- Delivered foundation: move retention and record planning out of ingest into
  a scheduled, single-flight, dry-run-only maintenance worker with durable
  status reporting.
- Delivered foundation: bounded, reviewable, read-only filesystem
  reconciliation with durable exact orphan/missing-reference inventory.
- Delivered foundation: configurable capacity thresholds, exact application
  storage categories, maintenance run/heartbeat visibility, durable
  rate-limited alerts, and confirmed manual cleanup limited to regenerated
  unreferenced derived assets.
- Delivered increment: separately approved, default-off automatic cleanup for
  reconciliation-confirmed generated derived orphans only, with immutable
  100-file/1-GiB caps and a five-minute candidate-admission budget with
  bounded per-candidate database waits, minimum daily interval, minimum seven-day
  grace, durable provenance, alert/audit history, and a fail-closed circuit
  breaker.
- Delivered increment: category-specific typed Administrator acknowledgement
  for a host-maintenance safety breaker, bound to the current breaker, its
  failed destructive receipt, and newer healthy worker evidence. The immutable
  acknowledgement closes only that breaker, deletes nothing, keeps schedules
  disabled, and does not replace a separate read-only preview.
- Delivered increment: read-only PostgreSQL table maintenance and transaction
  ID age observability, plus the fail-closed application control plane for one
  manual custom-format database backup. The reviewed fixed worker adapter is
  deployed and capability-validated on staging and production. Its first authorized
  create attempt exposed an audit-vocabulary defect and rolled back without an
  artifact. After that defect was corrected, one separately authorized August 1
  staging request completed once and verified a 59.2 MB custom-format backup
  with no reported error. Phase 3 staging acceptance is complete. After a
  separately approved production installation and activation, one August 2
  production request completed and verified a 64,806,352-byte custom-format
  backup. Keep catalog integration, in-app restore, automatic scheduling, and broader
  backup-verification jobs deferred unless this single-owner deployment develops
  a concrete need. Consider controlled `VACUUM ANALYZE` only as a separately
  reviewed future increment.
  Do not expose an arbitrary SQL or shell console.
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
  volumes. No source drive is mounted and no BVR recording is copied into ALPR;
  the later Street Overview path uses only a short API-generated temporary export.
- Durable Blue Iris vehicle-frame processing implemented: every accepted live
  read is queued only after its database transaction commits, then a bounded
  worker samples an initial 17 timeline JPEGs and retains one best vehicle
  view. Weak or incomplete initial results expand adaptively to no more than 29
  samples. Stored plate geometry anchors the event vehicle, Vehicle ReID tracks
  it through the sampled sequence, and completeness, sharpness, exposure,
  contrast, useful size, and detector confidence determine the winner. Atomic
  claims, processing leases, capped transient retries, camera-name resolution,
  and explicit terminal reasons make the queue recover safely across restarts.
  Historical reads are opt-in by camera and optional date range, prioritized
  behind live work, and independently pausable in Vehicle Intelligence.
  Vehicle Views now exposes worker state, live backlog, and the last worker
  error, while Recognition Feed shows attempt-aware processing failures and
  lets authorized reviewers explicitly retry an individual failed or
  unavailable vehicle view.
- Blue Iris ordered zone-crossing direction implemented as the replacement for
  the unsuccessful dense clip vehicle-direction experiment. The existing plate web
  action may include `"trigger_type":"&TYPE"`; ALPR normalizes an exact value
  such as `MOTION_A>B`, maps it through the selected camera's two semantic
  direction labels, and stores the raw trigger plus versioned mapping result on
  the same read. Camera setup requires two exact reverse crossings and exposes
  received, mapped, unknown, and unmapped totals. Live validation completed for
  Street LPR 1/2 and Entry LPR 1/2. New mapped reads now use the Blue Iris
  result as displayed direction and emit the existing direction notification
  event immediately; missing, disabled, shorthand, and unmapped crossings fall
  back to Vehicle ReID. Monochrome nighttime captures bypass both direction
  sources and display `Unavailable nighttime`. Legacy shadow observations and
  historical direction assignments are not rewritten. The former dense 100-millisecond clip
  sampling and vehicle-detection direction worker remain removed.
- Plate-anchored daytime Street Overview Vehicle Views implemented as the
  corrective primary path. Each new mapped Street LPR read selects an enabled
  primary profile by plate camera plus validated Blue Iris direction in the
  same atomic claim, snapshots that profile revision, adds the signed timing
  delta to the read timestamp, and requests one read-owned eight-second
  temporary timeline export from the continuous Street Overview recording.
  Claims wait for the calculated source window, one second of export padding,
  and a short Blue Iris finalization grace. ALPR validates the returned UTC,
  duration, and configured minimum resolution. Because the installed Blue Iris
  may reject status queries for an accepted reserved `@record`, the worker checks
  only that exact reserved download URI at five-second intervals. It downloads
  only when the owned URI is available; a missing global-list entry is not
  completion, and the full MP4 must still pass local FFprobe validation.
  After validation ALPR deletes its local MP4 and working frames. Blue Iris
  remains responsible for age and size retention of its generated Clipboard
  export. ALPR never sends a remote delete request and therefore does not need
  Blue Iris Administrator access.
  FFmpeg normalizes source timestamps and extracts exactly 61 local analysis
  frames over the profile-derived six-second window at 100-millisecond spacing.
  Frame selection follows the continuous vehicle track nearest the calculated
  anchor, accepts a uniquely owned confident one-edge crop when necessary,
  ignores nonviable detector specks, and refuses two viable tracks instead of
  assigning an unrelated vehicle. Source frames must remain color/daytime.
  Bounded selection telemetry persists requested range, sample availability,
  detections, viable tracks, completeness, edge contact, and failure reason.
  Analysis remains bounded to 1280-pixel frames, while the saved Vehicle View is
  extracted from the original verified export at the exact selected 10-fps slot
  and full exported resolution. ALPR explicitly disables re-encoding and requests
  the recorded main-stream video, while still enforcing a fail-closed minimum
  output resolution. Each semantic read, source window, and integer profile
  revision now has a stable SHA-256 export identity. Before its single allowed
  `cmd:export`, the ledger persists the pre-existing Blue Iris paths. Any
  exception after dispatch, including the installed server's observed case of
  reporting rejection while creating the MP4, is treated as acceptance-uncertain
  and reconciled at five-second intervals without a blind resubmit. A normal job
  adopts only one newly created exact camera/time/duration match; upgrade recovery
  may deterministically reuse one of several equivalent retained legacy duplicate
  exports without creating another. Claim-owned monotonic ledger transitions prevent a
  stale worker from regressing a downloaded export, while the final read commit
  verifies the downloaded export token and immutable profile ID/revision
  snapshot. No-op profile saves preserve the integer revision and therefore do
  not create a second semantic export identity. Attempt-unique atomic files prevent a reclaimed worker from
  overwriting a winner. The
  additive constraints remain migration-safe for community installations:
  legacy primary tolerances above 3000 milliseconds and same-camera source rows
  are preserved but excluded from claims until corrected through settings.
  Active Vehicle View diagnostics report the real plate-read queue and stable
  export ledger rather than the retired candidate queue, including started,
  active, downloaded, failed, and duplicate-start-violation totals. Every
  idempotent queue-kind constraint also accepts existing `overview` work, and
  every intermediate status constraint accepts active `processing` rows,
  before later migration blocks run. An upgrade therefore cannot fail merely
  because plate-owned overview work already exists or is in flight. The
  selected JPEG is written directly to its originating read as an overview
  primary image. Work is claimed oldest first, refreshed by heartbeat, and bound
  by a non-extendable five-minute deadline; expired second attempts become an
  explicit failed state rather than remaining Processing. A released claim
  retains its consumed attempt and waits before its one bounded retry; it can
  never reset the counter and create an unlimited series of duplicate Blue Iris
  Clipboard exports. Recovery requires an exact local start date/time and a
  separate read-only preview before queuing. It requeues only pending, stuck,
  and allowlisted transient operational failures once per read; it cannot
  silently reset itself forever. The export identity remains read-owned, so
  paired Street LPR 1/2 reads may each create one export when both primary jobs
  succeed. The paired-read phase is now implemented as a separately observable,
  shadow-first fallback. It derives each read's Overview anchor from the stored
  profile snapshot, then requires exact corrected plate identity, the same
  validated Blue Iris direction, different Street LPR cameras, the same Overview
  source, camera order, bounded anchor agreement, and unique one-to-one ownership.
  Shadow mode records proposals and rejections without changing data. Active
  mode may copy only an `overview_primary` image into a separate target-read file
  after the companion terminally fails with `VEHICLE_NOT_VISIBLE` or
  `RECORDING_UNAVAILABLE`; the final write rechecks both reads, the source path,
  profile revisions, and claim state. Direct source-read provenance is retained.
  This fallback cannot overwrite a ready image, chain from a shared image, or
  fill ambiguity, multi-vehicle, nighttime, daylight, direction, profile, or
  configuration outcomes. It intentionally does not delay or coalesce two fresh
  primary exports.
  Street Overview requires no motion or web-request action.
  Monochrome plate reads remain terminal `Unavailable nighttime` and make no
  timeline requests. The former candidate tables and historical records remain
  intact for compatibility, but independent candidate ingestion no longer owns
  the live path. Entry LPR driveway fallback is implemented as the final
  shadow-first read-to-read layer after primary retrieval and Street companion
  sharing. Administrators configure explicit routes from an existing Street
  camera and direction to two configured Entry LPR camera slots, one Entry
  direction, a signed expected delta, tolerance, and inter-camera event window.
  Evidence from both Entry cameras is preferred, but a single Entry read may
  qualify when it has authoritative matching Blue Iris direction, bounded route
  timing, a ready daytime Cam143 Vehicle View, acceptable plate identity, and no
  competing plausible event. Exact corrected plate identity is preferred. One
  confusion-normalized edit is permitted only for plates of at least five
  characters under the stricter single-read safeguards. Active mode copies the
  selected validated Cam143 image into a separate target-read file with direct
  provenance. It never
  synthesizes a missing Street read, overwrites a ready image, processes night,
  or fills ambiguity, direction, profile, and configuration outcomes.
- Plate-anchored daytime Entry Overview Vehicle Views now reuse the same stable,
  read-owned timeline-export lifecycle as Street Overview. Administrators can
  configure Entry LPR 1 and Entry LPR 2 independently for Entering and Exiting,
  with measured signed deltas and tolerances. Entry Overview is explicitly bound
  to the Blue Iris short name `Cam143`; a blank, duplicate, or mismatched binding
  fails closed before an export starts. Successful frames are stored as
  `entry_overview_primary` with source context, display name, short camera ID,
  profile revision, and export provenance. This distinct source kind is excluded
  from Street companion sharing at discovery, claim, decision, and write time.
  Known monochrome nighttime reads are not queued and do not initialize or call
  Blue Iris. Blue Iris initialization occurs only after an eligible read is
  claimed; initialization failures release that exact claim into the bounded
  retry policy and back off the worker instead of cycling through the backlog.
  No Entry Overview motion action, camera clone, or second export worker is
  required. Direct Entry mappings and the rare Street-to-driveway route are
  deliberately separate: each eligible Entry LPR read retrieves its own Cam143
  primary view, while an existing Street read may be considered only under one
  configured route. Two matching Entry reads provide stronger corroboration and
  are preferred. A single Entry read may be used only when it supplies the
  authoritative matching direction and passes the stricter identity, timing,
  payload, and ambiguity checks. A separately gated Cam143 payload may supply
  only a ready daytime `entry_overview_primary` image owned by that selected
  direction-authoritative read; Cam143 never creates or identifies the Street
  event. Route
  matching and payload use each start Off/Shadow and must both be Active before
  a validated payload can be copied to a distinct target-read file.
- A separate, direction-independent Entry Overview history campaign can upgrade
  retained Entry LPR 1/2 reads from an administrator-selected time range,
  including reads that predate reliable direction metadata. It uses immutable
  Cam143 anchor profiles instead of inventing a direction, previews a frozen
  high-water set before changing data, and admits work only in explicit batches
  of 1, 5, 25, or 250 behind all live processing. The 250-read option changes
  only how much reviewed work is admitted; the worker remains sequential and
  pause, cancellation, bounded retry, and live-read priority remain in force.
  Retained plate images provide the
  authoritative color/night preflight before Blue Iris is initialized; known
  monochrome or unreadable evidence therefore creates no export. Legacy
  plate-camera Vehicle Views are eligible for upgrade, but remain visible until
  a new full-resolution Cam143 frame has validated and won an exact atomic
  replacement check. Existing Entry Overview primary/history views are never
  replaced by the campaign. Pause, resume, cancellation, deadlines, bounded
  retries, stable export identity, and run progress survive worker restarts.
  Blue Iris continues to own Clipboard retention.
- Terminal transient Entry Overview history import failures now expose one
  explicit operator retry cycle in Vehicle Views. The retry reopens the same
  immutable job, retains its stable Blue Iris export identity, resets only its
  bounded processing-attempt budget, and preserves any current Vehicle View
  until a validated Cam143 replacement wins the exact database transition.
  Successful, nighttime, vehicle-not-visible, and multi-vehicle outcomes are
  excluded, and a job cannot receive a second operator retry.
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
Street LPR 1, Street Overview, and Entry Overview are installed. Street Overview
and Entry Overview supply strong daytime vehicle images but are monochrome at
night and are not expected to read a plate. Entry Overview is Blue Iris `Cam143`.
Street LPR 1/2 direction will use Blue Iris's existing motion tracker and
ordered `&TYPE` crossing rather than ALPR vehicle detection. Camera-specific
zone maps and direction meanings were validated with live traffic before
promotion. Vehicle ReID remains the automatic fallback if Blue Iris does not
emit a usable ordered crossing; the failed vehicle-detection clip pass will not
be restored. Monochrome nighttime captures do not receive a direction result.

- Expand the implemented asynchronous color, coarse-type, and direction
  observations to make/model/year with per-field confidence,
  provider/model/version provenance, raw result, status, and error.
- Store make, model, year range, alternate OCR candidates, and bounding boxes;
  expand current orientation observations with optional multiframe motion
  validation before speed claims.
- Continue monitoring camera-scoped Blue Iris mapping diagnostics after
  promotion, especially close vehicles and nearby opposing traffic. Keep
  missing, shorthand, and unmapped trigger values on the ReID fallback path.
  Mapping revisions remain independent from ReID calibration, and validation
  totals and recent observations stay scoped to one camera.
- Continue validating the corrected plate-anchored daytime overview pipeline
  with live production traffic.
  Confirm the signed Street Overview timing profiles for Street LPR 1 (normally
  within about one second) and Street LPR 2 (roughly four to five seconds).
  Measure and validate four Entry Overview primary mappings for Entry LPR 1/2
  Entering and Exiting rather than guessing deltas from sparse traffic. Confirm
  Cam143 provenance, full-resolution saved frames, zero nighttime Blue Iris
  calls, and strict exclusion from Street companion sharing.
  Continue observing guarded paired-Street-read sharing and the implemented
  Entry LPR route fallback. Start Entry fallback in Shadow, configure only the
  two approved driveway routes, and manually verify plate evidence, signed
  timing, source/corroborating reads, and one-to-one decisions before enabling
  writes. Review every ambiguous or unmatched outcome before changing
  tolerances; do not synthesize Street reads, enable nighttime processing, or
  restore the retired clip-based direction analyzer.
- Validate Cam143 fallback payload proposals in Shadow against the guarded
  Entry-LPR plate, direction, and timing decisions before enabling writes.
  Confirm that dual-camera evidence is preferred and that every single-read
  proposal has authoritative matching Blue Iris direction, an exact or guarded
  one-edit plate match, bounded timing, a clear ambiguity margin, and a ready
  daytime `entry_overview_primary` payload owned by that same read. Leave
  missing, stale, nighttime, processing, conflicting-direction, short-fuzzy, or
  ambiguous evidence unchanged. Never let the overview image establish identity
  or synthesize a missing Street read.
- Expand Vehicle ReID calibration with larger labeled local samples and
  camera-pair reporting before making stronger labels or applying thresholds.
- Consider pgvector only when the bounded in-process cosine scan no longer
  meets latency targets.
- Render configurable overlays at view/export time and cache derived assets;
  never burn overlays into the original capture.

## Operational logging roadmap

- Delivered foundation: bounded persistent JSON application logs, request IDs,
  authenticated size-limited JSON ingress, sanitized ingress receipts, explicit
  trigger-field state, and Blue Iris content-type compatibility.
- Delivered operator visibility: bounded server-side System Logs filtering and
  pagination, default-collapsed filters with active-filter summaries, denser
  log rows, Blue Iris trigger/direction context, expandable sanitized JSON,
  default-on five-second live refresh with inspection-aware pause, request-ID
  copy with direct-LAN HTTP fallback, bidirectional expanded request/receipt
  navigation, active-file usage, normalized compatibility severity, and
  sanitized background-runtime logging. An Administrator/Auditor ingress-receipt
  explorer adds bounded request, read, camera, outcome, error, and date filters
  plus direct correlation to operational logs and the exact resulting read.
  Versioned v2 receipts add sanitized trigger-alias conflict counts and exact
  duplicate-target read IDs without retaining alternate values or plates.
- Delivered per-read evidence: new accepted reads append a sanitized durable
  timeline for read persistence, direction resolution, notification outbox
  handoff, Vehicle View queue state, and legacy Pushover completion. The
  read-filtered Logs view keeps this timeline collapsed above rotating
  operational logs and pauses live refresh while it is inspected. Timeline
  rows follow parent read deletion through the existing cleanup lifecycle.
- Next: add guarded late-duplicate reconciliation that may attach missing
  nonconflicting evidence but never replace established evidence or queue
  successful work twice.
- Later: expose log/table growth and retention health, preview-first cleanup,
  incident protection and export, audit retention/partitioning, and bounded
  PostgreSQL log rotation. These controls remain planned and are not implied by
  the current System Logs page.

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
