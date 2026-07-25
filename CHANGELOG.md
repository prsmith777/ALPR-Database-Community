# Changelog

## Unreleased

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
