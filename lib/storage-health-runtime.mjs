import { stat, statfs } from "node:fs/promises";

import { getPool } from "./db.js";
import fileStorage from "./fileStorage.js";
import { resolveStoragePath } from "./storage-path.mjs";
import { collectStorageHealth, unavailableStorageHealth } from "./storage-health.mjs";
import { getMaintenanceJobStatus } from "./maintenance-repository.mjs";
import { getStorageReconciliationStatus } from "./storage-reconciliation-repository.mjs";

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
    return { ...snapshot, maintenance, reconciliation };
  } catch {
    return { ...unavailableStorageHealth(), maintenance: null, reconciliation: null };
  }
}
