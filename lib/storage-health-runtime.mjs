import { stat, statfs } from "node:fs/promises";

import { getPool } from "./db.js";
import fileStorage from "./fileStorage.js";
import { resolveStoragePath } from "./storage-path.mjs";
import { collectStorageHealth, unavailableStorageHealth } from "./storage-health.mjs";
import { getMaintenanceJobStatus } from "./maintenance-repository.mjs";
import { getStorageReconciliationStatus } from "./storage-reconciliation-repository.mjs";
import { collectStorageBreakdown } from "./storage-breakdown.mjs";

export async function getStorageHealth() {
  try {
    const pool = await getPool();
    const query = (text, values) => pool.query(text, values);
    const [snapshot, maintenance, reconciliation] = await Promise.all([
      collectStorageHealth({
        query,
        storagePath: fileStorage.baseDir,
        statfs,
        statPath: stat,
        resolvePath: (relativePath) => resolveStoragePath(fileStorage.baseDir, relativePath),
      }),
      getMaintenanceJobStatus({ query }).catch(() => null),
      getStorageReconciliationStatus({ query }).catch(() => null),
    ]);
    const breakdown = await collectStorageBreakdown({
      storagePath: fileStorage.baseDir,
      databaseBytes: snapshot.database?.totalBytes ?? null,
    });
    return {
      ...snapshot,
      breakdown,
      errors: [...(snapshot.errors || []), ...(breakdown.errors || [])],
      maintenance,
      reconciliation,
    };
  } catch {
    return { ...unavailableStorageHealth(), breakdown: null, maintenance: null, reconciliation: null };
  }
}
