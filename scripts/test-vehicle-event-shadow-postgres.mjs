import assert from "node:assert/strict";
import crypto from "node:crypto";

import pg from "pg";

import { canonicalVehicleImageAssetPath } from "../lib/vehicle-image-asset-model.mjs";
import { VehicleEventShadowRepository } from "../lib/vehicle-event-shadow-repository.mjs";
import { VehicleEventShadowService } from "../lib/vehicle-event-shadow.mjs";

const OPT_IN_NAME = "VEHICLE_EVENT_SHADOW_POSTGRES_TEST_OPT_IN";
const DATABASE_NAME = "VEHICLE_EVENT_SHADOW_POSTGRES_TEST_DATABASE";
const GUARD_TOKEN_NAME = "VEHICLE_EVENT_SHADOW_POSTGRES_TEST_GUARD_TOKEN";
const GUARD_SCOPE = "vehicle-event-shadow:v1";
const TEST_LOCK_NAME = "codex_vehicle_event_shadow_postgres_test_v1";

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
    `Refusing shadow-event integration test: DATABASE_URL names ${urlDatabase}, expected ${expectedDatabase}`
  );
}
if (expectedDatabase !== "fixture_test"
    && !/^codex_vehicle_event_shadow_[0-9a-f]{8,32}$/.test(expectedDatabase)) {
  throw new Error(
    "Refusing shadow-event integration test: database name is not an approved disposable test name"
  );
}

const { Pool } = pg;
const pool = new Pool({
  connectionString,
  max: 5,
  options: "-c lock_timeout=5000 -c statement_timeout=30000",
});
const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const readIds = [];
const assetHashes = [];
let actorUserId = null;
let catalogRunId = null;
let lockClient = null;
let lockHeld = false;
let guardPassed = false;

async function assertDisposableDatabaseGuard() {
  lockClient = await pool.connect();
  const identity = await lockClient.query(
    `SELECT current_database() AS database_name,
            to_regclass('public.codex_integration_test_guard')::text AS guard_table,
            to_regclass('public.host_maintenance_environment_identity')::text
              AS environment_identity_table`
  );
  assert.equal(identity.rows[0]?.database_name, expectedDatabase);
  assert.equal(identity.rows[0]?.guard_table, "codex_integration_test_guard");
  const sentinel = await lockClient.query(
    `SELECT COUNT(*)::integer AS count
     FROM public.codex_integration_test_guard
     WHERE scope = $1 AND guard_token = $2`,
    [GUARD_SCOPE, guardToken]
  );
  assert.equal(sentinel.rows[0]?.count, 1);
  if (identity.rows[0]?.environment_identity_table) {
    const liveIdentity = await lockClient.query(
      "SELECT COUNT(*)::integer AS count FROM public.host_maintenance_environment_identity"
    );
    if (liveIdentity.rows[0]?.count !== 0) {
      throw new Error(
        "Refusing shadow-event integration test: database has an application environment identity"
      );
    }
  }
  const initial = await lockClient.query(
    `SELECT
       (SELECT COUNT(*)::integer FROM public.plate_reads) AS plate_reads,
       (SELECT COUNT(*)::integer FROM public.vehicle_image_assets) AS assets,
       (SELECT COUNT(*)::integer FROM public.vehicle_image_asset_reads) AS asset_links,
       (SELECT COUNT(*)::integer FROM public.vehicle_events) AS events,
       (SELECT COUNT(*)::integer FROM public.vehicle_event_reads) AS event_reads,
       (SELECT COUNT(*)::integer FROM public.vehicle_event_shadow_decisions) AS decisions`
  );
  assert.deepEqual(initial.rows[0], {
    plate_reads: 0,
    assets: 0,
    asset_links: 0,
    events: 0,
    event_reads: 0,
    decisions: 0,
  });
  const lock = await lockClient.query(
    "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
    [TEST_LOCK_NAME]
  );
  assert.equal(lock.rows[0]?.locked, true);
  lockHeld = true;
  guardPassed = true;
}

function fixtureHash(label) {
  const hash = crypto.createHash("sha256").update(`${label}:${suffix}`).digest("hex");
  assetHashes.push(hash);
  return hash;
}

async function insertActorAndCompletedCatalog() {
  const actor = await pool.query(
    `INSERT INTO public.users (username, display_name, password_hash)
     VALUES ($1, $2, $3) RETURNING id`,
    [`codex_event_${suffix}`, "Codex shadow event smoke", "integration-test-not-a-password"]
  );
  actorUserId = Number(actor.rows[0].id);
  const run = await pool.query(
    `INSERT INTO public.vehicle_image_asset_catalog_runs (
       phase, status, max_read_id, preview_cursor_read_id, candidate_reads,
       batch_size, preview_fingerprint, actor_user_id, confirmed_actor_user_id,
       confirmed_at, completed_at
     ) VALUES (
       'completed', 'completed', 0, 0, 0, 5, $1, $2, $2,
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
     ) RETURNING id`,
    [crypto.createHash("sha256").update(`campaign:${suffix}`).digest("hex"), actorUserId]
  );
  catalogRunId = Number(run.rows[0].id);
}

async function insertAsset(label) {
  const contentSha256 = fixtureHash(label);
  const result = await pool.query(
    `INSERT INTO public.vehicle_image_assets (
       content_sha256, storage_path, media_type, byte_size,
       image_width, image_height
     ) VALUES ($1, $2, 'image/jpeg', 2048, 1920, 1080)
     RETURNING id`,
    [contentSha256, canonicalVehicleImageAssetPath(contentSha256)]
  );
  return Number(result.rows[0].id);
}

async function insertRead({
  plate,
  cameraName,
  readTimestamp,
  capturedAt,
  sourceKind,
  sourceReadId = null,
  assetId,
  imageLabel,
  relationship,
} = {}) {
  const imagePath = `images/codex-shadow-${suffix}-${imageLabel}.jpg`;
  const updatedAt = "2026-08-14T18:59:50.123456Z";
  const inserted = await pool.query(
    `INSERT INTO public.plate_reads (
       plate_number, camera_name, "timestamp",
       bi_trigger_direction_status, bi_trigger_direction_label,
       bi_trigger_direction_profile_version, bi_trigger_direction_algorithm,
       vehicle_image_status, vehicle_image_path, vehicle_image_timestamp,
       vehicle_image_source_kind, vehicle_image_source_read_id,
       vehicle_image_retryable, vehicle_image_updated_at
     ) VALUES (
       $1, $2, $3::timestamptz, 'ready', 'Eastbound', 1,
       'codex-shadow-test-v1', 'ready', $4, $5::timestamptz,
       $6, $7::integer, FALSE, $8::timestamptz
     ) RETURNING id, vehicle_image_updated_at::text AS updated_at_exact`,
    [plate, cameraName, readTimestamp, imagePath, capturedAt, sourceKind, sourceReadId, updatedAt]
  );
  const readId = Number(inserted.rows[0].id);
  readIds.push(readId);
  await pool.query(
    `INSERT INTO public.vehicle_image_asset_reads (
       asset_id, read_id, source_kind, source_read_id, relationship,
       identity_eligible, overview_context, captured_at, read_camera_name,
       source_camera_name, source_path_snapshot, source_updated_at,
       selection_metadata, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4::integer, $5, TRUE, 'street', $6::timestamptz,
       $7, 'Street Overview', $8, $9::timestamptz, '{}'::jsonb,
       CURRENT_TIMESTAMP - INTERVAL '1 minute',
       CURRENT_TIMESTAMP - INTERVAL '1 minute'
     )`,
    [
      assetId,
      readId,
      sourceKind,
      sourceReadId,
      relationship,
      capturedAt,
      cameraName,
      imagePath,
      inserted.rows[0].updated_at_exact,
    ]
  );
  return readId;
}

async function archiveAndDeleteAudits() {
  if (actorUserId == null) return;
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
     WHERE resource_type = 'vehicle_event_shadow' AND actor_user_id = $1
     ON CONFLICT (source_event_id, occurred_at) DO NOTHING`,
    [actorUserId]
  );
  await pool.query(
    `DELETE FROM public.audit_events
     WHERE resource_type = 'vehicle_event_shadow' AND actor_user_id = $1`,
    [actorUserId]
  );
}

async function cleanupFixtures() {
  await archiveAndDeleteAudits();
  await pool.query(
    "UPDATE public.vehicle_event_shadow_control SET enabled = FALSE, disabled_at = CURRENT_TIMESTAMP"
  );
  await pool.query(
    "DELETE FROM public.vehicle_event_shadow_decisions WHERE anchor_read_id = ANY($1::integer[])",
    [readIds]
  );
  await pool.query(
    `DELETE FROM public.vehicle_events
     WHERE id IN (
       SELECT event_id FROM public.vehicle_event_reads
       WHERE read_id = ANY($1::integer[])
     )`,
    [readIds]
  );
  await pool.query("DELETE FROM public.plate_reads WHERE id = ANY($1::integer[])", [readIds]);
  await pool.query(
    "DELETE FROM public.vehicle_image_assets WHERE content_sha256::text = ANY($1::text[])",
    [assetHashes]
  );
  if (catalogRunId != null) {
    await pool.query("DELETE FROM public.vehicle_image_asset_catalog_runs WHERE id = $1", [catalogRunId]);
  }
  if (actorUserId != null) await pool.query("DELETE FROM public.users WHERE id = $1", [actorUserId]);
  const residue = await pool.query(
    `SELECT
       (SELECT COUNT(*)::integer FROM public.plate_reads
        WHERE id = ANY($1::integer[])) AS reads,
       (SELECT COUNT(*)::integer FROM public.vehicle_image_assets
        WHERE content_sha256::text = ANY($2::text[])) AS assets,
       (SELECT COUNT(*)::integer FROM public.vehicle_event_reads
        WHERE read_id = ANY($1::integer[])) AS event_reads,
       (SELECT COUNT(*)::integer FROM public.vehicle_event_shadow_decisions
        WHERE anchor_read_id = ANY($1::integer[])) AS decisions`,
    [readIds, assetHashes]
  );
  assert.deepEqual(residue.rows[0], { reads: 0, assets: 0, event_reads: 0, decisions: 0 });
}

try {
  await assertDisposableDatabaseGuard();
  await insertActorAndCompletedCatalog();
  const sharedAssetId = await insertAsset("shared");
  const firstReadId = await insertRead({
    plate: `EV${suffix}`.slice(0, 10),
    cameraName: "Street LPR 1",
    readTimestamp: "2026-08-14T19:00:00.123456Z",
    capturedAt: "2026-08-14T19:00:00.500000Z",
    sourceKind: "overview_primary",
    assetId: sharedAssetId,
    imageLabel: "first",
    relationship: "primary",
  });
  const secondReadId = await insertRead({
    plate: `EV${suffix}`.slice(0, 10),
    cameraName: "Street LPR 2",
    readTimestamp: "2026-08-14T19:00:04.654321Z",
    capturedAt: "2026-08-14T19:00:00.500000Z",
    sourceKind: "overview_pair_share",
    sourceReadId: firstReadId,
    assetId: sharedAssetId,
    imageLabel: "second",
    relationship: "shared",
  });

  const repository = new VehicleEventShadowRepository(pool);
  const service = new VehicleEventShadowService({ repository });
  assert.equal((await service.processBatch()).activation, "disabled");
  assert.equal((await repository.setEnabled({ enabled: true, actorUserId })).enabled, true);
  const batch = await service.processBatch({ limit: 25 });
  assert.equal(batch.proposed, 1);
  assert.equal(batch.rejected, 0);
  const active = await pool.query(
    `SELECT events.correlation_class,
            COUNT(DISTINCT event_reads.read_id)::integer AS read_count,
            COUNT(DISTINCT event_assets.asset_id)::integer AS asset_count
     FROM public.vehicle_events events
     JOIN public.vehicle_event_reads event_reads ON event_reads.event_id = events.id
     JOIN public.vehicle_event_assets event_assets ON event_assets.event_id = events.id
     WHERE events.status = 'shadow'
       AND event_reads.read_id = ANY($1::integer[])
     GROUP BY events.id, events.correlation_class`,
    [[firstReadId, secondReadId]]
  );
  assert.deepEqual(active.rows[0], {
    correlation_class: "shared_asset",
    read_count: 2,
    asset_count: 1,
  });
  const decisions = await pool.query(
    `SELECT COUNT(*)::integer AS count,
            COUNT(*) FILTER (WHERE outcome = 'proposed')::integer AS proposed
     FROM public.vehicle_event_shadow_decisions
     WHERE anchor_read_id = ANY($1::integer[])`,
    [[firstReadId, secondReadId]]
  );
  assert.deepEqual(decisions.rows[0], { count: 2, proposed: 2 });

  await pool.query(
    "UPDATE public.plate_reads SET plate_number = $1 WHERE id = $2",
    [`CH${suffix}`.slice(0, 10), firstReadId]
  );
  const retirement = await service.processBatch({ limit: 25 });
  assert.equal(retirement.retired, 1);
  const retired = await pool.query(
    `SELECT status, retired_reason,
            (SELECT COUNT(*)::integer FROM public.vehicle_event_reads event_reads
             WHERE event_reads.event_id = events.id AND active = TRUE) AS active_reads
     FROM public.vehicle_events events
     WHERE id IN (
       SELECT event_id FROM public.vehicle_event_reads WHERE read_id = $1
     )`,
    [firstReadId]
  );
  assert.deepEqual(retired.rows[0], {
    status: "retired",
    retired_reason: "SOURCE_SNAPSHOT_CHANGED",
    active_reads: 0,
  });

  assert.equal((await repository.setEnabled({ enabled: false, actorUserId })).enabled, false);
  assert.equal((await service.processBatch()).activation, "disabled");
  const audit = await pool.query(
    `SELECT COUNT(*)::integer AS count,
            COUNT(*) FILTER (WHERE source <> 'browser')::integer AS invalid_source,
            COUNT(*) FILTER (WHERE outcome <> 'succeeded')::integer AS invalid_outcome
     FROM public.audit_events
     WHERE resource_type = 'vehicle_event_shadow' AND actor_user_id = $1`,
    [actorUserId]
  );
  assert.deepEqual(audit.rows[0], { count: 2, invalid_source: 0, invalid_outcome: 0 });
} finally {
  try {
    if (guardPassed) await cleanupFixtures();
  } finally {
    if (lockClient && lockHeld) {
      await lockClient.query(
        "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
        [TEST_LOCK_NAME]
      ).catch(() => {});
    }
    lockClient?.release();
    await pool.end();
  }
}

console.log("vehicle_event_shadow_postgres_gate=passed");
