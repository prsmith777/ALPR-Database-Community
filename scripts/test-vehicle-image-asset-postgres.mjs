import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";

import pg from "pg";

import {
  canonicalVehicleImageAssetPath,
  overviewAssetSourceDetails,
  overviewSourceCameraName,
} from "../lib/vehicle-image-asset-model.mjs";
import { VehicleImageAssetCatalogCampaignRepository } from "../lib/vehicle-image-asset-catalog-campaign-repository.mjs";
import { VehicleImageAssetRepository } from "../lib/vehicle-image-asset-repository.mjs";

const { Pool } = pg;
const CAMPAIGN_GUARD_SCOPE = "vehicle-image-asset-campaign:v1";
const connectionString = String(process.env.DATABASE_URL || "").trim();
if (!connectionString) throw new Error("DATABASE_URL is required");
if (process.env.VEHICLE_IMAGE_ASSET_POSTGRES_TEST_OPT_IN !== "true") {
  throw new Error(
    "VEHICLE_IMAGE_ASSET_POSTGRES_TEST_OPT_IN=true is required for this destructive PostgreSQL smoke test"
  );
}
const expectedDatabase = String(
  process.env.VEHICLE_IMAGE_ASSET_POSTGRES_TEST_DATABASE || ""
).trim();
if (!expectedDatabase) {
  throw new Error("VEHICLE_IMAGE_ASSET_POSTGRES_TEST_DATABASE is required");
}
const guardToken = String(
  process.env.VEHICLE_IMAGE_ASSET_POSTGRES_TEST_GUARD_TOKEN || ""
).trim();
if (!guardToken) {
  throw new Error("VEHICLE_IMAGE_ASSET_POSTGRES_TEST_GUARD_TOKEN is required");
}
const connectionUrl = new URL(connectionString);
const urlDatabase = decodeURIComponent(connectionUrl.pathname.replace(/^\/+/, ""));
if (urlDatabase !== expectedDatabase) {
  throw new Error(
    `Refusing PostgreSQL smoke test: DATABASE_URL names ${urlDatabase}, expected ${expectedDatabase}`
  );
}
if (
  expectedDatabase !== "fixture_test"
  && !/^codex_vehicle_asset_[0-9a-f]{8,32}$/.test(expectedDatabase)
) {
  throw new Error("Refusing PostgreSQL smoke test: database is not an approved disposable test name");
}

const pool = new Pool({
  connectionString,
  max: 6,
  options: "-c lock_timeout=5000 -c statement_timeout=30000",
});
const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
const readIds = [];
const assetHashes = [];
const campaignRunIds = [];
let campaignActorUserId = null;
let databaseGuardPassed = false;

async function assertDisposableDatabaseGuard() {
  const identity = await pool.query(
    `SELECT current_database() AS database_name,
            to_regclass('public.codex_integration_test_guard')::text AS guard_table,
            to_regclass('public.host_maintenance_environment_identity')::text
              AS environment_identity_table`
  );
  assert.equal(identity.rows[0]?.database_name, expectedDatabase);
  assert.equal(identity.rows[0]?.guard_table, "codex_integration_test_guard");
  const sentinel = await pool.query(
    `SELECT COUNT(*)::integer AS count
     FROM public.codex_integration_test_guard
     WHERE scope = $1 AND guard_token = $2`,
    [CAMPAIGN_GUARD_SCOPE, guardToken]
  );
  assert.equal(sentinel.rows[0]?.count, 1);
  if (identity.rows[0]?.environment_identity_table) {
    const liveIdentity = await pool.query(
      "SELECT COUNT(*)::integer AS count FROM public.host_maintenance_environment_identity"
    );
    if (liveIdentity.rows[0]?.count !== 0) {
      throw new Error("Refusing PostgreSQL smoke test: database has an application environment identity");
    }
  }
  const initialState = await pool.query(
    `SELECT
       (SELECT COUNT(*)::integer FROM public.plate_reads) AS plate_reads,
       (SELECT COUNT(*)::integer FROM public.vehicle_image_assets) AS vehicle_image_assets,
       (SELECT COUNT(*)::integer FROM public.vehicle_image_asset_reads) AS vehicle_image_asset_reads,
       (SELECT COUNT(*)::integer FROM public.vehicle_image_asset_catalog_runs) AS campaign_runs`
  );
  assert.deepEqual(initialState.rows[0], {
    plate_reads: 0,
    vehicle_image_assets: 0,
    vehicle_image_asset_reads: 0,
    campaign_runs: 0,
  });
}

function contentHash(label) {
  const hash = crypto.createHash("sha256").update(`${label}:${suffix}`).digest("hex");
  assetHashes.push(hash);
  return hash;
}

function asset(contentSha256) {
  return {
    contentSha256,
    storagePath: canonicalVehicleImageAssetPath(contentSha256),
    mediaType: "image/jpeg",
    byteSize: 2048,
    imageWidth: 1920,
    imageHeight: 1080,
  };
}

async function insertReadyRead({
  plate,
  sourceKind = "overview_primary",
  sourceReadId = null,
  imagePath,
  readTimestamp = "2026-08-14T18:00:00.111222Z",
  imageTimestamp = "2026-08-14T18:00:01.222333Z",
  updatedAt = "2026-08-14T18:00:02.123456Z",
} = {}) {
  const isEntry = sourceKind.startsWith("entry_");
  const sourceCameraName = isEntry ? "Entry Overview" : "Street Overview";
  const result = await pool.query(
    `INSERT INTO public.plate_reads (
       plate_number, camera_name, "timestamp", vehicle_image_status,
       vehicle_image_path, vehicle_image_timestamp, vehicle_image_score,
       vehicle_image_detection_confidence, vehicle_image_detection_box,
       vehicle_image_width, vehicle_image_height, vehicle_image_sampled_count,
       vehicle_image_selection_metadata, vehicle_image_source_kind,
       vehicle_image_source_read_id, vehicle_image_retryable,
       vehicle_image_updated_at
     ) VALUES (
       $1, $2, $3::timestamptz, 'ready', $4, $5::timestamptz, 0.91,
       0.94, '{"left":0.1,"top":0.2,"right":0.8,"bottom":0.9}'::jsonb,
       1920, 1080, 61, $6::jsonb, $7, $8::integer, FALSE,
       $9::timestamptz
     ) RETURNING id`,
    [
      plate,
      `Asset LPR ${suffix}`,
      readTimestamp,
      imagePath,
      imageTimestamp,
      JSON.stringify({ overviewContext: isEntry ? "entry" : "street", sourceCameraName }),
      sourceKind,
      sourceReadId,
      updatedAt,
    ]
  );
  const readId = Number(result.rows[0].id);
  readIds.push(readId);
  return readId;
}

async function registerReadAsset(readId, imageAsset) {
  const repository = new VehicleImageAssetRepository({ pool });
  const read = await repository.getRead(readId);
  assert.ok(read, `read ${readId} must exist`);
  const source = overviewAssetSourceDetails(read.vehicle_image_source_kind);
  assert.ok(source, `read ${readId} must have eligible Overview provenance`);
  return repository.withStorageWriter((writer) => writer.registerAssetForRead({
    readSnapshot: read,
    asset: imageAsset,
    link: {
      sourceKind: read.vehicle_image_source_kind,
      sourceReadId: read.vehicle_image_source_read_id ?? null,
      relationship: source.relationship,
      identityEligible: source.identityEligible,
      overviewContext: source.overviewContext,
      capturedAt: read.vehicle_image_timestamp ?? null,
      readCameraName: read.camera_name ?? null,
      sourceCameraName: overviewSourceCameraName(read),
      sourcePathSnapshot: read.vehicle_image_path,
      sourceUpdatedAt: read.vehicle_image_updated_at ?? null,
      detectionConfidence: read.vehicle_image_detection_confidence ?? null,
      detectionBox: read.vehicle_image_detection_box ?? null,
      selectionMetadata: read.vehicle_image_selection_metadata ?? {},
    },
  }));
}

async function insertCampaignActor() {
  const result = await pool.query(
    `INSERT INTO public.users (username, display_name, password_hash)
     VALUES ($1, $2, $3) RETURNING id`,
    [`codex_asset_${suffix}`, "Codex asset campaign smoke", "integration-test-not-a-password"]
  );
  campaignActorUserId = Number(result.rows[0].id);
  return campaignActorUserId;
}

async function archiveCampaignAudits(resourceIds) {
  if (!resourceIds.length) return;
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
     WHERE resource_type = 'vehicle_image_asset_catalog'
       AND resource_id = ANY($1::text[])
     ON CONFLICT (source_event_id, occurred_at) DO NOTHING`,
    [resourceIds]
  );
  await pool.query(
    `DELETE FROM public.audit_events
     WHERE resource_type = 'vehicle_image_asset_catalog'
       AND resource_id = ANY($1::text[])`,
    [resourceIds]
  );
}

async function cleanupFixtures() {
  const fixtureCameraName = `Asset LPR ${suffix}`;
  const fixturePathPattern = `derived/vehicle-asset-smoke/${suffix}-%`;
  const campaignResourceIds = campaignRunIds.map(String);
  await archiveCampaignAudits(campaignResourceIds);
  if (campaignRunIds.length) {
    await pool.query(
      "DELETE FROM public.vehicle_image_asset_catalog_items WHERE run_id = ANY($1::bigint[])",
      [campaignRunIds]
    );
    await pool.query(
      "DELETE FROM public.vehicle_image_asset_catalog_runs WHERE id = ANY($1::bigint[])",
      [campaignRunIds]
    );
  }
  await pool.query(
    `DELETE FROM public.plate_reads
     WHERE id = ANY($1::integer[]) OR camera_name = $2`,
    [readIds, fixtureCameraName]
  );
  await pool.query(
    `DELETE FROM public.vehicle_image_assets
     WHERE content_sha256::text = ANY($1::text[])`,
    [assetHashes]
  );
  if (campaignActorUserId != null) {
    await pool.query("DELETE FROM public.users WHERE id = $1", [campaignActorUserId]);
  }
  const residue = await pool.query(
    `SELECT
       (SELECT COUNT(*)::integer
        FROM public.plate_reads
        WHERE id = ANY($1::integer[]) OR camera_name = $2) AS read_count,
       (SELECT COUNT(*)::integer
        FROM public.vehicle_image_asset_reads
        WHERE read_id = ANY($1::integer[])
           OR source_read_id = ANY($1::integer[])
           OR source_path_snapshot LIKE $3) AS link_count,
       (SELECT COUNT(*)::integer
        FROM public.vehicle_image_assets
        WHERE content_sha256::text = ANY($4::text[])) AS asset_count,
       (SELECT COUNT(*)::integer
        FROM public.vehicle_image_asset_catalog_runs
        WHERE id = ANY($5::bigint[])) AS campaign_run_count,
       (SELECT COUNT(*)::integer
        FROM public.audit_events
        WHERE resource_type = 'vehicle_image_asset_catalog'
          AND resource_id = ANY($6::text[])) AS campaign_audit_count,
       (SELECT COUNT(*)::integer FROM public.users
        WHERE id = $7::bigint) AS campaign_user_count`,
    [readIds, fixtureCameraName, fixturePathPattern, assetHashes,
      campaignRunIds, campaignResourceIds, campaignActorUserId]
  );
  assert.deepEqual(residue.rows[0], {
    read_count: 0,
    link_count: 0,
    asset_count: 0,
    campaign_run_count: 0,
    campaign_audit_count: 0,
    campaign_user_count: 0,
  });
}

try {
  await assertDisposableDatabaseGuard();
  databaseGuardPassed = true;
  const migrations = await fs.readFile(new URL("../migrations.sql", import.meta.url), "utf8");

  // Match production's full-file migration runner and prove a later replay is
  // harmless while canonical assets and provenance links already exist.
  await pool.query(migrations);

  const microReadId = await insertReadyRead({
    plate: `M${suffix}`.slice(0, 10),
    imagePath: `derived/vehicle-asset-smoke/${suffix}-micro-a.jpg`,
  });
  const microHashA = contentHash("micro-a");
  const firstMicroRegistration = await registerReadAsset(microReadId, asset(microHashA));
  assert.equal(firstMicroRegistration.assetCreated, true);
  assert.equal(firstMicroRegistration.linkCreated, true);

  const microsecondSnapshot = await pool.query(
    `SELECT to_char(reads.vehicle_image_updated_at, 'US') AS read_microseconds,
            to_char(links.source_updated_at, 'US') AS link_microseconds,
            reads.vehicle_image_updated_at = links.source_updated_at AS exact_match
     FROM public.plate_reads reads
     JOIN public.vehicle_image_asset_reads links ON links.read_id = reads.id
     WHERE reads.id = $1`,
    [microReadId]
  );
  assert.deepEqual(microsecondSnapshot.rows[0], {
    read_microseconds: "123456",
    link_microseconds: "123456",
    exact_match: true,
  });

  const duplicateHash = contentHash("concurrent-duplicate");
  const duplicateAsset = asset(duplicateHash);
  const duplicateReadIds = await Promise.all([
    insertReadyRead({
      plate: `D1${suffix}`.slice(0, 10),
      imagePath: `derived/vehicle-asset-smoke/${suffix}-duplicate-1.jpg`,
    }),
    insertReadyRead({
      plate: `D2${suffix}`.slice(0, 10),
      imagePath: `derived/vehicle-asset-smoke/${suffix}-duplicate-2.jpg`,
    }),
  ]);
  const duplicateResults = await Promise.all(
    duplicateReadIds.map((readId) => registerReadAsset(readId, duplicateAsset))
  );
  assert.equal(duplicateResults.filter((result) => result.assetCreated).length, 1);
  assert.ok(duplicateResults.every((result) => result.linkCreated));
  assert.equal(new Set(duplicateResults.map((result) => Number(result.asset.id))).size, 1);
  const duplicateCounts = await pool.query(
    `SELECT COUNT(DISTINCT assets.id)::integer AS asset_count,
            COUNT(links.read_id)::integer AS link_count
     FROM public.vehicle_image_assets assets
     LEFT JOIN public.vehicle_image_asset_reads links ON links.asset_id = assets.id
     WHERE assets.content_sha256 = $1`,
    [duplicateHash]
  );
  assert.deepEqual(duplicateCounts.rows[0], { asset_count: 1, link_count: 2 });

  const sourceReadId = await insertReadyRead({
    plate: `S${suffix}`.slice(0, 10),
    imagePath: `derived/vehicle-asset-smoke/${suffix}-source.jpg`,
  });
  const sharedReadId = await insertReadyRead({
    plate: `T${suffix}`.slice(0, 10),
    sourceKind: "overview_pair_share",
    sourceReadId,
    imagePath: `derived/vehicle-asset-smoke/${suffix}-shared.jpg`,
  });
  const sharedHash = contentHash("shared");
  await registerReadAsset(sharedReadId, asset(sharedHash));

  await pool.query(migrations);
  const migrationLedger = await pool.query(
    `SELECT COUNT(*)::integer AS count
     FROM public.schema_migrations
     WHERE version = '2026081402_vehicle_image_asset_foundation'`
  );
  assert.equal(migrationLedger.rows[0].count, 1);

  await pool.query("DELETE FROM public.plate_reads WHERE id = $1", [sourceReadId]);
  const retainedSharedLink = await pool.query(
    `SELECT links.source_read_id, links.source_kind, links.relationship,
            links.identity_eligible, links.overview_context
     FROM public.vehicle_image_asset_reads links
     WHERE links.read_id = $1`,
    [sharedReadId]
  );
  assert.deepEqual(retainedSharedLink.rows[0], {
    source_read_id: null,
    source_kind: "overview_pair_share",
    relationship: "shared",
    identity_eligible: true,
    overview_context: "street",
  });

  const microHashB = contentHash("micro-b");
  const replacementPath = `derived/vehicle-asset-smoke/${suffix}-micro-b.jpg`;
  await pool.query(
    `UPDATE public.plate_reads
     SET vehicle_image_path = $2,
         vehicle_image_timestamp = '2026-08-14T18:05:01.444555Z'::timestamptz,
         vehicle_image_updated_at = '2026-08-14T18:05:02.654321Z'::timestamptz
     WHERE id = $1`,
    [microReadId, replacementPath]
  );
  const relinked = await registerReadAsset(microReadId, asset(microHashB));
  assert.equal(relinked.assetCreated, true);
  assert.equal(relinked.linkCreated, false);
  assert.equal(relinked.linkUpdated, true);
  const currentProjection = await pool.query(
    `SELECT assets.content_sha256::text AS content_sha256,
            links.source_path_snapshot,
            to_char(links.source_updated_at, 'US') AS link_microseconds,
            COUNT(*) OVER ()::integer AS projection_count
     FROM public.vehicle_image_asset_reads links
     JOIN public.vehicle_image_assets assets ON assets.id = links.asset_id
     WHERE links.read_id = $1`,
    [microReadId]
  );
  assert.deepEqual(currentProjection.rows[0], {
    content_sha256: microHashB,
    source_path_snapshot: replacementPath,
    link_microseconds: "654321",
    projection_count: 1,
  });
  const retainedImmutableAssets = await pool.query(
    `SELECT COUNT(*)::integer AS count
     FROM public.vehicle_image_assets
     WHERE content_sha256 IN ($1, $2)`,
    [microHashA, microHashB]
  );
  assert.equal(retainedImmutableAssets.rows[0].count, 2);

  const campaignActorId = await insertCampaignActor();
  const campaignRepository = new VehicleImageAssetCatalogCampaignRepository(pool);
  const campaignReadId = await insertReadyRead({
    plate: `C${suffix}`.slice(0, 10),
    imagePath: `derived/vehicle-asset-smoke/${suffix}-campaign-lifecycle.jpg`,
  });
  const campaignHash = contentHash("campaign-lifecycle");
  const previewRun = await campaignRepository.createPreview({ actorUserId: campaignActorId });
  campaignRunIds.push(Number(previewRun.id));
  assert.equal(previewRun.status, "previewing");
  assert.equal(Number(previewRun.candidate_reads), 1);
  const previewClaim = await campaignRepository.claimPreviewItem();
  assert.equal(Number(previewClaim.read_id), campaignReadId);
  assert.equal(await campaignRepository.completePreviewItem(previewClaim, {
    contentSha256: campaignHash,
    byteSize: 2_048,
    imageWidth: 1_920,
    imageHeight: 1_080,
    storagePath: canonicalVehicleImageAssetPath(campaignHash),
  }), true);
  const readyRun = await campaignRepository.finalizePreview(previewRun.id);
  assert.equal(readyRun.status, "ready");
  assert.match(readyRun.preview_fingerprint, /^[0-9a-f]{64}$/);
  assert.equal((await campaignRepository.setPaused({
    runId: previewRun.id,
    paused: true,
    actorUserId: campaignActorId,
  })).status, "paused");
  assert.equal((await campaignRepository.setPaused({
    runId: previewRun.id,
    paused: false,
    actorUserId: campaignActorId,
  })).status, "ready");
  const confirmation = await campaignRepository.confirmBatch({
    runId: previewRun.id,
    previewFingerprint: readyRun.preview_fingerprint,
    limit: 1,
    actorUserId: campaignActorId,
  });
  assert.deepEqual(confirmation, { queued: 1, batchSize: 1 });
  const catalogClaim = await campaignRepository.claimCatalogItem();
  assert.equal(Number(catalogClaim.read_id), campaignReadId);
  const campaignRegistration = await registerReadAsset(campaignReadId, asset(campaignHash));
  assert.equal(await campaignRepository.completeCatalogItem(
    catalogClaim,
    campaignRegistration
  ), true);
  const completedRun = await campaignRepository.settleCatalogRun(previewRun.id);
  assert.equal(completedRun.status, "completed");
  assert.equal(completedRun.phase, "completed");

  const emptyRun = await campaignRepository.createPreview({ actorUserId: campaignActorId });
  campaignRunIds.push(Number(emptyRun.id));
  assert.equal(Number(emptyRun.candidate_reads), 0);
  const completedEmptyRun = await campaignRepository.finalizePreview(emptyRun.id);
  assert.equal(completedEmptyRun.status, "completed");
  assert.equal(completedEmptyRun.phase, "completed");

  const retryGoodReadId = await insertReadyRead({
    plate: `R1${suffix}`.slice(0, 10),
    imagePath: `derived/vehicle-asset-smoke/${suffix}-campaign-retry-good.jpg`,
  });
  const frozenSourceReadId = await insertReadyRead({
    plate: `RS${suffix}`.slice(0, 10),
    imagePath: `derived/vehicle-asset-smoke/${suffix}-campaign-source.jpg`,
  });
  await pool.query(
    `UPDATE public.plate_reads
     SET vehicle_image_status = 'unavailable', vehicle_image_path = NULL,
         vehicle_image_updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [frozenSourceReadId]
  );
  const frozenSharedReadId = await insertReadyRead({
    plate: `R2${suffix}`.slice(0, 10),
    sourceKind: "overview_pair_share",
    sourceReadId: frozenSourceReadId,
    imagePath: `derived/vehicle-asset-smoke/${suffix}-campaign-shared.jpg`,
  });
  const retryUnavailableReadId = await insertReadyRead({
    plate: `R3${suffix}`.slice(0, 10),
    imagePath: `derived/vehicle-asset-smoke/${suffix}-campaign-unavailable.jpg`,
  });
  const retryHash = contentHash("campaign-retry-good");
  const retryRun = await campaignRepository.createPreview({ actorUserId: campaignActorId });
  campaignRunIds.push(Number(retryRun.id));
  assert.equal(Number(retryRun.candidate_reads), 3);

  await pool.query("DELETE FROM public.plate_reads WHERE id = $1", [frozenSourceReadId]);
  const frozenProvenance = await pool.query(
    `SELECT items.source_read_id AS frozen_source_read_id,
            reads.vehicle_image_source_read_id AS live_source_read_id
     FROM public.vehicle_image_asset_catalog_items items
     JOIN public.plate_reads reads ON reads.id = items.read_id
     WHERE items.run_id = $1 AND items.read_id = $2`,
    [retryRun.id, frozenSharedReadId]
  );
  assert.deepEqual(frozenProvenance.rows[0], {
    frozen_source_read_id: frozenSourceReadId,
    live_source_read_id: null,
  });

  const retryGoodClaim = await campaignRepository.claimPreviewItem();
  assert.equal(Number(retryGoodClaim.read_id), retryGoodReadId);
  assert.equal(await campaignRepository.completePreviewItem(retryGoodClaim, {
    contentSha256: retryHash,
    byteSize: 2_048,
    imageWidth: 1_920,
    imageHeight: 1_080,
    storagePath: canonicalVehicleImageAssetPath(retryHash),
  }), true);
  const supersededClaim = await campaignRepository.claimPreviewItem();
  assert.equal(Number(supersededClaim.read_id), frozenSharedReadId);
  assert.equal(await campaignRepository.failClaimedItem(supersededClaim, {
    stage: "preview",
    status: "superseded",
    errorCode: "VEHICLE_IMAGE_ASSET_PREVIEW_CHANGED",
    errorDetails: { message: "source provenance changed" },
    retryable: false,
  }), true);
  const unavailableClaim = await campaignRepository.claimPreviewItem();
  assert.equal(Number(unavailableClaim.read_id), retryUnavailableReadId);
  assert.equal(await campaignRepository.failClaimedItem(unavailableClaim, {
    stage: "preview",
    status: "unavailable",
    errorCode: "VEHICLE_IMAGE_ASSET_SOURCE_MISSING",
    errorDetails: { message: "source missing" },
    retryable: false,
  }), true);
  const retryReadyRun = await campaignRepository.finalizePreview(retryRun.id);
  assert.equal(retryReadyRun.status, "ready");
  assert.deepEqual(await campaignRepository.confirmBatch({
    runId: retryRun.id,
    previewFingerprint: retryReadyRun.preview_fingerprint,
    limit: 1,
    actorUserId: campaignActorId,
  }), { queued: 1, batchSize: 1 });
  await assert.rejects(
    campaignRepository.retryItem({
      jobId: unavailableClaim.id,
      actorUserId: campaignActorId,
    }),
    /Wait for active canonical Overview catalog work/
  );
  const retryCatalogClaim = await campaignRepository.claimCatalogItem();
  const retryRegistration = await registerReadAsset(retryGoodReadId, asset(retryHash));
  assert.equal(await campaignRepository.completeCatalogItem(
    retryCatalogClaim,
    retryRegistration
  ), true);
  assert.equal((await campaignRepository.settleCatalogRun(retryRun.id)).status, "completed");

  const manualRetry = await campaignRepository.retryItem({
    jobId: unavailableClaim.id,
    actorUserId: campaignActorId,
  });
  assert.equal(manualRetry.stage, "preview");
  const manualRetryClaim = await campaignRepository.claimPreviewItem();
  assert.equal(Number(manualRetryClaim.id), Number(unavailableClaim.id));
  await assert.rejects(
    campaignRepository.cancel({ runId: retryRun.id, actorUserId: campaignActorId }),
    /current canonical Overview item to finish/
  );
  assert.equal(await campaignRepository.failClaimedItem(manualRetryClaim, {
    stage: "preview",
    status: "unavailable",
    errorCode: "VEHICLE_IMAGE_ASSET_SOURCE_MISSING",
    errorDetails: { message: "source still missing" },
    retryable: false,
  }), true);
  assert.equal((await campaignRepository.cancel({
    runId: retryRun.id,
    actorUserId: campaignActorId,
  })).cancelled, 0);
  await assert.rejects(
    campaignRepository.retryItem({
      jobId: unavailableClaim.id,
      actorUserId: campaignActorId,
    }),
    /cancelled canonical Overview catalog run cannot be reopened/
  );

  await pool.query("DELETE FROM public.plate_reads WHERE id = $1", [frozenSharedReadId]);
  const retainedCampaignEvidence = await pool.query(
    `SELECT COUNT(*)::integer AS count
     FROM public.vehicle_image_asset_catalog_items
     WHERE run_id = $1 AND read_id = $2`,
    [retryRun.id, frozenSharedReadId]
  );
  assert.equal(retainedCampaignEvidence.rows[0].count, 1);

  await pool.query(
    `UPDATE public.plate_reads
     SET vehicle_image_status = 'unavailable', vehicle_image_path = NULL,
         vehicle_image_updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [retryUnavailableReadId]
  );
  const terminalReadId = await insertReadyRead({
    plate: `RT${suffix}`.slice(0, 10),
    imagePath: `derived/vehicle-asset-smoke/${suffix}-campaign-terminal.jpg`,
  });
  const terminalRun = await campaignRepository.createPreview({ actorUserId: campaignActorId });
  campaignRunIds.push(Number(terminalRun.id));
  assert.equal(Number(terminalRun.candidate_reads), 1);
  const terminalClaim = await campaignRepository.claimPreviewItem();
  assert.equal(Number(terminalClaim.read_id), terminalReadId);
  assert.equal(await campaignRepository.failClaimedItem(terminalClaim, {
    stage: "preview",
    status: "invalid",
    errorCode: "VEHICLE_IMAGE_ASSET_INVALID_METADATA",
    errorDetails: { message: "invalid legacy metadata" },
    retryable: false,
  }), true);
  const completedTerminalRun = await campaignRepository.finalizePreview(terminalRun.id);
  assert.equal(completedTerminalRun.status, "completed");
  assert.equal(Number(completedTerminalRun.counts.invalid), 1);

  const campaignAuditState = await pool.query(
    `SELECT COUNT(*)::integer AS count,
            COUNT(*) FILTER (WHERE source <> 'browser')::integer AS invalid_source,
            COUNT(*) FILTER (WHERE outcome <> 'succeeded')::integer AS invalid_outcome
     FROM public.audit_events
     WHERE resource_type = 'vehicle_image_asset_catalog'
       AND resource_id = ANY($1::text[])`,
    [campaignRunIds.map(String)]
  );
  assert.ok(campaignAuditState.rows[0].count >= 10);
  assert.equal(campaignAuditState.rows[0].invalid_source, 0);
  assert.equal(campaignAuditState.rows[0].invalid_outcome, 0);

  await assert.rejects(
    pool.query(
      `UPDATE public.vehicle_image_assets
       SET byte_size = byte_size
       WHERE content_sha256 = $1`,
      [microHashB]
    ),
    /vehicle_image_assets content is immutable/
  );

} finally {
  try {
    if (databaseGuardPassed) await cleanupFixtures();
  } finally {
    await pool.end();
  }
}

console.log("vehicle_image_asset_postgres_gate=passed");
