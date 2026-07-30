import { canonicalHostInventoryRevision, normalizeHostMaintenanceInventory } from "./host-maintenance-policy.mjs";

export class DisabledHostMaintenanceAdapter {
  async inspect() {
    throw new Error("The fixed privileged host-maintenance interface is not configured");
  }

  async prune() {
    throw new Error("The fixed privileged host-maintenance interface is not configured");
  }
}

// Safe local adapter for automated tests and development simulations. It can
// mutate only its in-memory inventory and never invokes a shell or filesystem.
export class InMemoryHostMaintenanceAdapter {
  constructor(inventory) {
    this.inventory = normalizeHostMaintenanceInventory(inventory);
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
