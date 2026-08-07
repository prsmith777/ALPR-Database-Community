import { createHash } from "node:crypto";

import { normalizeHostMaintenanceInventory } from "./host-maintenance-policy.mjs";

export const HOST_BACKUP_CATALOG_VERSION = "host-backup-catalog-v1";
export const HOST_BACKUP_MINIMUM_VERIFIED_COUNT = 5;
export const HOST_BACKUP_MINIMUM_AGE_DAYS = 30;

const DAY_MS = 86_400_000;
const sha256 = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function canonicalTimestamp(value, label) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} is invalid`);
  return parsed.toISOString();
}

function canonicalEntry(entry) {
  return {
    id: entry.id,
    identity: entry.identity,
    bytes: Number(entry.bytes),
    createdAt: canonicalTimestamp(entry.createdAt, "Backup catalog createdAt"),
    checksumVerified: entry.checksumVerified === true,
    checksumSha256: String(entry.checksumSha256 || ""),
    protected: entry.protected === true,
    currentRelease: entry.currentRelease === true,
    rollbackChain: entry.rollbackChain === true,
    imageIds: [...entry.imageIds],
    environmentId: entry.environmentId,
    databaseIdentity: entry.databaseIdentity,
    releaseId: entry.releaseId,
    schemaVersion: entry.schemaVersion,
    postgresFormat: entry.postgresFormat,
    device: entry.device,
    inode: entry.inode,
    modifiedAt: canonicalTimestamp(entry.modifiedAt, "Backup catalog modifiedAt"),
    partial: entry.partial === true,
    symlink: entry.symlink === true,
    hardlinkCount: Number(entry.hardlinkCount),
  };
}

function catalogRevision(catalog) {
  return sha256({
    version: catalog.version,
    environmentId: catalog.environmentId,
    databaseIdentity: catalog.databaseIdentity,
    workerGeneration: catalog.workerGeneration,
    catalogComplete: catalog.catalogComplete === true,
    releaseLedgerComplete: catalog.releaseLedgerComplete === true,
    authoritativeCurrentReleaseCount: Number(catalog.authoritativeCurrentReleaseCount),
    leases: {
      backupRestore: catalog.leases?.backupRestore === true,
      build: catalog.leases?.build === true,
      deploy: catalog.leases?.deploy === true,
      rollback: catalog.leases?.rollback === true,
    },
    entries: [...catalog.entries].sort((left, right) => left.id.localeCompare(right.id)).map(canonicalEntry),
  });
}

function safeNow(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("Backup catalog reference time is invalid");
  return parsed;
}

function verifiedBackup(entry, catalog) {
  return entry.checksumVerified === true && /^[0-9a-f]{64}$/.test(entry.checksumSha256) &&
    entry.partial === false && entry.symlink === false && entry.hardlinkCount === 1 &&
    entry.environmentId === catalog.environmentId && entry.databaseIdentity === catalog.databaseIdentity &&
    entry.postgresFormat === "custom";
}

function invalidReasons(entry, catalog) {
  const reasons = [];
  if (!entry.checksumVerified || !/^[0-9a-f]{64}$/.test(entry.checksumSha256)) reasons.push("checksum-unverified");
  if (entry.partial) reasons.push("partial");
  if (entry.symlink) reasons.push("symbolic-link");
  if (entry.hardlinkCount !== 1) reasons.push("hard-link");
  if (entry.environmentId !== catalog.environmentId) reasons.push("foreign-environment");
  if (entry.databaseIdentity !== catalog.databaseIdentity) reasons.push("foreign-database");
  if (entry.postgresFormat !== "custom") reasons.push("unsupported-postgres-format");
  return reasons;
}

export function buildHostBackupCatalog(inventoryValue) {
  const inventory = normalizeHostMaintenanceInventory(inventoryValue);
  const entries = [...inventory.backups]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((backup) => Object.freeze({ ...backup, imageIds: Object.freeze([...backup.imageIds]) }));
  const canonical = {
    version: HOST_BACKUP_CATALOG_VERSION,
    environmentId: inventory.environmentId,
    databaseIdentity: inventory.databaseIdentity,
    workerGeneration: inventory.workerGeneration,
    catalogComplete: inventory.catalogComplete,
    releaseLedgerComplete: inventory.releaseLedgerComplete,
    authoritativeCurrentReleaseCount: inventory.authoritativeCurrentReleaseCount,
    leases: inventory.leases,
    entries,
  };
  return Object.freeze({
    ...canonical,
    catalogRevision: catalogRevision(canonical),
    inventoryRevision: inventory.revision,
    measuredAt: inventory.measuredAt,
    backupCount: entries.length,
    backupBytes: entries.reduce((total, entry) => total + entry.bytes, 0),
  });
}

export function buildHostBackupCatalogPreview(catalog, {
  now = new Date(),
  retainedVerifiedCount = HOST_BACKUP_MINIMUM_VERIFIED_COUNT,
  minimumAgeDays = HOST_BACKUP_MINIMUM_AGE_DAYS,
} = {}) {
  if (!catalog || catalog.version !== HOST_BACKUP_CATALOG_VERSION || !Array.isArray(catalog.entries)) {
    throw new Error("Backup catalog is invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(catalog.catalogRevision) || catalogRevision(catalog) !== catalog.catalogRevision) {
    throw new Error("Backup catalog revision mismatch");
  }
  const catalogBytes = catalog.entries.reduce((total, entry) => total + Number(entry.bytes), 0);
  if ((catalog.backupCount !== undefined && Number(catalog.backupCount) !== catalog.entries.length) ||
      (catalog.backupBytes !== undefined && Number(catalog.backupBytes) !== catalogBytes)) {
    throw new Error("Backup catalog totals mismatch");
  }
  const reference = safeNow(now);
  const keepCount = Math.max(HOST_BACKUP_MINIMUM_VERIFIED_COUNT, Math.min(50, Number.parseInt(String(retainedVerifiedCount), 10) || HOST_BACKUP_MINIMUM_VERIFIED_COUNT));
  const keepAgeDays = Math.max(HOST_BACKUP_MINIMUM_AGE_DAYS, Math.min(365, Number.parseInt(String(minimumAgeDays), 10) || HOST_BACKUP_MINIMUM_AGE_DAYS));
  const cutoff = new Date(reference.getTime() - keepAgeDays * DAY_MS);
  const verified = catalog.entries.filter((entry) => verifiedBackup(entry, catalog))
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt) || right.id.localeCompare(left.id));
  const newest = new Set(verified.slice(0, keepCount).map((entry) => entry.id));
  const currentReleaseEntries = catalog.entries.filter((entry) => entry.currentRelease);
  const policyBlocks = [];
  if (!catalog.catalogComplete) policyBlocks.push("catalog-incomplete");
  if (!catalog.releaseLedgerComplete) policyBlocks.push("release-ledger-incomplete");
  if (catalog.authoritativeCurrentReleaseCount !== 1 || currentReleaseEntries.length !== 1) policyBlocks.push("current-release-ambiguous");
  if (catalog.leases?.backupRestore) policyBlocks.push("backup-restore-lease");
  if (catalog.leases?.build) policyBlocks.push("build-lease");
  if (catalog.leases?.deploy) policyBlocks.push("deploy-lease");
  if (catalog.leases?.rollback) policyBlocks.push("rollback-lease");
  const policyReady = policyBlocks.length === 0;
  const entries = catalog.entries.map((entry) => {
    const rejected = invalidReasons(entry, catalog);
    const protectionReasons = [];
    if (entry.protected) protectionReasons.push("state-reference");
    if (entry.currentRelease) protectionReasons.push("current-release");
    if (entry.rollbackChain) protectionReasons.push("rollback-chain");
    if (verifiedBackup(entry, catalog) && new Date(entry.createdAt) > cutoff) protectionReasons.push("newer-than-age-floor");
    if (newest.has(entry.id)) protectionReasons.push("newest-verified-floor");
    if (rejected.length) protectionReasons.push("catalog-anomaly");
    if (!policyReady) protectionReasons.push("policy-not-ready");
    const disposition = rejected.length ? "rejected" : protectionReasons.length ? "protected" : "preview-candidate";
    return Object.freeze({ ...entry, verified: rejected.length === 0, rejectedReasons: Object.freeze(rejected), protectionReasons: Object.freeze([...new Set(protectionReasons)]), disposition });
  });
  const candidates = entries.filter((entry) => entry.disposition === "preview-candidate");
  return Object.freeze({
    catalogVersion: catalog.version,
    catalogRevision: catalog.catalogRevision,
    inventoryRevision: catalog.inventoryRevision,
    environmentId: catalog.environmentId,
    databaseIdentity: catalog.databaseIdentity,
    workerGeneration: catalog.workerGeneration,
    measuredAt: catalog.measuredAt,
    evaluatedAt: reference.toISOString(),
    cutoffAt: cutoff.toISOString(),
    retainedVerifiedCount: keepCount,
    minimumAgeDays: keepAgeDays,
    policyReady,
    policyBlocks: Object.freeze(policyBlocks),
    backupCount: entries.length,
    backupBytes: catalogBytes,
    verifiedCount: entries.filter((entry) => entry.verified).length,
    protectedCount: entries.filter((entry) => entry.disposition === "protected").length,
    rejectedCount: entries.filter((entry) => entry.disposition === "rejected").length,
    candidateCount: candidates.length,
    candidateBytes: candidates.reduce((total, entry) => total + entry.bytes, 0),
    destructiveExecutionAvailable: false,
    entries: Object.freeze(entries),
  });
}

export function publicHostBackupCatalogPreview(preview) {
  if (!preview || !Array.isArray(preview.entries)) return null;
  return {
    status: preview.policyReady ? "ready" : "blocked",
    catalogVersion: preview.catalogVersion,
    catalogRevision: preview.catalogRevision,
    inventoryRevision: preview.inventoryRevision,
    measuredAt: preview.measuredAt,
    evaluatedAt: preview.evaluatedAt,
    cutoffAt: preview.cutoffAt,
    retainedVerifiedCount: preview.retainedVerifiedCount,
    minimumAgeDays: preview.minimumAgeDays,
    policyReady: preview.policyReady,
    policyBlocks: [...preview.policyBlocks],
    backupCount: preview.backupCount,
    backupBytes: preview.backupBytes,
    verifiedCount: preview.verifiedCount,
    protectedCount: preview.protectedCount,
    rejectedCount: preview.rejectedCount,
    candidateCount: preview.candidateCount,
    candidateBytes: preview.candidateBytes,
    destructiveExecutionAvailable: false,
    entries: preview.entries.map((entry) => ({
      id: entry.id,
      bytes: entry.bytes,
      createdAt: entry.createdAt,
      modifiedAt: entry.modifiedAt,
      releaseId: entry.releaseId,
      schemaVersion: entry.schemaVersion,
      postgresFormat: entry.postgresFormat,
      verified: entry.verified,
      disposition: entry.disposition,
      protectionReasons: [...entry.protectionReasons],
      rejectedReasons: [...entry.rejectedReasons],
    })),
  };
}
