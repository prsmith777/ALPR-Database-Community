import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pg from "pg";

import {
  createStorageCleanupPreview,
  executeStorageCleanupPreview,
  STORAGE_CLEANUP_CONFIRMATION,
} from "../lib/storage-cleanup.mjs";
import { runStorageReconciliationBatch } from "../lib/storage-reconciliation-repository.mjs";
import { canonicalVehicleImageAssetPath } from "../lib/vehicle-image-asset-model.mjs";

const OPT_IN_NAME = "VEHICLE_IMAGE_ASSET_CLEANUP_POSTGRES_TEST_OPT_IN";
const DATABASE_NAME = "VEHICLE_IMAGE_ASSET_CLEANUP_POSTGRES_TEST_DATABASE";
const GUARD_TOKEN_NAME = "VEHICLE_IMAGE_ASSET_CLEANUP_POSTGRES_TEST_GUARD_TOKEN";
const GUARD_SCOPE = "vehicle-image-asset-cleanup:v1";
const TEMPORARY_ROOT_PREFIX = "alpr-vehicle-asset-cleanup-";
const TEST_LOCK_NAME = "codex_vehicle_image_asset_cleanup_postgres_test_v1";

if (process.env[OPT_IN_NAME] !== "true") {
  throw new Error(`${OPT_IN_NAME}=true is required for this destructive integration test`);
}

function requiredEnvironment(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const expectedDatabase = requiredEnvironment(DATABASE_NAME);
const guardToken = requiredEnvironment(GUARD_TOKEN_NAME);
const connectionString = requiredEnvironment("DATABASE_URL");
const connectionUrl = new URL(connectionString);
const urlDatabase = decodeURIComponent(connectionUrl.pathname.replace(/^\/+/, ""));

if (urlDatabase !== expectedDatabase) {
  throw new Error(
    `Refusing cleanup integration test: DATABASE_URL names ${urlDatabase}, expected ${expectedDatabase}`
  );
}
if (
  expectedDatabase !== "fixture_test" &&
  !/^codex_vehicle_asset_cleanup_[0-9a-f]{8,32}$/.test(expectedDatabase)
) {
  throw new Error(
    "Refusing cleanup integration test: database name is not an approved disposable test name"
  );
}

const { Pool } = pg;
const pool = new Pool({
  connectionString,
  max: 6,
  options: "-c lock_timeout=5000 -c statement_timeout=30000",
});
const suffix = crypto.randomUUID().replaceAll("-", "");
const assetHashes = [];
const maintenanceRunIds = [];
let reconciliationRunId = null;
let temporaryRoot = null;
let lockClient = null;
let testLockHeld = false;
let databaseGuardPassed = false;
let successSummary = null;

function fixtureImage(label) {
  const bytes = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    Buffer.from(`codex-${label}-${suffix}`, "utf8"),
  ]);
  const contentSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  assetHashes.push(contentSha256);
  return {
    label,
    bytes,
    contentSha256,
    relativePath: canonicalVehicleImageAssetPath(contentSha256),
  };
}

function absoluteFixturePath(fixture) {
  return path.join(temporaryRoot, ...fixture.relativePath.split("/"));
}

async function assertDatabaseGuard() {
  lockClient = await pool.connect();
  const identity = await lockClient.query(
    `SELECT current_database() AS database_name,
            to_regclass('public.codex_integration_test_guard')::text AS guard_table,
            to_regclass('public.host_maintenance_environment_identity')::text
              AS environment_identity_table`
  );
  assert.equal(identity.rows[0]?.database_name, expectedDatabase);
  if (identity.rows[0]?.guard_table !== "codex_integration_test_guard") {
    throw new Error("Refusing cleanup integration test: disposable-database guard table is missing");
  }

  const sentinel = await lockClient.query(
    `SELECT COUNT(*)::integer AS count
     FROM public.codex_integration_test_guard
     WHERE scope = $1 AND guard_token = $2`,
    [GUARD_SCOPE, guardToken]
  );
  if (sentinel.rows[0]?.count !== 1) {
    throw new Error("Refusing cleanup integration test: disposable-database guard token is missing");
  }

  if (identity.rows[0]?.environment_identity_table) {
    const liveIdentity = await lockClient.query(
      "SELECT COUNT(*)::integer AS count FROM public.host_maintenance_environment_identity"
    );
    if (liveIdentity.rows[0]?.count !== 0) {
      throw new Error("Refusing cleanup integration test: database has an application environment identity");
    }
  }

  const initialState = await lockClient.query(
    `SELECT
       (SELECT COUNT(*)::integer FROM public.plate_reads) AS plate_reads,
       (SELECT COUNT(*)::integer FROM public.vehicle_image_assets) AS vehicle_image_assets,
       (SELECT COUNT(*)::integer FROM public.vehicle_image_asset_reads) AS vehicle_image_asset_reads,
       (SELECT COUNT(*)::integer FROM public.storage_reconciliation_runs) AS reconciliation_runs,
       (SELECT COUNT(*)::integer FROM public.maintenance_runs) AS maintenance_runs`
  );
  assert.deepEqual(initialState.rows[0], {
    plate_reads: 0,
    vehicle_image_assets: 0,
    vehicle_image_asset_reads: 0,
    reconciliation_runs: 0,
    maintenance_runs: 0,
  });

  const lock = await lockClient.query(
    "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
    [TEST_LOCK_NAME]
  );
  if (!lock.rows[0]?.locked) {
    throw new Error("Another canonical asset cleanup integration test is running");
  }
  testLockHeld = true;
  databaseGuardPassed = true;
}

async function createTemporaryStorage(fixtures) {
  const temporaryBase = path.resolve(os.tmpdir());
  temporaryRoot = await fs.mkdtemp(path.join(temporaryBase, TEMPORARY_ROOT_PREFIX));
  const relative = path.relative(temporaryBase, path.resolve(temporaryRoot));
  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !path.basename(temporaryRoot).startsWith(TEMPORARY_ROOT_PREFIX)
  ) {
    throw new Error("Temporary cleanup storage root failed containment validation");
  }

  await Promise.all([
    fs.mkdir(path.join(temporaryRoot, "images"), { recursive: true }),
    fs.mkdir(path.join(temporaryRoot, "thumbnails"), { recursive: true }),
    fs.mkdir(path.join(temporaryRoot, "derived"), { recursive: true }),
  ]);
  const oldTimestamp = new Date(Date.now() - (3 * 86_400_000));
  oldTimestamp.setMilliseconds(0);
  for (const fixture of fixtures) {
    const fullPath = absoluteFixturePath(fixture);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, fixture.bytes, { flag: "wx", mode: 0o600 });
    await fs.utimes(fullPath, oldTimestamp, oldTimestamp);
  }
}

async function insertAsset(fixture) {
  const result = await pool.query(
    `INSERT INTO public.vehicle_image_assets (
       content_sha256, storage_path, media_type, byte_size, image_width, image_height
     ) VALUES ($1, $2, 'image/jpeg', $3, 1, 1)
     RETURNING id`,
    [fixture.contentSha256, fixture.relativePath, fixture.bytes.length]
  );
  return Number(result.rows[0].id);
}

async function completeReconciliation() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await runStorageReconciliationBatch({
      pool,
      baseDir: temporaryRoot,
      enabled: true,
      intervalSeconds: 3_600,
      initialDelaySeconds: 0,
      batchSize: 25,
    });
    if (result.runId) reconciliationRunId = Number(result.runId);
    if (result.status === "completed") return result;
    assert.equal(result.status, "running");
  }
  throw new Error("Storage reconciliation did not complete within 100 bounded batches");
}

async function cleanupDatabaseFixtures() {
  if (!databaseGuardPassed) return;
  if (reconciliationRunId == null) {
    const discoveredReconciliation = await pool.query(
      "SELECT id FROM public.storage_reconciliation_runs ORDER BY id"
    );
    if (discoveredReconciliation.rowCount > 1) {
      throw new Error("Cleanup integration test found an unexpected reconciliation run");
    }
    if (discoveredReconciliation.rowCount === 1) {
      reconciliationRunId = Number(discoveredReconciliation.rows[0].id);
    }
  }
  if (maintenanceRunIds.length) {
    const discoveredMaintenance = await pool.query(
      `SELECT id FROM public.maintenance_runs
       WHERE id = ANY($1::bigint[]) OR preview_run_id = ANY($1::bigint[])
       ORDER BY id`,
      [maintenanceRunIds]
    );
    for (const row of discoveredMaintenance.rows) {
      const runId = Number(row.id);
      if (!maintenanceRunIds.includes(runId)) maintenanceRunIds.push(runId);
    }
  }
  const resourceIds = maintenanceRunIds.map(String);
  if (resourceIds.length) {
    await pool.query(
      `INSERT INTO public.audit_event_archive (
         source_event_id, actor_user_id, actor_api_credential_id, source,
         event_type, resource_type, resource_id, outcome, reason, request_id,
         metadata, occurred_at, retention_preview_id
       )
       SELECT id, actor_user_id, actor_api_credential_id, source,
              event_type, resource_type, resource_id, outcome, reason, request_id,
              metadata, occurred_at, NULL
       FROM public.audit_events
       WHERE resource_type = 'maintenance-run'
         AND resource_id = ANY($1::text[])
         AND event_type = ANY($2::text[])
       ON CONFLICT (source_event_id, occurred_at) DO NOTHING`,
      [
        resourceIds,
        [
          "maintenance.storage_cleanup_previewed",
          "maintenance.storage_cleanup_started",
          "maintenance.storage_cleanup_executed",
          "maintenance.storage_cleanup_interrupted",
        ],
      ]
    );
    await pool.query(
      `DELETE FROM public.audit_events
       WHERE resource_type = 'maintenance-run'
         AND resource_id = ANY($1::text[])
         AND event_type = ANY($2::text[])`,
      [
        resourceIds,
        [
          "maintenance.storage_cleanup_previewed",
          "maintenance.storage_cleanup_started",
          "maintenance.storage_cleanup_executed",
          "maintenance.storage_cleanup_interrupted",
        ],
      ]
    );
    for (const runId of [...maintenanceRunIds].sort((left, right) => right - left)) {
      await pool.query("DELETE FROM public.maintenance_runs WHERE id = $1", [runId]);
    }
  }
  if (reconciliationRunId != null) {
    await pool.query("DELETE FROM public.storage_reconciliation_runs WHERE id = $1", [reconciliationRunId]);
  }
  await pool.query(
    "DELETE FROM public.maintenance_job_state WHERE job_name = 'storage-reconciliation'"
  );
  if (assetHashes.length) {
    await pool.query(
      "DELETE FROM public.vehicle_image_assets WHERE content_sha256::text = ANY($1::text[])",
      [assetHashes]
    );
  }

  const residue = await pool.query(
    `SELECT
       (SELECT COUNT(*)::integer FROM public.vehicle_image_assets
        WHERE content_sha256::text = ANY($1::text[])) AS asset_count,
       (SELECT COUNT(*)::integer FROM public.storage_reconciliation_runs
        WHERE id = $2::bigint) AS reconciliation_count,
       (SELECT COUNT(*)::integer FROM public.maintenance_runs
        WHERE id = ANY($3::bigint[])) AS maintenance_count,
       (SELECT COUNT(*)::integer FROM public.audit_events
        WHERE resource_type = 'maintenance-run'
          AND resource_id = ANY($4::text[])) AS audit_count`,
    [assetHashes, reconciliationRunId, maintenanceRunIds, resourceIds]
  );
  assert.deepEqual(residue.rows[0], {
    asset_count: 0,
    reconciliation_count: 0,
    maintenance_count: 0,
    audit_count: 0,
  });
}

async function removeTemporaryStorage() {
  if (!temporaryRoot) return;
  const temporaryBase = path.resolve(os.tmpdir());
  const resolved = path.resolve(temporaryRoot);
  const relative = path.relative(temporaryBase, resolved);
  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !path.basename(resolved).startsWith(TEMPORARY_ROOT_PREFIX)
  ) {
    throw new Error("Refusing to remove an unvalidated temporary cleanup root");
  }
  await fs.rm(resolved, { recursive: true, force: true });
}

try {
  await assertDatabaseGuard();

  const protectedBeforeScan = fixtureImage("protected-before-scan");
  const protectedAfterScan = fixtureImage("protected-after-scan");
  const deletionControl = fixtureImage("deletion-control");
  await createTemporaryStorage([
    protectedBeforeScan,
    protectedAfterScan,
    deletionControl,
  ]);

  const protectedBeforeScanId = await insertAsset(protectedBeforeScan);
  const reconciliation = await completeReconciliation();
  assert.equal(reconciliation.status, "completed");
  assert.equal(reconciliation.result.destructive, false);
  assert.equal(reconciliation.result.errorCount, 0);
  assert.equal(reconciliation.result.missingReferencePaths, 0);
  assert.equal(reconciliation.result.orphanFiles, 2);
  assert.equal(reconciliation.result.filesScanned, 3);
  assert.equal(reconciliation.result.referencesChecked, 1);

  const reconciliationState = await pool.query(
    `SELECT status, phase, max_vehicle_image_asset_id, vehicle_image_asset_cursor
     FROM public.storage_reconciliation_runs WHERE id = $1`,
    [reconciliationRunId]
  );
  assert.equal(reconciliationState.rows[0].status, "completed");
  assert.equal(reconciliationState.rows[0].phase, "completed");
  assert.equal(Number(reconciliationState.rows[0].max_vehicle_image_asset_id), protectedBeforeScanId);
  assert.equal(Number(reconciliationState.rows[0].vehicle_image_asset_cursor), protectedBeforeScanId);

  const findings = await pool.query(
    `SELECT finding_type, relative_path, size_bytes
     FROM public.storage_reconciliation_items
     WHERE run_id = $1 ORDER BY relative_path`,
    [reconciliationRunId]
  );
  assert.equal(findings.rowCount, 2);
  const findingByPath = new Map(findings.rows.map((row) => [row.relative_path, row]));
  for (const fixture of [protectedAfterScan, deletionControl]) {
    assert.deepEqual(
      {
        findingType: findingByPath.get(fixture.relativePath)?.finding_type,
        sizeBytes: Number(findingByPath.get(fixture.relativePath)?.size_bytes),
      },
      { findingType: "orphan-file", sizeBytes: fixture.bytes.length }
    );
  }
  assert.equal(
    findings.rows.some((row) => row.relative_path === protectedBeforeScan.relativePath),
    false
  );

  const previewNow = new Date();
  const preview = await createStorageCleanupPreview({
    pool,
    now: previewNow,
    graceSeconds: 86_400,
    tokenFactory: () => `vehicle-asset-cleanup-${suffix}`,
  });
  maintenanceRunIds.push(preview.runId);
  assert.equal(preview.destructive, false);
  assert.equal(preview.candidateCount, 2);
  assert.equal(
    preview.candidateBytes,
    protectedAfterScan.bytes.length + deletionControl.bytes.length
  );

  // Simulate the strongest race: reconciliation and the immutable cleanup
  // preview both saw this path as orphaned, then a canonical asset acquired it
  // before execution. The execution-time reference check must still preserve it.
  await insertAsset(protectedAfterScan);

  const execution = await executeStorageCleanupPreview({
    pool,
    storagePath: temporaryRoot,
    previewToken: preview.previewToken,
    confirmation: STORAGE_CLEANUP_CONFIRMATION,
    now: () => new Date(),
  });
  maintenanceRunIds.push(execution.runId);
  assert.equal(execution.status, "completed");
  assert.equal(execution.failureCount, 0);
  assert.equal(execution.reclaimedBytes, deletionControl.bytes.length);
  assert.deepEqual(execution.counts, {
    "skipped-referenced": 1,
    deleted: 1,
  });

  const cleanupItems = await pool.query(
    `SELECT relative_path, status, reclaimed_bytes
     FROM public.maintenance_cleanup_items
     WHERE run_id = $1 ORDER BY relative_path`,
    [execution.runId]
  );
  const cleanupByPath = new Map(cleanupItems.rows.map((row) => [row.relative_path, row]));
  assert.deepEqual(
    {
      status: cleanupByPath.get(protectedAfterScan.relativePath)?.status,
      reclaimedBytes: Number(cleanupByPath.get(protectedAfterScan.relativePath)?.reclaimed_bytes),
    },
    { status: "skipped-referenced", reclaimedBytes: 0 }
  );
  assert.deepEqual(
    {
      status: cleanupByPath.get(deletionControl.relativePath)?.status,
      reclaimedBytes: Number(cleanupByPath.get(deletionControl.relativePath)?.reclaimed_bytes),
    },
    { status: "deleted", reclaimedBytes: deletionControl.bytes.length }
  );

  assert.deepEqual(await fs.readFile(absoluteFixturePath(protectedBeforeScan)), protectedBeforeScan.bytes);
  assert.deepEqual(await fs.readFile(absoluteFixturePath(protectedAfterScan)), protectedAfterScan.bytes);
  await assert.rejects(
    fs.stat(absoluteFixturePath(deletionControl)),
    (error) => error?.code === "ENOENT"
  );

  const retainedAssets = await pool.query(
    `SELECT content_sha256::text AS content_sha256, storage_path
     FROM public.vehicle_image_assets
     WHERE content_sha256::text = ANY($1::text[])
     ORDER BY content_sha256`,
    [[protectedBeforeScan.contentSha256, protectedAfterScan.contentSha256]]
  );
  assert.equal(retainedAssets.rowCount, 2);
  const retainedByHash = new Map(retainedAssets.rows.map((row) => [row.content_sha256, row]));
  for (const fixture of [protectedBeforeScan, protectedAfterScan]) {
    assert.equal(retainedByHash.get(fixture.contentSha256)?.storage_path, fixture.relativePath);
  }

  const lifecycle = await pool.query(
    `SELECT
       (SELECT consumed_at IS NOT NULL FROM public.maintenance_cleanup_tokens
        WHERE preview_run_id = $1) AS token_consumed,
       (SELECT result->>'reconciliationRequired' FROM public.maintenance_runs
        WHERE id = $2) AS reconciliation_required,
       (SELECT COUNT(*)::integer FROM public.audit_events
        WHERE resource_type = 'maintenance-run'
          AND resource_id = ANY($3::text[])
          AND event_type = ANY($4::text[])
          AND outcome = 'succeeded') AS successful_audits`,
    [
      preview.runId,
      execution.runId,
      [String(preview.runId), String(execution.runId)],
      [
        "maintenance.storage_cleanup_previewed",
        "maintenance.storage_cleanup_started",
        "maintenance.storage_cleanup_executed",
      ],
    ]
  );
  assert.deepEqual(lifecycle.rows[0], {
    token_consumed: true,
    reconciliation_required: "false",
    successful_audits: 3,
  });

  successSummary = {
    status: "passed",
    database: expectedDatabase,
    reconciliationRunId,
    previewRunId: preview.runId,
    executionRunId: execution.runId,
    protectedFiles: 2,
    deletedControls: 1,
    reclaimedBytes: execution.reclaimedBytes,
  };
} finally {
  let cleanupError = null;
  try {
    await cleanupDatabaseFixtures();
  } catch (error) {
    cleanupError = error;
  }
  try {
    await removeTemporaryStorage();
  } catch (error) {
    cleanupError ||= error;
  }
  if (lockClient) {
    if (testLockHeld) {
      try {
        await lockClient.query(
          "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
          [TEST_LOCK_NAME]
        );
      } catch (error) {
        cleanupError ||= error;
      }
    }
    lockClient.release(cleanupError || undefined);
  }
  await pool.end();
  if (cleanupError) throw cleanupError;
}

console.log(JSON.stringify(successSummary));
