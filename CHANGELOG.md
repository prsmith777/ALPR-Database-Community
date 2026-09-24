# Changelog

## Unreleased

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
  guidance, and updated the Community user guide to version 1.2.

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
- Restored legacy visual search for the default `v2_shadow` compatibility mode
  used by clean Community installations.
- Redirected successful manual image migrations to the dashboard only after
  the database update-completion marker is confirmed.
