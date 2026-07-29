async function defaultPool() {
  return (await import("./db.js")).getPool();
}

export async function getPostgresMaintenanceObservability({ executor } = {}) {
  const database = executor || await defaultPool();
  const [databaseStats, tableStats, tableDetails, transactionAge] = await Promise.all([
    database.query(
      `SELECT current_database() AS database_name,
              pg_database_size(current_database())::bigint AS database_bytes,
              stats_reset
       FROM pg_stat_database WHERE datname = current_database()`
    ),
    database.query(
      `SELECT COUNT(*)::bigint AS table_count,
              COALESCE(SUM(n_live_tup), 0)::bigint AS live_tuples,
              COALESCE(SUM(n_dead_tup), 0)::bigint AS dead_tuples,
              MAX(last_autovacuum) AS last_autovacuum,
              MAX(last_autoanalyze) AS last_autoanalyze,
              MAX(last_vacuum) AS last_manual_vacuum,
              MAX(last_analyze) AS last_manual_analyze
       FROM pg_stat_user_tables`
    ),
    database.query(
      `SELECT schemaname, relname, n_live_tup::bigint AS live_tuples,
              n_dead_tup::bigint AS dead_tuples,
              CASE WHEN n_live_tup + n_dead_tup = 0 THEN 0
                   ELSE ROUND((n_dead_tup::numeric * 100) / (n_live_tup + n_dead_tup), 2) END AS dead_percent,
              last_autovacuum, last_autoanalyze
       FROM pg_stat_user_tables
       ORDER BY n_dead_tup DESC, relname ASC LIMIT 20`
    ),
    database.query(
      `SELECT age(datfrozenxid)::bigint AS transaction_id_age,
              current_setting('autovacuum_freeze_max_age')::bigint AS freeze_max_age
       FROM pg_database WHERE datname = current_database()`
    ),
  ]);
  const db = databaseStats.rows?.[0] || {};
  const tables = tableStats.rows?.[0] || {};
  const xid = transactionAge.rows?.[0] || {};
  return {
    available: true,
    databaseName: db.database_name || null,
    databaseBytes: db.database_bytes == null ? null : Number(db.database_bytes),
    statsResetAt: db.stats_reset || null,
    tableCount: Number(tables.table_count || 0),
    liveTuples: Number(tables.live_tuples || 0),
    deadTuples: Number(tables.dead_tuples || 0),
    lastAutovacuumAt: tables.last_autovacuum || null,
    lastAutoanalyzeAt: tables.last_autoanalyze || null,
    lastManualVacuumAt: tables.last_manual_vacuum || null,
    lastManualAnalyzeAt: tables.last_manual_analyze || null,
    executionEnabled: false,
    transactionIdAge: xid.transaction_id_age == null ? null : Number(xid.transaction_id_age),
    freezeMaxAge: xid.freeze_max_age == null ? null : Number(xid.freeze_max_age),
    tables: (tableDetails.rows || []).map((row) => ({
      schema: row.schemaname,
      table: row.relname,
      liveTuples: Number(row.live_tuples || 0),
      deadTuples: Number(row.dead_tuples || 0),
      deadPercent: Number(row.dead_percent || 0),
      needsAttention: Number(row.dead_tuples || 0) >= 10_000 && Number(row.dead_percent || 0) >= 20,
      lastAutovacuumAt: row.last_autovacuum || null,
      lastAutoanalyzeAt: row.last_autoanalyze || null,
    })),
  };
}
