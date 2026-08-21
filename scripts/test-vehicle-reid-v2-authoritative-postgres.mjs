import assert from "node:assert/strict";
import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import pg from "pg";

import { VehicleReidV2AuthorityRepository } from "../lib/vehicle-reid-v2-authority-repository.mjs";
import { VehicleReidV2AuthorityService } from "../lib/vehicle-reid-v2-authority-service.mjs";
import { VehicleReidV2ConversionRepository } from "../lib/vehicle-reid-v2-conversion-repository.mjs";
import { VehicleReidV2ConversionService } from "../lib/vehicle-reid-v2-conversion-service.mjs";
import { VehicleReidV2LiveRepository, VehicleReidV2LiveService } from "../lib/vehicle-reid-v2-live.mjs";
import { VehicleReidV2ShadowRepository } from "../lib/vehicle-reid-v2-shadow-repository.mjs";
import { VehicleReidV2ShadowService } from "../lib/vehicle-reid-v2-shadow.mjs";

const OPT_IN = "VEHICLE_REID_V2_POSTGRES_TEST_OPT_IN";
const EXPECTED_DATABASE = "VEHICLE_REID_V2_POSTGRES_TEST_DATABASE";
const GUARD_TOKEN = "VEHICLE_REID_V2_POSTGRES_TEST_GUARD_TOKEN";
const GUARD_SCOPE = "vehicle-reid-v2-authoritative-stage1:v1";
const LOCK_NAME = "codex_vehicle_reid_v2_authoritative_stage1_v1";

if (process.env[OPT_IN] !== "true") {
  throw new Error(`${OPT_IN}=true is required for this destructive integration test`);
}

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const expectedDatabase = required(EXPECTED_DATABASE);
const guardToken = required(GUARD_TOKEN);
const databaseUrl = required("DATABASE_URL");
const urlDatabase = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\/+/, ""));
if (urlDatabase !== expectedDatabase) {
  throw new Error(`Refusing ReID v2 integration test: DATABASE_URL names ${urlDatabase}`);
}
if (!/^codex_vehicle_reid_v2_[0-9a-f]{8,32}$/.test(expectedDatabase)) {
  throw new Error("Refusing ReID v2 integration test: database is not an approved disposable name");
}

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 8,
  options: "-c lock_timeout=5000 -c statement_timeout=60000",
});
const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const fixture = {
  actorId: null,
  readIds: [],
  assetIds: [],
  derivativeIds: [],
  embeddingIds: [],
  reviewIds: [],
};
let lockClient = null;
let lockHeld = false;

const hash = (value) => crypto.createHash("sha256").update(`${suffix}:${value}`).digest("hex");
const assetPath = (sha256) => `derived/vehicle-assets/${sha256.slice(0, 2)}/${sha256}.jpg`;
const cropPath = (sha256) => `derived/vehicle-crops/${sha256.slice(0, 2)}/${sha256}.jpg`;

async function guard() {
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
    `SELECT COUNT(*)::integer AS count FROM public.codex_integration_test_guard
     WHERE scope = $1 AND guard_token = $2`,
    [GUARD_SCOPE, guardToken]
  );
  assert.equal(sentinel.rows[0]?.count, 1);
  if (identity.rows[0]?.environment_identity_table) {
    const live = await lockClient.query(
      "SELECT COUNT(*)::integer AS count FROM public.host_maintenance_environment_identity"
    );
    assert.equal(live.rows[0]?.count, 0, "application environment identity must be absent");
  }
  const empty = await lockClient.query(
    `SELECT
       (SELECT COUNT(*)::integer FROM public.plate_reads) AS reads,
       (SELECT COUNT(*)::integer FROM public.vehicle_image_assets) AS assets,
       (SELECT COUNT(*)::integer FROM public.vehicle_image_derivatives) AS derivatives,
       (SELECT COUNT(*)::integer FROM public.vehicle_asset_embeddings) AS embeddings,
       (SELECT COUNT(*)::integer FROM public.vehicle_reid_v2_conversion_runs) AS conversions,
       (SELECT COUNT(*)::integer FROM public.vehicle_reid_v2_profiles) AS profiles,
       (SELECT COUNT(*)::integer FROM public.vehicle_reid_v2_profile_members) AS members,
       (SELECT COUNT(*)::integer FROM public.vehicle_reid_v2_read_assignments) AS assignments,
       (SELECT mode FROM public.vehicle_reid_control WHERE singleton = TRUE) AS mode`
  );
  assert.deepEqual(empty.rows[0], {
    reads: 0,
    assets: 0,
    derivatives: 0,
    embeddings: 0,
    conversions: 0,
    profiles: 0,
    members: 0,
    assignments: 0,
    mode: "v2_shadow",
  });
  const lock = await lockClient.query(
    "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
    [LOCK_NAME]
  );
  assert.equal(lock.rows[0]?.locked, true);
  lockHeld = true;
}

async function testAuthorityStartupFence() {
  const exactLock = "vehicle_reid_v2_authority_stage2";
  const unrelatedLock = `codex_unrelated_reid_fence_${suffix}`;
  const sentinelScope = `vehicle-reid-v2-fence:${suffix}`;
  const holder = await pool.connect();
  const waiter = await pool.connect();
  const unrelated = await pool.connect();
  // node-postgres emits an idle-client error event when a backend is
  // intentionally terminated; consume it so the test can assert the bounded
  // disconnect instead of treating the expected fence as an uncaught error.
  holder.on("error", () => {});
  waiter.on("error", () => {});
  let waiterLockPromise = null;
  let unrelatedHeld = false;
  try {
    await holder.query("BEGIN");
    await holder.query(
      `INSERT INTO public.codex_integration_test_guard (scope, guard_token)
       VALUES ($1, $2)`,
      [sentinelScope, guardToken]
    );
    await holder.query("SELECT pg_advisory_xact_lock(hashtext($1))", [exactLock]);

    await waiter.query("BEGIN");
    waiterLockPromise = waiter.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [exactLock]
    ).then(
      () => ({ acquired: true, error: null }),
      (error) => ({ acquired: false, error })
    );

    const unrelatedResult = await unrelated.query(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [unrelatedLock]
    );
    assert.equal(unrelatedResult.rows[0]?.locked, true);
    unrelatedHeld = true;

    let participants = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      participants = await pool.query(
        `WITH target AS (
           SELECT hashtext($1)::bigint AS lock_key
         )
         SELECT COUNT(DISTINCT locks.pid)::integer AS participant_count,
                COUNT(DISTINCT locks.pid) FILTER (WHERE locks.granted)::integer AS granted_count,
                COUNT(DISTINCT locks.pid) FILTER (WHERE NOT locks.granted)::integer AS waiting_count
         FROM pg_catalog.pg_locks locks
         CROSS JOIN target
         WHERE locks.locktype = 'advisory'
           AND locks.objsubid = 1
           AND locks.classid::bigint = ((target.lock_key >> 32) & 4294967295::bigint)
           AND locks.objid::bigint = (target.lock_key & 4294967295::bigint)
           AND locks.database = (
             SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database()
           )`,
        [exactLock]
      );
      if (participants.rows[0]?.participant_count === 2
          && participants.rows[0]?.granted_count === 1
          && participants.rows[0]?.waiting_count === 1) break;
      await delay(20);
    }
    assert.deepEqual(participants?.rows?.[0], {
      participant_count: 2,
      granted_count: 1,
      waiting_count: 1,
    });

    // Ensure the fence connection is newer than every predecessor candidate.
    await delay(20);
    const repository = new VehicleReidV2LiveRepository({ pool });
    const fenced = await repository.fencePredecessorAuthoritySessions();
    assert.deepEqual(fenced, {
      candidateCount: 2,
      terminatedCount: 2,
      remainingCount: 0,
    });

    const waiterOutcome = await waiterLockPromise;
    assert.equal(typeof waiterOutcome.acquired, "boolean");
    await assert.rejects(holder.query("SELECT 1"));
    await assert.rejects(waiter.query("SELECT 1"));
    const sentinel = await pool.query(
      `SELECT COUNT(*)::integer AS count
       FROM public.codex_integration_test_guard WHERE scope = $1`,
      [sentinelScope]
    );
    assert.equal(sentinel.rows[0]?.count, 0);

    const exactRemaining = await pool.query(
      `WITH target AS (
         SELECT hashtext($1)::bigint AS lock_key
       )
       SELECT COUNT(*)::integer AS count
       FROM pg_catalog.pg_locks locks
       CROSS JOIN target
       WHERE locks.locktype = 'advisory'
         AND locks.objsubid = 1
         AND locks.classid::bigint = ((target.lock_key >> 32) & 4294967295::bigint)
         AND locks.objid::bigint = (target.lock_key & 4294967295::bigint)
         AND locks.database = (
           SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database()
         )`,
      [exactLock]
    );
    assert.equal(exactRemaining.rows[0]?.count, 0);
    const unrelatedStillAlive = await unrelated.query(
      `SELECT pg_backend_pid()::integer AS pid,
              pg_advisory_unlock(hashtext($1)) AS unlocked`,
      [unrelatedLock]
    );
    assert.ok(Number(unrelatedStillAlive.rows[0]?.pid) > 0);
    assert.equal(unrelatedStillAlive.rows[0]?.unlocked, true);
    unrelatedHeld = false;
  } finally {
    if (unrelatedHeld) {
      await unrelated.query("SELECT pg_advisory_unlock(hashtext($1))", [unrelatedLock])
        .catch(() => {});
    }
    holder.release(true);
    waiter.release(true);
    unrelated.release(true);
  }
}

async function createRead({
  plate,
  reviewStatus = "corrected",
  reviewRevision = 1,
  vehicleStatus = null,
  vehiclePath = null,
  sourceKind = null,
  errorCode = null,
  queueKind = null,
  timestampOffset = "0 seconds",
}) {
  const result = await pool.query(
    `INSERT INTO public.plate_reads (
       plate_number, camera_name, "timestamp", review_status, review_revision,
       validated, vehicle_image_status, vehicle_image_path,
       vehicle_image_source_kind, vehicle_image_error_code,
       vehicle_image_queue_kind, vehicle_image_retryable,
       vehicle_image_updated_at
     ) VALUES (
       $1::text, 'Codex Street LPR', CURRENT_TIMESTAMP + $2::interval,
       $3::varchar(24), $4::integer,
       $3::varchar(24) IN ('confirmed','corrected','alias_resolved'),
       $5::text, $6::text, $7::text, $8::text, $9::text,
       FALSE, CASE WHEN $5::text IS NULL THEN NULL
                   ELSE '2026-08-16T12:00:00.123456Z'::timestamptz END
     ) RETURNING id, observed_plate, vehicle_image_updated_at::text`,
    [plate, timestampOffset, reviewStatus, reviewRevision, vehicleStatus,
      vehiclePath, sourceKind, errorCode, queueKind]
  );
  const row = result.rows[0];
  fixture.readIds.push(Number(row.id));
  return row;
}

async function createAssetWithCrop(name, plate, {
  reviewStatus = "corrected",
  relationship = "primary",
  sourceKind = "overview_primary",
  overviewContext = "street",
  timestampOffset = "0 seconds",
  embeddingValues = [],
} = {}) {
  const assetSha = hash(`asset:${name}`);
  const derivativeSha = hash(`crop:${name}`);
  const embeddingSha = hash(`embedding:${name}`);
  const storedAssetPath = assetPath(assetSha);
  const asset = await pool.query(
    `INSERT INTO public.vehicle_image_assets (
       content_sha256, storage_path, media_type, byte_size, image_width, image_height
     ) VALUES ($1, $2, 'image/jpeg', 100, 640, 360) RETURNING id`,
    [assetSha, storedAssetPath]
  );
  const assetId = Number(asset.rows[0].id);
  fixture.assetIds.push(assetId);
  const read = await createRead({
    plate,
    reviewStatus,
    vehicleStatus: "ready",
    vehiclePath: storedAssetPath,
    sourceKind,
    timestampOffset,
  });
  await pool.query(
    `INSERT INTO public.vehicle_image_asset_reads (
       asset_id, read_id, source_kind, source_read_id, relationship,
       identity_eligible, overview_context, captured_at, read_camera_name,
       source_camera_name, source_path_snapshot, source_updated_at,
       selection_metadata
     ) VALUES (
       $1, $2, $3, NULL, $4, TRUE, $5, CURRENT_TIMESTAMP,
       'Codex Street LPR', 'Codex Overview', $6, $7::timestamptz, '{}'::jsonb
     )`,
    [assetId, Number(read.id), sourceKind, relationship, overviewContext,
      storedAssetPath, read.vehicle_image_updated_at]
  );
  const derivative = await pool.query(
    `INSERT INTO public.vehicle_image_derivatives (
       asset_id, derivative_kind, algorithm_version, source_sha256,
       content_sha256, storage_path, media_type, byte_size, image_width,
       image_height, crop_box, detector_model, detection_confidence,
       evidence_read_id
     ) VALUES (
       $1, 'vehicle_crop', 'canonical-overview-detection-box-v1', $2, $3, $4,
       'image/jpeg', 80, 500, 300,
       '{"left":1,"top":1,"width":500,"height":300,"paddingRatio":0.04}'::jsonb,
       'codex-fixture-detector', 0.95, $5
     ) RETURNING id`,
    [assetId, assetSha, derivativeSha, cropPath(derivativeSha), Number(read.id)]
  );
  const derivativeId = Number(derivative.rows[0].id);
  fixture.derivativeIds.push(derivativeId);
  const embeddingBytes = Buffer.alloc(512 * 4);
  for (let index = 0; index < Math.min(embeddingValues.length, 512); index += 1) {
    embeddingBytes.writeFloatLE(Number(embeddingValues[index]), index * 4);
  }
  const embedding = await pool.query(
    `INSERT INTO public.vehicle_asset_embeddings (
       derivative_id, model_name, algorithm_version, source_sha256,
       embedding_sha256, embedding_dimensions, embedding
     ) VALUES (
       $1, 'vehicle-reid-0001-ir-fp16-v1',
       'canonical-overview-crop-embedding-v1', $2, $3, 512,
       $4::bytea
     ) RETURNING id`,
    [derivativeId, derivativeSha, embeddingSha, embeddingBytes]
  );
  const embeddingId = Number(embedding.rows[0].id);
  fixture.embeddingIds.push(embeddingId);
  return {
    name,
    plate,
    assetId,
    assetSha,
    assetPath: storedAssetPath,
    readId: Number(read.id),
    sourceUpdatedAt: read.vehicle_image_updated_at,
    derivativeId,
    derivativeSha,
    embeddingId,
    embeddingSha,
  };
}

async function addSharedRead(source, plate = source.plate) {
  const read = await createRead({
    plate,
    vehicleStatus: "ready",
    vehiclePath: source.assetPath,
    sourceKind: "overview_pair_share",
    timestampOffset: "1 second",
  });
  await pool.query(
    `INSERT INTO public.vehicle_image_asset_reads (
       asset_id, read_id, source_kind, source_read_id, relationship,
       identity_eligible, overview_context, captured_at, read_camera_name,
       source_camera_name, source_path_snapshot, source_updated_at,
       selection_metadata
     ) VALUES (
       $1, $2, 'overview_pair_share', $3, 'shared', TRUE, 'street',
       CURRENT_TIMESTAMP, 'Codex Street LPR', 'Codex Overview', $4,
       $5::timestamptz, '{}'::jsonb
     )`,
    [source.assetId, Number(read.id), source.readId, source.assetPath, source.sourceUpdatedAt]
  );
  return Number(read.id);
}

async function replaceCanonicalSource(source, name, {
  timestampOffset = "20 seconds",
  embeddingValues = [],
} = {}) {
  const replacement = await createAssetWithCrop(name, source.plate, {
    timestampOffset,
    embeddingValues,
  });
  await pool.query(
    "DELETE FROM public.vehicle_image_asset_reads WHERE asset_id = $1 AND read_id = $2",
    [source.assetId, source.readId]
  );
  const updated = await pool.query(
    `UPDATE public.plate_reads
     SET vehicle_image_status = 'ready', vehicle_image_path = $2,
         vehicle_image_source_kind = 'overview_pair_share',
         vehicle_image_updated_at = clock_timestamp()
     WHERE id = $1
     RETURNING vehicle_image_updated_at::text`,
    [source.readId, replacement.assetPath]
  );
  await pool.query(
    `INSERT INTO public.vehicle_image_asset_reads (
       asset_id, read_id, source_kind, source_read_id, relationship,
       identity_eligible, overview_context, captured_at, read_camera_name,
       source_camera_name, source_path_snapshot, source_updated_at,
       selection_metadata
     ) VALUES (
       $1, $2, 'overview_pair_share', $3, 'shared', TRUE, 'street',
       CURRENT_TIMESTAMP, 'Codex Street LPR', 'Codex Overview', $4,
       $5::timestamptz, '{}'::jsonb
     )`,
    [replacement.assetId, source.readId, replacement.readId,
      replacement.assetPath, updated.rows[0].vehicle_image_updated_at]
  );
  return replacement;
}

async function createPairReview(left, right, label) {
  const low = left.derivativeId < right.derivativeId ? left : right;
  const high = low === left ? right : left;
  const result = await pool.query(
    `INSERT INTO public.vehicle_reid_v2_pair_reviews (
       derivative_id_low, derivative_id_high, source_sha256_low,
       source_sha256_high, embedding_id_low, embedding_id_high,
       embedding_model, algorithm_version, similarity_score, label,
       evidence_read_id_low, evidence_read_id_high, evidence_plate_low,
       evidence_plate_high, evidence_camera_low, evidence_camera_high,
       evidence_context_low, evidence_context_high, actor_user_id,
       actor_username, actor_display_name
     ) VALUES (
       $1, $2, $3, $4, $5, $6, 'vehicle-reid-0001-ir-fp16-v1',
       'canonical-overview-crop-embedding-v1', 0.91, $7, $8, $9, $10,
       $11, 'Codex Street LPR', 'Codex Street LPR', 'street', 'street',
       $12, $13, 'Codex ReID v2 integration'
     ) RETURNING id`,
    [low.derivativeId, high.derivativeId, low.derivativeSha, high.derivativeSha,
      low.embeddingId, high.embeddingId, label, low.readId, high.readId,
      low.plate || null, high.plate || null, fixture.actorId,
      `codex_reid_${suffix}`]
  );
  fixture.reviewIds.push(Number(result.rows[0].id));
  return Number(result.rows[0].id);
}

async function createActor() {
  if (fixture.actorId) return fixture.actorId;
  const actor = await pool.query(
    `INSERT INTO public.users (username, display_name, password_hash)
     VALUES ($1, 'Codex ReID v2 integration', 'integration-test-not-a-password')
     RETURNING id`,
    [`codex_reid_${suffix}`]
  );
  fixture.actorId = Number(actor.rows[0].id);
  return fixture.actorId;
}

function fixtureActor() {
  return {
    id: fixture.actorId,
    username: `codex_reid_${suffix}`,
    displayName: "Codex ReID v2 integration",
  };
}

function newConversionService({ repository = null } = {}) {
  const shadowService = new VehicleReidV2ShadowService({
    repository: new VehicleReidV2ShadowRepository({ pool }),
  });
  return new VehicleReidV2ConversionService({
    repository: repository || new VehicleReidV2ConversionRepository({ pool }),
    shadowService,
  });
}

function newAuthorityService() {
  return new VehicleReidV2AuthorityService({
    repository: new VehicleReidV2AuthorityRepository({ pool }),
  });
}

function newLiveService() {
  return new VehicleReidV2LiveService({
    repository: new VehicleReidV2LiveRepository({ pool }),
    logger: { error() {} },
  });
}

async function testEmptyPreviewFinalizes() {
  const started = await newConversionService().startPreview({
    actor: fixtureActor(),
    batchSize: 1,
  });
  assert.equal(started.operation.reused, false);
  assert.equal(started.overview.latestRun.status, "ready");
  assert.equal(started.overview.latestRun.maxReadId, 0);
  assert.equal(started.overview.latestRun.counts.total, 0);
  assert.match(started.overview.latestRun.previewFingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(started.overview.authority, { profiles: 0, members: 0, assignments: 0 });

  const cancelled = await newConversionService().cancel({
    runId: started.operation.runId,
    actor: fixtureActor(),
  });
  assert.equal(cancelled.overview.latestRun.status, "cancelled");
}

async function createFixtures() {
  await createActor();

  const exactA = await createAssetWithCrop("exact-a", "COR123", {
    embeddingValues: [1, 0],
  });
  const exactB = await createAssetWithCrop("exact-b", "COR123", {
    timestampOffset: "-7 days",
    embeddingValues: [0.95, 0.05],
  });
  const sharedReadId = await addSharedRead(exactA);
  const humanA = await createAssetWithCrop("human-a", "OCR123");
  const humanB = await createAssetWithCrop("human-b", "OCR128");
  const differentA = await createAssetWithCrop("different-a", "DIF111");
  const differentB = await createAssetWithCrop("different-b", "DIF111");
  const unsureA = await createAssetWithCrop("unsure-a", "UNS111");
  const unsureB = await createAssetWithCrop("unsure-b", "UNS111");
  const dissimilarA = await createAssetWithCrop("dissimilar-a", "AAA111");
  const dissimilarB = await createAssetWithCrop("dissimilar-b", "ZZZ999");
  const singleton = await createAssetWithCrop("singleton", "SNG111");

  await createPairReview(humanA, humanB, "same_vehicle");
  await createPairReview(differentA, differentB, "different_vehicle");
  await createPairReview(unsureA, unsureB, "unsure");
  await createPairReview(dissimilarA, dissimilarB, "same_vehicle");

  const historical = await createRead({
    plate: "COR123",
    reviewStatus: "corrected",
    vehicleStatus: "unavailable",
    errorCode: "HISTORICAL_NO_OVERVIEW",
    queueKind: "historical",
  });
  const nighttime = await createRead({
    plate: "COR123",
    reviewStatus: "confirmed",
    vehicleStatus: "unavailable",
    errorCode: "NIGHTTIME",
    queueKind: "historical",
  });
  await createRead({
    plate: "COR123",
    reviewStatus: "unreviewed",
    reviewRevision: 0,
    vehicleStatus: "unavailable",
    errorCode: "NO_OVERVIEW",
  });

  const display = await createRead({
    plate: "COR123",
    reviewStatus: "corrected",
    vehicleStatus: "ready",
    vehiclePath: exactA.assetPath,
    sourceKind: "entry_overview_route_fallback",
  });
  await pool.query(
    `INSERT INTO public.vehicle_image_asset_reads (
       asset_id, read_id, source_kind, relationship, identity_eligible,
       overview_context, source_path_snapshot, source_updated_at,
       selection_metadata
     ) VALUES (
       $1, $2, 'entry_overview_route_fallback', 'display_fallback', FALSE,
       'entry', $3, $4::timestamptz, '{}'::jsonb
     )`,
    [exactA.assetId, Number(display.id), exactA.assetPath, exactA.sourceUpdatedAt]
  );

  const incompleteAssetSha = hash("asset:incomplete");
  const incompletePath = assetPath(incompleteAssetSha);
  const incompleteAsset = await pool.query(
    `INSERT INTO public.vehicle_image_assets (
       content_sha256, storage_path, media_type, byte_size, image_width, image_height
     ) VALUES ($1, $2, 'image/jpeg', 100, 640, 360) RETURNING id`,
    [incompleteAssetSha, incompletePath]
  );
  const incompleteAssetId = Number(incompleteAsset.rows[0].id);
  fixture.assetIds.push(incompleteAssetId);
  const incomplete = await createRead({
    plate: "INC111",
    vehicleStatus: "ready",
    vehiclePath: incompletePath,
    sourceKind: "overview_primary",
  });
  await pool.query(
    `INSERT INTO public.vehicle_image_asset_reads (
       asset_id, read_id, source_kind, relationship, identity_eligible,
       overview_context, source_path_snapshot, source_updated_at,
       selection_metadata
     ) VALUES ($1, $2, 'overview_primary', 'primary', TRUE, 'street',
               $3, $4::timestamptz, '{}'::jsonb)`,
    [incompleteAssetId, Number(incomplete.id), incompletePath,
      incomplete.vehicle_image_updated_at]
  );

  const stale = await createAssetWithCrop("stale", "STL111");
  await pool.query(
    `UPDATE public.plate_reads SET vehicle_image_path = $2 WHERE id = $1`,
    [stale.readId, `${stale.assetPath}.replacement`]
  );

  const cluster = await pool.query(
    `INSERT INTO public.vehicle_clusters (
       representative_read_id, embedding_model, algorithm_version
     ) VALUES ($1, 'vehicle-reid-0001', 'vehicle-reid-shadow-cluster-v1')
     RETURNING id`,
    [exactA.readId]
  );
  await pool.query(
    `INSERT INTO public.vehicle_cluster_assignments (
       read_id, cluster_id, assignment_status, embedding_model,
       algorithm_version
     ) VALUES
       ($1, $4, 'seed', 'vehicle-reid-0001', 'vehicle-reid-shadow-cluster-v1'),
       ($2, $4, 'seed', 'vehicle-reid-0001', 'vehicle-reid-shadow-cluster-v1'),
       ($3, $4, 'seed', 'vehicle-reid-0001', 'vehicle-reid-shadow-cluster-v1')`,
    [exactA.readId, Number(historical.id), sharedReadId, Number(cluster.rows[0].id)]
  );
  return {
    exactA,
    exactB,
    sharedReadId,
    singleton,
    historicalReadId: Number(historical.id),
    nighttimeReadId: Number(nighttime.id),
    displayReadId: Number(display.id),
    incompleteReadId: Number(incomplete.id),
    staleReadId: stale.readId,
  };
}

async function startCommittedPreview({ concurrent = false } = {}) {
  const actor = fixtureActor();
  let results;
  if (concurrent) {
    const barrier = await pool.connect();
    let barrierHeld = false;
    try {
      await barrier.query(
        "SELECT pg_advisory_lock(hashtext('vehicle_reid_v2_conversion_preview'))"
      );
      barrierHeld = true;
      const requests = [
        newConversionService().startPreview({ actor, batchSize: 5 }),
        newConversionService().startPreview({ actor, batchSize: 25 }),
      ];
      let observedWaiter = false;
      for (let attempt = 0; attempt < 100 && !observedWaiter; attempt += 1) {
        const waiters = await barrier.query(
          `SELECT COUNT(*)::integer AS count
           FROM pg_stat_activity activity
           WHERE activity.wait_event = 'advisory'
             AND pg_backend_pid() = ANY(pg_blocking_pids(activity.pid))`
        );
        observedWaiter = Number(waiters.rows[0]?.count) > 0;
        if (!observedWaiter) await delay(10);
      }
      assert.equal(observedWaiter, true, "concurrent start must wait behind the session lock barrier");
      await barrier.query(
        "SELECT pg_advisory_unlock(hashtext('vehicle_reid_v2_conversion_preview'))"
      );
      barrierHeld = false;
      results = await Promise.all(requests);
    } finally {
      if (barrierHeld) {
        await barrier.query(
          "SELECT pg_advisory_unlock(hashtext('vehicle_reid_v2_conversion_preview'))"
        );
      }
      barrier.release();
    }
  } else {
    results = [await newConversionService().startPreview({ actor, batchSize: 5 })];
  }
  const runIds = new Set(results.map((result) => result.operation.runId));
  assert.equal(runIds.size, 1, "concurrent starts must converge on one active run");
  if (concurrent) {
    assert.equal(results.filter((result) => result.operation.reused === false).length, 1);
    assert.equal(results.filter((result) => result.operation.reused === true).length, 1);
  }
  const runId = results[0].operation.runId;
  const overview = await newConversionService().getOverview();
  assert.equal(overview.latestRun.id, runId);
  assert.equal(overview.latestRun.status, "previewing");
  assert.deepEqual(overview.authority, { profiles: 0, members: 0, assignments: 0 });
  assert.equal(overview.control.mode, "v2_shadow");
  assert.match(overview.latestRun.identityEvidenceFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(overview.latestRun.previewFingerprint, null);
  return { runId, overview };
}

async function processCommittedPreview(runId, { firstLimit = 1 } = {}) {
  const actor = fixtureActor();
  let overview = await newConversionService().getOverview();
  let calls = 0;
  while (overview.latestRun.status === "previewing") {
    const result = await newConversionService().processBatch({
      runId,
      limit: calls === 0 ? firstLimit : 250,
      actor,
    });
    assert.ok(result.operation.processed >= 0 && result.operation.processed <= 250);
    overview = result.overview;
    calls += 1;
    assert.ok(calls < 20, "bounded preview should converge across committed batches");
  }
  assert.equal(overview.latestRun.status, "ready");
  assert.match(overview.latestRun.previewFingerprint, /^[0-9a-f]{64}$/);
  return overview;
}

async function exercisePauseAndRetry(runId) {
  const actor = fixtureActor();
  await newConversionService().setPaused({ runId, paused: true, actor });
  assert.equal((await newConversionService().getOverview()).latestRun.status, "paused");
  await newConversionService().setPaused({ runId, paused: false, actor });

  const exhausted = await pool.query(
    `SELECT id FROM public.vehicle_reid_v2_conversion_jobs
     WHERE run_id = $1 AND status = 'pending' ORDER BY id LIMIT 1`,
    [runId]
  );
  assert.ok(exhausted.rows[0], "preview must create bounded read jobs");
  const jobId = Number(exhausted.rows[0].id);
  await pool.query(
    `UPDATE public.vehicle_reid_v2_conversion_jobs
     SET status = 'failed', attempt_count = 3,
         error_code = 'CODEX_TRANSIENT', error_details = '{"message":"fixture"}'::jsonb
     WHERE id = $1`,
    [jobId]
  );
  const retry = await newConversionService().retryJob({ jobId, actor });
  assert.equal(retry.overview.latestRun.status, "previewing");
  const retried = await pool.query(
    `SELECT status, attempt_count, operator_retry_count
     FROM public.vehicle_reid_v2_conversion_jobs WHERE id = $1`,
    [jobId]
  );
  assert.deepEqual(retried.rows[0], {
    status: "pending",
    attempt_count: 0,
    operator_retry_count: 1,
  });
}

async function verifyCommittedPreview(runId, previewFingerprint) {
  const verified = await newConversionService().verifyCurrent({
    runId,
    previewFingerprint,
    actor: fixtureActor(),
  });
  assert.equal(verified.operation.current, true);
  assert.equal(verified.overview.latestRun.lastRevalidationStatus, "current");
  return verified;
}

async function verifyCommittedPreviewConcurrently(runId, previewFingerprint) {
  const barrier = await pool.connect();
  let barrierHeld = false;
  try {
    await barrier.query(
      "SELECT pg_advisory_lock(hashtext('vehicle_reid_v2_conversion_preview'))"
    );
    barrierHeld = true;
    const requests = [
      newConversionService().verifyCurrent({
        runId, previewFingerprint, actor: fixtureActor(),
      }),
      newConversionService().verifyCurrent({
        runId, previewFingerprint, actor: fixtureActor(),
      }),
    ];
    let blocked = 0;
    for (let attempt = 0; attempt < 100 && blocked < 2; attempt += 1) {
      const waiters = await barrier.query(
        `SELECT COUNT(*)::integer AS count
         FROM pg_stat_activity activity
         WHERE activity.wait_event = 'advisory'
           AND pg_backend_pid() = ANY(pg_blocking_pids(activity.pid))`
      );
      blocked = Number(waiters.rows[0]?.count) || 0;
      if (blocked < 2) await delay(10);
    }
    assert.ok(blocked >= 2, "both ready-run verifiers must wait behind the session barrier");
    await barrier.query(
      "SELECT pg_advisory_unlock(hashtext('vehicle_reid_v2_conversion_preview'))"
    );
    barrierHeld = false;
    const results = await Promise.all(requests);
    assert.ok(results.every((result) => result.operation.current === true));
    assert.ok(results.every((result) => (
      result.overview.latestRun.lastRevalidationStatus === "current"
    )));
  } finally {
    try {
      if (barrierHeld) {
        await barrier.query(
          "SELECT pg_advisory_unlock(hashtext('vehicle_reid_v2_conversion_preview'))"
        );
      }
    } finally {
      barrier.release();
    }
  }
}

async function forceAndRecoverRevalidationFailure(runId, previewFingerprint) {
  const failingRepository = new VehicleReidV2ConversionRepository({ pool });
  failingRepository.captureLiveEvidence = async () => {
    const error = new Error("Codex forced revalidation capture failure");
    error.code = "CODEX_REVALIDATION_FAILURE";
    throw error;
  };
  const failed = await newConversionService({ repository: failingRepository }).verifyCurrent({
    runId,
    previewFingerprint,
    actor: fixtureActor(),
  });
  assert.equal(failed.operation.current, false);
  assert.equal(failed.operation.failed, true);
  assert.equal(failed.overview.latestRun.status, "ready");
  assert.equal(failed.overview.latestRun.lastRevalidationStatus, "failed");
  assert.equal(failed.overview.latestRun.lastRevalidationFingerprint, null);
  assert.equal(
    failed.overview.latestRun.lastRevalidationErrorCode,
    "CODEX_REVALIDATION_FAILURE"
  );
  await verifyCommittedPreview(runId, previewFingerprint);
}

async function correctHistoricalPlate(readId) {
  const historical = await pool.query(
    `SELECT plate_number, review_status FROM public.plate_reads WHERE id = $1`,
    [readId]
  );
  await pool.query(
    `UPDATE public.plate_reads
     SET plate_number = 'NEW999', review_status = 'corrected',
         review_revision = review_revision + 1,
         last_reviewed_at = CURRENT_TIMESTAMP, last_reviewed_by = $2
     WHERE id = $1`,
    [readId, fixture.actorId]
  );
  await pool.query(
    `INSERT INTO public.plate_read_reviews (
       read_id, action, previous_plate, new_plate, previous_status,
       new_status, actor_user_id, actor_username, actor_display_name
     ) VALUES ($1, 'correct', $2, 'NEW999', $3, 'corrected', $4, $5, $6)`,
    [readId, historical.rows[0].plate_number, historical.rows[0].review_status,
      fixture.actorId, `codex_reid_${suffix}`, "Codex ReID v2 integration"]
  );
}

async function assertPreviewIsStale(runId, previewFingerprint) {
  const stale = await newConversionService().verifyCurrent({
    runId,
    previewFingerprint,
    actor: fixtureActor(),
  });
  assert.equal(stale.operation.current, false);
  assert.equal(stale.overview.latestRun.status, "stale");
  assert.deepEqual(stale.overview.authority, { profiles: 0, members: 0, assignments: 0 });
}

async function persistedDispositionTuples(runId) {
  const result = await pool.query(
    `SELECT dispositions.read_id, dispositions.disposition,
            dispositions.reason_code, profiles.projection_key,
            dispositions.assignment_basis,
            dispositions.profile_evidence_basis, dispositions.asset_id,
            dispositions.derivative_id, dispositions.embedding_id,
            dispositions.normalized_effective_plate, dispositions.historical,
            dispositions.nighttime, dispositions.disposition_fingerprint
     FROM public.vehicle_reid_v2_conversion_read_dispositions dispositions
     LEFT JOIN public.vehicle_reid_v2_conversion_projected_profiles profiles
       ON profiles.run_id = dispositions.run_id
      AND profiles.id = dispositions.projected_profile_id
     WHERE dispositions.run_id = $1
     ORDER BY dispositions.read_id`,
    [runId]
  );
  return result.rows.map((row) => ({
    readId: Number(row.read_id),
    disposition: row.disposition,
    reasonCode: row.reason_code,
    projectionKey: row.projection_key ? String(row.projection_key).trim() : null,
    assignmentBasis: row.assignment_basis,
    profileEvidenceBasis: row.profile_evidence_basis,
    assetId: row.asset_id == null ? null : Number(row.asset_id),
    derivativeId: row.derivative_id == null ? null : Number(row.derivative_id),
    embeddingId: row.embedding_id == null ? null : Number(row.embedding_id),
    normalizedPlate: row.normalized_effective_plate,
    historical: row.historical,
    nighttime: row.nighttime,
    fingerprint: String(row.disposition_fingerprint).trim(),
  }));
}

async function runConversionPreview(fixtures) {
  const first = await startCommittedPreview({ concurrent: true });
  await exercisePauseAndRetry(first.runId);

  const firstBatch = await newConversionService().processBatch({
    runId: first.runId,
    limit: 1,
    actor: fixtureActor(),
  });
  assert.equal(firstBatch.operation.processed, 1);
  const earlyShared = await pool.query(
    `SELECT assignment_basis FROM public.vehicle_reid_v2_conversion_read_dispositions
     WHERE run_id = $1 AND read_id = $2`,
    [first.runId, fixtures.exactA.readId]
  );
  assert.equal(
    earlyShared.rows[0]?.assignment_basis,
    "shared_asset",
    "one-read batches must use the full frozen asset-link count"
  );

  const overview = await processCommittedPreview(first.runId, { firstLimit: 250 });
  assert.ok(overview.latestRun.metrics.projectedMultiMemberProfiles >= 2);
  assert.ok(overview.latestRun.metrics.projectedSingletonProfiles >= 1);
  assert.ok(overview.latestRun.metrics.sharedAssetAssignments >= 2);
  assert.ok(overview.latestRun.metrics.exactPlateOnlyAssignments >= 2);
  assert.ok(overview.latestRun.metrics.historicalExactPlateAssignments >= 2);
  assert.ok(overview.latestRun.metrics.nighttimeExactPlateAssignments >= 1);
  assert.ok(overview.latestRun.metrics.conflictedComponents >= 3);
  assert.ok(overview.latestRun.metrics.unassignedReads >= 4);
  assert.ok(overview.latestRun.metrics.v1AssignedReads >= 3);

  const dispositions = await pool.query(
    `SELECT read_id, disposition, assignment_basis, reason_code,
            disposition_fingerprint
     FROM public.vehicle_reid_v2_conversion_read_dispositions
     WHERE run_id = $1 ORDER BY read_id`,
    [first.runId]
  );
  const byRead = new Map(dispositions.rows.map((row) => [Number(row.read_id), row]));
  assert.equal(byRead.get(fixtures.exactA.readId).assignment_basis, "shared_asset");
  assert.equal(byRead.get(fixtures.sharedReadId).assignment_basis, "shared_asset");
  assert.equal(byRead.get(fixtures.historicalReadId).assignment_basis, "exact_effective_plate");
  assert.equal(byRead.get(fixtures.nighttimeReadId).assignment_basis, "exact_effective_plate");
  assert.equal(byRead.get(fixtures.displayReadId).reason_code, "display_only_fallback");
  assert.equal(byRead.get(fixtures.incompleteReadId).disposition, "unavailable");
  assert.equal(byRead.get(fixtures.staleReadId).disposition, "stale");
  assert.ok(dispositions.rows.every((row) => /^[0-9a-f]{64}$/.test(
    String(row.disposition_fingerprint).trim()
  )));

  const fingerprint = overview.latestRun.previewFingerprint;
  const identityFingerprint = overview.latestRun.identityEvidenceFingerprint;
  const firstScheduleTuples = await persistedDispositionTuples(first.runId);
  await verifyCommittedPreviewConcurrently(first.runId, fingerprint);
  await forceAndRecoverRevalidationFailure(first.runId, fingerprint);

  await assert.rejects(
    pool.query(
      `UPDATE public.vehicle_reid_v2_conversion_read_evidence
       SET effective_plate = 'MUTATE'
       WHERE run_id = $1 AND read_id = (
         SELECT MIN(read_id) FROM public.vehicle_reid_v2_conversion_read_evidence
         WHERE run_id = $1
       )`,
      [first.runId]
    ),
    /immutable/
  );
  await assert.rejects(
    pool.query(
      `UPDATE public.vehicle_reid_v2_conversion_v1_comparisons
       SET v1_cluster_id = v1_cluster_id WHERE run_id = $1`,
      [first.runId]
    ),
    /immutable/
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO public.vehicle_reid_v2_conversion_v1_comparisons (
         run_id, read_id, comparison_fingerprint
       ) VALUES ($1, $2, $3)`,
      [first.runId, fixtures.exactA.readId, hash("late-comparison")]
    ),
    /sealed ReID v2 conversion snapshot/
  );
  await assert.rejects(
    pool.query(
      `UPDATE public.vehicle_reid_v2_conversion_runs
       SET status = 'previewing', phase = 'freeze', updated_at = clock_timestamp()
       WHERE id = $1`,
      [first.runId]
    ),
    /Invalid ReID v2 conversion transition/
  );
  await assert.rejects(
    pool.query(
      `UPDATE public.vehicle_reid_v2_conversion_runs
       SET identity_evidence_fingerprint = $2, updated_at = clock_timestamp()
       WHERE id = $1`,
      [first.runId, hash("rewritten-identity-fingerprint")]
    ),
    /rewrite sealed fields/
  );
  const candidateRun = await pool.query(
    "SELECT MAX(id)::bigint AS id FROM public.vehicle_reid_v2_profile_candidate_runs"
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO public.vehicle_reid_v2_profile_candidate_conflicts (
         run_id, conflict_key, reason, derivative_ids, effective_plates
       ) VALUES ($1, $2, 'human_different', '[]'::jsonb, '[]'::jsonb)`,
      [Number(candidateRun.rows[0].id), hash("late-candidate-conflict")]
    ),
    /profile candidate snapshots are immutable/
  );

  await newConversionService().cancel({ runId: first.runId, actor: fixtureActor() });
  const second = await startCommittedPreview();
  const secondOverview = await processCommittedPreview(second.runId, { firstLimit: 250 });
  const secondScheduleTuples = await persistedDispositionTuples(second.runId);
  assert.equal(secondOverview.latestRun.previewFingerprint, fingerprint);
  assert.equal(secondOverview.latestRun.identityEvidenceFingerprint, identityFingerprint);
  assert.deepEqual(
    secondScheduleTuples,
    firstScheduleTuples,
    "persisted dispositions and fingerprints must be independent of batch schedule"
  );
  await verifyCommittedPreview(second.runId, secondOverview.latestRun.previewFingerprint);

  await correctHistoricalPlate(fixtures.historicalReadId);
  await assertPreviewIsStale(second.runId, secondOverview.latestRun.previewFingerprint);

  const third = await startCommittedPreview();
  const thirdOverview = await processCommittedPreview(third.runId);
  await verifyCommittedPreview(third.runId, thirdOverview.latestRun.previewFingerprint);
  fixtures.exactBReplacement = await replaceCanonicalSource(
    fixtures.exactB,
    "replacement-exact-b",
    { timestampOffset: "-7 days", embeddingValues: [0.95, 0.05] }
  );
  await assertPreviewIsStale(third.runId, thirdOverview.latestRun.previewFingerprint);

  const fourth = await startCommittedPreview();
  const fourthOverview = await processCommittedPreview(fourth.runId);
  await verifyCommittedPreview(fourth.runId, fourthOverview.latestRun.previewFingerprint);
  const postBoundReadId = await addSharedRead(fixtures.exactA, "BRG999");
  await assertPreviewIsStale(fourth.runId, fourthOverview.latestRun.previewFingerprint);

  const fifth = await startCommittedPreview();
  const fifthOverview = await processCommittedPreview(fifth.runId);
  const conflicts = await pool.query(
    `SELECT read_id, disposition, reason_code
     FROM public.vehicle_reid_v2_conversion_read_dispositions
     WHERE run_id = $1 AND read_id = ANY($2::integer[])
     ORDER BY read_id`,
    [fifth.runId, [fixtures.exactA.readId, fixtures.sharedReadId, postBoundReadId]]
  );
  assert.equal(conflicts.rows.length, 3);
  assert.ok(conflicts.rows.every((row) => (
    row.disposition === "conflict" && row.reason_code === "conflicted_component"
  )));
  const multiPlateConflict = await pool.query(
    `SELECT derivative_ids, read_ids, effective_plates
     FROM public.vehicle_reid_v2_conversion_conflicts
     WHERE run_id = $1 AND reason = 'ambiguous_effective_plates'`,
    [fifth.runId]
  );
  assert.equal(multiPlateConflict.rows.length, 1);
  assert.ok(multiPlateConflict.rows[0].derivative_ids.includes(fixtures.exactA.derivativeId));
  assert.ok(multiPlateConflict.rows[0].read_ids.includes(postBoundReadId));
  assert.deepEqual(multiPlateConflict.rows[0].effective_plates, ["BRG999", "COR123"]);
  const quarantine = await pool.query(
    `SELECT
       (SELECT COUNT(*)::integer
        FROM public.vehicle_reid_v2_conversion_projected_members
        WHERE run_id = $1 AND derivative_id = $2) AS projected_members,
       (SELECT COUNT(*)::integer
        FROM public.vehicle_reid_v2_conversion_projected_profiles
        WHERE run_id = $1 AND anchor_plates ? 'BRG999') AS bridge_anchors,
       (SELECT COUNT(*)::integer
        FROM public.vehicle_reid_v2_conversion_read_dispositions
        WHERE run_id = $1 AND assignment_basis = 'exact_effective_plate'
          AND normalized_effective_plate = 'BRG999') AS plate_only_assignments,
       (SELECT COUNT(*)::integer
        FROM public.vehicle_reid_v2_conversion_conflicts
        WHERE run_id = $1 AND reason = 'stale_source_link'
          AND details->>'dispositionReason' = 'conflicted_component')
          AS false_stale_conflicts`,
    [fifth.runId, fixtures.exactA.derivativeId]
  );
  assert.deepEqual(quarantine.rows[0], {
    projected_members: 0,
    bridge_anchors: 0,
    plate_only_assignments: 0,
    false_stale_conflicts: 0,
  });
  await verifyCommittedPreview(fifth.runId, fifthOverview.latestRun.previewFingerprint);
  return { latestRunId: fifth.runId };
}

async function testOlderFailedRunCannotBeRevived(readyRunId) {
  const actor = fixtureActor();
  await newConversionService().cancel({ runId: readyRunId, actor });

  const failedRun = await startCommittedPreview();
  const exhausted = await pool.query(
    `UPDATE public.vehicle_reid_v2_conversion_jobs
     SET status = 'failed', attempt_count = 3, retryable = TRUE,
         error_code = 'CODEX_EXHAUSTED',
         error_details = '{"message":"forced exhaustion"}'::jsonb
     WHERE run_id = $1
     RETURNING id`,
    [failedRun.runId]
  );
  assert.ok(exhausted.rows.length > 0);
  const exhaustedJobId = Math.min(...exhausted.rows.map((row) => Number(row.id)));
  const finalized = await newConversionService().processBatch({
    runId: failedRun.runId,
    limit: 1,
    actor,
  });
  assert.equal(finalized.operation.processed, 0);
  assert.equal(finalized.overview.latestRun.status, "failed");

  const newer = await startCommittedPreview();
  await newConversionService().cancel({ runId: newer.runId, actor });
  await assert.rejects(
    newConversionService().retryJob({ jobId: exhaustedJobId, actor }),
    /not eligible/
  );
  const oldRun = await pool.query(
    "SELECT status FROM public.vehicle_reid_v2_conversion_runs WHERE id = $1",
    [failedRun.runId]
  );
  assert.equal(oldRun.rows[0]?.status, "failed");
  const hiddenActive = await pool.query(
    `SELECT COUNT(*)::integer AS count
     FROM public.vehicle_reid_v2_conversion_runs
     WHERE id < $1 AND status IN ('previewing','ready','paused','accepted','running')`,
    [newer.runId]
  );
  assert.equal(hiddenActive.rows[0]?.count, 0);
}

async function testAuthorityAndRollbackSchema(fixtures, templateRunId) {
  const client = await pool.connect();
  await client.query("BEGIN");
  try {
    await client.query("SAVEPOINT standalone_authority_contract_checks");
    const profile = await client.query(
      `INSERT INTO public.vehicle_reid_v2_profiles (
         status, provenance_basis, representative_derivative_id,
         representative_embedding_id, representative_source_sha256,
         representative_evidence_fingerprint, created_by_user_id,
         created_by_username, created_by_display_name
       ) VALUES (
         'provisional', 'provisional_singleton', $1, $2, $3, $4, $5, $6, $7
       ) RETURNING id`,
      [fixtures.singleton.derivativeId, fixtures.singleton.embeddingId,
        fixtures.singleton.derivativeSha, hash("authority-profile"), fixture.actorId,
        `codex_reid_${suffix}`, "Codex ReID v2 integration"]
    );

    const provenanceRun = await client.query(
      "SELECT MAX(id)::bigint AS id FROM public.vehicle_reid_v2_conversion_runs"
    );
    await client.query("SAVEPOINT fabricated_profile_provenance_check");
    await assert.rejects(
      client.query(
        `INSERT INTO public.vehicle_reid_v2_profiles (
           status, provenance_basis, representative_derivative_id,
           representative_embedding_id, representative_source_sha256,
           representative_evidence_fingerprint, origin_conversion_run_id,
           origin_projection_key, created_by_user_id, created_by_username,
           created_by_display_name
         ) VALUES (
           'provisional', 'provisional_singleton', $1, $2, $3, $4,
           $5, $6, $7, $8, 'Codex ReID v2 integration'
         )`,
        [fixtures.singleton.derivativeId, fixtures.singleton.embeddingId,
          fixtures.singleton.derivativeSha, hash("fabricated-profile-evidence"),
          Number(provenanceRun.rows[0].id), hash("nonexistent-projection-key"),
          fixture.actorId, `codex_reid_${suffix}`]
      ),
      /sealed outside running\/materialize/
    );
    await client.query("ROLLBACK TO SAVEPOINT fabricated_profile_provenance_check");

    await client.query("SAVEPOINT fabricated_member_check");
    await assert.rejects(
      client.query(
        `INSERT INTO public.vehicle_reid_v2_profile_members (
           profile_id, derivative_id, asset_id, derivative_kind,
           crop_algorithm_version, asset_source_sha256, crop_content_sha256,
           embedding_id, embedding_model, embedding_algorithm_version,
           embedding_source_sha256, embedding_sha256, membership_basis,
           representative_evidence_read_id, source_revision_fingerprint,
           evidence_fingerprint
         ) VALUES (
           $1, $2, $3, 'vehicle_crop', 'canonical-overview-detection-box-v1',
           $4, $5, $6, 'vehicle-reid-0001-ir-fp16-v1',
           'canonical-overview-crop-embedding-v1', $5, $7,
           'provisional_singleton', $8, $9, $10
         )`,
        [Number(profile.rows[0].id), fixtures.singleton.derivativeId,
          fixtures.singleton.assetId, fixtures.singleton.assetSha,
          fixtures.singleton.derivativeSha, fixtures.singleton.embeddingId,
          hash("fabricated-embedding-hash"), fixtures.singleton.readId,
          hash("fabricated-source-revision"), hash("fabricated-member-evidence")]
      ),
      /exact asset\/crop\/embedding contract/
    );
    await client.query("ROLLBACK TO SAVEPOINT fabricated_member_check");

    const member = await client.query(
      `INSERT INTO public.vehicle_reid_v2_profile_members (
         profile_id, derivative_id, asset_id, derivative_kind,
         crop_algorithm_version, asset_source_sha256, crop_content_sha256,
         embedding_id, embedding_model, embedding_algorithm_version,
         embedding_source_sha256, embedding_sha256, membership_basis,
         representative_evidence_read_id, source_revision_fingerprint,
         evidence_fingerprint
       ) VALUES (
         $1, $2, $3, 'vehicle_crop', 'canonical-overview-detection-box-v1',
         $4, $5, $6, 'vehicle-reid-0001-ir-fp16-v1',
         'canonical-overview-crop-embedding-v1', $5, $7,
         'provisional_singleton', $8, $9, $10
       ) RETURNING id`,
      [Number(profile.rows[0].id), fixtures.singleton.derivativeId,
        fixtures.singleton.assetId, fixtures.singleton.assetSha,
        fixtures.singleton.derivativeSha, fixtures.singleton.embeddingId,
        fixtures.singleton.embeddingSha, fixtures.singleton.readId,
        hash("source-revision"), hash("member-evidence")]
    );

    const mismatchedLink = await client.query(
      `SELECT source_updated_at::text, updated_at::text
       FROM public.vehicle_image_asset_reads
       WHERE asset_id = $1 AND read_id = $2`,
      [fixtures.exactA.assetId, fixtures.exactA.readId]
    );
    await client.query("SAVEPOINT mismatched_assignment_check");
    await assert.rejects(
      client.query(
        `INSERT INTO public.vehicle_reid_v2_read_assignments (
           read_id, profile_id, assignment_basis, profile_membership_basis,
           profile_revision, profile_member_id, asset_id, derivative_id,
           embedding_id, normalized_effective_plate, plate_review_status,
           plate_review_revision, source_kind, source_relationship,
           source_path_snapshot, source_updated_at, source_link_updated_at,
           evidence_fingerprint
         ) VALUES (
           $1, $2, 'canonical_image', 'provisional_singleton', 1, $3, $4,
           $5, $6, 'COR123', 'corrected', 1, 'overview_primary', 'primary',
           $7, $8::timestamptz, $9::timestamptz, $10
         )`,
        [fixtures.exactA.readId, Number(profile.rows[0].id), Number(member.rows[0].id),
          fixtures.exactA.assetId, fixtures.exactA.derivativeId,
          fixtures.exactA.embeddingId, fixtures.exactA.assetPath,
          mismatchedLink.rows[0].source_updated_at, mismatchedLink.rows[0].updated_at,
          hash("mismatched-assignment-evidence")]
      ),
      /exact current member\/source-link contract/
    );
    await client.query("ROLLBACK TO SAVEPOINT mismatched_assignment_check");

    await client.query("SAVEPOINT untrusted_exact_plate_check");
    await assert.rejects(
      client.query(
        `INSERT INTO public.vehicle_reid_v2_read_assignments (
           read_id, profile_id, assignment_basis, profile_membership_basis,
           profile_revision, normalized_effective_plate, plate_review_status,
           plate_review_revision, evidence_fingerprint
         ) VALUES (
           $1, $2, 'exact_effective_plate', 'exact_effective_plate', 1,
           'COR123', 'unreviewed', 0, $3
         )`,
        [fixtures.historicalReadId, Number(profile.rows[0].id),
          hash("untrusted-exact-assignment")]
      ),
      /current reviewed plate evidence|vehicle_reid_v2_read_assignments_check/
    );
    await client.query("ROLLBACK TO SAVEPOINT untrusted_exact_plate_check");

    await client.query("SAVEPOINT unrelated_trusted_plate_check");
    await assert.rejects(
      client.query(
        `INSERT INTO public.vehicle_reid_v2_read_assignments (
           read_id, profile_id, assignment_basis, profile_membership_basis,
           profile_revision, normalized_effective_plate, plate_review_status,
           plate_review_revision, plate_review_id, applied_alias_id,
           evidence_fingerprint
         )
         SELECT
           reads.id, $2, 'exact_effective_plate', 'exact_effective_plate', 1,
           UPPER(REGEXP_REPLACE(reads.plate_number, '[^A-Za-z0-9]', '', 'g')),
           reads.review_status, reads.review_revision,
           (SELECT reviews.id FROM public.plate_read_reviews reviews
            WHERE reviews.read_id = reads.id
            ORDER BY reviews.created_at DESC, reviews.id DESC LIMIT 1),
           reads.applied_alias_id, $3
         FROM public.plate_reads reads WHERE reads.id = $1`,
        [fixtures.historicalReadId, Number(profile.rows[0].id),
          hash("unrelated-trusted-exact-assignment")]
      ),
      /requires a current profile plate anchor/
    );
    await client.query("ROLLBACK TO SAVEPOINT unrelated_trusted_plate_check");

    const singletonLink = await client.query(
      `SELECT source_updated_at::text, updated_at::text
       FROM public.vehicle_image_asset_reads
       WHERE asset_id = $1 AND read_id = $2`,
      [fixtures.singleton.assetId, fixtures.singleton.readId]
    );
    await client.query("SAVEPOINT read_delete_cascade_check");
    await client.query(
      `INSERT INTO public.vehicle_reid_v2_read_assignments (
         read_id, profile_id, assignment_basis, profile_membership_basis,
         profile_revision, profile_member_id, asset_id, derivative_id,
         embedding_id, normalized_effective_plate, plate_review_status,
         plate_review_revision, source_kind, source_relationship,
         source_path_snapshot, source_updated_at, source_link_updated_at,
         evidence_fingerprint
       ) VALUES (
         $1, $2, 'canonical_image', 'provisional_singleton', 1, $3, $4,
         $5, $6, 'SNG111', 'corrected', 1, 'overview_primary', 'primary',
         $7, $8::timestamptz, $9::timestamptz, $10
       )`,
      [fixtures.singleton.readId, Number(profile.rows[0].id), Number(member.rows[0].id),
        fixtures.singleton.assetId, fixtures.singleton.derivativeId,
        fixtures.singleton.embeddingId, fixtures.singleton.assetPath,
        singletonLink.rows[0].source_updated_at, singletonLink.rows[0].updated_at,
        hash("assignment-evidence")]
    );
    await client.query("DELETE FROM public.plate_reads WHERE id = $1", [fixtures.singleton.readId]);
    const afterDelete = await client.query(
      `SELECT
         (SELECT COUNT(*) FROM public.vehicle_reid_v2_profiles)::integer AS profiles,
         (SELECT COUNT(*) FROM public.vehicle_reid_v2_profile_members)::integer AS members,
         (SELECT COUNT(*) FROM public.vehicle_reid_v2_read_assignments)::integer AS assignments`
    );
    assert.deepEqual(afterDelete.rows[0], { profiles: 1, members: 1, assignments: 0 });
    await client.query("ROLLBACK TO SAVEPOINT standalone_authority_contract_checks");

    await client.query("SAVEPOINT premature_cutover_check");
    await assert.rejects(
      client.query(
        `UPDATE public.vehicle_reid_control
         SET previous_mode = mode, mode = 'v2_primary', revision = revision + 1,
             transition_reason = 'Premature cutover must fail',
             transitioned_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE singleton = TRUE`
      ),
      /exact materialization requires one conversion run|requires one completed, exactly revalidated conversion run/
    );
    await client.query("ROLLBACK TO SAVEPOINT premature_cutover_check");

    await client.query("SAVEPOINT direct_completed_insert_check");
    await assert.rejects(
      client.query(
        `INSERT INTO public.vehicle_reid_v2_conversion_runs (
           status, phase, max_read_id, max_derivative_id,
           max_plate_review_id, max_pair_review_id, crop_kind,
           crop_algorithm_version, embedding_model,
           embedding_algorithm_version, source_profile_candidate_run_id,
           source_profile_candidate_fingerprint,
           profile_candidate_algorithm_version, actor_user_id,
           actor_username, actor_display_name
         )
         SELECT
           'completed', 'complete', max_read_id, max_derivative_id,
           max_plate_review_id, max_pair_review_id, crop_kind,
           crop_algorithm_version, embedding_model,
           embedding_algorithm_version, source_profile_candidate_run_id,
           source_profile_candidate_fingerprint,
           profile_candidate_algorithm_version, $2, $3, $4
         FROM public.vehicle_reid_v2_conversion_runs WHERE id = $1`,
        [templateRunId, fixture.actorId, `codex_reid_${suffix}`,
          "Codex ReID v2 integration"]
      ),
      /must begin as an untouched preview freeze/
    );
    await client.query("ROLLBACK TO SAVEPOINT direct_completed_insert_check");

    await client.query(
      `UPDATE public.vehicle_reid_v2_conversion_runs
       SET status = 'cancelled', cancelled_at = clock_timestamp(),
           updated_at = clock_timestamp()
       WHERE id = $1`,
      [templateRunId]
    );

    const inconsistentRun = await client.query(
      `INSERT INTO public.vehicle_reid_v2_conversion_runs (
         status, phase, max_read_id, max_derivative_id, max_plate_review_id,
         max_pair_review_id, crop_kind, crop_algorithm_version,
         embedding_model, embedding_algorithm_version,
         source_profile_candidate_run_id,
         source_profile_candidate_fingerprint,
         profile_candidate_algorithm_version, identity_evidence_fingerprint,
         batch_size, projected_profiles, projected_singleton_profiles,
         projected_members, assigned_reads, actor_user_id, actor_username,
         actor_display_name
       )
       SELECT
         'previewing', 'freeze', max_read_id, max_derivative_id,
         max_plate_review_id, max_pair_review_id, crop_kind,
         crop_algorithm_version, embedding_model,
         embedding_algorithm_version, source_profile_candidate_run_id,
         source_profile_candidate_fingerprint,
         profile_candidate_algorithm_version, $2, 1, 1, 1, 1, 1,
         $3, $4, $5
       FROM public.vehicle_reid_v2_conversion_runs
       WHERE id = $1
       RETURNING id`,
      [templateRunId, hash("inconsistent-authority-evidence"), fixture.actorId,
        `codex_reid_${suffix}`, "Codex ReID v2 integration"]
    );
    const inconsistentRunId = Number(inconsistentRun.rows[0].id);
    await client.query(
      `UPDATE public.vehicle_reid_v2_conversion_runs
       SET phase = 'project_reads', updated_at = clock_timestamp()
       WHERE id = $1`,
      [inconsistentRunId]
    );
    await client.query(
      `UPDATE public.vehicle_reid_v2_conversion_runs
       SET status = 'ready', phase = 'revalidate',
           preview_fingerprint = $2, comparison_fingerprint = $3,
           preview_metrics = '{"intentionallyInconsistent":true}'::jsonb,
           updated_at = clock_timestamp()
       WHERE id = $1`,
      [inconsistentRunId, hash("inconsistent-authority-preview"),
        hash("inconsistent-authority-comparison")]
    );
    await client.query(
      `UPDATE public.vehicle_reid_v2_conversion_runs
       SET last_revalidation_status = 'current',
           last_revalidation_fingerprint = identity_evidence_fingerprint,
           last_revalidated_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE id = $1`,
      [inconsistentRunId]
    );
    await client.query(
      `UPDATE public.vehicle_reid_v2_conversion_runs
       SET status = 'accepted', accepted_preview_fingerprint = preview_fingerprint,
           accepted_actor_user_id = $2, accepted_actor_username = $3,
           accepted_actor_display_name = $4, accepted_at = clock_timestamp(),
           updated_at = clock_timestamp()
       WHERE id = $1`,
      [inconsistentRunId, fixture.actorId, `codex_reid_${suffix}`,
        "Codex ReID v2 integration"]
    );
    await client.query(
      `UPDATE public.vehicle_reid_v2_conversion_runs
       SET status = 'running', phase = 'materialize', updated_at = clock_timestamp()
       WHERE id = $1`,
      [inconsistentRunId]
    );
    await client.query("SAVEPOINT inconsistent_metrics_check");
    await assert.rejects(
      client.query(
        `UPDATE public.vehicle_reid_v2_conversion_runs
         SET status = 'completed', phase = 'complete',
             completed_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE id = $1`,
        [inconsistentRunId]
      ),
      /materialization metrics do not match/
    );
    await client.query("ROLLBACK TO SAVEPOINT inconsistent_metrics_check");
    await client.query(
      `UPDATE public.vehicle_reid_v2_conversion_runs
       SET status = 'failed', last_error_code = 'CODEX_INCONSISTENT_METRICS',
           updated_at = clock_timestamp()
       WHERE id = $1`,
      [inconsistentRunId]
    );

    const sourceProjection = await client.query(
      `SELECT projected.id AS projected_profile_id, dispositions.read_id,
              dispositions.assignment_basis
       FROM public.vehicle_reid_v2_conversion_projected_profiles projected
       JOIN public.vehicle_reid_v2_conversion_projected_members members
         ON members.run_id = projected.run_id
        AND members.projected_profile_id = projected.id
       JOIN public.vehicle_reid_v2_conversion_read_dispositions dispositions
         ON dispositions.run_id = projected.run_id
        AND dispositions.projected_profile_id = projected.id
        AND dispositions.derivative_id = members.derivative_id
       WHERE projected.run_id = $1
         AND projected.profile_kind = 'provisional_singleton'
         AND dispositions.disposition = 'assigned'
         AND dispositions.assignment_basis IN (
           'canonical_image','shared_asset','human_same'
         )
       ORDER BY dispositions.read_id
       LIMIT 1`,
      [templateRunId]
    );
    assert.equal(sourceProjection.rows.length, 1);
    const projectedProfileId = Number(sourceProjection.rows[0].projected_profile_id);
    const projectedReadId = Number(sourceProjection.rows[0].read_id);
    const assignmentBasis = sourceProjection.rows[0].assignment_basis;

    const dedicatedRun = await client.query(
      `INSERT INTO public.vehicle_reid_v2_conversion_runs (
         status, phase, max_read_id, max_derivative_id, max_plate_review_id,
         max_pair_review_id, crop_kind, crop_algorithm_version,
         embedding_model, embedding_algorithm_version,
         source_profile_candidate_run_id,
         source_profile_candidate_fingerprint,
         profile_candidate_algorithm_version, identity_evidence_fingerprint,
         batch_size, eligible_crops, exact_current_embeddings,
         projected_profiles, projected_multi_member_profiles,
         projected_singleton_profiles, projected_members,
         actor_user_id, actor_username, actor_display_name
       )
       SELECT
         'previewing', 'freeze', max_read_id, max_derivative_id,
         max_plate_review_id, max_pair_review_id, crop_kind,
         crop_algorithm_version, embedding_model,
         embedding_algorithm_version, source_profile_candidate_run_id,
         source_profile_candidate_fingerprint,
         profile_candidate_algorithm_version, $2, 1, 1, 1, 1, 0, 1, 1,
         $3, $4, $5
       FROM public.vehicle_reid_v2_conversion_runs
       WHERE id = $1
       RETURNING id`,
      [templateRunId, hash("dedicated-authority-evidence"), fixture.actorId,
        `codex_reid_${suffix}`, "Codex ReID v2 integration"]
    );
    assert.equal(dedicatedRun.rows.length, 1);
    const dedicatedRunId = Number(dedicatedRun.rows[0].id);

    await client.query(
      `INSERT INTO public.vehicle_reid_v2_conversion_read_evidence (
         run_id, read_id, read_event_identity, read_timestamp, read_created_at,
         camera_name, observed_plate, effective_plate,
         normalized_effective_plate, plate_review_status,
         plate_review_revision, last_plate_review_id,
         last_plate_review_action, last_plate_review_created_at,
         applied_alias_id, plate_evidence_fingerprint, vehicle_image_status,
         vehicle_image_queue_kind, vehicle_image_error_code,
         vehicle_image_path, vehicle_image_source_kind,
         vehicle_image_updated_at, daylight_status, canonical_link_state,
         asset_id, derivative_id, embedding_id, source_read_id, source_kind,
         relationship, identity_eligible, overview_context,
         source_path_snapshot, source_updated_at, link_updated_at,
         crop_evidence_fingerprint, evidence_fingerprint
       )
       SELECT
         $1, read_id, read_event_identity, read_timestamp, read_created_at,
         camera_name, observed_plate, effective_plate,
         normalized_effective_plate, plate_review_status,
         plate_review_revision, last_plate_review_id,
         last_plate_review_action, last_plate_review_created_at,
         applied_alias_id, plate_evidence_fingerprint, vehicle_image_status,
         vehicle_image_queue_kind, vehicle_image_error_code,
         vehicle_image_path, vehicle_image_source_kind,
         vehicle_image_updated_at, daylight_status, canonical_link_state,
         asset_id, derivative_id, embedding_id, source_read_id, source_kind,
         relationship, identity_eligible, overview_context,
         source_path_snapshot, source_updated_at, link_updated_at,
         crop_evidence_fingerprint, evidence_fingerprint
       FROM public.vehicle_reid_v2_conversion_read_evidence
       WHERE run_id = $2 AND read_id = $3`,
      [dedicatedRunId, templateRunId, projectedReadId]
    );
    const dedicatedProjection = await client.query(
      `INSERT INTO public.vehicle_reid_v2_conversion_projected_profiles (
         run_id, projection_key, profile_kind, evidence_basis,
         representative_derivative_id, representative_embedding_id,
         representative_source_sha256, member_count, read_count,
         anchor_plates, camera_names, overview_contexts,
         projection_fingerprint
       )
       SELECT
         $1, projection_key, profile_kind, evidence_basis,
         representative_derivative_id, representative_embedding_id,
         representative_source_sha256, member_count, 1,
         anchor_plates, camera_names, overview_contexts,
         projection_fingerprint
       FROM public.vehicle_reid_v2_conversion_projected_profiles
       WHERE run_id = $2 AND id = $3
       RETURNING id`,
      [dedicatedRunId, templateRunId, projectedProfileId]
    );
    const dedicatedProjectionId = Number(dedicatedProjection.rows[0].id);
    await client.query(
      `INSERT INTO public.vehicle_reid_v2_conversion_projected_members (
         run_id, projected_profile_id, derivative_id, asset_id, embedding_id,
         crop_content_sha256, embedding_sha256, evidence_basis,
         effective_plates, member_fingerprint
       )
       SELECT
         $1, $2, derivative_id, asset_id, embedding_id,
         crop_content_sha256, embedding_sha256, evidence_basis,
         effective_plates, member_fingerprint
       FROM public.vehicle_reid_v2_conversion_projected_members
       WHERE run_id = $3 AND projected_profile_id = $4`,
      [dedicatedRunId, dedicatedProjectionId, templateRunId, projectedProfileId]
    );
    await client.query(
      `UPDATE public.vehicle_reid_v2_conversion_runs
       SET phase = 'project_reads', updated_at = clock_timestamp()
       WHERE id = $1`,
      [dedicatedRunId]
    );
    await client.query(
      `INSERT INTO public.vehicle_reid_v2_conversion_read_dispositions (
         run_id, read_id, disposition, projected_profile_id,
         assignment_basis, profile_evidence_basis, reason_code, asset_id,
         derivative_id, embedding_id, normalized_effective_plate,
         historical, nighttime, disposition_fingerprint
       )
       SELECT
         $1, read_id, disposition, $2, assignment_basis,
         profile_evidence_basis, reason_code, asset_id, derivative_id,
         embedding_id, normalized_effective_plate, historical, nighttime,
         disposition_fingerprint
       FROM public.vehicle_reid_v2_conversion_read_dispositions
       WHERE run_id = $3 AND read_id = $4`,
      [dedicatedRunId, dedicatedProjectionId, templateRunId, projectedReadId]
    );
    await client.query(
      `UPDATE public.vehicle_reid_v2_conversion_runs
       SET status = 'ready', phase = 'revalidate',
           preview_fingerprint = $2, comparison_fingerprint = $3,
           assigned_reads = 1,
           canonical_image_assignments = CASE WHEN $4 = 'canonical_image' THEN 1 ELSE 0 END,
           shared_asset_assignments = CASE WHEN $4 = 'shared_asset' THEN 1 ELSE 0 END,
           preview_metrics = '{"dedicatedAuthorityFixture":true}'::jsonb,
           updated_at = clock_timestamp()
       WHERE id = $1`,
      [dedicatedRunId, hash("dedicated-authority-preview"),
        hash("dedicated-authority-comparison"), assignmentBasis]
    );
    await client.query(
      `UPDATE public.vehicle_reid_v2_conversion_runs
       SET last_revalidation_status = 'current',
           last_revalidation_fingerprint = identity_evidence_fingerprint,
           last_revalidated_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE id = $1`,
      [dedicatedRunId]
    );
    await client.query(
      `UPDATE public.vehicle_reid_v2_conversion_runs
       SET status = 'accepted',
           accepted_preview_fingerprint = preview_fingerprint,
           accepted_actor_user_id = $2, accepted_actor_username = $3,
           accepted_actor_display_name = $4, accepted_at = clock_timestamp(),
           updated_at = clock_timestamp()
       WHERE id = $1`,
      [dedicatedRunId, fixture.actorId, `codex_reid_${suffix}`,
        "Codex ReID v2 integration"]
    );
    await client.query(
      `UPDATE public.vehicle_reid_v2_conversion_runs
       SET status = 'running', phase = 'materialize', updated_at = clock_timestamp()
       WHERE id = $1`,
      [dedicatedRunId]
    );

    await client.query("SAVEPOINT fabricated_running_profile_check");
    await assert.rejects(
      client.query(
        `INSERT INTO public.vehicle_reid_v2_profiles (
           status, provenance_basis, representative_derivative_id,
           representative_embedding_id, representative_source_sha256,
           representative_evidence_fingerprint, origin_conversion_run_id,
           origin_projection_key, created_by_user_id, created_by_username,
           created_by_display_name
         ) VALUES (
           'provisional', 'provisional_singleton', $1, $2, $3, $4,
           $5, $6, $7, $8, 'Codex ReID v2 integration'
         )`,
        [fixtures.singleton.derivativeId, fixtures.singleton.embeddingId,
          fixtures.singleton.derivativeSha, hash("fabricated-running-profile"),
          dedicatedRunId, hash("nonexistent-running-projection"), fixture.actorId,
          `codex_reid_${suffix}`]
      ),
      /does not exactly reproduce its preview provenance/
    );
    await client.query("ROLLBACK TO SAVEPOINT fabricated_running_profile_check");

    await client.query("SAVEPOINT empty_authority_check");
    await assert.rejects(
      client.query(
        `UPDATE public.vehicle_reid_v2_conversion_runs
         SET status = 'completed', phase = 'complete',
             completed_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE id = $1`,
        [dedicatedRunId]
      ),
      /materialization does not exactly reproduce/
    );
    await client.query("ROLLBACK TO SAVEPOINT empty_authority_check");

    const materializedProfile = await client.query(
      `INSERT INTO public.vehicle_reid_v2_profiles (
         status, provenance_basis, representative_derivative_id,
         representative_embedding_id, representative_source_sha256,
         representative_evidence_fingerprint, origin_conversion_run_id,
         origin_projection_key, created_by_user_id, created_by_username,
         created_by_display_name
       )
       SELECT
         CASE WHEN profile_kind = 'provisional_singleton'
              THEN 'provisional' ELSE 'active' END,
         evidence_basis, representative_derivative_id,
         representative_embedding_id, representative_source_sha256,
         projection_fingerprint, run_id, projection_key, $2, $3, $4
       FROM public.vehicle_reid_v2_conversion_projected_profiles
       WHERE run_id = $1
       RETURNING id`,
      [dedicatedRunId, fixture.actorId, `codex_reid_${suffix}`,
        "Codex ReID v2 integration"]
    );
    const materializedProfileId = Number(materializedProfile.rows[0].id);

    await client.query("SAVEPOINT partial_authority_check");
    await assert.rejects(
      client.query(
        `UPDATE public.vehicle_reid_v2_conversion_runs
         SET status = 'completed', phase = 'complete',
             completed_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE id = $1`,
        [dedicatedRunId]
      ),
      /member materialization does not exactly reproduce/
    );
    await client.query("ROLLBACK TO SAVEPOINT partial_authority_check");

    const materializedMember = await client.query(
      `INSERT INTO public.vehicle_reid_v2_profile_members (
         profile_id, derivative_id, asset_id, derivative_kind,
         crop_algorithm_version, asset_source_sha256, crop_content_sha256,
         embedding_id, embedding_model, embedding_algorithm_version,
         embedding_source_sha256, embedding_sha256, membership_basis,
         representative_evidence_read_id, source_revision_fingerprint,
         evidence_fingerprint, origin_conversion_run_id,
         origin_projected_member_fingerprint
       )
       SELECT
         $2, projected.derivative_id, projected.asset_id,
         derivatives.derivative_kind, derivatives.algorithm_version,
         assets.content_sha256, projected.crop_content_sha256,
         projected.embedding_id, embeddings.model_name,
         embeddings.algorithm_version, embeddings.source_sha256,
         projected.embedding_sha256, projected.evidence_basis, $3,
         $4, projected.member_fingerprint, projected.run_id,
         projected.member_fingerprint
       FROM public.vehicle_reid_v2_conversion_projected_members projected
       JOIN public.vehicle_image_derivatives derivatives
         ON derivatives.id = projected.derivative_id
       JOIN public.vehicle_image_assets assets ON assets.id = projected.asset_id
       JOIN public.vehicle_asset_embeddings embeddings
         ON embeddings.id = projected.embedding_id
       WHERE projected.run_id = $1
       RETURNING id`,
      [dedicatedRunId, materializedProfileId, projectedReadId,
        hash("dedicated-authority-source-revision")]
    );
    const materializedMemberId = Number(materializedMember.rows[0].id);

    await client.query(
      `INSERT INTO public.vehicle_reid_v2_profile_plate_anchors (
         profile_id, status, normalized_plate, evidence_read_id,
         plate_review_status, plate_review_revision, plate_review_id,
         applied_alias_id, evidence_fingerprint, origin_conversion_run_id,
         origin_projection_key
       )
       SELECT $2, 'current', plates.normalized_plate, evidence.read_id,
              evidence.plate_review_status, evidence.plate_review_revision,
              evidence.last_plate_review_id, evidence.applied_alias_id,
              evidence.plate_evidence_fingerprint, projected.run_id,
              projected.projection_key
       FROM public.vehicle_reid_v2_conversion_projected_profiles projected
       CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS_TEXT(projected.anchor_plates)
         plates(normalized_plate)
       JOIN LATERAL (
         SELECT reads.*
         FROM public.vehicle_reid_v2_conversion_read_dispositions dispositions
         JOIN public.vehicle_reid_v2_conversion_read_evidence reads
           ON reads.run_id = dispositions.run_id
          AND reads.read_id = dispositions.read_id
         WHERE dispositions.run_id = projected.run_id
           AND dispositions.projected_profile_id = projected.id
           AND dispositions.disposition = 'assigned'
           AND reads.normalized_effective_plate = plates.normalized_plate
           AND reads.plate_review_status IN ('confirmed','corrected','alias_resolved')
         ORDER BY reads.read_id LIMIT 1
       ) evidence ON TRUE
       WHERE projected.run_id = $1`,
      [dedicatedRunId, materializedProfileId]
    );

    await client.query("SAVEPOINT missing_assignment_check");
    await assert.rejects(
      client.query(
        `UPDATE public.vehicle_reid_v2_conversion_runs
         SET status = 'completed', phase = 'complete',
             completed_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE id = $1`,
        [dedicatedRunId]
      ),
      /assignment materialization does not exactly reproduce/
    );
    await client.query("ROLLBACK TO SAVEPOINT missing_assignment_check");

    const materializedAssignment = await client.query(
      `INSERT INTO public.vehicle_reid_v2_read_assignments (
         read_id, profile_id, assignment_basis, profile_membership_basis,
         profile_revision, profile_member_id, asset_id, derivative_id,
         embedding_id, normalized_effective_plate, plate_review_status,
         plate_review_revision, plate_review_id, applied_alias_id,
         source_kind, source_relationship, source_path_snapshot,
         source_updated_at, source_link_updated_at, evidence_fingerprint,
         origin_conversion_run_id, origin_disposition_fingerprint
       )
       SELECT
         dispositions.read_id, $2, dispositions.assignment_basis,
         dispositions.profile_evidence_basis, 1, $3, dispositions.asset_id,
         dispositions.derivative_id, dispositions.embedding_id,
         dispositions.normalized_effective_plate, reads.review_status,
         reads.review_revision,
         (SELECT reviews.id FROM public.plate_read_reviews reviews
          WHERE reviews.read_id = reads.id
          ORDER BY reviews.created_at DESC, reviews.id DESC LIMIT 1),
         reads.applied_alias_id, links.source_kind, links.relationship,
         links.source_path_snapshot, links.source_updated_at, links.updated_at,
         dispositions.disposition_fingerprint, dispositions.run_id,
         dispositions.disposition_fingerprint
       FROM public.vehicle_reid_v2_conversion_read_dispositions dispositions
       JOIN public.plate_reads reads ON reads.id = dispositions.read_id
       JOIN public.vehicle_image_asset_reads links
         ON links.read_id = dispositions.read_id
        AND links.asset_id = dispositions.asset_id
       WHERE dispositions.run_id = $1 AND dispositions.disposition = 'assigned'
       RETURNING id`,
      [dedicatedRunId, materializedProfileId, materializedMemberId]
    );
    const materializedAssignmentId = Number(materializedAssignment.rows[0].id);

    await client.query(
      `UPDATE public.vehicle_reid_v2_conversion_runs
       SET status = 'completed', phase = 'complete',
           completed_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE id = $1`,
      [dedicatedRunId]
    );

    await client.query("SAVEPOINT sealed_authority_check");
    await assert.rejects(
      client.query(
        "DELETE FROM public.vehicle_reid_v2_read_assignments WHERE id = $1",
        [materializedAssignmentId]
      ),
      /sealed outside running\/materialize/
    );
    await client.query("ROLLBACK TO SAVEPOINT sealed_authority_check");

    await client.query(
      `UPDATE public.vehicle_reid_control
       SET previous_mode = mode, mode = 'v2_primary', revision = revision + 1,
           transition_run_id = $1, transition_actor_user_id = $2,
           transition_actor_username = $3, transition_actor_display_name = $4,
           transition_reason = 'Codex integration cutover simulation',
           transitioned_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE singleton = TRUE`,
      [dedicatedRunId, fixture.actorId, `codex_reid_${suffix}`,
        "Codex ReID v2 integration"]
    );

    await client.query("SAVEPOINT delete_control_check");
    await assert.rejects(
      client.query("DELETE FROM public.vehicle_reid_control WHERE singleton = TRUE"),
      /authority control singleton cannot be deleted/
    );
    await client.query("ROLLBACK TO SAVEPOINT delete_control_check");

    await client.query("SAVEPOINT same_mode_provenance_check");
    await assert.rejects(
      client.query(
        `UPDATE public.vehicle_reid_control
         SET transition_reason = 'Same-mode provenance rewrite must fail',
             updated_at = clock_timestamp()
         WHERE singleton = TRUE`
      ),
      /provenance is immutable without a mode transition/
    );
    await client.query("ROLLBACK TO SAVEPOINT same_mode_provenance_check");

    await client.query("SAVEPOINT direct_authority_exit_check");
    await assert.rejects(
      client.query(
        `UPDATE public.vehicle_reid_control
         SET previous_mode = mode, mode = 'v2_shadow', revision = revision + 1,
             transition_reason = 'Direct authority exit must fail',
             transitioned_at = clock_timestamp() + INTERVAL '1 millisecond',
             updated_at = clock_timestamp()
         WHERE singleton = TRUE`
      ),
      /Invalid ReID authority transition/
    );
    await client.query("ROLLBACK TO SAVEPOINT direct_authority_exit_check");

    await client.query("SAVEPOINT different_run_rollback_check");
    await assert.rejects(
      client.query(
        `UPDATE public.vehicle_reid_control
         SET previous_mode = mode, mode = 'v1_rollback', revision = revision + 1,
             transition_run_id = $1,
             transition_reason = 'Different-run rollback must fail',
             transitioned_at = clock_timestamp() + INTERVAL '1 millisecond',
             updated_at = clock_timestamp()
         WHERE singleton = TRUE`,
        [templateRunId]
      ),
      /must immediately retain the v2_primary conversion run/
    );
    await client.query("ROLLBACK TO SAVEPOINT different_run_rollback_check");

    await client.query(
      `UPDATE public.vehicle_reid_control
       SET previous_mode = mode, mode = 'v1_rollback', revision = revision + 1,
           transition_reason = 'Codex integration rollback simulation',
           transitioned_at = clock_timestamp() + INTERVAL '1 millisecond',
           updated_at = clock_timestamp()
       WHERE singleton = TRUE`
    );
    const control = await client.query(
      "SELECT mode, previous_mode FROM public.vehicle_reid_control WHERE singleton = TRUE"
    );
    assert.deepEqual(control.rows[0], { mode: "v1_rollback", previous_mode: "v2_primary" });
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function drainLiveReads(service, readIds, label) {
  const expected = [...new Set(readIds.map(Number))].sort((left, right) => left - right);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await service.processBatch({ limit: 25 });
    const jobs = await pool.query(
      `SELECT jobs.read_id, jobs.status, jobs.error_code,
              EXISTS (
                SELECT 1
                FROM public.vehicle_reid_v2_current_read_assignments assignments
                WHERE assignments.id = jobs.assignment_id
                  AND assignments.read_id = jobs.read_id
              ) AS has_current_assignment
       FROM public.vehicle_reid_v2_live_jobs jobs
       WHERE jobs.read_id = ANY($1::integer[]) ORDER BY jobs.read_id`,
      [expected]
    );
    if (jobs.rows.length === expected.length
      && jobs.rows.every((row) => (
        row.status === "ready" && row.has_current_assignment === true
      ))) {
      return jobs.rows;
    }
    const terminal = jobs.rows.find((row) => (
      row.status === "conflict" || row.status === "unavailable"
      || (row.status === "failed" && row.error_code)
    ));
    if (terminal) {
      assert.fail(`${label} stopped at ${terminal.status}:${terminal.error_code || "unknown"}`);
    }
  }
  assert.fail(`${label} did not reach ready within the bounded live drain`);
}

async function currentProfilesForReads(readIds) {
  const result = await pool.query(
    `SELECT read_id, canonical_profile_id
     FROM public.vehicle_reid_v2_current_read_assignments
     WHERE read_id = ANY($1::integer[]) ORDER BY read_id`,
    [readIds]
  );
  return new Map(result.rows.map((row) => [
    Number(row.read_id), Number(row.canonical_profile_id),
  ]));
}

async function revisePairReview(reviewId, label) {
  const result = await pool.query(
    `UPDATE public.vehicle_reid_v2_pair_reviews
     SET label = $2, revision = revision + 1,
         actor_user_id = $3, actor_username = $4,
         actor_display_name = $5, updated_at = clock_timestamp()
     WHERE id = $1 RETURNING revision`,
    [reviewId, label, fixture.actorId, `codex_reid_${suffix}`,
      "Codex ReID v2 integration"]
  );
  assert.equal(result.rowCount, 1);
  return Number(result.rows[0].revision);
}

async function testBoundedLiveDiscoveryWindows({ authority, runId, actor }) {
  const anchor = await pool.query(
    `SELECT normalized_plate
     FROM public.vehicle_reid_v2_current_plate_anchors
     ORDER BY normalized_plate LIMIT 1`
  );
  assert.equal(anchor.rowCount, 1);
  const plate = anchor.rows[0].normalized_plate;
  const run = await pool.query(
    `SELECT max_read_id FROM public.vehicle_reid_v2_conversion_runs WHERE id = $1`,
    [runId]
  );
  const seeded = await pool.query(
    `SELECT transition_run_id, forward_cursor_read_id, revisit_cursor_read_id,
            revisit_upper_read_id, last_scanned_at, revision
     FROM public.vehicle_reid_v2_live_discovery_state
     WHERE singleton = TRUE`
  );
  assert.equal(Number(seeded.rows[0].transition_run_id), runId);
  assert.equal(Number(seeded.rows[0].forward_cursor_read_id), Number(run.rows[0].max_read_id));
  assert.equal(Number(seeded.rows[0].revisit_cursor_read_id), Number(run.rows[0].max_read_id));
  assert.equal(Number(seeded.rows[0].revisit_upper_read_id), Number(run.rows[0].max_read_id));
  assert.ok(seeded.rows[0].last_scanned_at);

  // Two concurrent discoverers serialize on the singleton and consume
  // disjoint 250-ID base-table windows.  All 500 exact-plate candidates must
  // be enqueued; there is no result cap inside the raw window.
  const decoys = await pool.query(
    `INSERT INTO public.plate_reads (
       plate_number, camera_name, "timestamp", review_status, review_revision,
       validated
     )
     SELECT $1, 'Codex bounded discovery',
            CURRENT_TIMESTAMP + (series.value || ' milliseconds')::interval,
            'corrected', 1, TRUE
     FROM GENERATE_SERIES(1, 500) series(value)
     RETURNING id`,
    [plate]
  );
  const decoyIds = decoys.rows.map((row) => Number(row.id));
  const repositories = [
    new VehicleReidV2LiveRepository({ pool }),
    new VehicleReidV2LiveRepository({ pool }),
  ];
  const windows = await Promise.all(repositories.map((repository) => (
    repository.discover({ limit: 250 })
  )));
  assert.equal(windows[0].length, 250);
  assert.equal(windows[1].length, 250);
  assert.equal(new Set([...windows[0], ...windows[1]]).size, 500);
  assert.deepEqual(
    [...windows[0], ...windows[1]].sort((left, right) => left - right),
    decoyIds
  );
  const concurrentState = await pool.query(
    `SELECT forward_cursor_read_id, forward_windows_since_revisit, revision
     FROM public.vehicle_reid_v2_live_discovery_state WHERE singleton = TRUE`
  );
  assert.equal(Number(concurrentState.rows[0].forward_cursor_read_id), decoyIds.at(-1));
  assert.equal(Number(concurrentState.rows[0].forward_windows_since_revisit), 2);
  assert.equal(
    Number(concurrentState.rows[0].revision),
    Number(seeded.rows[0].revision) + 2
  );
  await pool.query(`DELETE FROM public.plate_reads WHERE id = ANY($1::integer[])`, [decoyIds]);

  // A forced state-update failure occurs after the candidate upsert.  The
  // surrounding transaction must retain neither the job nor cursor progress.
  const rollbackRead = await createRead({
    plate,
    reviewStatus: "corrected",
    vehicleStatus: "unavailable",
    errorCode: "BOUNDED_DISCOVERY_ROLLBACK",
    queueKind: "historical",
  });
  const beforeRollback = await pool.query(
    `SELECT forward_cursor_read_id, revision
     FROM public.vehicle_reid_v2_live_discovery_state WHERE singleton = TRUE`
  );
  await pool.query(
    `CREATE OR REPLACE FUNCTION public.codex_fail_reid_discovery_state_update()
     RETURNS TRIGGER LANGUAGE plpgsql AS $$
     BEGIN
       RAISE EXCEPTION 'forced discovery-state rollback';
     END;
     $$;
     DROP TRIGGER IF EXISTS codex_fail_reid_discovery_state_update
       ON public.vehicle_reid_v2_live_discovery_state;
     CREATE TRIGGER codex_fail_reid_discovery_state_update
     BEFORE UPDATE ON public.vehicle_reid_v2_live_discovery_state
     FOR EACH ROW EXECUTE FUNCTION public.codex_fail_reid_discovery_state_update();`
  );
  try {
    await assert.rejects(
      repositories[0].discover({ limit: 250 }),
      /forced discovery-state rollback/
    );
  } finally {
    await pool.query(
      `DROP TRIGGER IF EXISTS codex_fail_reid_discovery_state_update
         ON public.vehicle_reid_v2_live_discovery_state;
       DROP FUNCTION IF EXISTS public.codex_fail_reid_discovery_state_update();`
    );
  }
  const afterRollback = await pool.query(
    `SELECT state.forward_cursor_read_id, state.revision,
            EXISTS (
              SELECT 1 FROM public.vehicle_reid_v2_live_jobs jobs
              WHERE jobs.read_id = $1
            ) AS has_job
     FROM public.vehicle_reid_v2_live_discovery_state state
     WHERE state.singleton = TRUE`,
    [Number(rollbackRead.id)]
  );
  assert.deepEqual(afterRollback.rows[0], {
    forward_cursor_read_id: beforeRollback.rows[0].forward_cursor_read_id,
    revision: beforeRollback.rows[0].revision,
    has_job: false,
  });
  await pool.query(`DELETE FROM public.plate_reads WHERE id = $1`, [Number(rollbackRead.id)]);

  // Reserve a lower sequence ID in an uncommitted transaction.  A later ID
  // commits and advances the forward cursor first; the independent revisit
  // window must still find the late lower-ID commit.
  const lateClient = await pool.connect();
  let lateId;
  let highId;
  let newestId;
  try {
    const base = await pool.query(
      `SELECT forward_cursor_read_id
       FROM public.vehicle_reid_v2_live_discovery_state WHERE singleton = TRUE`
    );
    const baseCursor = Number(base.rows[0].forward_cursor_read_id);
    await lateClient.query("BEGIN");
    const late = await lateClient.query(
      `INSERT INTO public.plate_reads (
         plate_number, camera_name, review_status, review_revision, validated
       ) VALUES ($1, 'Codex late lower id', 'corrected', 1, TRUE)
       RETURNING id`,
      [plate]
    );
    lateId = Number(late.rows[0].id);
    const high = await pool.query(
      `INSERT INTO public.plate_reads (
         plate_number, camera_name, review_status, review_revision, validated
       ) VALUES ('LATEHIGH', 'Codex forward priority', 'unreviewed', 0, FALSE)
       RETURNING id`
    );
    highId = Number(high.rows[0].id);
    assert.ok(baseCursor < lateId && lateId < highId);
    assert.deepEqual(await repositories[0].discover({ limit: 250 }), []);
    await pool.query(
      `UPDATE public.vehicle_reid_v2_live_discovery_state
       SET revisit_cursor_read_id = $1, revisit_upper_read_id = $2,
           forward_windows_since_revisit = 8,
           revision = revision + 1, updated_at = CURRENT_TIMESTAMP
       WHERE singleton = TRUE`,
      [baseCursor, highId]
    );
    await lateClient.query("COMMIT");
    const newest = await pool.query(
      `INSERT INTO public.plate_reads (
         plate_number, camera_name, review_status, review_revision, validated
       ) VALUES ('LATENEWER', 'Codex bounded revisit fairness', 'unreviewed', 0, FALSE)
       RETURNING id`
    );
    newestId = Number(newest.rows[0].id);
    assert.ok(highId < newestId);
    assert.deepEqual(await repositories[0].discover({ limit: 250 }), [lateId]);
    const fairState = await pool.query(
      `SELECT forward_cursor_read_id, revisit_cursor_read_id,
              forward_windows_since_revisit
       FROM public.vehicle_reid_v2_live_discovery_state WHERE singleton = TRUE`
    );
    assert.equal(Number(fairState.rows[0].forward_cursor_read_id), highId);
    assert.equal(Number(fairState.rows[0].revisit_cursor_read_id), highId);
    assert.equal(Number(fairState.rows[0].forward_windows_since_revisit), 0);
    assert.deepEqual(await repositories[0].discover({ limit: 250 }), []);
  } catch (error) {
    await lateClient.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    lateClient.release();
  }
  await pool.query(
    `DELETE FROM public.plate_reads WHERE id = ANY($1::integer[])`,
    [[lateId, highId, newestId]]
  );

  const beforeReplay = await pool.query(
    `SELECT forward_cursor_read_id, revisit_cursor_read_id,
            revisit_upper_read_id, forward_windows_since_revisit,
            revision, last_scanned_at
     FROM public.vehicle_reid_v2_live_discovery_state WHERE singleton = TRUE`
  );
  await authority.transitionMode({
    mode: "v1_rollback",
    reason: "Bounded discovery no-rewind check",
    actor,
  });
  await authority.transitionMode({
    mode: "v2_primary",
    runId,
    reason: "Bounded discovery same-run re-entry check",
    actor,
  });
  const afterReplay = await pool.query(
    `SELECT transition_run_id, forward_cursor_read_id, revisit_cursor_read_id,
            revisit_upper_read_id, forward_windows_since_revisit,
            revision, last_scanned_at
     FROM public.vehicle_reid_v2_live_discovery_state WHERE singleton = TRUE`
  );
  assert.equal(Number(afterReplay.rows[0].transition_run_id), runId);
  assert.equal(
    Number(afterReplay.rows[0].forward_cursor_read_id),
    Number(beforeReplay.rows[0].forward_cursor_read_id)
  );
  assert.equal(
    Number(afterReplay.rows[0].revisit_cursor_read_id),
    Number(beforeReplay.rows[0].revisit_cursor_read_id)
  );
  assert.equal(
    Number(afterReplay.rows[0].revisit_upper_read_id),
    Number(beforeReplay.rows[0].revisit_upper_read_id)
  );
  assert.equal(
    Number(afterReplay.rows[0].forward_windows_since_revisit),
    Number(beforeReplay.rows[0].forward_windows_since_revisit)
  );
  assert.ok(Number(afterReplay.rows[0].revision) > Number(beforeReplay.rows[0].revision));
  assert.ok(new Date(afterReplay.rows[0].last_scanned_at) >= new Date(beforeReplay.rows[0].last_scanned_at));
  assert.equal(await repositories[0].isDiscoveryDue(), false);

  // A control rollback after claim must defer the exact token, not turn the
  // read into a terminal exception.  The claim-only attempt is refunded so a
  // same-run primary re-entry can reclaim the read with its full retry budget.
  const claimReleaseRead = await createRead({
    plate: `RC${suffix.slice(0, 8)}`,
    reviewStatus: "corrected",
    vehicleStatus: "unavailable",
    errorCode: "CLAIM_RELEASE_TEST",
    queueKind: "historical",
  });
  const claimReleaseReadId = Number(claimReleaseRead.id);
  await pool.query(
    `INSERT INTO public.vehicle_reid_v2_live_jobs (read_id) VALUES ($1)`,
    [claimReleaseReadId]
  );
  const firstClaim = await repositories[0].claim({ limit: 1 });
  assert.deepEqual(firstClaim.readIds, [claimReleaseReadId]);
  const claimed = await pool.query(
    `SELECT status, attempt_count, claim_token::text AS claim_token
     FROM public.vehicle_reid_v2_live_jobs WHERE read_id = $1`,
    [claimReleaseReadId]
  );
  assert.equal(claimed.rows[0].status, "processing");
  assert.equal(Number(claimed.rows[0].attempt_count), 1);
  assert.equal(claimed.rows[0].claim_token, firstClaim.token);

  await authority.transitionMode({
    mode: "v1_rollback",
    reason: "Bounded live claim release race",
    actor,
  });
  assert.deepEqual(
    await repositories[0].processClaimedRead({
      readId: claimReleaseReadId,
      claimToken: firstClaim.token,
    }),
    { status: "pending", readId: claimReleaseReadId, released: true, attemptCount: 0 }
  );
  const released = await pool.query(
    `SELECT status, attempt_count, retryable, claim_token,
            processing_deadline_at, next_attempt_at, error_code, completed_at
     FROM public.vehicle_reid_v2_live_jobs WHERE read_id = $1`,
    [claimReleaseReadId]
  );
  assert.deepEqual(released.rows[0], {
    status: "pending",
    attempt_count: 0,
    retryable: true,
    claim_token: null,
    processing_deadline_at: null,
    next_attempt_at: null,
    error_code: null,
    completed_at: null,
  });

  await authority.transitionMode({
    mode: "v2_primary",
    runId,
    reason: "Bounded live claim release re-entry",
    actor,
  });
  const secondClaim = await repositories[0].claim({ limit: 1 });
  assert.deepEqual(secondClaim.readIds, [claimReleaseReadId]);
  assert.notEqual(secondClaim.token, firstClaim.token);
  const reclaimed = await pool.query(
    `SELECT status, attempt_count, claim_token::text AS claim_token
     FROM public.vehicle_reid_v2_live_jobs WHERE read_id = $1`,
    [claimReleaseReadId]
  );
  assert.equal(reclaimed.rows[0].status, "processing");
  assert.equal(Number(reclaimed.rows[0].attempt_count), 1);
  assert.equal(reclaimed.rows[0].claim_token, secondClaim.token);
  await pool.query(`DELETE FROM public.plate_reads WHERE id = $1`, [claimReleaseReadId]);
}

async function primarySimilarityState() {
  const result = await pool.query(
    `SELECT
       (SELECT COUNT(*)::integer FROM public.vehicle_reid_v2_profiles) AS profiles,
       (SELECT COUNT(*)::integer FROM public.vehicle_reid_v2_profile_members) AS members,
       (SELECT COUNT(*)::integer FROM public.vehicle_reid_v2_read_assignments) AS assignments,
       (SELECT COUNT(*)::integer FROM public.vehicle_reid_v2_pair_reviews) AS pair_reviews`
  );
  return result.rows[0];
}

async function testPrimaryHistoricalSimilarityReadOnly(fixtures) {
  const historicalSource = fixtures.exactBReplacement;
  assert.ok(historicalSource);
  const before = await primarySimilarityState();
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionOpen = true;
    await client.query("SET LOCAL statement_timeout = '5s'");
    const service = new VehicleReidV2ShadowService({
      repository: new VehicleReidV2ShadowRepository({ executor: client }),
    });
    const overview = await service.getOverview({
      primaryBrowse: true,
      browseMode: true,
      sourceDerivativeId: historicalSource.derivativeId,
      page: 1,
      pageSize: 2,
      resultLimit: 2,
    });
    assert.equal(overview.selected.derivativeId, historicalSource.derivativeId);
    assert.equal(overview.selected.sourceKind, "overview_primary");
    assert.equal(
      overview.selected.imageUrl,
      `/images/${cropPath(historicalSource.derivativeSha)}`
    );
    assert.ok(overview.selected.currentProfileIds.length > 0);
    assert.ok(Date.now() - new Date(overview.selected.timestamp).getTime() > 6 * 24 * 60 * 60 * 1000);
    assert.equal(overview.matches[0]?.derivativeId, fixtures.exactA.derivativeId);
    assert.ok(overview.matches[0]?.similarity > 0.99);
    assert.ok(overview.sources.length <= 2);
    await client.query("ROLLBACK");
    transactionOpen = false;
  } finally {
    if (transactionOpen) await client.query("ROLLBACK");
    client.release();
  }
  assert.deepEqual(await primarySimilarityState(), before);
}

async function testCommittedStage2MaterializationAndRollback(fixtures) {
  const actor = fixtureActor();
  const conversion = await startCommittedPreview();
  const ready = await processCommittedPreview(conversion.runId, { firstLimit: 250 });
  await verifyCommittedPreview(conversion.runId, ready.latestRun.previewFingerprint);

  const authority = newAuthorityService();
  const accepted = await authority.acceptPreview({
    runId: conversion.runId,
    previewFingerprint: ready.latestRun.previewFingerprint,
    actor,
  });
  assert.deepEqual(accepted.operation, {
    accepted: true,
    stale: false,
    runId: conversion.runId,
  });
  const materialized = await authority.materializeAcceptedPreview({
    runId: conversion.runId,
    previewFingerprint: ready.latestRun.previewFingerprint,
    actor,
  });
  assert.equal(materialized.operation.completed, true);
  assert.equal(materialized.operation.stale, undefined);
  assert.equal(materialized.overview.control.mode, "v2_shadow");
  assert.equal(materialized.overview.counts.profiles, materialized.operation.profiles);
  assert.equal(materialized.overview.counts.members, materialized.operation.members);
  assert.equal(materialized.overview.counts.assignments, materialized.operation.assignments);
  assert.equal(materialized.overview.counts.plateAnchors, materialized.operation.plateAnchors);

  const cutover = await authority.transitionMode({
    mode: "v2_primary",
    runId: conversion.runId,
    reason: "Committed Stage 2 integration cutover",
    actor,
  });
  assert.equal(cutover.overview.control.mode, "v2_primary");
  assert.equal(cutover.overview.control.transitionRunId, conversion.runId);

  await testPrimaryHistoricalSimilarityReadOnly(fixtures);

  await testBoundedLiveDiscoveryWindows({
    authority,
    runId: conversion.runId,
    actor,
  });

  const profilePage = await authority.listProfiles({ page: 1, pageSize: 24 });
  assert.ok(profilePage.total > 0);
  assert.ok(profilePage.profiles.length > 0);
  assert.ok(profilePage.profiles.length <= 24);
  assert.ok(profilePage.profiles.every((profile) => profile.memberCount > 0));
  const searchableAnchor = await pool.query(
    `SELECT normalized_plate
     FROM public.vehicle_reid_v2_current_plate_anchors
     ORDER BY normalized_plate LIMIT 1`
  );
  assert.equal(searchableAnchor.rowCount, 1);
  const searchedProfiles = await authority.listProfiles({
    page: 1,
    pageSize: 24,
    search: searchableAnchor.rows[0].normalized_plate,
  });
  assert.ok(searchedProfiles.profiles.length > 0);
  assert.ok(searchedProfiles.profiles.every((profile) => (
    profile.anchorPlates.includes(searchableAnchor.rows[0].normalized_plate)
  )));

  const live = newLiveService();
  const replacementTarget = await pool.query(
    `SELECT assignments.read_id, assignments.asset_id
     FROM public.vehicle_reid_v2_current_read_assignments assignments
     WHERE assignments.origin_conversion_run_id = $1
       AND assignments.assignment_basis IN ('canonical_image','shared_asset','human_same')
     ORDER BY assignments.read_id LIMIT 1`,
    [conversion.runId]
  );
  assert.equal(replacementTarget.rowCount, 1);
  const replacedReadId = Number(replacementTarget.rows[0].read_id);
  await pool.query(
    `UPDATE public.vehicle_image_asset_reads
     SET updated_at = updated_at + INTERVAL '1 second'
     WHERE read_id = $1 AND asset_id = $2`,
    [replacedReadId, Number(replacementTarget.rows[0].asset_id)]
  );
  const staleAfterLinkChange = await pool.query(
    `SELECT COUNT(*)::integer AS count
     FROM public.vehicle_reid_v2_current_read_assignments WHERE read_id = $1`,
    [replacedReadId]
  );
  assert.equal(staleAfterLinkChange.rows[0].count, 0);
  await drainLiveReads(live, [replacedReadId], "source-link replacement");
  const replacementHistory = await pool.query(
    `SELECT
       (SELECT COUNT(*)::integer FROM public.vehicle_reid_v2_read_assignments
        WHERE read_id = $1 AND status = 'active') AS history,
       (SELECT COUNT(*)::integer FROM public.vehicle_reid_v2_current_read_assignments
        WHERE read_id = $1) AS current`,
    [replacedReadId]
  );
  assert.deepEqual(replacementHistory.rows[0], { history: 2, current: 1 });

  const anchorTarget = await pool.query(
    `SELECT anchors.normalized_plate, anchors.evidence_read_id
     FROM public.vehicle_reid_v2_current_plate_anchors anchors
     JOIN public.vehicle_reid_v2_current_read_assignments assignments
       ON assignments.read_id = anchors.evidence_read_id
      AND assignments.canonical_profile_id = anchors.canonical_profile_id
     ORDER BY anchors.id LIMIT 1`
  );
  assert.equal(anchorTarget.rowCount, 1);
  const anchorPlate = anchorTarget.rows[0].normalized_plate;
  const anchorReadId = Number(anchorTarget.rows[0].evidence_read_id);
  await pool.query(
    `UPDATE public.plate_reads
     SET review_revision = review_revision + 1 WHERE id = $1`,
    [anchorReadId]
  );
  await drainLiveReads(live, [anchorReadId], "plate-anchor revision replacement");
  const anchorHistory = await pool.query(
    `SELECT
       (SELECT COUNT(*)::integer
        FROM public.vehicle_reid_v2_profile_plate_anchors
        WHERE normalized_plate = $1 AND status = 'current') AS history,
       (SELECT COUNT(*)::integer
        FROM public.vehicle_reid_v2_current_plate_anchors
        WHERE normalized_plate = $1) AS current`,
    [anchorPlate]
  );
  assert.ok(anchorHistory.rows[0].history >= 2);
  assert.equal(anchorHistory.rows[0].current, 1);

  const historical = await createRead({
    plate: anchorPlate,
    reviewStatus: "corrected",
    vehicleStatus: "unavailable",
    errorCode: "STAGE2_HISTORICAL_NO_OVERVIEW",
    queueKind: "historical",
    timestampOffset: "40 seconds",
  });
  const historicalId = Number(historical.id);
  await drainLiveReads(live, [historicalId], "new exact-plate history");
  let exactAssignment = await pool.query(
    `SELECT assignment_basis
     FROM public.vehicle_reid_v2_current_read_assignments WHERE read_id = $1`,
    [historicalId]
  );
  assert.equal(exactAssignment.rows[0]?.assignment_basis, "exact_effective_plate");
  await pool.query(
    `UPDATE public.plate_reads
     SET review_revision = review_revision + 1 WHERE id = $1`,
    [historicalId]
  );
  await drainLiveReads(live, [historicalId], "exact-plate review replacement");
  exactAssignment = await pool.query(
    `SELECT
       (SELECT COUNT(*)::integer FROM public.vehicle_reid_v2_read_assignments
        WHERE read_id = $1 AND status = 'active') AS history,
       (SELECT COUNT(*)::integer FROM public.vehicle_reid_v2_current_read_assignments
        WHERE read_id = $1) AS current`,
    [historicalId]
  );
  assert.deepEqual(exactAssignment.rows[0], { history: 2, current: 1 });

  const liveA = await createAssetWithCrop("stage2-live-a", "LVA111", {
    reviewStatus: "unreviewed", timestampOffset: "50 seconds",
  });
  const liveB = await createAssetWithCrop("stage2-live-b", "LVB222", {
    reviewStatus: "unreviewed", timestampOffset: "51 seconds",
  });
  const liveC = await createAssetWithCrop("stage2-live-c", "LVC333", {
    reviewStatus: "unreviewed", timestampOffset: "52 seconds",
  });
  const detailTags = [
    { name: `codex-reid-${suffix}-resident`, color: "#2563EB" },
    { name: `codex-reid-${suffix}-review`, color: "#DC2626" },
  ];
  await pool.query(
    `WITH inserted_tags AS (
       INSERT INTO public.tags (name, color)
       SELECT tag.name, tag.color
       FROM JSONB_TO_RECORDSET($2::jsonb) AS tag(name text, color text)
       RETURNING id
     )
     INSERT INTO public.plate_tags (plate_number, tag_id)
     SELECT $1, inserted_tags.id FROM inserted_tags`,
    [liveB.plate, JSON.stringify(detailTags)]
  );
  const liveReadIds = [liveA.readId, liveB.readId, liveC.readId];
  await drainLiveReads(live, liveReadIds, "provisional singleton creation");
  let liveProfiles = await currentProfilesForReads(liveReadIds);
  assert.equal(new Set(liveProfiles.values()).size, 3);

  const firstReviewId = await createPairReview(liveA, liveB, "same_vehicle");
  const firstMerge = await authority.mergeProfilesByReview({ reviewId: firstReviewId, actor });
  assert.equal(firstMerge.merged, true);
  liveProfiles = await currentProfilesForReads(liveReadIds);
  assert.equal(liveProfiles.get(liveA.readId), liveProfiles.get(liveB.readId));

  // The second review deliberately uses the raw source-profile member from the
  // first merge, proving expansion validates pre-merge canonical groups.
  const expansionReviewId = await createPairReview(liveB, liveC, "same_vehicle");
  const expansion = await authority.mergeProfilesByReview({
    reviewId: expansionReviewId, actor,
  });
  assert.equal(expansion.merged, true);
  liveProfiles = await currentProfilesForReads(liveReadIds);
  assert.equal(new Set(liveProfiles.values()).size, 1);
  const mergedProfileId = liveProfiles.get(liveA.readId);
  const mergedPage = await authority.listProfiles({
    page: 1,
    pageSize: 100,
  });
  const mergedListProfile = mergedPage.profiles.find((profile) => (
    profile.id === mergedProfileId
  ));
  assert.ok(mergedListProfile);
  assert.equal(mergedListProfile.memberCount, 3);
  assert.equal(mergedListProfile.readCount, 3);
  assert.equal(mergedPage.profiles.some((profile) => (
    profile.id === firstMerge.sourceProfileId
      || profile.id === expansion.sourceProfileId
  )), false);
  const mergedDetail = await authority.getProfile(firstMerge.sourceProfileId);
  assert.equal(mergedDetail.profile.id, mergedProfileId);
  assert.equal(mergedDetail.profile.status, "active");
  assert.equal(mergedDetail.profile.memberCount, 3);
  assert.equal(mergedDetail.profile.readCount, 3);
  assert.equal(mergedDetail.members.length, 3);
  assert.equal(mergedDetail.reads.length, 3);
  assert.deepEqual(
    new Set(mergedDetail.members.map((member) => member.assetId)),
    new Set([liveA.assetId, liveB.assetId, liveC.assetId])
  );
  assert.deepEqual(
    new Set(mergedDetail.reads.map((read) => read.id)),
    new Set(liveReadIds)
  );
  const taggedRead = mergedDetail.reads.find((read) => read.id === liveB.readId);
  assert.ok(taggedRead);
  assert.deepEqual(
    taggedRead.tags.map((tag) => `${tag.name}:${tag.color}`).sort(),
    detailTags.map((tag) => `${tag.name}:${tag.color}`).sort()
  );

  await revisePairReview(firstReviewId, "different_vehicle");
  const split = await authority.mergeProfilesByReview({ reviewId: firstReviewId, actor });
  assert.equal(split.split, true);
  liveProfiles = await currentProfilesForReads(liveReadIds);
  assert.equal(new Set(liveProfiles.values()).size, 3);

  await revisePairReview(firstReviewId, "same_vehicle");
  const remerge = await authority.mergeProfilesByReview({ reviewId: firstReviewId, actor });
  assert.equal(remerge.merged, true);
  liveProfiles = await currentProfilesForReads(liveReadIds);
  assert.equal(new Set(liveProfiles.values()).size, 1);
  const remergedProfileId = liveProfiles.get(liveA.readId);
  const remergedDetail = await authority.getProfile(firstMerge.sourceProfileId);
  assert.equal(remergedDetail.profile.id, remergedProfileId);
  assert.equal(remergedDetail.profile.memberCount, 3);
  assert.equal(remergedDetail.profile.readCount, 3);
  assert.equal(remergedDetail.members.length, 3);
  assert.deepEqual(
    new Set(remergedDetail.reads.map((read) => read.id)),
    new Set(liveReadIds)
  );
  const mergeHistory = await pool.query(
    `SELECT status, COUNT(*)::integer AS count
     FROM public.vehicle_reid_v2_profile_merges
     WHERE pair_review_id = $1 GROUP BY status ORDER BY status`,
    [firstReviewId]
  );
  assert.deepEqual(mergeHistory.rows, [
    { status: "current", count: 1 },
    { status: "withdrawn", count: 1 },
  ]);

  const rollback = await authority.transitionMode({
    mode: "v1_rollback",
    reason: "Committed Stage 2 integration rollback",
    actor,
  });
  assert.equal(rollback.overview.control.mode, "v1_rollback");
  const standby = await live.processBatch({ limit: 25 });
  assert.equal(standby.mode, "v1_rollback");
  assert.equal(standby.processed, 0);

  const retained = await pool.query(
    `SELECT
       (SELECT COUNT(*)::integer FROM public.vehicle_clusters) AS v1_clusters,
       (SELECT COUNT(*)::integer FROM public.vehicle_cluster_assignments)
         AS v1_assignments,
       (SELECT COUNT(*)::integer FROM public.vehicle_reid_v2_profiles) AS profiles,
       (SELECT COUNT(*)::integer FROM public.vehicle_reid_v2_profile_members) AS members,
       (SELECT COUNT(*)::integer FROM public.vehicle_reid_v2_read_assignments) AS assignments,
       (SELECT COUNT(*)::integer FROM public.vehicle_reid_v2_profile_plate_anchors) AS anchors,
       (SELECT COUNT(*)::integer FROM public.vehicle_reid_v2_live_jobs) AS live_jobs`
  );
  assert.deepEqual({
    v1_clusters: retained.rows[0].v1_clusters,
    v1_assignments: retained.rows[0].v1_assignments,
  }, { v1_clusters: 1, v1_assignments: 3 });
  return {
    profiles: retained.rows[0].profiles,
    members: retained.rows[0].members,
    assignments: retained.rows[0].assignments,
    anchors: retained.rows[0].anchors,
    liveJobs: retained.rows[0].live_jobs,
  };
}

async function assertFinalBoundary(stage2) {
  const state = await pool.query(
    `SELECT
       (SELECT COUNT(*)::integer FROM public.vehicle_reid_v2_conversion_runs) AS conversions,
       (SELECT COUNT(*)::integer FROM public.vehicle_reid_v2_conversion_runs
         WHERE status = 'cancelled') AS cancelled,
       (SELECT COUNT(*)::integer FROM public.vehicle_reid_v2_conversion_runs
         WHERE status = 'stale') AS stale,
       (SELECT COUNT(*)::integer FROM public.vehicle_reid_v2_conversion_runs
         WHERE status = 'ready') AS ready,
       (SELECT COUNT(*)::integer FROM public.vehicle_reid_v2_conversion_runs
         WHERE status = 'failed') AS failed,
       (SELECT COUNT(*)::integer FROM public.vehicle_reid_v2_profiles) AS profiles,
       (SELECT COUNT(*)::integer FROM public.vehicle_reid_v2_profile_members) AS members,
       (SELECT COUNT(*)::integer FROM public.vehicle_reid_v2_read_assignments) AS assignments,
       (SELECT COUNT(*)::integer FROM public.vehicle_reid_v2_profile_plate_anchors) AS anchors,
       (SELECT COUNT(*)::integer FROM public.vehicle_reid_v2_live_jobs) AS live_jobs,
       (SELECT mode FROM public.vehicle_reid_control WHERE singleton = TRUE) AS mode`
  );
  assert.deepEqual(state.rows[0], {
    conversions: 9,
    cancelled: 4,
    stale: 3,
    ready: 0,
    failed: 1,
    profiles: stage2.profiles,
    members: stage2.members,
    assignments: stage2.assignments,
    anchors: stage2.anchors,
    live_jobs: stage2.liveJobs,
    mode: "v1_rollback",
  });
}

let succeeded = false;
try {
  await guard();
  await testAuthorityStartupFence();
  await createActor();
  await testEmptyPreviewFinalizes();
  const fixtures = await createFixtures();
  const previewResult = await runConversionPreview(fixtures);
  await testAuthorityAndRollbackSchema(fixtures, previewResult.latestRunId);
  await testOlderFailedRunCannotBeRevived(previewResult.latestRunId);
  const stage2 = await testCommittedStage2MaterializationAndRollback(fixtures);
  await assertFinalBoundary(stage2);
  succeeded = true;
} finally {
  try {
    if (lockClient) {
      if (lockHeld) {
        await lockClient.query(
          "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
          [LOCK_NAME]
        );
      }
      lockClient.release();
    }
  } finally {
    await pool.end();
  }
}

if (!succeeded) throw new Error("ReID v2 authoritative Stage 1/2 integration test did not complete");
console.log("vehicle_reid_v2_authoritative_stage2_postgres_gate=passed");
