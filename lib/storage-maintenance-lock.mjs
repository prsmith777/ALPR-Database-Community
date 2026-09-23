export const STORAGE_CLEANUP_LOCK_NAME = "alpr_storage_cleanup";

export async function unlockAndReleaseStorageCleanupClient(client, { shared = false } = {}) {
  let unlockError = null;
  try {
    await client.query(
      shared
        ? "SELECT pg_advisory_unlock_shared(hashtext($1))"
        : "SELECT pg_advisory_unlock(hashtext($1))",
      [STORAGE_CLEANUP_LOCK_NAME]
    );
  } catch (error) {
    unlockError = error;
  }
  // node-postgres destroys a checked-out client when release(error) is used.
  // A session whose unlock result is unknown must never re-enter the pool.
  client.release(unlockError || undefined);
  return unlockError;
}

export async function withStorageCleanupWriterLock(pool, operation) {
  if (!pool || typeof pool.connect !== "function") {
    throw new Error("Derived storage writers require a database connection pool");
  }
  if (typeof operation !== "function") {
    throw new Error("Derived storage writer operation must be a function");
  }
  const client = await pool.connect();
  let locked = false;
  let operationError = null;
  try {
    await client.query(
      "SELECT pg_advisory_lock_shared(hashtext($1))",
      [STORAGE_CLEANUP_LOCK_NAME]
    );
    locked = true;
    return await operation(client);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (locked) {
      const unlockError = await unlockAndReleaseStorageCleanupClient(client, { shared: true });
      if (unlockError && !operationError) throw unlockError;
    } else {
      client.release();
    }
  }
}
