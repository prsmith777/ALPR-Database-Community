# Changelog

## Unreleased

- Added configurable storage warning/critical thresholds, exact source,
  thumbnail, derived-image, database, Docker, and backup breakdowns, durable
  maintenance run/heartbeat/failure reporting, rate-limited SMTP and signed
  webhook maintenance alerts, and a typed-confirmation manual cleanup limited
  to reconciliation-confirmed generated derived-file orphans.
- Added default-off, separately Administrator-approved automatic cleanup for
  generated derived orphans only. Runs require fresh zero-error reconciliation
  provenance, enforce 100-file/1-GiB caps and a five-minute candidate-admission
  budget with bounded database waits, reject links and changed or
  referenced files, and suspend after failure until a fresh reconciliation and
  typed acknowledgement. Added read-only PostgreSQL dead/live tuple,
  autovacuum/autoanalyze, and transaction-ID-age observability; no VACUUM,
  restore, shell, unrestricted Docker, or release controls were added.
- Added a fail-closed, no-input manual PostgreSQL custom-format backup
  request/status control. It is available only when a fresh, separately
  installed worker advertises `database-backup-create-v1`, exposes no path,
  command, schedule, or restore input, and reports only sanitized verified
  status. The reviewed fixed adapter is installed, active, and
  capability-validated on staging and production. One separately authorized
  August 1 staging request completed once and verified
  `alpr-postgres-20260801T120648Z-5.dump` at 59.2 MB with no reported error.
  After the separately approved August 2 production installation and
  activation, one production request completed and verified the 64,806,352-byte
  (61.8 MB) `alpr-postgres-20260802T164636Z-1.dump`. Future production
  deployments and worker changes remain separately approval-gated.
- Fixed manual database-backup request and worker audit writes to use the
  existing `audit_events` source/outcome vocabulary. The first authorized
  staging request rolled back atomically on the prior constraint mismatch and
  created no backup artifact; the later authorized staging acceptance above
  confirms the repaired request and worker path.

- Strengthen Blue Iris best-vehicle-frame selection so edge-adjacent detections no longer stop the search early, and add a bounded sparse fallback through 16 seconds when the initial timeline still lacks a clearly framed vehicle.

- Replace the Blue Iris best-frame selector's size-heavy ranking with
  plate-anchored multiframe Vehicle ReID tracking, hard completeness
  preference, sharpness/exposure/contrast scoring, and an adaptive timeline
  extension from 17 to at most 29 read-only JPEG samples. Persist bounded
  selection diagnostics while retaining only one derived vehicle image.
- Allow administrators to explicitly reevaluate existing vehicle views while
  retaining every prior image until a replacement is successfully selected
  and saved.
- Expose Blue Iris vehicle-frame worker health and live backlog in Vehicle
  Views, show attempt-aware terminal reasons in Recognition Feed, and allow an
  authorized reviewer to retry an individual failed or unavailable vehicle
  view.
- Reorganized the administrative Vehicle Setup area into clean, route-backed
  Cameras, Vehicle Views, Processing, and Calibration pages. Queue totals are
  shown as compact tab status, optional date filters and completed-history
  re-evaluation are progressively disclosed, and the desktop Settings sidebar
  can collapse to a persisted icon rail. The operational Vehicle Intelligence
  workspace remains focused on profiles and review work.
- Added mouse-wheel zoom to the Recognition Feed image popup. Wheel changes
  now move from the midpoint to either limit in three notches while preserving
  the continuous slider limits and plate-centering behavior, and scrolling over
  the image no longer moves the underlying page.
- Stabilized the Recognition Feed date-range calendar at a fixed two-month
  footprint so navigating backward or forward no longer resizes or shifts the
  popup between months with different week counts.
- Added durable automatic Blue Iris best-vehicle-frame processing after each
  accepted live read. The background worker resolves ALPR camera names to Blue
  Iris camera IDs, samples the bounded 17-frame window without delaying
  ingestion, retries transient failures across restarts, and records explicit
  queued, processing, ready, recording-unavailable, vehicle-not-visible, and
  camera-not-mapped outcomes. Administrators can separately queue historical
  work by camera and date range, pause or resume only that historical queue,
  and inspect progress in Settings > Vehicle Intelligence.
- Added fully local automatic coarse vehicle-type observations using the
  OpenVINO Open Model Zoo model. New and historical vehicle crops can produce
  car, van, truck, or bus evidence with confidence, provider/model provenance,
  Unknown handling, and durable failure state without manual labeling or an
  external service.
- Added reviewable vehicle profiles that keep descriptor-only ReID grouping
  separate from explicit plate associations. Human-confirmed cluster captures
  create plate-link suggestions; confirmation or rejection is separately
  audited and only confirmed links become trusted future mismatch baselines.
- Replaced legacy query-string page selection with dedicated URLs throughout
  Settings, Known/Monitored Plates, Notification Rules, MQTT, Pushover, email,
  and webhook navigation. Search, sorting, pagination, and filter parameters
  remain URL-backed so filtered views can still be bookmarked and shared.
- Added previewed historical vehicle-direction re-evaluation for the selected
  camera or every configured camera. Current results stay visible until their
  replacements are ready, human front/rear reviews remain authoritative, and
  administrators can pause or resume only the historical queue. New live reads
  are prioritized, display Pending until analyzed, refresh in Live Feed without
  manual intervention, and historical work sends no notifications.

## [0.1.10] - 07-26-2026

- Added configurable per-camera vehicle direction with audited front/rear
  calibration, sortable and reviewable Recognition Feed results, and a paced,
  resumable historical backfill that preserves human decisions.
- Added Vehicle ReID color evidence and conservative reviewable shadow vehicle
  clusters without plate-ownership claims or automatic mismatch alerts.
- Consolidated notification rules and dedicated MQTT, Pushover, SMTP email, and
  signed-webhook integration pages with durable delivery and testing.
- Added read-only Storage Health and installed release information, including
  separate application and user-manual versions.
- Improved the image review workflow, plate-focused zoom, next-read navigation,
  correction status filters, and recurring aliases that default to all cameras.
- Added alias-only saves, confirmed audited alias replacement, and optional
  associated-alias disabling when reversing a plate review.

- Added guarded deletion for disabled notification rules. The confirmation
  identifies the exact rule and version, removes it from the active workspace,
  cancels queued deliveries, and preserves historical activity and audit links.
- Fixed legacy-migrated notification rules retaining the old UTC schema default.
  Existing migration targets now inherit the configured local timezone across
  the rule, quiet hours, and schedule conditions without changing intentional
  UTC rules created independently in the unified builder.
- Fixed finalized and retired notification migration targets remaining hidden
  from the normal Notification Rules list after their guarded legacy workflow
  ended. Preserved unified rules now reappear without restoring legacy rows.
- Fixed Create rule resetting the rule, quiet-hours, and Schedule time zones to
  the configured MQTT fallback after the browser-local timezone had already
  been resolved.
- Simplified notification administration: Notification Rules no longer shows
  channel setup cards, Settings links directly to each integration, and MQTT,
  Pushover, email, and webhook use consistent functional header tabs. Pushover
  usage and monthly allowance metrics now have a dedicated tab.
- Extended verified migration finalization to both MQTT and Pushover. Disabled
  legacy sources are deleted only after successful unified post-cutover delivery,
  while immutable credential-free snapshots and audit evidence remain.
- Removed the remaining legacy Pushover rule editor and write endpoints. MQTT,
  Pushover, email, and webhook rules are now managed only by the unified
  Notifications builder, with all direct channel tests in one panel.
- Added unified SMTP email and HMAC-signed webhook rule actions with protected
  settings, direct channel tests, durable retries, delivery attempts, and
  dead-letter visibility.
- Added conservative webhook destination controls, redirect blocking,
  idempotency keys, and optional capture attachments for email alerts.

## [0.1.9] - 08-15-2025

- Support for MQTT as plate notification for HA
- Staged code for AI vehicle descriptions and deep research agent
- More UI improvements
- Database setup fixes
- Improved session management
- Improved management of known plates and flags
- Error handling for non-plate objects in AI dump
- Hardened integration tests

## [0.1.8] - 03-19-2025

**This is a major update. It will require some changes to your Blue Iris configuration and an update to the codeproject.ai ALPR module to take full advantage of the functionality.
See release notes for more detail on how to update the other systems: https://github.com/algertc/ALPR-Database/releases**

- Automatic AI model training to improve recognition accuracy
- Full UI/UX redux
- Mobile Application
- New secondary live view page similar to Motorola law enforcement UI
- Additional dashboard metrics
- Several bug fixes and other improvements
- Foundation for soon-to-come RF fingerprinting functionality

## [0.1.7] - 02-11-2025

- Complete overhaul of image storage system
- Tables UI improved with more advanced filtering and sorting
- Manually add known plates without prior detection
- Plate image viewer with integrated actions
- System logs page
- Improved timestamp display and time zone handling
- Automatic install and update scripts
- A variety of other bug fixes and performance improvements
- **This update is a major change and will require existing users to complete the update process within the app to migrate their images**

## [0.1.6] - 01-03-2025

- Live update of recognition feed
- New dashboard visualizations & controls
- Speed & loading improvements
- Ability to edit tag name and color
- More sensible default database sorting
- Set ignore flag on known plates to exclude from database
- Time formatting fix
- **Requires new migrations.sql update from GitHub**

## [0.1.5] - 12-09-2024

- Support for 24 hour time
- Fixed max records pruning
- Time based recognition filtering
- Pagination for database page
- Notification time zone fix
- Live feed plate image modal
- UI Improvements

## [0.1.4] - 12-01-2024

- Added camera name column to live feed. Optionally send with "camera":"&CAM" or &NAME for long name.
- Additional sorting options in plate database
- Auth bypass for HomeAssistant dashboards
- Database migration fix (**Requires new migrations.sql file from GitHub**)
- Ability to correct/edit OCR recognitions in the live feed

## [0.1.3] - 11-20-2024

- Database Pruning Fix

## [0.1.2] - 11-20-2024

- Push Notification bug fixes and improvements

## [0.1.1] - 11-19-2024

- Fixed Docker volume mappings
- Fuzzy search
- Optionally use &MEMO instead of &PLATE to capture multiple plates in a single image

## [0.1.0] - 11-16-2024

- Initial release
