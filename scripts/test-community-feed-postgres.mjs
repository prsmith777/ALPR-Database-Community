import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { withReadOnlySnapshot } from "../lib/read-only-snapshot.mjs";

import pg from "pg";

import { VehicleReidV2AuthorityRepository } from "../lib/vehicle-reid-v2-authority-repository.mjs";
import { VehicleReidV2AuthorityService } from "../lib/vehicle-reid-v2-authority-service.mjs";
import { VehicleReidV2ConversionRepository } from "../lib/vehicle-reid-v2-conversion-repository.mjs";
import { VehicleReidV2ConversionService } from "../lib/vehicle-reid-v2-conversion-service.mjs";
import { VehicleReidV2LiveRepository, VehicleReidV2LiveService } from "../lib/vehicle-reid-v2-live.mjs";
import { VehicleReidV2ShadowRepository } from "../lib/vehicle-reid-v2-shadow-repository.mjs";
import { VehicleReidV2ShadowService } from "../lib/vehicle-reid-v2-shadow.mjs";
import { hydratePlateReadVehicleIdentity, PRIMARY_PLATE_READ_IDENTITY_SQL } from "../lib/plate-read-vehicle-identity.mjs";

const OPT_IN = "COMMUNITY_FEED_POSTGRES_TEST_OPT_IN";
const EXPECTED_DATABASE = "COMMUNITY_FEED_POSTGRES_TEST_DATABASE";
const GUARD_TOKEN = "COMMUNITY_FEED_POSTGRES_TEST_GUARD_TOKEN";
const GUARD_SCOPE = "community-feed:v1";
const LOCK_NAME = "codex_community_feed_v1";

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
if (!/^codex_community_feed_[0-9a-f]{8,32}$/.test(expectedDatabase)) {
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

async function testIdentityLifecycle() {
  const actor = fixtureActor();
  const started = await newConversionService().startPreview({ actor, batchSize: 5 });
  const conversion = { runId: started.operation.runId };
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
  const feedBeforeReplacement = await hydratePlateReadVehicleIdentity(pool, [{ id: replacedReadId }]);
  assert.equal(feedBeforeReplacement[0].vehicle_identity_mode, "v2_primary");
  assert.ok(feedBeforeReplacement[0].vehicle_profile_id);
  assert.equal(feedBeforeReplacement[0].vehicle_cluster_status, "authoritative");
  await assertFeedIdentityEquivalent("initial current assignments");
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
  const staleFeed = await hydratePlateReadVehicleIdentity(pool, [{ id: replacedReadId }]);
  assert.equal(staleFeed[0].vehicle_profile_id, null, "feed must not revive an active but stale assignment");
  assert.equal(staleFeed[0].vehicle_cluster_id, null, "primary feed must not fall back to legacy identity");
  await assertFeedIdentityEquivalent("stale source-link contract");
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
  const replacedFeed = await hydratePlateReadVehicleIdentity(pool, [{ id: replacedReadId }]);
  assert.ok(replacedFeed[0].vehicle_profile_id, "feed selects the exact-current assignment among historical active rows");
  await assertFeedIdentityEquivalent("replacement alongside stale active history");

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
  await assertFeedIdentityEquivalent("replaced reviewed-plate anchor");

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
  const historicalFeed = await hydratePlateReadVehicleIdentity(pool, [{ id: historicalId }]);
  assert.ok(historicalFeed[0].vehicle_profile_id, "exact-plate history keeps its authoritative identity without an overview");
  assert.equal(historicalFeed[0].vehicle_profile_assignment_basis, "exact_effective_plate");
  assert.equal(historicalFeed[0].vehicle_find_similar_available, false);
  await assertFeedIdentityEquivalent("exact-plate history without overview");
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
  await assertFeedIdentityEquivalent("replaced exact-plate review");

  const liveA = await createAssetWithCrop("stage2-live-a", "LVA111", {
    reviewStatus: "unreviewed", timestampOffset: "50 seconds",
  });
  const liveB = await createAssetWithCrop("stage2-live-b", "LVB222", {
    reviewStatus: "unreviewed", timestampOffset: "51 seconds",
  });
  const liveC = await createAssetWithCrop("stage2-live-c", "LVC333", {
    reviewStatus: "unreviewed", timestampOffset: "52 seconds",
  });
  const liveReadIds = [liveA.readId, liveB.readId, liveC.readId];
  await drainLiveReads(live, liveReadIds, "provisional singleton creation");
  let liveProfiles = await currentProfilesForReads(liveReadIds);
  assert.equal(new Set(liveProfiles.values()).size, 3);

  const firstReviewId = await createPairReview(liveA, liveB, "same_vehicle");
  const firstMerge = await authority.mergeProfilesByReview({ reviewId: firstReviewId, actor });
  assert.equal(firstMerge.merged, true);
  liveProfiles = await currentProfilesForReads(liveReadIds);
  assert.equal(liveProfiles.get(liveA.readId), liveProfiles.get(liveB.readId));
  await assertFeedIdentityEquivalent("current Same merge");

  // The second review deliberately uses the raw source-profile member from the
  // first merge, proving expansion validates pre-merge canonical groups.
  const expansionReviewId = await createPairReview(liveB, liveC, "same_vehicle");
  const expansion = await authority.mergeProfilesByReview({
    reviewId: expansionReviewId, actor,
  });
  assert.equal(expansion.merged, true);
  liveProfiles = await currentProfilesForReads(liveReadIds);
  assert.equal(new Set(liveProfiles.values()).size, 1);
  await assertFeedIdentityEquivalent("expanded merge with off-page sources");
  await revisePairReview(firstReviewId, "different_vehicle");
  await assertFeedIdentityEquivalent("merge invalidated by changed pair review before worker reconciliation");
  const split = await authority.mergeProfilesByReview({ reviewId: firstReviewId, actor });
  assert.equal(split.split, true);
  liveProfiles = await currentProfilesForReads(liveReadIds);
  assert.equal(new Set(liveProfiles.values()).size, 3);
  await assertFeedIdentityEquivalent("split after Different review");

  await revisePairReview(firstReviewId, "same_vehicle");
  const remerge = await authority.mergeProfilesByReview({ reviewId: firstReviewId, actor });
  assert.equal(remerge.merged, true);
  await assertFeedIdentityEquivalent("remerged profile");
  liveProfiles = await currentProfilesForReads(liveReadIds);
  assert.equal(new Set(liveProfiles.values()).size, 1);
  console.log("feed_identity_lifecycle=passed");
}

const referenceFeedSql = await readFile(new URL("../test/fixtures/community-primary-identity-reference.sql", import.meta.url), "utf8");

async function assertFeedIdentityEquivalent(label, ids = fixture.readIds) {
  const client = await pool.connect();
  const actual = [];
  const ordered = rows => rows.sort((a, b) => Number(a.read_id) - Number(b.read_id));
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    for (let i = 0; i < ids.length; i += 25) {
      const values = [ids.slice(i, i + 25)];
      const expected = await client.query(referenceFeedSql, values);
      const result = await client.query(PRIMARY_PLATE_READ_IDENTITY_SQL, values);
      assert.deepEqual(ordered(result.rows), ordered(expected.rows), label);
      actual.push(...result.rows);
    }
  } finally { await client.query("ROLLBACK"); client.release(); }
  return actual;
}

// Deliberately reproduce a large profile and unrelated negative review pairs.
// Only the guarded disposable database is used, after the existing lifecycle
// assertions. All inserts retain normal constraints/triggers; no production data.
async function testSetBasedFeedWorkAndOffPageConflicts() {
  const groups = [[], []];
  for (let group = 0; group < 2; group++) {
    for (let i = 0; i < 80; i++) {
      groups[group].push(await createAssetWithCrop(`feed-work-${group}-${i}`, `PFM00${group}`, {
        reviewStatus: "unreviewed",
      }));
    }
    const first = groups[group][0];
    const profile = await pool.query(`INSERT INTO public.vehicle_reid_v2_profiles (
      status, provenance_basis, representative_derivative_id, representative_embedding_id,
      representative_source_sha256, representative_evidence_fingerprint,
      created_by_user_id, created_by_username, created_by_display_name
    ) VALUES ('provisional', 'provisional_singleton', $1, $2, $3, $4, $5, $6, 'Feed query integration') RETURNING id`,
    [first.derivativeId, first.embeddingId, first.derivativeSha, hash(`feed-profile-${group}`), fixture.actorId, `codex_reid_${suffix}`]);
    const profileId = Number(profile.rows[0].id);
    await pool.query(`INSERT INTO public.vehicle_reid_v2_profile_members (
      profile_id, derivative_id, asset_id, derivative_kind, crop_algorithm_version,
      asset_source_sha256, crop_content_sha256, embedding_id, embedding_model,
      embedding_algorithm_version, embedding_source_sha256, embedding_sha256,
      membership_basis, representative_evidence_read_id, source_revision_fingerprint, evidence_fingerprint
    ) SELECT $1, d.id, d.asset_id, d.derivative_kind, d.algorithm_version,
      a.content_sha256, d.content_sha256, e.id, e.model_name, e.algorithm_version,
      e.source_sha256, e.embedding_sha256, 'provisional_singleton', d.evidence_read_id, $3, $3
      FROM public.vehicle_image_derivatives d
      JOIN public.vehicle_image_assets a ON a.id = d.asset_id
      JOIN public.vehicle_asset_embeddings e ON e.derivative_id = d.id
      WHERE d.id = ANY($2::bigint[])`,
    [profileId, groups[group].map(row => row.derivativeId), hash(`feed-members-${group}`)]);
    await pool.query(`INSERT INTO public.vehicle_reid_v2_read_assignments (
      read_id, profile_id, assignment_basis, profile_membership_basis, profile_revision,
      profile_member_id, asset_id, derivative_id, embedding_id,
      normalized_effective_plate, plate_review_status, plate_review_revision,
      source_kind, source_relationship, source_path_snapshot, source_updated_at,
      source_link_updated_at, evidence_fingerprint
    ) SELECT r.id, m.profile_id, 'canonical_image', m.membership_basis, 1,
      m.id, m.asset_id, m.derivative_id, m.embedding_id, r.plate_number, r.review_status, r.review_revision,
      l.source_kind, l.relationship, l.source_path_snapshot, l.source_updated_at, l.updated_at, $2
      FROM public.vehicle_reid_v2_profile_members m
      JOIN public.vehicle_image_asset_reads l ON l.asset_id = m.asset_id
      JOIN public.plate_reads r ON r.id = l.read_id WHERE m.profile_id = $1`,
    [profileId, hash(`feed-assignments-${group}`)]);
  }
  for (let i = 0; i < 60; i++) await createPairReview(groups[0][i], groups[1][i], i % 2 ? "unsure" : "different_vehicle");
  await pool.query("ANALYZE");
  const ids = groups[0].slice(0, 23).map(row => row.readId);
  const baseline = await assertFeedIdentityEquivalent("large profile / unrelated negative reviews", ids);
  assert.equal(baseline.filter(row => row.canonical_profile_id).length, 23);
  const plans = [];
  for (const sql of [referenceFeedSql, PRIMARY_PLATE_READ_IDENTITY_SQL]) {
    const result = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, [ids]);
    plans.push(result.rows[0]["QUERY PLAN"][0]);
  }
  const oldHits = plans[0].Plan["Shared Hit Blocks"];
  const newHits = plans[1].Plan["Shared Hit Blocks"];
  assert.ok(newHits < oldHits / 2, `set-based validation must halve repeated buffer work: ${newHits} vs ${oldHits}`);
  console.log("feed_identity_work_regression=" + JSON.stringify({ oldHits, newHits,
    oldMs: plans[0]["Execution Time"], newMs: plans[1]["Execution Time"] }));

  // Neither member in this conflicting pair is on the visible 23-read page.
  const offPage = await createPairReview(groups[0][65], groups[0][66], "different_vehicle");
  for (const label of ["different_vehicle", "unsure"]) {
    if (label === "unsure") await revisePairReview(offPage, label);
    const invalid = await assertFeedIdentityEquivalent(`off-page ${label} veto`, ids);
    assert.ok(invalid.every(row => row.canonical_profile_id === null));
  }
  await pool.query("UPDATE public.plate_reads SET vehicle_image_updated_at = vehicle_image_updated_at + INTERVAL '1 second' WHERE id = $1",
    [groups[0][65].readId]);
  const staleReview = await assertFeedIdentityEquivalent("stale off-page pair no longer supplies current conflict evidence", ids);
  assert.ok(staleReview.every(row => row.canonical_profile_id));
  await pool.query("UPDATE public.plate_reads SET vehicle_image_updated_at = vehicle_image_updated_at + INTERVAL '1 second' WHERE id = $1",
    [groups[0][0].readId]);
  const staleVisible = await assertFeedIdentityEquivalent("visible stale source fails closed", ids);
  assert.equal(staleVisible.find(row => Number(row.read_id) === ids[0]).canonical_profile_id, null);
}

let appDb;
async function loadApplicationDatabase() {
  // Only the configuration boundary is replaced. Execute the actual application
  // query/pool code against the guarded disposable database; no running app.
  const parsed = new URL(databaseUrl);
  const config = { database: {
    host: parsed.hostname + ":" + (parsed.port || "5432"),
    name: expectedDatabase,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  } };
  const settingsUrl = "data:text/javascript," + encodeURIComponent("export async function getConfig() { return " + JSON.stringify(config) + "; }");
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/settings") return { url: settingsUrl, shortCircuit: true };
    if (specifier.startsWith("@/")) return nextResolve(new URL("../" + specifier.slice(2), import.meta.url).href, context);
    return nextResolve(specifier, context);
  } });
  try { appDb = await import("../lib/db.js"); } finally { hooks.deregister(); }
}

async function testApplicationFeed(mode) {
  const { getPlateReads } = appDb;
  const all = await getPlateReads({ pageSize: 100 });
  const total = Number((await pool.query("SELECT COUNT(*) FROM plate_reads")).rows[0].count);
  assert.equal(all.pagination.total, total);
  assert.equal(all.data.length, Math.min(total, 100));
  assert.ok(all.data.every(row => row.vehicle_identity_mode === mode));
  const fields = ["timestamp", "plate_number", "confidence", "occurrence_count", "tags", "camera_name", "direction"];
  for (const field of fields) {
    for (const direction of ["asc", "desc"]) {
      const sort = { field, direction };
      const complete = await getPlateReads({ pageSize: 100, sort });
      const first = await getPlateReads({ pageSize: 2, sort });
      const second = await getPlateReads({ page: 2, pageSize: 2, sort });
      assert.deepEqual([...first.data, ...second.data].map(row => row.id),
        complete.data.slice(0, 4).map(row => row.id), field + " " + direction + " pagination");
    }
  }
  const target = all.data[0];
  for (const filters of [
    { readId: target.id },
    { readIds: [target.id] },
    { plateNumber: target.plate_number, matchMode: "exact" },
    { cameraNames: ["CODEX STREET LPR"], reviewStatuses: [target.review_status] },
    { tags: ["untagged"], directionLabels: ["__unknown__"] },
    { timestampRange: { from: "2020-01-01T00:00:00Z", to: "2099-01-01T00:00:00Z" } },
    { dateRange: { from: "2020-01-01", to: "2099-01-01" }, hourRange: { from: 0, to: 23 }, timeZone: "UTC" },
  ]) {
    const result = await getPlateReads({ filters, pageSize: 100 });
    assert.ok(result.data.some(row => row.id === target.id), JSON.stringify(filters));
    assert.ok(result.pagination.total > 0);
  }
  const noMatch = await getPlateReads({ filters: { cameraName: "not-a-camera" } });
  assert.equal(noMatch.pagination.total, 0);
  assert.deepEqual(noMatch.data, []);
  const beyond = await getPlateReads({ page: 9999 });
  assert.equal(beyond.pagination.total, total);
  assert.deepEqual(beyond.data, []);
  if (mode === "v2_primary") {
    const identities = await withReadOnlySnapshot(pool, client => hydratePlateReadVehicleIdentity(client, all.data));
    assert.deepEqual(all.data, identities);
  }
  console.log("application_feed_" + mode + "=passed");
}

async function testConcurrentSnapshot(readId) {
  await withReadOnlySnapshot(pool, async client => {
    const before = await client.query("SELECT review_revision FROM plate_reads WHERE id = $1", [readId]);
    await pool.query("UPDATE plate_reads SET review_revision = review_revision + 1 WHERE id = $1", [readId]);
    const during = await client.query("SELECT review_revision FROM plate_reads WHERE id = $1", [readId]);
    assert.deepEqual(during.rows, before.rows, "concurrent changes cannot mix page and identity snapshots");
    await assert.rejects(client.query("UPDATE plate_reads SET review_revision = review_revision WHERE id = $1", [readId]),
      error => error.code === "25006");
    // PostgreSQL aborts this read-only transaction after the intentional refusal;
    // COMMIT safely ends it without writes.
  });
}

try {
  await guard();
  await createActor();
  const first = await createAssetWithCrop("initial-a", "TST1001");
  await createAssetWithCrop("initial-b", "TST1002");
  await addSharedRead(first);
  await loadApplicationDatabase();
  await testApplicationFeed("v2_shadow");
  await testIdentityLifecycle();
  await testApplicationFeed("v2_primary");
  await testSetBasedFeedWorkAndOffPageConflicts();
  await testConcurrentSnapshot(first.readId);
  console.log("community_feed_postgres=passed");
} finally {
  if (appDb) await (await appDb.getPool()).end();
  if (lockClient) {
    if (lockHeld) await lockClient.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [LOCK_NAME]);
    lockClient.release();
  }
  await pool.end();
}
