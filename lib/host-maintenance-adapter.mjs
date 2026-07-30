import { canonicalHostInventoryRevision, normalizeHostMaintenanceInventory } from "./host-maintenance-policy.mjs";

export class DisabledHostMaintenanceAdapter {
  capabilities = Object.freeze([]);

  async inspect() {
    throw new Error("The fixed privileged host-maintenance interface is not configured");
  }

  async prune() {
    throw new Error("The fixed privileged host-maintenance interface is not configured");
  }

  async backup() {
    throw new Error("The fixed database-backup interface is not configured");
  }
}

// Safe local adapter for automated tests and development simulations. It can
// mutate only its in-memory inventory and never invokes a shell or filesystem.
export class InMemoryHostMaintenanceAdapter {
  constructor(inventory) {
    this.inventory = normalizeHostMaintenanceInventory(inventory);
    this.capabilities = Object.freeze(["database-backup-create-v1"]);
  }

  async inspect() {
    return structuredClone(this.inventory);
  }

  async prune({ category, environmentId, databaseIdentity, workerGeneration, inventoryRevision, candidateSetHash, items, maxItems, maxBytes, deadline }) {
    if (inventoryRevision !== this.inventory.revision) throw new Error("Host inventory revision changed before prune");
    const expectedKind = { "docker-build-cache": "docker-build-cache", "unused-alpr-images": "unused-alpr-image", "rollout-backups": "rollout-backup" }[category];
    if (!expectedKind || items.some((item) => item.kind !== expectedKind)) throw new Error("Cross-category host prune request rejected");
    if (items.length > maxItems || items.reduce((sum, item) => sum + item.bytes, 0) > maxBytes) throw new Error("Host prune request exceeds its category cap");
    if (!deadline || new Date(deadline) <= new Date()) throw new Error("Host prune request deadline expired");
    const allowed = new Set(items.map((item) => `${item.kind}:${item.id}:${item.identity}`));
    let reclaimedBytes = 0;
    const results = [];
    const remove = (collection, kind) => collection.filter((item) => {
      const key = `${kind}:${item.id}:${item.identity}`;
      if (!allowed.has(key)) return true;
      reclaimedBytes += item.bytes;
      results.push({ kind, id: item.id, identity: item.identity, status: "deleted", reclaimedBytes: item.bytes });
      return false;
    });
    this.inventory.docker.buildCache = remove(this.inventory.docker.buildCache, "docker-build-cache");
    this.inventory.backups = remove(this.inventory.backups, "rollout-backup");
    this.inventory.docker.images = remove(this.inventory.docker.images, "unused-alpr-image");
    this.inventory.measuredAt = new Date().toISOString();
    this.inventory.revision = canonicalHostInventoryRevision(this.inventory);
    return { results, reclaimedBytes, hostLockHeld: true, durationMs: 1,
      environmentId, databaseIdentity, workerGeneration, inventoryRevision, candidateSetHash };
  }

  async backup({ operation, format, environmentId, databaseIdentity, workerGeneration, requestId, maxBytes, deadline }) {
    if (operation !== "postgres-database-backup" || format !== "custom") throw new Error("Unsupported database-backup operation");
    if (!Number.isSafeInteger(requestId) || requestId <= 0) throw new Error("Database-backup request id is invalid");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024) throw new Error("Database-backup byte cap is invalid");
    if (!deadline || new Date(deadline) <= new Date()) throw new Error("Database-backup request deadline expired");
    const createdAt = new Date().toISOString();
    const stamp = createdAt.replaceAll("-", "").replaceAll(":", "").slice(0, 15) + "Z";
    return {
      hostLockHeld: true,
      environmentId,
      databaseIdentity,
      workerGeneration,
      requestId,
      format: "custom",
      filename: `alpr-postgres-${stamp}-${requestId}.dump`,
      sizeBytes: 1024,
      checksumSha256: "0".repeat(64),
      verified: true,
      durationMs: 1,
      createdAt,
    };
  }
}

let adapter = new DisabledHostMaintenanceAdapter();

export function getHostMaintenanceAdapter() {
  return adapter;
}

export function setHostMaintenanceAdapterForTests(value) {
  if (!value || typeof value.inspect !== "function" || typeof value.prune !== "function") {
    throw new Error("Host maintenance adapter must expose fixed inspect and prune methods");
  }
  adapter = value;
}
