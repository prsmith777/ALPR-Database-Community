# Recognition Feed identity performance

## Scope of the v0.1.42 repair

A database already using `v2_primary` could spend seconds validating the same
vehicle identity evidence repeatedly while loading a small feed page. This
could leave the page layout visible before its records arrived, with or without
filters. The delay grew with profile membership and pair-review evidence,
not just the number of visible records.

Fresh Community installations retain their default `v2_shadow` mode and legacy
identity path. This repair does not change the selected mode, run a conversion,
delete data, add a cache, or expose advanced ReID administration. No manual SQL
or additional migration is required; follow the normal update process.

## What changed

The application selects the page first, hydrates only those records, then reads
their vehicle identities. Count, page, metadata, mode, and identity reads share
one short read-only repeatable-read transaction.

For ReID 2 primary mode, materialized SQL sets validate relevant canonical
profiles, exact merge evidence, members, plate anchors, and pair reviews once
per identity query instead of expanding nested views for every assignment.
All members of the relevant profiles are considered, including members outside
the page: a current Different or Unsure review must still veto conflicting
identity evidence. Changed source links, image evidence, plate reviews, and
merge reviews cannot revive stale historical assignments.

Other supported modes query only the selected reads' legacy assignments.
Missing or invalid authority control raises an error instead of silently
presenting legacy identities as current. An identity can be absent while its
evidence is being revalidated; this does not mean the plate read was deleted.

## Verify after updating

1. Use the normal updater and complete Technical system checks.
2. Open Recognition Feed from another page, first without filters and then with
   a camera/date/tag filter.
3. Check the first and next results pages, sorting, and plate/vehicle image views.
4. Complete the normal real-use acceptance checklist before accepting the update.

If loading remains slow, record the release, page size, filter types, approximate
delay, and whether records or only images are delayed. Administrators can inspect
application logs for `[plate-reads] query timing`: requests taking at least
500 ms log durations for pool, connection, count, page, hydrate, and identity
stages that ran. Query parameters, plates, image paths, and credentials are not
included in those timing entries. Other log entries may contain private data;
review and redact any support material before sharing it.

Do not change authority modes, delete identity history, or rerun migration as a
performance workaround. If the authority mode is unavailable, preserve the
database and report the error for diagnosis.

## Maintainer regression coverage

`node --test test/live-feed-query-planning.test.mjs` checks identity mapping,
mode routing, transaction cleanup, and privacy-safe timing behavior.

`yarn test:community-feed:postgres` is a destructive synthetic-fixture harness
for disposable CI databases only, not a command for users' installations.
The CI workflow creates a separate PostgreSQL 17 database, applies schema and
migrations twice, installs a sentinel, and sets all three
`COMMUNITY_FEED_POSTGRES_TEST_*` opt-ins. The harness refuses a mismatched
database name, missing sentinel, populated fixture tables, or a live environment
identity. CI drops that exact disposable database on completion or failure.

Coverage includes:

- the actual application feed query in default and primary modes, all supported
  sort fields in both directions, filters, pagination, and empty pages;
- committed preview/materialization, shared reads, replaced source links and
  plate anchors, exact-plate history without images, merges, splits, and remerges;
- a 23-read page within two 80-member synthetic profiles and 60 inter-profile
  reviews, compared with the pre-repair Community SQL in the same snapshot;
- off-page Different/Unsure conflicts, stale off-page evidence, and stale visible
  source evidence;
- repeatable-read consistency under a concurrent write and read-only refusal.

The performance gate requires at least a 50% reduction in shared-buffer hits
for the synthetic workload. Execution times are reported, not used as a
hardware-dependent absolute SLA. This is not a full browser-speed benchmark.
No production data or images are used, and test fixtures are excluded from
the runtime image.
