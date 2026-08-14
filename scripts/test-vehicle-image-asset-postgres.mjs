import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";

import pg from "pg";

import {
  canonicalVehicleImageAssetPath,
  overviewAssetSourceDetails,
  overviewSourceCameraName,
} from "../lib/vehicle-image-asset-model.mjs";
import { VehicleImageAssetRepository } from "../lib/vehicle-image-asset-repository.mjs";

const { Pool } = pg;
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

const pool = new Pool({ connectionString, max: 6 });
const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
const readIds = [];
const assetHashes = [];
let databaseGuardPassed = false;

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

async function cleanupFixtures() {
  const fixtureCameraName = `Asset LPR ${suffix}`;
  const fixturePathPattern = `derived/vehicle-asset-smoke/${suffix}-%`;
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
        WHERE content_sha256::text = ANY($4::text[])) AS asset_count`,
    [readIds, fixtureCameraName, fixturePathPattern, assetHashes]
  );
  assert.deepEqual(residue.rows[0], {
    read_count: 0,
    link_count: 0,
    asset_count: 0,
  });
}

try {
  const database = await pool.query("SELECT current_database() AS database_name");
  const actualDatabase = String(database.rows[0]?.database_name || "");
  if (actualDatabase !== expectedDatabase) {
    throw new Error(
      `Refusing PostgreSQL smoke test: expected database ${expectedDatabase}, got ${actualDatabase}`
    );
  }
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
