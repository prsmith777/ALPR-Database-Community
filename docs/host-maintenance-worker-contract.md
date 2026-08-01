# Host maintenance worker contract

Phase 3 adds a fail-closed database control plane for host artifacts. The web
application does not mount the Docker socket, receive a privileged container,
run host commands, or mount backup/release directories writable. Until a
separately installed fixed worker reports a heartbeat, Data & Privacy displays
the controls as unavailable and queued requests cannot inspect or delete data.

## Independent boundaries

`docker-build-cache`, `unused-alpr-images`, and `rollout-backups` have separate
configuration, approval revision, schedule, breaker, alert, preview, receipt,
and audit history. All schedules default off. Cache and backup schedules each
require their displayed one-time activation phrase. Unused-image scheduling is
unsupported; backup retention never removes an image.

The worker derives every candidate. The browser submits only a category, then
receives an opaque, 15-minute token after worker preview. A token is immutable,
single-use, actor/category/environment/policy/worker-generation bound, and
commits to the exact candidate-set hash. Execution re-acquires the shared host
lock, repeats inventory and identity checks, and executes only that exact set.
Newly eligible artifacts are not admitted.

## Fixed worker requirements

Install the worker once as an operating-system service with database access and
only the host permissions required for its fixed operations. It must share one
exclusive lock with build, deploy, backup, and restore jobs. It must be
single-flight, enforce item/byte/time caps, publish a heartbeat, and return a
complete per-item receipt. A crash, timeout, ambiguous/partial receipt, failed
identity check, or lock conflict fails the category closed, disables its
schedule, and opens its breaker.

The adapter surface is exactly:

- `inspect()`: return the signed/validated inventory shape consumed by
  `normalizeHostMaintenanceInventory`.
- `prune(request)`: accept a category, environment, worker generation,
  inventory revision, candidate-set hash, and exact opaque items. It must hold
  the shared lock and revalidate again before each bounded operation.
- `backup(request)`: accept only the fixed PostgreSQL custom-format operation,
  environment/database/worker bindings, numeric request ID, immutable 50 GiB
  ceiling, and deadline. It must hold the shared lock and return the bound,
  verified receipt described below.
- `cleanupDatabaseBackupRequest(request)`: run only during bounded stale-lease
  replay exhaustion. It accepts the numeric request ID, environment/database
  bindings, and deadline, then either attests and reuses the already cataloged
  result or removes only the exact worker-owned partial/published artifact after
  terminating the request's fixed database backend. It never accepts a path.

No request field is a path, Docker command, shell fragment, image selector, or
user-supplied identifier. Opaque IDs resolve only inside worker-owned catalogs.
`inventory.revision` is the lowercase SHA-256 returned by
`canonicalHostInventoryRevision`: a canonical ordering of inventory identities,
sizes, protection flags, catalog completeness, and leases. It intentionally
excludes `measuredAt`, so a fresh measurement of unchanged protection state
does not invalidate a preview; any protection or identity change does.

The application database is a trusted administrative/audit plane, not a host
security boundary. The privileged worker must treat every database request as
untrusted input: independently rederive eligibility from authoritative host
catalogs, enforce hard-coded retention floors and category caps, bind the
configured environment and database identity, acquire the shared host lock,
and validate an exact receipt even if database rows were modified by an
administrator. Configure both `HOST_MAINTENANCE_ENVIRONMENT_ID` and
`HOST_MAINTENANCE_DATABASE_IDENTITY` identically for the control-plane service
and worker. The installer must also insert those exact values once into the
immutable `host_maintenance_environment_identity` singleton; every control and
worker cycle verifies that database-resident identity so a foreign logical
restore fails closed. Missing or mismatched bindings fail closed.

## Cache policy

Scheduled build-cache cleanup is allowed only for a dedicated ALPR BuildKit
namespace or an explicitly dedicated host. The worker may remove only unused,
ALPR-managed, non-mutable, non-shared cache records whose `lastUsedAt` is older
than the category policy (hard floor seven days; seeded default seven days).
It must never use system
prune, image prune `-a`, container prune, network prune, or volume prune.

## Image ledger policy

The worker owns an exact-image-ID release ledger. Unknown images fail closed.
Running and stopped container references, current/prepared/deployed/rollback
releases, backup references, and active build/deploy leases are protected.
Only an explicitly retired ALPR image older than the worker grace period can
appear in a manual preview. This category has no automated schedule.

## Backup catalog policy

The worker owns a manifest/catalog containing environment and database
identity, release and schema version, PostgreSQL format, SHA-256, device,
inode, size, and mtime. It protects the newest five verified backups **and**
every verified backup newer than 30 days, plus current-release and rollback
chains. Manifestless, partial, corrupt, foreign, symlinked, hard-linked, or
identity-drifted files are rejected. Removal is exact-file only, preferably by
quarantine followed by a later bounded purge; only empty directories created
by the worker may be removed. Current releases, prepared releases, database
records/volumes, captures, and protected rollback backups are never candidates.

## Manual database-backup creation

Manual database-backup creation is a separate fixed operation, not a cleanup
category or retention schedule. The application may enqueue only one active
request, and the control remains unavailable unless a fresh worker heartbeat
advertises `database-backup-create-v1`. The browser cannot provide a path,
filename, database name, command, argument, schedule, or restore input.

The fixed adapter acquires the shared host lock, binds the request to the exact
environment and PostgreSQL system identity, runs a PostgreSQL custom-format
dump through fixed Docker execution against the exact database container, and
verifies the result within the worker-owned approved backup root. The operation
has a 50 GiB output ceiling. Its receipt exposes only a bound basename, verified
size, checksum and verification marker, timing, and sanitized failure state.
The worker database role has only narrow SELECT/UPDATE access to the dedicated
request queue; it has no application-table read or dump privilege.

As of July 31, 2026, the reviewed adapter and runtime are installed on staging.
The installer passed PostgreSQL 17 readiness checks with the capability both
absent and present, and the activated worker completed a locked cycle before
publishing the capability. Staging acceptance was preview-only and did not
create a real backup. A subsequent authorized create attempt rolled back before
enqueue because its audit insert used labels outside the `audit_events` source
and outcome vocabulary. No backup artifact was created. This release uses
`browser`/`succeeded` for the request and `system` with `succeeded` or `failed`
for worker events. One explicit staging retry remains pending. Production has no
deployed adapter or advertised capability.

## Installation and recovery

This repository deliberately ships the disabled adapter and an in-memory test
adapter, not a privileged host implementation. An operator must separately
install and configure a reviewed worker implementation for each target
environment. Staging has that separate installation; production does not.
The service process imports only `lib/host-maintenance-worker.mjs`; application
routes, actions, and monitors must import `lib/host-maintenance-control.mjs`.
After any breaker event, investigate the immutable intent/run/receipt/audit
evidence and repair the worker or catalog. Re-enabling automation requires a
new category-specific approval revision; never bypass the breaker by editing
database state manually.

Breaker acknowledgement never accepts browser-authored diagnostic evidence.
It requires a healthy worker heartbeat and fresh authoritative inventory from
the configured environment after the breaker opened; that worker generation,
inventory revision, measurement, and heartbeat form the append-only evidence.
Acknowledgement clears the breaker but leaves the schedule disabled.
