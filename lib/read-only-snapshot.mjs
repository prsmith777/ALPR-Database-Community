// A single client and snapshot keep mode, page selection, and identity evidence
// consistent even if a review or authority transition commits during the read.
export async function withReadOnlySnapshot(pool, operation, { connect = () => pool.connect() } = {}) {
  const client = await connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
