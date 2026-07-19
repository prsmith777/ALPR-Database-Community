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
- Disable upstream telemetry/training by default and remove its automatic
  dashboard trigger. Retain a local **Data & Privacy** page for retention,
  export, telemetry status, audit, and deletion controls.

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

Initial triggers and conditions:

- arrival and any accepted read;
- plate seen at least X times within Y minutes;
- no/fewer than X reads for a camera within Y minutes;
- active weekdays and local-time windows, including overnight windows;
- camera/site/direction, known-plate name, tag, and watchlist state;
- lifetime or period read-count thresholds;
- exact, contains, wildcard, OCR-confusion, edit-distance, and OCR-candidate
  plate matching;
- confidence thresholds and, when available, vehicle make/model/color/type.

Operational behavior:

- nested AND/OR condition groups;
- explicit rule timezone and event-time evaluation;
- cooldown, deduplication, quiet hours, delivery retries, and dead-letter state;
- rule preview against recent reads;
- alert history that explains why each condition matched.

### Phase 4 — Operations, storage, and updates

- Move retention and record pruning out of ingest into a scheduled,
  single-flight maintenance worker.
- Report mounted filesystem capacity, PostgreSQL size, record/image counts,
  orphaned/missing files, reads/day, bytes/read, and projected exhaustion or
  prune dates.
- Add safe reconcile, prune, `VACUUM ANALYZE`, backup, restore-preflight, and
  backup-verification jobs. Do not expose an arbitrary SQL or shell console.
- Display current version, git SHA, release channel, and release notes.
- Keep updates externally orchestrated: back up the database, sync an approved
  commit, build the application, preview/apply migrations, health-check, and
  roll back. The app should observe this process rather than controlling
  unrestricted Docker/host commands.

### Phase 5 — Vehicle intelligence and visual search

- Add asynchronous vehicle observations with per-field confidence,
  provider/model/version provenance, raw result, status, and error.
- Store plate jurisdiction/region, make, model, color, body type, year range,
  orientation, alternate OCR candidates, and bounding boxes.
- Create a vehicle crop before indexing.
- Store SHA-256 for exact duplicates and pHash/dHash for near-identical frames.
- Store a learned vehicle embedding for cross-angle/lighting similarity. Use
  cosine similarity through pgvector or a bounded external vector index.
- Let a user upload an image or select an existing capture as the query, then
  combine similarity with vehicle, camera, and time filters.
- Rank results with clearly labeled scores and match types.
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
