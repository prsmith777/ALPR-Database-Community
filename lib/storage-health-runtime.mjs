import { stat, statfs } from "node:fs/promises";

import { getPool } from "./db.js";
import fileStorage from "./fileStorage.js";
import { resolveStoragePath } from "./storage-path.mjs";
import { collectStorageHealth, unavailableStorageHealth } from "./storage-health.mjs";

export async function getStorageHealth() {
  try {
    const pool = await getPool();
    return await collectStorageHealth({
      query: (text, values) => pool.query(text, values),
      storagePath: fileStorage.baseDir,
      statfs,
      statPath: stat,
      resolvePath: (relativePath) => resolveStoragePath(fileStorage.baseDir, relativePath),
    });
  } catch {
    return unavailableStorageHealth();
  }
}
