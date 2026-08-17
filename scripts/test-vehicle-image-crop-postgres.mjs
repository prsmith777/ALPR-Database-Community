import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pg from "pg";
import sharp from "sharp";

import { FileStorage } from "../lib/fileStorage.js";
import { validateAndDeleteCleanupCandidate } from "../lib/storage-cleanup.mjs";
import { VehicleImageCropCampaignService } from "../lib/vehicle-image-crop-campaign.mjs";
import { VehicleImageCropLiveService } from "../lib/vehicle-image-crop-live.mjs";
import { VehicleImageCropLiveRepository } from "../lib/vehicle-image-crop-live-repository.mjs";
import { VehicleImageCropRepository } from "../lib/vehicle-image-crop-repository.mjs";
import { VehicleImageCropService } from "../lib/vehicle-image-crop.mjs";
import { canonicalVehicleImageAssetPath } from "../lib/vehicle-image-asset-model.mjs";
import { VehicleAssetEmbeddingCampaignService } from "../lib/vehicle-asset-embedding-campaign.mjs";
import { VehicleAssetEmbeddingRepository } from "../lib/vehicle-asset-embedding-repository.mjs";
import {
  VEHICLE_ASSET_EMBEDDING_ALGORITHM,
  VEHICLE_ASSET_EMBEDDING_MODEL,
} from "../lib/vehicle-asset-embedding-contract.mjs";
import { VehicleAssetAttributeCampaignService } from "../lib/vehicle-asset-attribute-campaign.mjs";
import {
  VEHICLE_ASSET_ATTRIBUTE_ALGORITHM,
  VEHICLE_ASSET_BODY_TYPE_ATTRIBUTE,
  VEHICLE_ASSET_COLOR_ATTRIBUTE,
} from "../lib/vehicle-asset-attribute-contract.mjs";
import {
  VehicleAssetAttributeRepository,
  vehicleAssetAttributeRepositoryInternals,
} from "../lib/vehicle-asset-attribute-repository.mjs";
import { VehicleReidV2ShadowService } from "../lib/vehicle-reid-v2-shadow.mjs";
import { VehicleReidV2ShadowRepository } from "../lib/vehicle-reid-v2-shadow-repository.mjs";

const OPT_IN = "VEHICLE_IMAGE_CROP_POSTGRES_TEST_OPT_IN";
const EXPECTED_DATABASE = "VEHICLE_IMAGE_CROP_POSTGRES_TEST_DATABASE";
const GUARD_TOKEN = "VEHICLE_IMAGE_CROP_POSTGRES_TEST_GUARD_TOKEN";
const GUARD_SCOPE = "vehicle-image-crop:v1";
const LOCK_NAME = "codex_vehicle_image_crop_postgres_test_v1";

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
  throw new Error(`Refusing crop integration test: DATABASE_URL names ${urlDatabase}`);
}
if (expectedDatabase !== "fixture_test"
    && !/^codex_vehicle_crop_[0-9a-f]{8,32}$/.test(expectedDatabase)) {
  throw new Error("Refusing crop integration test: database is not an approved disposable name");
}

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 5,
  options: "-c timezone=UTC -c lock_timeout=5000 -c statement_timeout=30000",
});
const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
let lockClient = null;
let lockHeld = false;
let tempRoot = null;
let actorId = null;
let readId = null;
let assetId = null;
let runId = null;
let liveReadId = null;
let liveAssetId = null;
let embeddingRunId = null;
let attributeRunId = null;
let pairReviewId = null;
let profileCandidateRunId = null;

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
       (SELECT COUNT(*)::integer FROM public.vehicle_image_asset_reads) AS links,
       (SELECT COUNT(*)::integer FROM public.vehicle_image_derivatives) AS derivatives,
       (SELECT COUNT(*)::integer FROM public.vehicle_image_crop_runs) AS runs,
       (SELECT COUNT(*)::integer FROM public.vehicle_image_crop_jobs) AS jobs,
       (SELECT COUNT(*)::integer FROM public.vehicle_image_crop_live_jobs) AS live_jobs,
       (SELECT COUNT(*)::integer FROM public.vehicle_asset_embeddings) AS embeddings,
       (SELECT COUNT(*)::integer FROM public.vehicle_asset_embedding_runs) AS embedding_runs,
       (SELECT COUNT(*)::integer FROM public.vehicle_asset_embedding_jobs) AS embedding_jobs,
       (SELECT COUNT(*)::integer FROM public.vehicle_asset_attribute_observations)
         AS attribute_observations,
       (SELECT COUNT(*)::integer FROM public.vehicle_asset_attribute_runs) AS attribute_runs,
       (SELECT COUNT(*)::integer FROM public.vehicle_asset_attribute_jobs) AS attribute_jobs,
       (SELECT COUNT(*)::integer FROM public.vehicle_reid_v2_pair_reviews) AS pair_reviews,
       (SELECT COUNT(*)::integer FROM public.vehicle_reid_v2_profile_candidate_runs)
         AS profile_candidate_runs`
  );
  assert.deepEqual(empty.rows[0], {
    reads: 0, assets: 0, links: 0, derivatives: 0, runs: 0, jobs: 0, live_jobs: 0,
    embeddings: 0, embedding_runs: 0, embedding_jobs: 0,
    attribute_observations: 0, attribute_runs: 0, attribute_jobs: 0, pair_reviews: 0,
    profile_candidate_runs: 0,
  });
  const lock = await lockClient.query(
    "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
    [LOCK_NAME]
  );
  assert.equal(lock.rows[0]?.locked, true);
  lockHeld = true;
}

async function createFixture() {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-vehicle-crop-"));
  const storage = new FileStorage({ baseDir: tempRoot });
  await storage.initialize();
  const actor = await pool.query(
    `INSERT INTO public.users (username, display_name, password_hash)
     VALUES ($1, 'Codex vehicle crop smoke', 'integration-test-not-a-password')
     RETURNING id`,
    [`codex_crop_${suffix}`]
  );
  actorId = Number(actor.rows[0].id);
  const image = await sharp({
    create: { width: 320, height: 180, channels: 3, background: "#557799" },
  }).jpeg({ quality: 92 }).toBuffer();
  const sourceHash = crypto.createHash("sha256").update(image).digest("hex");
  const sourcePath = canonicalVehicleImageAssetPath(sourceHash);
  await storage.saveDerivedImageIfAbsent(sourcePath, image);
  const asset = await pool.query(
    `INSERT INTO public.vehicle_image_assets (
       content_sha256, storage_path, media_type, byte_size, image_width, image_height
     ) VALUES ($1, $2, 'image/jpeg', $3, 320, 180) RETURNING id`,
    [sourceHash, sourcePath, image.length]
  );
  assetId = Number(asset.rows[0].id);
  const evidencePath = `derived/codex-crop-evidence-${suffix}.jpg`;
  const read = await pool.query(
    `INSERT INTO public.plate_reads (
       plate_number, camera_name, "timestamp", vehicle_image_status,
       vehicle_image_path, vehicle_image_timestamp, vehicle_image_source_kind,
       vehicle_image_detection_confidence, vehicle_image_detection_box,
       vehicle_image_width, vehicle_image_height, vehicle_image_retryable,
       vehicle_image_updated_at
     ) VALUES (
       'CRP123', 'Street LPR 1', CURRENT_TIMESTAMP, 'ready', $1,
       CURRENT_TIMESTAMP, 'overview_primary', 0.92,
       '{"left":0.2,"top":0.2,"right":0.8,"bottom":0.8}'::jsonb,
       320, 180, FALSE, '2026-08-14T20:00:00.123456Z'::timestamptz
     ) RETURNING id, vehicle_image_updated_at::text AS updated_at`,
    [evidencePath]
  );
  readId = Number(read.rows[0].id);
  await pool.query(
    `INSERT INTO public.vehicle_image_asset_reads (
       asset_id, read_id, source_kind, relationship, identity_eligible,
       overview_context, captured_at, read_camera_name, source_camera_name,
       source_path_snapshot, source_updated_at, detection_confidence,
       detection_box, selection_metadata
     ) VALUES (
       $1, $2, 'overview_primary', 'primary', TRUE, 'street', CURRENT_TIMESTAMP,
       'Street LPR 1', 'Street Overview', $3, $4::timestamptz, 0.92,
       '{"left":0.2,"top":0.2,"right":0.8,"bottom":0.8}'::jsonb, '{}'::jsonb
     )`,
    [assetId, readId, evidencePath, read.rows[0].updated_at]
  );
  return storage;
}

async function runCampaign(storage) {
  const repository = new VehicleImageCropRepository({ pool });
  const cropService = new VehicleImageCropService({ repository, fileStorage: storage });
  const campaign = new VehicleImageCropCampaignService({ repository, cropService });
  const run = await campaign.createPreview({ actorUserId: actorId });
  runId = Number(run.id);
  const preview = await campaign.processBatch({ limit: 5 });
  assert.equal(preview.processed, 1);
  let overview = await campaign.getOverview();
  assert.equal(overview.latestRun.status, "ready");
  assert.equal(Number(overview.counts.previewed), 1);
  const fingerprint = overview.latestRun.preview_fingerprint;
  const confirmation = await campaign.confirmBatch({
    runId,
    previewFingerprint: fingerprint,
    limit: 1,
    actorUserId: actorId,
  });
  assert.equal(confirmation.queued, 1);
  const cataloged = await campaign.processBatch({ limit: 5 });
  assert.equal(cataloged.processed, 1);
  overview = await campaign.getOverview();
  assert.equal(overview.latestRun.status, "completed");
  const derivative = await pool.query(
    `SELECT * FROM public.vehicle_image_derivatives WHERE asset_id = $1`,
    [assetId]
  );
  assert.equal(derivative.rowCount, 1);
  assert.ok(Number(derivative.rows[0].image_width) < 320);
  assert.ok(Number(derivative.rows[0].image_height) < 180);
  const cropPath = await storage.resolveExistingImagePath(derivative.rows[0].storage_path);
  const cropBytes = await fs.readFile(cropPath);
  assert.equal(
    crypto.createHash("sha256").update(cropBytes).digest("hex"),
    derivative.rows[0].content_sha256
  );
  const cropStat = await fs.lstat(cropPath);
  const cleanupResult = await validateAndDeleteCleanupCandidate({
    query: pool.query.bind(pool),
    storagePath: tempRoot,
    item: {
      relative_path: derivative.rows[0].storage_path,
      size_bytes: cropStat.size,
      modified_at: cropStat.mtime,
    },
  });
  assert.equal(cleanupResult.status, "skipped-referenced");
  assert.deepEqual(await fs.readFile(cropPath), cropBytes);
  await assert.rejects(
    pool.query(
      "UPDATE public.vehicle_image_derivatives SET byte_size = byte_size + 1 WHERE id = $1",
      [derivative.rows[0].id]
    ),
    /immutable/
  );
}

async function runAutomaticCrop(storage) {
  const image = await sharp({
    create: { width: 360, height: 200, channels: 3, background: "#775544" },
  }).jpeg({ quality: 91 }).toBuffer();
  const sourceHash = crypto.createHash("sha256").update(image).digest("hex");
  const sourcePath = canonicalVehicleImageAssetPath(sourceHash);
  await storage.saveDerivedImageIfAbsent(sourcePath, image);
  const asset = await pool.query(
    `INSERT INTO public.vehicle_image_assets (
       content_sha256, storage_path, media_type, byte_size, image_width, image_height
     ) VALUES ($1, $2, 'image/jpeg', $3, 360, 200) RETURNING id`,
    [sourceHash, sourcePath, image.length]
  );
  liveAssetId = Number(asset.rows[0].id);
  const evidencePath = `derived/codex-live-crop-evidence-${suffix}.jpg`;
  const read = await pool.query(
    `INSERT INTO public.plate_reads (
       plate_number, camera_name, "timestamp", vehicle_image_status,
       vehicle_image_path, vehicle_image_timestamp, vehicle_image_source_kind,
       vehicle_image_detection_confidence, vehicle_image_detection_box,
       vehicle_image_width, vehicle_image_height, vehicle_image_retryable,
       vehicle_image_updated_at
     ) VALUES (
       'CRP123', 'Entry LPR 1', CURRENT_TIMESTAMP, 'ready', $1,
       CURRENT_TIMESTAMP, 'entry_overview_primary', 0.95,
       '{"left":0.18,"top":0.2,"right":0.82,"bottom":0.82}'::jsonb,
       360, 200, FALSE, '2026-08-15T12:00:00.654321Z'::timestamptz
     ) RETURNING id, vehicle_image_updated_at::text AS updated_at`,
    [evidencePath]
  );
  liveReadId = Number(read.rows[0].id);
  await pool.query(
    `INSERT INTO public.vehicle_image_asset_reads (
       asset_id, read_id, source_kind, relationship, identity_eligible,
       overview_context, captured_at, read_camera_name, source_camera_name,
       source_path_snapshot, source_updated_at, detection_confidence,
       detection_box, selection_metadata
     ) VALUES (
       $1, $2, 'entry_overview_primary', 'primary', TRUE, 'entry', CURRENT_TIMESTAMP,
       'Entry LPR 1', 'Entry Overview', $3, $4::timestamptz, 0.95,
       '{"left":0.18,"top":0.2,"right":0.82,"bottom":0.82}'::jsonb, '{}'::jsonb
     )`,
    [liveAssetId, liveReadId, evidencePath, read.rows[0].updated_at]
  );

  const repository = new VehicleImageCropRepository({ pool });
  const cropService = new VehicleImageCropService({ repository, fileStorage: storage });
  const liveRepository = new VehicleImageCropLiveRepository(pool);
  const liveCrop = new VehicleImageCropLiveService({ repository: liveRepository, cropService });
  const campaign = new VehicleImageCropCampaignService({ repository, cropService, liveCrop });
  await liveCrop.setEnabled({ enabled: true, actorUserId: actorId });
  await assert.rejects(
    campaign.createPreview({ actorUserId: actorId }),
    /Disable automatic vehicle cropping/
  );
  const processed = await liveCrop.processBatch({ limit: 1 });
  assert.equal(processed.discovered, 1);
  assert.equal(processed.processed, 1);
  assert.equal(processed.succeeded, 1);
  const result = await pool.query(
    `SELECT jobs.status, jobs.attempt_count,
            jobs.evidence_source_updated_at::text AS evidence_updated_at,
            derivatives.id AS derivative_id, derivatives.storage_path,
            derivatives.content_sha256
     FROM public.vehicle_image_crop_live_jobs jobs
     JOIN public.vehicle_image_derivatives derivatives
       ON derivatives.id = jobs.derivative_id
     WHERE jobs.asset_id = $1`,
    [liveAssetId]
  );
  assert.equal(result.rowCount, 1);
  assert.equal(result.rows[0].status, "ready");
  assert.match(result.rows[0].evidence_updated_at, /\.654321\+00$/);
  const cropPath = await storage.resolveExistingImagePath(result.rows[0].storage_path);
  const cropBytes = await fs.readFile(cropPath);
  assert.equal(
    crypto.createHash("sha256").update(cropBytes).digest("hex"),
    result.rows[0].content_sha256
  );
  await liveCrop.setEnabled({ enabled: false, actorUserId: actorId });
  assert.equal((await liveCrop.getOverview()).enabled, false);
}

async function runEmbeddingCampaign() {
  const repository = new VehicleAssetEmbeddingRepository({ pool });
  const embeddingBytes = Buffer.alloc(2048);
  for (let index = 0; index < 512; index += 1) {
    embeddingBytes.writeFloatLE((index + 1) / 512, index * 4);
  }
  const embeddingSha256 = crypto.createHash("sha256").update(embeddingBytes).digest("hex");
  const rendered = Object.freeze({
    embedding: embeddingBytes,
    embeddingSha256,
    embeddingDimensions: 512,
    embeddingBytes: 2048,
    modelName: VEHICLE_ASSET_EMBEDDING_MODEL,
    algorithmVersion: VEHICLE_ASSET_EMBEDDING_ALGORITHM,
  });
  const embeddingService = {
    async preview() {
      const { embedding: _embedding, ...preview } = rendered;
      return preview;
    },
    async catalog(job) {
      assert.equal(job.preview_embedding_sha256, embeddingSha256);
      return repository.registerEmbedding(job, rendered);
    },
  };
  const campaign = new VehicleAssetEmbeddingCampaignService({ repository, embeddingService });
  const run = await campaign.createPreview({ actorUserId: actorId });
  embeddingRunId = Number(run.id);
  const preview = await campaign.processBatch({ limit: 5 });
  assert.equal(preview.processed, 2);
  let overview = await campaign.getOverview();
  assert.equal(overview.latestRun.status, "ready");
  assert.equal(Number(overview.counts.previewed), 2);
  assert.match(overview.latestRun.preview_fingerprint, /^[0-9a-f]{64}$/);

  const first = await campaign.confirmBatch({
    runId: embeddingRunId,
    previewFingerprint: overview.latestRun.preview_fingerprint,
    limit: 1,
    actorUserId: actorId,
  });
  assert.equal(first.queued, 1);
  assert.equal((await campaign.processBatch({ limit: 5 })).processed, 1);
  overview = await campaign.getOverview();
  assert.equal(overview.latestRun.status, "ready");
  assert.equal(Number(overview.counts.previewed), 1);

  const second = await campaign.confirmBatch({
    runId: embeddingRunId,
    previewFingerprint: overview.latestRun.preview_fingerprint,
    limit: 5,
    actorUserId: actorId,
  });
  assert.equal(second.queued, 1);
  assert.equal((await campaign.processBatch({ limit: 5 })).processed, 1);
  overview = await campaign.getOverview();
  assert.equal(overview.latestRun.status, "completed");
  assert.equal(Number(overview.catalog.embedding_count), 2);
  assert.equal(Number(overview.catalog.embedding_bytes), 4096);

  const stored = await pool.query(
    `SELECT embeddings.*, jobs.*, runs.model_name, runs.algorithm_version,
            jobs.evidence_source_updated_at::text AS evidence_updated_at
     FROM public.vehicle_asset_embeddings embeddings
     JOIN public.vehicle_asset_embedding_jobs jobs ON jobs.embedding_id = embeddings.id
     JOIN public.vehicle_asset_embedding_runs runs ON runs.id = jobs.run_id
     WHERE jobs.run_id = $1 ORDER BY embeddings.id`,
    [embeddingRunId]
  );
  assert.equal(stored.rowCount, 2);
  assert.equal(Number(stored.rows[0].embedding_dimensions), 512);
  assert.equal(stored.rows[0].embedding.length, 2048);
  assert.match(stored.rows[0].evidence_updated_at, /\.(123456|654321)\+00$/);
  const reused = await repository.registerEmbedding({
    ...stored.rows[0],
    evidence_source_updated_at: stored.rows[0].evidence_updated_at,
  }, rendered);
  assert.equal(reused.embeddingCreated, false);
  await assert.rejects(
    pool.query(
      "UPDATE public.vehicle_asset_embeddings SET source_sha256 = $2 WHERE id = $1",
      [stored.rows[0].embedding_id, "0".repeat(64)]
    ),
    /immutable/
  );
}

async function runReidV2PairReview() {
  const sources = await pool.query(
    `SELECT derivative_id
     FROM public.vehicle_asset_embeddings
     WHERE model_name = $1 AND algorithm_version = $2
     ORDER BY derivative_id`,
    [VEHICLE_ASSET_EMBEDDING_MODEL, VEHICLE_ASSET_EMBEDDING_ALGORITHM]
  );
  assert.equal(sources.rowCount, 2);
  const sourceDerivativeId = Number(sources.rows[0].derivative_id);
  const candidateDerivativeId = Number(sources.rows[1].derivative_id);
  const repository = new VehicleReidV2ShadowRepository({ pool });
  const service = new VehicleReidV2ShadowService({ repository });
  const shadow = await service.getOverview({
    sourceDerivativeId,
    resultLimit: 1,
  });
  assert.equal(shadow.selected.lprEvidence.direct.length, 1);
  assert.equal(shadow.selected.lprEvidence.direct[0].evidenceType, "direct");
  assert.equal(shadow.selected.lprEvidence.direct[0].imageUrl, null);
  assert.equal(shadow.selected.lprEvidence.companions.length, 0);
  assert.equal(shadow.matches.length, 1);
  assert.equal(shadow.matches[0].lprEvidence.direct.length, 1);
  const actor = {
    id: actorId,
    username: `codex_crop_${suffix}`,
    displayName: "Codex vehicle crop smoke",
  };
  const first = await service.recordPairReview({
    sourceDerivativeId,
    candidateDerivativeId,
    label: "same_vehicle",
    actor,
  });
  pairReviewId = Number(first.review.id);
  assert.equal(first.review.label, "same_vehicle");
  assert.equal(first.review.similarity, 1);
  assert.equal(first.calibration.sameVehicle, 1);
  assert.equal(first.calibration.recommendation, null);

  const corrected = await service.recordPairReview({
    sourceDerivativeId: candidateDerivativeId,
    candidateDerivativeId: sourceDerivativeId,
    label: "unsure",
    actor,
  });
  assert.equal(corrected.review.id, pairReviewId);
  assert.equal(corrected.review.label, "unsure");
  assert.equal(corrected.review.revision, 2);
  assert.equal(corrected.calibration.unsure, 1);
  const stored = await pool.query(
    `SELECT reviews.*, COUNT(audit.id)::integer AS audit_count
     FROM public.vehicle_reid_v2_pair_reviews reviews
     LEFT JOIN public.audit_events audit
       ON audit.resource_type = 'vehicle_reid_v2_pair_review'
      AND audit.resource_id = reviews.id::text
     WHERE reviews.id = $1
     GROUP BY reviews.id`,
    [pairReviewId]
  );
  assert.equal(stored.rowCount, 1);
  assert.equal(stored.rows[0].label, "unsure");
  assert.equal(Number(stored.rows[0].revision), 2);
  assert.equal(Number(stored.rows[0].audit_count), 2);
  assert.equal(Number(stored.rows[0].derivative_id_low), Math.min(sourceDerivativeId, candidateDerivativeId));
  assert.equal(Number(stored.rows[0].derivative_id_high), Math.max(sourceDerivativeId, candidateDerivativeId));
}

async function runReidV2ProfileCandidates() {
  const repository = new VehicleReidV2ShadowRepository({ pool });
  const service = new VehicleReidV2ShadowService({ repository });
  const actor = {
    id: actorId,
    username: `codex_crop_${suffix}`,
    displayName: "Codex vehicle crop smoke",
  };
  const reviewedPair = await pool.query(
    `SELECT derivative_id_low, derivative_id_high
     FROM public.vehicle_reid_v2_pair_reviews WHERE id = $1`,
    [pairReviewId]
  );
  const confirmedSame = await service.recordPairReview({
    sourceDerivativeId: Number(reviewedPair.rows[0].derivative_id_low),
    candidateDerivativeId: Number(reviewedPair.rows[0].derivative_id_high),
    label: "same_vehicle",
    actor,
  });
  assert.equal(confirmedSame.review.revision, 3);
  const created = await service.createProfileCandidateSnapshot({ actor });
  profileCandidateRunId = Number(created.id);
  assert.equal(created.reused, false);
  assert.equal(created.totalSources, 2);
  assert.equal(created.candidateProfiles, 1);
  assert.equal(created.candidateMembers, 2);
  assert.equal(created.conflictedComponents, 0);
  assert.equal(created.profiles[0]?.evidenceBasis, "mixed");
  assert.deepEqual(created.profiles[0]?.anchorPlates, ["CRP123"]);

  const reused = await service.createProfileCandidateSnapshot({ actor });
  assert.equal(reused.id, profileCandidateRunId);
  assert.equal(reused.reused, true);
  const stored = await pool.query(
    `SELECT runs.*,
            (SELECT COUNT(*)::integer
             FROM public.vehicle_reid_v2_profile_candidates profiles
             WHERE profiles.run_id = runs.id) AS profiles,
            (SELECT COUNT(*)::integer
             FROM public.vehicle_reid_v2_profile_candidate_members members
             WHERE members.run_id = runs.id) AS members,
            (SELECT COUNT(*)::integer
             FROM public.audit_events audit
             WHERE audit.resource_type = 'vehicle_reid_v2_profile_candidate_run'
               AND audit.resource_id = runs.id::text) AS audit_count
     FROM public.vehicle_reid_v2_profile_candidate_runs runs
     WHERE runs.id = $1`,
    [profileCandidateRunId]
  );
  assert.equal(stored.rowCount, 1);
  assert.equal(Number(stored.rows[0].profiles), 1);
  assert.equal(Number(stored.rows[0].members), 2);
  assert.equal(Number(stored.rows[0].audit_count), 1);
  const suggestionInputs = await repository.getProfileCandidateSuggestionInputs(
    profileCandidateRunId
  );
  assert.equal(suggestionInputs.members.length, 2);
  assert.ok(suggestionInputs.members.every((row) => row.candidate_key));
  assert.deepEqual(suggestionInputs.conflicts, []);
  await assert.rejects(
    pool.query(
      `UPDATE public.vehicle_reid_v2_profile_candidate_runs
       SET total_sources = total_sources + 1 WHERE id = $1`,
      [profileCandidateRunId]
    ),
    /immutable/
  );
}

async function runAttributeCampaign() {
  const repository = new VehicleAssetAttributeRepository({ pool });
  const result = Object.freeze({
    algorithmVersion: VEHICLE_ASSET_ATTRIBUTE_ALGORITHM,
    observations: [
      Object.freeze({
        attributeKey: VEHICLE_ASSET_COLOR_ATTRIBUTE.attributeKey,
        provider: VEHICLE_ASSET_COLOR_ATTRIBUTE.provider,
        modelVersion: VEHICLE_ASSET_COLOR_ATTRIBUTE.modelVersion,
        status: "ready",
        value: "red",
        confidence: 0.88,
        rawResult: { reliability: 0.9, reason: null },
      }),
      Object.freeze({
        attributeKey: VEHICLE_ASSET_BODY_TYPE_ATTRIBUTE.attributeKey,
        provider: VEHICLE_ASSET_BODY_TYPE_ATTRIBUTE.provider,
        modelVersion: VEHICLE_ASSET_BODY_TYPE_ATTRIBUTE.modelVersion,
        status: "ready",
        value: "truck",
        confidence: 0.91,
        rawResult: { scores: { car: 0.04, bus: 0.01, truck: 0.91, van: 0.04 } },
      }),
    ],
  });
  const rendered = Object.freeze({
    result,
    resultSha256: vehicleAssetAttributeRepositoryInternals.sha256(result),
    resultBytes: Buffer.byteLength(
      vehicleAssetAttributeRepositoryInternals.canonicalJson(result)
    ),
    algorithmVersion: VEHICLE_ASSET_ATTRIBUTE_ALGORITHM,
  });
  const attributeService = {
    async preview() { return rendered; },
    async catalog(job) {
      assert.equal(job.preview_result_sha256, rendered.resultSha256);
      assert.equal(
        vehicleAssetAttributeRepositoryInternals.canonicalJson(job.preview_result),
        vehicleAssetAttributeRepositoryInternals.canonicalJson(result)
      );
      return repository.registerObservations(job, rendered);
    },
  };
  const campaign = new VehicleAssetAttributeCampaignService({ repository, attributeService });
  const run = await campaign.createPreview({ actorUserId: actorId });
  attributeRunId = Number(run.id);
  const preview = await campaign.processBatch({ limit: 5 });
  assert.equal(preview.processed, 2);
  let overview = await campaign.getOverview();
  assert.equal(overview.latestRun.status, "ready");
  assert.equal(Number(overview.counts.previewed), 2);
  assert.match(overview.latestRun.preview_fingerprint, /^[0-9a-f]{64}$/);

  const first = await campaign.confirmBatch({
    runId: attributeRunId,
    previewFingerprint: overview.latestRun.preview_fingerprint,
    limit: 1,
    actorUserId: actorId,
  });
  assert.equal(first.queued, 1);
  assert.equal((await campaign.processBatch({ limit: 5 })).processed, 1);
  overview = await campaign.getOverview();
  assert.equal(overview.latestRun.status, "ready");
  assert.equal(Number(overview.counts.previewed), 1);

  const second = await campaign.confirmBatch({
    runId: attributeRunId,
    previewFingerprint: overview.latestRun.preview_fingerprint,
    limit: 5,
    actorUserId: actorId,
  });
  assert.equal(second.queued, 1);
  assert.equal((await campaign.processBatch({ limit: 5 })).processed, 1);
  overview = await campaign.getOverview();
  assert.equal(overview.latestRun.status, "completed");
  assert.equal(Number(overview.catalog.fully_observed_crops), 2);
  assert.equal(Number(overview.catalog.observation_count), 4);
  assert.equal(Number(overview.catalog.color_ready), 2);
  assert.equal(Number(overview.catalog.body_type_ready), 2);

  const stored = await pool.query(
    `SELECT observations.*, observations.id AS observation_id, jobs.*,
            jobs.evidence_source_updated_at::text AS evidence_updated_at
     FROM public.vehicle_asset_attribute_observations observations
     JOIN public.vehicle_asset_attribute_jobs jobs
       ON jobs.derivative_id = observations.derivative_id
     WHERE jobs.run_id = $1
     ORDER BY observations.derivative_id, observations.attribute_key`,
    [attributeRunId]
  );
  assert.equal(stored.rowCount, 4);
  assert.deepEqual(
    [...new Set(stored.rows.map((row) => row.attribute_key))].sort(),
    ["body_type", "color"]
  );
  assert.ok(stored.rows.every((row) => row.status === "ready"));
  assert.ok(stored.rows.every((row) => /\.(123456|654321)\+00$/.test(row.evidence_updated_at)));
  const firstJob = stored.rows[0];
  const reused = await repository.registerObservations({
    ...firstJob,
    evidence_source_updated_at: firstJob.evidence_updated_at,
    algorithm_version: VEHICLE_ASSET_ATTRIBUTE_ALGORITHM,
  }, rendered);
  assert.equal(reused.observationsCreated, 0);
  await assert.rejects(
    pool.query(
      `UPDATE public.vehicle_asset_attribute_observations
       SET source_sha256 = $2 WHERE id = $1`,
      [stored.rows[0].observation_id, "0".repeat(64)]
    ),
    /immutable/
  );
}

async function cleanup() {
  if (actorId != null) {
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
         WHERE resource_type IN ('vehicle_image_crop','vehicle_image_crop_live','vehicle_asset_embedding','vehicle_asset_attribute','vehicle_reid_v2_pair_review','vehicle_reid_v2_profile_candidate_run')
          AND actor_user_id = $1
       ON CONFLICT (source_event_id, occurred_at) DO NOTHING`,
      [actorId]
    );
    await pool.query(
      `DELETE FROM public.audit_events
       WHERE resource_type IN ('vehicle_image_crop','vehicle_image_crop_live','vehicle_asset_embedding','vehicle_asset_attribute','vehicle_reid_v2_pair_review','vehicle_reid_v2_profile_candidate_run')
         AND actor_user_id = $1`,
      [actorId]
    );
  }
  if (attributeRunId != null) {
    await pool.query(
      "DELETE FROM public.vehicle_asset_attribute_jobs WHERE run_id = $1",
      [attributeRunId]
    );
    await pool.query("DELETE FROM public.vehicle_asset_attribute_observations");
    await pool.query(
      "DELETE FROM public.vehicle_asset_attribute_runs WHERE id = $1",
      [attributeRunId]
    );
  }
  if (embeddingRunId != null) {
    if (pairReviewId != null) {
      await pool.query("DELETE FROM public.vehicle_reid_v2_pair_reviews WHERE id = $1", [pairReviewId]);
    }
    await pool.query(
      "DELETE FROM public.vehicle_asset_embedding_jobs WHERE run_id = $1",
      [embeddingRunId]
    );
    await pool.query("DELETE FROM public.vehicle_asset_embeddings");
    await pool.query(
      "DELETE FROM public.vehicle_asset_embedding_runs WHERE id = $1",
      [embeddingRunId]
    );
  }
  if (runId != null) {
    await pool.query("DELETE FROM public.vehicle_image_crop_jobs WHERE run_id = $1", [runId]);
    await pool.query("DELETE FROM public.vehicle_image_crop_runs WHERE id = $1", [runId]);
  }
  if (liveAssetId != null) {
    await pool.query(
      "DELETE FROM public.vehicle_image_crop_live_jobs WHERE asset_id = $1",
      [liveAssetId]
    );
    await pool.query("DELETE FROM public.vehicle_image_derivatives WHERE asset_id = $1", [liveAssetId]);
  }
  if (assetId != null) {
    await pool.query("DELETE FROM public.vehicle_image_derivatives WHERE asset_id = $1", [assetId]);
  }
  if (readId != null) await pool.query("DELETE FROM public.plate_reads WHERE id = $1", [readId]);
  if (liveReadId != null) await pool.query("DELETE FROM public.plate_reads WHERE id = $1", [liveReadId]);
  if (assetId != null) await pool.query("DELETE FROM public.vehicle_image_assets WHERE id = $1", [assetId]);
  if (liveAssetId != null) await pool.query("DELETE FROM public.vehicle_image_assets WHERE id = $1", [liveAssetId]);
  await pool.query(
    `UPDATE public.vehicle_image_crop_live_control
     SET enabled = FALSE, enabled_by_user_id = NULL, enabled_at = NULL,
         disabled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE singleton = TRUE`
  );
  if (actorId != null) await pool.query("DELETE FROM public.users WHERE id = $1", [actorId]);
  const residue = await pool.query(
    `SELECT
       (SELECT COUNT(*)::integer FROM public.plate_reads) AS reads,
       (SELECT COUNT(*)::integer FROM public.vehicle_image_assets) AS assets,
       (SELECT COUNT(*)::integer FROM public.vehicle_image_asset_reads) AS links,
       (SELECT COUNT(*)::integer FROM public.vehicle_image_derivatives) AS derivatives,
       (SELECT COUNT(*)::integer FROM public.vehicle_image_crop_runs) AS runs,
       (SELECT COUNT(*)::integer FROM public.vehicle_image_crop_jobs) AS jobs,
       (SELECT COUNT(*)::integer FROM public.vehicle_image_crop_live_jobs) AS live_jobs,
       (SELECT COUNT(*)::integer FROM public.vehicle_asset_embeddings) AS embeddings,
       (SELECT COUNT(*)::integer FROM public.vehicle_asset_embedding_runs) AS embedding_runs,
       (SELECT COUNT(*)::integer FROM public.vehicle_asset_embedding_jobs) AS embedding_jobs,
       (SELECT COUNT(*)::integer FROM public.vehicle_asset_attribute_observations)
         AS attribute_observations,
       (SELECT COUNT(*)::integer FROM public.vehicle_asset_attribute_runs) AS attribute_runs,
       (SELECT COUNT(*)::integer FROM public.vehicle_asset_attribute_jobs) AS attribute_jobs,
       (SELECT COUNT(*)::integer FROM public.vehicle_reid_v2_pair_reviews) AS pair_reviews,
       (SELECT COUNT(*)::integer FROM public.vehicle_reid_v2_profile_candidate_runs)
         AS profile_candidate_runs,
       (SELECT COUNT(*)::integer FROM public.vehicle_reid_v2_profile_candidates)
         AS profile_candidates,
       (SELECT COUNT(*)::integer FROM public.vehicle_reid_v2_profile_candidate_members)
         AS profile_candidate_members,
       (SELECT COUNT(*)::integer FROM public.vehicle_reid_v2_profile_candidate_conflicts)
         AS profile_candidate_conflicts`
  );
  assert.deepEqual(residue.rows[0], {
    reads: 0, assets: 0, links: 0, derivatives: 0, runs: 0, jobs: 0, live_jobs: 0,
    embeddings: 0, embedding_runs: 0, embedding_jobs: 0,
    attribute_observations: 0, attribute_runs: 0, attribute_jobs: 0, pair_reviews: 0,
    profile_candidate_runs: profileCandidateRunId == null ? 0 : 1,
    profile_candidates: profileCandidateRunId == null ? 0 : 1,
    profile_candidate_members: profileCandidateRunId == null ? 0 : 2,
    profile_candidate_conflicts: 0,
  });
}

let succeeded = false;
try {
  await guard();
  const storage = await createFixture();
  await runCampaign(storage);
  await runAutomaticCrop(storage);
  await runEmbeddingCampaign();
  await runReidV2PairReview();
  await runReidV2ProfileCandidates();
  await runAttributeCampaign();
  succeeded = true;
} finally {
  try {
    await cleanup();
  } finally {
    if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
    if (lockClient) {
      if (lockHeld) await lockClient.query(
        "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
        [LOCK_NAME]
      );
      lockClient.release();
    }
    await pool.end();
  }
}

if (!succeeded) throw new Error("Vehicle crop integration test did not complete");
console.log("vehicle_image_crop_postgres_gate=passed");
