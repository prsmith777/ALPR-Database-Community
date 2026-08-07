import assert from "node:assert/strict";

import pg from "pg";

import { InMemoryHostMaintenanceAdapter } from "../lib/host-maintenance-adapter.mjs";
import { getHostBackupCatalogOverview } from "../lib/host-maintenance-control.mjs";
import { inspectAndHeartbeatHostMaintenanceWorker } from "../lib/host-maintenance.mjs";
import { canonicalHostInventoryRevision } from "../lib/host-maintenance-policy.mjs";

const { Pool } = pg;
const NOW = new Date("2026-08-05T18:00:00.000Z");
const ENVIRONMENT_ID = "catalog-integration-local";
const DATABASE_IDENTITY = "catalog-integration-db";

function requiredEnvironment(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function backup(id, days, extra = {}) {
  const timestamp = new Date(NOW.getTime() - days * 86_400_000).toISOString();
  return {
    id,
    identity: `identity-${id}`,
    bytes: 1024,
    createdAt: timestamp,
    checksumVerified: true,
    checksumSha256: "a".repeat(64),
    protected: false,
    currentRelease: false,
    rollbackChain: false,
    imageIds: [],
    environmentId: ENVIRONMENT_ID,
    databaseIdentity: DATABASE_IDENTITY,
    releaseId: `release-${id}`,
    schemaVersion: "schema-1",
    postgresFormat: "custom",
    device: "device-local",
    inode: `inode-${id}`,
    modifiedAt: timestamp,
    partial: false,
    symlink: false,
    hardlinkCount: 1,
    ...extra,
  };
}

function inventory() {
  const value = {
    healthy: true,
    revision: "temporary",
    environmentId: ENVIRONMENT_ID,
    databaseIdentity: DATABASE_IDENTITY,
    workerGeneration: "worker-local-1",
    measuredAt: NOW.toISOString(),
    hostLockAvailable: true,
    catalogComplete: true,
    releaseLedgerComplete: true,
    workerImageLedgerComplete: true,
    authoritativeCurrentReleaseCount: 1,
    authoritativeCurrentWorkerCount: 1,
    leases: { backupRestore: false, build: false, deploy: false, rollback: false },
    docker: { dedicatedNamespace: true, dedicatedHost: false, unknownImageCount: 0, buildCache: [], images: [] },
    backups: [
      backup("state-current", 90, { protected: true, currentRelease: true }),
      backup("old-1", 60), backup("old-2", 55), backup("old-3", 50),
      backup("old-4", 45), backup("old-5", 40), backup("old-6", 35),
      backup("recent", 10),
    ],
  };
  value.revision = canonicalHostInventoryRevision(value);
  return value;
}

async function rejected(query, matcher) {
  await assert.rejects(query, (error) => {
    assert.match(String(error?.message || error), matcher);
    return true;
  });
}

const adminPool = new Pool({ connectionString: requiredEnvironment("DATABASE_URL"), max: 2 });
const workerPool = new Pool({ connectionString: requiredEnvironment("BACKUP_CATALOG_WORKER_DATABASE_URL"), max: 2 });

try {
  const workerIdentity = await workerPool.query("SELECT current_user, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname=current_user");
  assert.equal(workerIdentity.rowCount, 1);
  assert.deepEqual(workerIdentity.rows[0], {
    current_user: workerIdentity.rows[0].current_user,
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    rolbypassrls: false,
  });

  await adminPool.query(
    "INSERT INTO public.host_maintenance_environment_identity(singleton,environment_id,database_identity) VALUES(TRUE,$1,$2) ON CONFLICT(singleton) DO NOTHING",
    [ENVIRONMENT_ID, DATABASE_IDENTITY],
  );

  const configuration = await adminPool.query("SELECT automation_supported,scheduled_enabled,next_run_at FROM public.host_maintenance_config WHERE category='rollout-backups'");
  assert.equal(configuration.rowCount, 1);
  assert.equal(configuration.rows[0].automation_supported, false);
  assert.equal(configuration.rows[0].scheduled_enabled, false);
  assert.equal(configuration.rows[0].next_run_at, null);

  const catalogColumns = await adminPool.query(`SELECT table_name,column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name IN('host_backup_catalog_snapshots','host_backup_catalog_entries') ORDER BY table_name,ordinal_position`);
  assert.ok(catalogColumns.rowCount > 0);
  const forbiddenColumns = catalogColumns.rows.filter(({ column_name: column }) => /path|delete|purge|quarantine|token/i.test(column));
  assert.deepEqual(forbiddenColumns, []);

  const workerRole = workerIdentity.rows[0].current_user;
  const acl = await adminPool.query(`SELECT
    has_table_privilege($1,'public.host_backup_catalog_snapshots','SELECT') AS snapshots_select,
    has_table_privilege($1,'public.host_backup_catalog_snapshots','INSERT') AS snapshots_insert,
    has_table_privilege($1,'public.host_backup_catalog_snapshots','UPDATE') AS snapshots_update,
    has_table_privilege($1,'public.host_backup_catalog_snapshots','DELETE') AS snapshots_delete,
    has_table_privilege($1,'public.host_backup_catalog_snapshots','TRUNCATE') AS snapshots_truncate,
    has_table_privilege($1,'public.host_backup_catalog_entries','SELECT') AS entries_select,
    has_table_privilege($1,'public.host_backup_catalog_entries','INSERT') AS entries_insert,
    has_table_privilege($1,'public.host_backup_catalog_entries','UPDATE') AS entries_update,
    has_table_privilege($1,'public.host_backup_catalog_entries','DELETE') AS entries_delete,
    has_table_privilege($1,'public.host_backup_catalog_entries','TRUNCATE') AS entries_truncate,
    has_sequence_privilege($1,'public.host_backup_catalog_snapshots_id_seq','USAGE') AS snapshots_sequence,
    has_sequence_privilege($1,'public.host_backup_catalog_entries_id_seq','USAGE') AS entries_sequence`, [workerRole]);
  assert.deepEqual(acl.rows[0], {
    snapshots_select: true, snapshots_insert: true, snapshots_update: false, snapshots_delete: false, snapshots_truncate: false,
    entries_select: true, entries_insert: true, entries_update: false, entries_delete: false, entries_truncate: false,
    snapshots_sequence: true, entries_sequence: true,
  });

  const value = inventory();
  const adapter = new InMemoryHostMaintenanceAdapter(value);
  const first = await inspectAndHeartbeatHostMaintenanceWorker({
    executor: workerPool,
    adapter,
    workerId: "catalog-integration-worker",
    now: NOW,
    expectedEnvironmentId: ENVIRONMENT_ID,
    expectedDatabaseIdentity: DATABASE_IDENTITY,
  });
  const second = await inspectAndHeartbeatHostMaintenanceWorker({
    executor: workerPool,
    adapter,
    workerId: "catalog-integration-worker",
    now: NOW,
    expectedEnvironmentId: ENVIRONMENT_ID,
    expectedDatabaseIdentity: DATABASE_IDENTITY,
  });
  assert.equal(first.backupCatalogRevision, second.backupCatalogRevision);

  const counts = await adminPool.query(`SELECT
    (SELECT COUNT(*)::int FROM public.host_backup_catalog_snapshots) AS snapshots,
    (SELECT COUNT(*)::int FROM public.host_backup_catalog_entries) AS entries,
    (SELECT COUNT(*)::int FROM public.host_maintenance_worker_state) AS worker_rows`);
  assert.deepEqual(counts.rows[0], { snapshots: 1, entries: 8, worker_rows: 1 });

  process.env.HOST_MAINTENANCE_ENVIRONMENT_ID = ENVIRONMENT_ID;
  process.env.HOST_MAINTENANCE_DATABASE_IDENTITY = DATABASE_IDENTITY;
  const overview = await getHostBackupCatalogOverview({ executor: adminPool, now: NOW });
  assert.equal(overview.status, "ready");
  assert.equal(overview.policyReady, true);
  assert.equal(overview.backupCount, 8);
  assert.equal(overview.verifiedCount, 8);
  assert.equal(overview.protectedCount, 6);
  assert.equal(overview.candidateCount, 2);
  assert.equal(overview.destructiveExecutionAvailable, false);
  assert.equal(overview.entries.find((entry) => entry.id === "state-current").disposition, "protected");
  assert.ok(overview.entries.find((entry) => entry.id === "recent").protectionReasons.includes("newer-than-age-floor"));
  for (const entry of overview.entries) {
    assert.equal("identity" in entry, false);
    assert.equal("checksumSha256" in entry, false);
    assert.equal("device" in entry, false);
    assert.equal("inode" in entry, false);
    assert.equal("path" in entry, false);
  }
  const staleOverview = await getHostBackupCatalogOverview({ executor: adminPool, now: new Date(NOW.getTime() + 360_000) });
  assert.equal(staleOverview.status, "unavailable");
  assert.equal(staleOverview.destructiveExecutionAvailable, false);

  const tamperClient = await adminPool.connect();
  try {
    await tamperClient.query("BEGIN");
    await tamperClient.query(`INSERT INTO public.host_backup_catalog_snapshots
      (catalog_version,environment_id,database_identity,worker_generation,inventory_revision,catalog_revision,inventory_measured_at,
       catalog_complete,release_ledger_complete,authoritative_current_release_count,backup_restore_lease,build_lease,deploy_lease,rollback_lease,
       backup_count,backup_bytes,created_at)
      SELECT catalog_version,environment_id,database_identity,worker_generation,inventory_revision,$1,inventory_measured_at,
       catalog_complete,release_ledger_complete,authoritative_current_release_count,backup_restore_lease,build_lease,deploy_lease,rollback_lease,
       0,0,created_at FROM public.host_backup_catalog_snapshots ORDER BY id LIMIT 1`, ["b".repeat(64)]);
    const tamperedOverview = await getHostBackupCatalogOverview({ executor: tamperClient, now: NOW });
    assert.equal(tamperedOverview.status, "blocked");
    assert.deepEqual(tamperedOverview.policyBlocks, ["catalog-integrity-mismatch"]);
  } finally {
    await tamperClient.query("ROLLBACK");
    tamperClient.release();
  }

  await rejected(workerPool.query("UPDATE public.host_backup_catalog_snapshots SET backup_bytes=0"), /permission denied/i);
  await rejected(workerPool.query("DELETE FROM public.host_backup_catalog_entries"), /permission denied/i);
  await rejected(workerPool.query("TRUNCATE public.host_backup_catalog_snapshots"), /permission denied/i);
  await rejected(adminPool.query("UPDATE public.host_backup_catalog_snapshots SET backup_bytes=0"), /append-only/i);
  await rejected(adminPool.query("DELETE FROM public.host_backup_catalog_entries"), /append-only/i);
  await rejected(adminPool.query("TRUNCATE public.host_backup_catalog_entries"), /append-only/i);

  if (process.env.BACKUP_CATALOG_EXPECT_MIGRATION === "true") {
    const migration = await adminPool.query("SELECT 1 FROM public.schema_migrations WHERE version='2026080501_read_only_backup_catalog'");
    assert.equal(migration.rowCount, 1);
  }

  console.log(JSON.stringify({
    status: "passed",
    database: new URL(requiredEnvironment("DATABASE_URL")).pathname.slice(1),
    workerRole,
    catalogRevision: overview.catalogRevision,
    snapshots: counts.rows[0].snapshots,
    entries: counts.rows[0].entries,
    protected: overview.protectedCount,
    previewCandidates: overview.candidateCount,
    destructiveExecutionAvailable: overview.destructiveExecutionAvailable,
  }));
} finally {
  await Promise.allSettled([workerPool.end(), adminPool.end()]);
}
