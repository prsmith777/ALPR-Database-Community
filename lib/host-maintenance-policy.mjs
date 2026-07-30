import { createHash } from "node:crypto";

export const HOST_MAINTENANCE_CONFIRMATIONS = Object.freeze({
  "docker-build-cache": "PRUNE UNUSED ALPR BUILD CACHE",
  "unused-alpr-images": "PRUNE RETIRED ALPR IMAGES",
  "rollout-backups": "PRUNE EXPIRED VERIFIED ROLLOUT BACKUPS",
});
export const HOST_MAINTENANCE_ACKNOWLEDGEMENTS = Object.freeze({
  "docker-build-cache": "ACKNOWLEDGE DOCKER CACHE FAILURE",
  "unused-alpr-images": "ACKNOWLEDGE UNUSED IMAGE FAILURE",
  "rollout-backups": "ACKNOWLEDGE ROLLOUT BACKUP FAILURE",
});
export const HOST_MAINTENANCE_CAPS = Object.freeze({
  "docker-build-cache": Object.freeze({ maxItems: 100, maxBytes: 5 * 1024 ** 3, maxDurationSeconds: 300 }),
  "unused-alpr-images": Object.freeze({ maxItems: 10, maxBytes: 10 * 1024 ** 3, maxDurationSeconds: 300 }),
  "rollout-backups": Object.freeze({ maxItems: 5, maxBytes: 50 * 1024 ** 3, maxDurationSeconds: 300 }),
});
export const HOST_MAINTENANCE_ACTIVATIONS = Object.freeze({
  "docker-build-cache": "ENABLE SCHEDULED DOCKER CACHE PRUNING",
  "unused-alpr-images": "ENABLE SCHEDULED UNUSED ALPR IMAGE PRUNING",
  "rollout-backups": "ENABLE SCHEDULED ROLLOUT BACKUP RETENTION",
});
export const HOST_MAINTENANCE_PREVIEW_TTL_SECONDS = 900;
export const HOST_MAINTENANCE_INVENTORY_MAX_AGE_SECONDS = 120;
export const HOST_MAINTENANCE_FUTURE_SKEW_SECONDS = 30;
export const HOST_MAINTENANCE_MIN_INTERVAL_SECONDS = 86_400;
export const HOST_MAINTENANCE_CATEGORIES = Object.freeze(["docker-build-cache", "unused-alpr-images", "rollout-backups"]);
export const hostMaintenanceJob = (category) => `host-maintenance:${category}`;

export function normalizeHostMaintenanceCategory(value) {
  const category = String(value || "");
  if (!HOST_MAINTENANCE_CATEGORIES.includes(category)) throw new Error("Unsupported host maintenance category");
  return category;
}

function safeId(value, label) {
  const id = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9:_.@+-]{0,199}$/.test(id)) throw new Error(`${label} has an invalid opaque identifier`);
  return id;
}

function bytes(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} bytes must be a non-negative integer`);
  return parsed;
}
function positiveInteger(value,label){const parsed=Number(value);if(!Number.isSafeInteger(parsed)||parsed<1)throw new Error(`${label} must be an explicit positive integer`);return parsed;}

function date(value, label) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} must include a valid timestamp`);
  return parsed.toISOString();
}

export function normalizeHostMaintenanceInventory(value = {}) {
  if (value.healthy !== true) throw new Error("Host maintenance inventory health check failed");
  const revision = safeId(value.revision, "Inventory revision");
  const environmentId = safeId(value.environmentId, "Environment");
  const databaseIdentity = safeId(value.databaseIdentity, "Database identity");
  const workerGeneration = safeId(value.workerGeneration, "Worker generation");
  const measuredAt = date(value.measuredAt, "Inventory measuredAt");
  const buildCache = (value.docker?.buildCache || []).map((item) => ({
    id: safeId(item.id, "Build cache"),
    identity: safeId(item.identity, "Build cache identity"),
    bytes: bytes(item.bytes, "Build cache"),
    unused: item.unused === true,
    alprManaged: item.alprManaged === true,
    lastUsedAt: date(item.lastUsedAt, "Build cache lastUsedAt"),
    mutable: item.mutable === true,
    shared: item.shared === true,
  }));
  const backups = (value.backups || []).map((item) => ({
    id: safeId(item.id, "Backup"),
    identity: safeId(item.identity, "Backup identity"),
    bytes: bytes(item.bytes, "Backup"),
    createdAt: date(item.createdAt, "Backup createdAt"),
    checksumVerified: item.checksumVerified === true && /^[0-9a-f]{64}$/.test(String(item.checksumSha256 || "")),
    checksumSha256: String(item.checksumSha256 || ""),
    protected: item.protected === true,
    currentRelease: item.currentRelease === true,
    rollbackChain: item.rollbackChain === true,
    imageIds: [...new Set((item.imageIds || []).map((id) => safeId(id, "Backup image")))].sort(),
    environmentId: safeId(item.environmentId, "Backup environment"),
    databaseIdentity: safeId(item.databaseIdentity, "Backup database"),
    releaseId: safeId(item.releaseId, "Backup release"),
    schemaVersion: safeId(item.schemaVersion, "Backup schema"),
    postgresFormat: safeId(item.postgresFormat, "Backup PostgreSQL format"),
    device: safeId(item.device, "Backup device"),
    inode: safeId(item.inode, "Backup inode"),
    modifiedAt: date(item.modifiedAt, "Backup modifiedAt"),
    partial: item.partial === true,
    symlink: item.symlink === true,
    hardlinkCount: positiveInteger(item.hardlinkCount, "Backup hardlinkCount"),
  }));
  const images = (value.docker?.images || []).map((item) => ({
    id: safeId(item.id, "Docker image"),
    identity: safeId(item.identity, "Docker image identity"),
    bytes: bytes(item.bytes, "Docker image"),
    usedByContainer: item.usedByContainer === true,
    currentRelease: item.currentRelease === true,
    preparedRelease: item.preparedRelease === true,
    deployedRelease: item.deployedRelease === true,
    backupIds: [...new Set((item.backupIds || []).map((id) => safeId(id, "Image backup")))].sort(),
    alprManaged: item.alprManaged === true,
    knownInReleaseLedger: item.knownInReleaseLedger === true,
    explicitlyRetired: item.explicitlyRetired === true,
    retiredAt: item.retiredAt ? date(item.retiredAt, "Image retiredAt") : null,
    buildLease: item.buildLease === true,
    deployLease: item.deployLease === true,
    stoppedContainerReference: item.stoppedContainerReference === true,
    rollbackReference: item.rollbackReference === true,
  }));
  for (const collection of [buildCache, backups, images]) {
    if (new Set(collection.map((item) => item.id)).size !== collection.length) throw new Error("Host inventory contains duplicate opaque identifiers");
  }
  return {
    revision, environmentId, databaseIdentity, workerGeneration, measuredAt, healthy: true,
    hostLockAvailable: value.hostLockAvailable === true,
    catalogComplete: value.catalogComplete === true,
    releaseLedgerComplete: value.releaseLedgerComplete === true,
    authoritativeCurrentReleaseCount: bytes(value.authoritativeCurrentReleaseCount ?? 0, "Authoritative current release count"),
    leases: {
      backupRestore: value.leases?.backupRestore === true,
      build: value.leases?.build === true,
      deploy: value.leases?.deploy === true,
      rollback: value.leases?.rollback === true,
    },
    docker: {
      buildCache, images,
      dedicatedNamespace: value.docker?.dedicatedNamespace === true,
      dedicatedHost: value.docker?.dedicatedHost === true,
      unknownImageCount: bytes(value.docker?.unknownImageCount || 0, "Unknown image count"),
    },
    backups,
  };
}

export function canonicalHostInventoryRevision(inventoryValue) {
  const inventory=normalizeHostMaintenanceInventory(inventoryValue);
  const canonical={...inventory,revision:undefined,measuredAt:undefined,
    docker:{...inventory.docker,buildCache:[...inventory.docker.buildCache].sort((a,b)=>a.id.localeCompare(b.id)),images:[...inventory.docker.images].sort((a,b)=>a.id.localeCompare(b.id))},
    backups:[...inventory.backups].sort((a,b)=>a.id.localeCompare(b.id))};
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function assertFreshHostMaintenanceInventory(inventoryValue, {
  now = new Date(), expectedEnvironmentId, expectedDatabaseIdentity,
  maxAgeSeconds = HOST_MAINTENANCE_INVENTORY_MAX_AGE_SECONDS,
  futureSkewSeconds = HOST_MAINTENANCE_FUTURE_SKEW_SECONDS,
} = {}) {
  const inventory = normalizeHostMaintenanceInventory(inventoryValue);
  if (!expectedEnvironmentId || inventory.environmentId !== expectedEnvironmentId) throw new Error("Host inventory environment mismatch");
  if (!expectedDatabaseIdentity || inventory.databaseIdentity !== expectedDatabaseIdentity) throw new Error("Host inventory database identity mismatch");
  const measured = new Date(inventory.measuredAt).getTime();
  const reference = new Date(now).getTime();
  if (measured > reference + futureSkewSeconds * 1000) throw new Error("Host inventory timestamp is in the future");
  if (reference - measured > maxAgeSeconds * 1000) throw new Error("Host inventory is stale");
  return inventory;
}

export function buildHostMaintenancePlan(inventoryValue, {
  retainedVerifiedCount = 5,
  minimumAgeDays = 30,
  now = new Date(),
} = {}) {
  const inventory = normalizeHostMaintenanceInventory(inventoryValue);
  const keepCount = Math.max(5, Math.min(50, Number.parseInt(String(retainedVerifiedCount), 10) || 5));
  const configuredAgeDays = Math.min(365, Number.parseInt(String(minimumAgeDays), 10) || 30);
  const keepAgeDays = Math.max(30, configuredAgeDays);
  const cacheAgeDays = Math.max(7, configuredAgeDays);
  const ageCutoff = new Date(new Date(now).getTime() - keepAgeDays * 86_400_000);
  const verified = inventory.backups
    .filter((backup) => backup.checksumVerified && !backup.partial && !backup.symlink && backup.hardlinkCount === 1 &&
      backup.environmentId === inventory.environmentId && backup.databaseIdentity === inventory.databaseIdentity)
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt) || right.id.localeCompare(left.id));
  const retainedBackupIds = new Set(verified.slice(0, keepCount).map((backup) => backup.id));
  for (const backup of inventory.backups) {
    if (backup.protected || backup.currentRelease || backup.rollbackChain || !backup.checksumVerified || new Date(backup.createdAt) > ageCutoff) retainedBackupIds.add(backup.id);
  }
  const backupPolicyReady = inventory.catalogComplete && inventory.releaseLedgerComplete &&
    inventory.authoritativeCurrentReleaseCount === 1 && inventory.backups.filter((backup)=>backup.currentRelease).length===1 && !inventory.leases.backupRestore &&
    !inventory.leases.build && !inventory.leases.deploy && !inventory.leases.rollback;
  const backupCandidates = backupPolicyReady ? verified.filter((backup) => !retainedBackupIds.has(backup.id)) : [];
  const cacheCutoff = new Date(new Date(now).getTime() - cacheAgeDays * 86_400_000);
  const buildCacheCandidates = inventory.docker.dedicatedNamespace || inventory.docker.dedicatedHost
    ? inventory.docker.buildCache.filter((item) => item.unused && item.alprManaged && !item.mutable && !item.shared && new Date(item.lastUsedAt) <= cacheCutoff)
    : [];
  const imageGraceCutoff = new Date(new Date(now).getTime() - 7 * 86_400_000);
  const imageCandidates = inventory.catalogComplete && inventory.releaseLedgerComplete && inventory.authoritativeCurrentReleaseCount === 1 &&
    inventory.docker.images.filter((image)=>image.currentRelease).length===1 &&
    !inventory.leases.build && !inventory.leases.deploy && !inventory.leases.rollback && inventory.docker.unknownImageCount === 0
    ? inventory.docker.images.filter((image) =>
        image.alprManaged && image.knownInReleaseLedger && image.explicitlyRetired && image.retiredAt &&
        new Date(image.retiredAt) <= imageGraceCutoff && !image.usedByContainer &&
        !image.stoppedContainerReference && !image.currentRelease && !image.preparedRelease &&
        !image.deployedRelease && image.backupIds.length === 0 &&
        !image.rollbackReference && !image.buildLease && !image.deployLease
      )
    : [];
  const items = [
    ...buildCacheCandidates.map((item) => ({ kind: "docker-build-cache", ...item })),
    ...backupCandidates.map((item) => ({ kind: "rollout-backup", ...item })),
    ...imageCandidates.map((item) => ({ kind: "unused-alpr-image", ...item })),
  ];
  return {
    inventoryRevision: inventory.revision,
    environmentId: inventory.environmentId,
    workerGeneration: inventory.workerGeneration,
    databaseIdentity: inventory.databaseIdentity,
    measuredAt: inventory.measuredAt,
    healthy: true,
    retainedVerifiedBackupIds: [...retainedBackupIds].sort(),
    retainedVerifiedCount: keepCount,
    minimumAgeDays: keepAgeDays,
    cacheMinimumAgeDays: cacheAgeDays,
    items,
    candidateCount: items.length,
    candidateBytes: items.reduce((total, item) => total + item.bytes, 0),
  };
}

export function plansMatch(left, right) {
  if (!left || !right) return false;
  return left.inventoryRevision === right.inventoryRevision &&
    left.environmentId === right.environmentId && left.databaseIdentity === right.databaseIdentity && left.workerGeneration === right.workerGeneration &&
    candidateSetHash(left) === candidateSetHash(right);
}

export function candidateSetHash(plan) {
  const candidates = (plan?.items || []).map((item) => ({
    kind: item.kind, id: item.id, identity: item.identity, bytes: item.bytes,
    checksumSha256: item.checksumSha256 || null, device: item.device || null,
    inode: item.inode || null, modifiedAt: item.modifiedAt || null,
  })).sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  return createHash("sha256").update(JSON.stringify({environmentId:plan?.environmentId||null,databaseIdentity:plan?.databaseIdentity||null,
    workerGeneration:plan?.workerGeneration||null,candidates})).digest("hex");
}

export function planForCategory(plan, categoryValue) {
  const category = normalizeHostMaintenanceCategory(categoryValue);
  const kinds = category === "docker-build-cache"
    ? new Set(["docker-build-cache"])
    : category === "unused-alpr-images"
      ? new Set(["unused-alpr-image"])
      : new Set(["rollout-backup"]);
  const items = plan.items.filter((item) => kinds.has(item.kind));
  return { ...plan, category, items, candidateCount: items.length, candidateBytes: items.reduce((sum, item) => sum + item.bytes, 0) };
}
