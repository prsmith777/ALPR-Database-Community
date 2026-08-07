import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHostBackupCatalog,
  buildHostBackupCatalogPreview,
  HOST_BACKUP_CATALOG_VERSION,
  publicHostBackupCatalogPreview,
} from "../lib/host-backup-catalog.mjs";
import { canonicalHostInventoryRevision } from "../lib/host-maintenance-policy.mjs";

const NOW = new Date("2026-08-05T18:00:00.000Z");

function backup(id, days, extra = {}) {
  const timestamp = new Date(NOW.getTime() - days * 86_400_000).toISOString();
  return {
    id,
    identity: `identity-${id}`,
    bytes: 1024,
    createdAt: timestamp,
    checksumVerified: true,
    checksumSha256: "a".repeat(64),
    protected: false,
    currentRelease: false,
    rollbackChain: false,
    imageIds: [],
    environmentId: "local",
    databaseIdentity: "db-local",
    releaseId: `release-${id}`,
    schemaVersion: "schema-1",
    postgresFormat: "custom",
    device: "device-1",
    inode: `inode-${id}`,
    modifiedAt: timestamp,
    partial: false,
    symlink: false,
    hardlinkCount: 1,
    ...extra,
  };
}

function inventory(backups) {
  const value = {
    healthy: true,
    revision: "temporary",
    environmentId: "local",
    databaseIdentity: "db-local",
    workerGeneration: "worker-local-1",
    measuredAt: NOW.toISOString(),
    hostLockAvailable: true,
    catalogComplete: true,
    releaseLedgerComplete: true,
    workerImageLedgerComplete: true,
    authoritativeCurrentReleaseCount: 1,
    authoritativeCurrentWorkerCount: 1,
    leases: { backupRestore: false, build: false, deploy: false, rollback: false },
    docker: { dedicatedNamespace: true, dedicatedHost: false, unknownImageCount: 0, buildCache: [], images: [] },
    backups,
  };
  value.revision = canonicalHostInventoryRevision(value);
  return value;
}

test("catalog keeps the newest five, all verified backups strictly newer than 30 days, and state references", () => {
  const value = inventory([
    backup("state", 90, { protected: true, currentRelease: true }),
    backup("old-1", 60), backup("old-2", 55), backup("old-3", 50),
    backup("old-4", 45), backup("old-5", 40), backup("old-6", 35),
    backup("recent", 10),
  ]);
  const preview = buildHostBackupCatalogPreview(buildHostBackupCatalog(value), { now: NOW });
  const byId = new Map(preview.entries.map((entry) => [entry.id, entry]));

  assert.equal(byId.get("state").disposition, "protected");
  assert.ok(byId.get("state").protectionReasons.includes("state-reference"));
  assert.equal(byId.get("recent").disposition, "protected");
  assert.ok(byId.get("recent").protectionReasons.includes("newer-than-age-floor"));
  assert.equal(byId.get("old-1").disposition, "preview-candidate");
  assert.equal(preview.candidateCount, 2);
  assert.equal(preview.destructiveExecutionAvailable, false);
});

test("an exact 30-day-old backup is not age-protected", () => {
  const value = inventory([
    backup("current", 90, { currentRelease: true }),
    backup("exact-boundary", 30),
    backup("new-1", 1), backup("new-2", 2), backup("new-3", 3), backup("new-4", 4), backup("new-5", 5), backup("new-6", 6),
  ]);
  const preview = buildHostBackupCatalogPreview(buildHostBackupCatalog(value), { now: NOW });
  const boundary = preview.entries.find((entry) => entry.id === "exact-boundary");
  assert.equal(boundary.disposition, "preview-candidate");
  assert.equal(boundary.protectionReasons.includes("newer-than-age-floor"), false);
});

test("a catalog with fewer than five verified backups protects every available backup", () => {
  const value = inventory([
    backup("current", 90, { currentRelease: true }), backup("one", 80), backup("two", 70), backup("three", 60),
  ]);
  const preview = buildHostBackupCatalogPreview(buildHostBackupCatalog(value), { now: NOW });
  assert.equal(preview.backupCount, 4);
  assert.equal(preview.protectedCount, 4);
  assert.equal(preview.candidateCount, 0);
});

test("catalog anomalies and incomplete policy state are rejected or fail preview closed", () => {
  const corrupt = backup("corrupt", 60, { checksumVerified: false, checksumSha256: "bad", symlink: true });
  const value = inventory([backup("current", 90, { currentRelease: true }), corrupt, backup("candidate", 80)]);
  value.catalogComplete = false;
  value.revision = canonicalHostInventoryRevision(value);
  const preview = buildHostBackupCatalogPreview(buildHostBackupCatalog(value), { now: NOW });
  const rejected = preview.entries.find((entry) => entry.id === "corrupt");
  assert.equal(preview.policyReady, false);
  assert.equal(preview.candidateCount, 0);
  assert.equal(rejected.disposition, "rejected");
  assert.deepEqual([...rejected.rejectedReasons].sort(), ["checksum-unverified", "symbolic-link"]);
});

test("catalog revision is ordering and measurement-time stable but binds filesystem evidence", () => {
  const firstInventory = inventory([backup("current", 90, { currentRelease: true }), backup("other", 60)]);
  const first = buildHostBackupCatalog(firstInventory);
  const reordered = structuredClone(firstInventory);
  reordered.measuredAt = "2026-08-05T18:01:00.000Z";
  reordered.backups.reverse();
  reordered.revision = canonicalHostInventoryRevision(reordered);
  assert.equal(buildHostBackupCatalog(reordered).catalogRevision, first.catalogRevision);

  reordered.backups[0].inode = "changed-inode";
  reordered.revision = canonicalHostInventoryRevision(reordered);
  assert.notEqual(buildHostBackupCatalog(reordered).catalogRevision, first.catalogRevision);
});

test("preview rejects catalog content or totals that do not match the immutable revision", () => {
  const catalog = buildHostBackupCatalog(inventory([backup("current", 90, { currentRelease: true }), backup("other", 60)]));
  const changed = structuredClone(catalog);
  changed.entries[1].inode = "tampered-inode";
  assert.throws(() => buildHostBackupCatalogPreview(changed, { now: NOW }), /revision mismatch/);

  const wrongTotals = structuredClone(catalog);
  wrongTotals.backupBytes += 1;
  assert.throws(() => buildHostBackupCatalogPreview(wrongTotals, { now: NOW }), /totals mismatch/);
});

test("public catalog preview is path-free and omits checksum and filesystem identity", () => {
  const catalog = buildHostBackupCatalog(inventory([backup("current", 90, { currentRelease: true })]));
  const result = publicHostBackupCatalogPreview(buildHostBackupCatalogPreview(catalog, { now: NOW }));
  assert.equal(result.catalogVersion, HOST_BACKUP_CATALOG_VERSION);
  assert.equal(result.destructiveExecutionAvailable, false);
  assert.equal("identity" in result.entries[0], false);
  assert.equal("checksumSha256" in result.entries[0], false);
  assert.equal("device" in result.entries[0], false);
  assert.equal("inode" in result.entries[0], false);
  assert.equal("path" in result.entries[0], false);
});
