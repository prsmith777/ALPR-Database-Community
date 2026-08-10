import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";

import pg from "pg";

import { BlueIrisVehicleFrameRepository } from "../lib/blue-iris-vehicle-frame-repository.mjs";

const { Pool } = pg;
const connectionString = String(process.env.DATABASE_URL || "").trim();
if (!connectionString) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString, max: 5 });
const migrations = await fs.readFile(new URL("../migrations.sql", import.meta.url), "utf8");
const claimA = "11111111-1111-4111-8111-111111111111";
const claimB = "22222222-2222-4222-8222-222222222222";
const exportKey = crypto.randomBytes(32).toString("hex");
const suffix = crypto.randomUUID().slice(0, 8);
const overviewCamera = `Codex Overview ${suffix}`;
const plateCamera = `Codex LPR ${suffix}`;
let readId = null;
let profileId = null;
let migrationCompatibilityReadId = null;
const clients = [];

try {
  // The production compose runner applies this same file with ON_ERROR_STOP.
  // Running it twice around an active processing row proves additive migration
  // idempotency against the exact production queue state on PostgreSQL 17.
  await pool.query(migrations);
  const migrationCompatibilityRead = await pool.query(
    `INSERT INTO public.plate_reads (
       plate_number, camera_name, "timestamp", bi_trigger_direction_status,
       bi_trigger_direction_label, bi_trigger_direction_profile_version,
       bi_trigger_direction_algorithm, vehicle_image_queue_kind,
       vehicle_image_status, vehicle_image_attempt_count, vehicle_image_retryable
     ) VALUES (
       'MIGTEST', $1, CURRENT_TIMESTAMP - INTERVAL '1 minute',
       'ready', 'Eastbound', 1, 'blue-iris-zone-crossing-v1',
       'overview', 'processing', 1, TRUE
     ) RETURNING id`,
    [plateCamera]
  );
  migrationCompatibilityReadId = Number(migrationCompatibilityRead.rows[0].id);
  await pool.query(migrations);

  const profile = await pool.query(
    `INSERT INTO public.vehicle_overview_pair_profiles (
       source_camera_name, plate_camera_name, direction_label, source_role,
       expected_delta_ms, tolerance_ms, priority, enabled, updated_at
     ) VALUES (
       $1, $2, 'Eastbound', 'primary', 0, 1500, 99, TRUE,
       '2026-08-10T16:00:00.123456Z'::timestamptz
     ) RETURNING id, revision, to_char(updated_at, 'US') AS microseconds`,
    [overviewCamera, plateCamera]
  );
  profileId = Number(profile.rows[0].id);
  assert.equal(profile.rows[0].microseconds, "123456");
  assert.equal(Number(profile.rows[0].revision), 1);

  const read = await pool.query(
    `INSERT INTO public.plate_reads (
       plate_number, camera_name, "timestamp", bi_trigger_direction_status,
       bi_trigger_direction_label, bi_trigger_direction_profile_version,
       bi_trigger_direction_algorithm, vehicle_image_queue_kind, vehicle_image_status,
       vehicle_image_attempt_count, vehicle_image_retryable,
       vehicle_image_claim_token, vehicle_image_heartbeat_at,
       vehicle_image_processing_deadline_at, vehicle_image_hard_deadline_at,
       vehicle_image_updated_at
     ) VALUES (
       'CXTEST', $2, CURRENT_TIMESTAMP - INTERVAL '1 minute',
       'ready', 'Eastbound', 1, 'blue-iris-zone-crossing-v1',
       'overview', 'processing', 1, TRUE,
       $1::uuid, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '3 minutes',
       CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP
     ) RETURNING id, vehicle_image_hard_deadline_at`,
    [claimA, plateCamera]
  );
  readId = Number(read.rows[0].id);
  const common = {
    exportKey,
    readId,
    sourceCameraName: overviewCamera,
    requestedStartAt: new Date(Date.now() - 60_000).toISOString(),
    requestedDurationMs: 8_000,
    hardDeadlineAt: read.rows[0].vehicle_image_hard_deadline_at,
    pairProfileId: profileId,
    profileRevision: 1,
    algorithmRevision: "overview-timeline-export-v2",
  };

  const [clientA, clientB, recoveryClient] = await Promise.all([
    pool.connect(),
    pool.connect(),
    pool.connect(),
  ]);
  clients.push(clientA, clientB, recoveryClient);
  const repositoryA = new BlueIrisVehicleFrameRepository(clientA);
  const repositoryB = new BlueIrisVehicleFrameRepository(clientB);
  const recoveryRepository = new BlueIrisVehicleFrameRepository(recoveryClient);

  // Independent sessions race to create and claim the same stable export.
  const begins = await Promise.all([
    repositoryA.beginTimelineExport({ ...common, claimToken: claimA }),
    repositoryB.beginTimelineExport({ ...common, claimToken: claimA }),
  ]);
  assert.ok(begins.every((row) => row?.export_token));
  assert.equal(new Set(begins.map((row) => row.export_token)).size, 1);
  const exportToken = begins[0].export_token;

  const starts = await Promise.all([
    repositoryA.claimTimelineExportStart(exportToken, claimA, ["@before-a.mp4"]),
    repositoryB.claimTimelineExportStart(exportToken, claimA, ["@before-b.mp4"]),
  ]);
  assert.equal(starts.filter(Boolean).length, 1);
  assert.equal(Number(starts.find(Boolean).automatic_start_count), 1);

  // Transfer the read lease to B. A and B then race for the ledger; only B may own it.
  await pool.query(
    `UPDATE public.plate_reads
     SET vehicle_image_claim_token = $2::uuid,
         vehicle_image_processing_deadline_at = CURRENT_TIMESTAMP + INTERVAL '3 minutes',
         vehicle_image_hard_deadline_at = CURRENT_TIMESTAMP + INTERVAL '5 minutes'
     WHERE id = $1`,
    [readId, claimB]
  );
  const [staleBegin, currentBegin] = await Promise.all([
    repositoryA.beginTimelineExport({ ...common, claimToken: claimA }),
    repositoryB.beginTimelineExport({ ...common, claimToken: claimB }),
  ]);
  assert.equal(staleBegin, null);
  assert.equal(currentBegin.claim_token, claimB);

  const remote = {
    remotePath: "@owned.mp4",
    uri: "@owned.mp4",
    utc: Date.now() - 60_000,
    durationMs: 8_000,
    complete: true,
    progress: 100,
  };
  const [staleRemote, currentRemote] = await Promise.all([
    repositoryA.recordTimelineExportRemote(exportToken, remote, { claimToken: claimA }),
    repositoryB.recordTimelineExportRemote(exportToken, remote, { claimToken: claimB }),
  ]);
  assert.equal(staleRemote, null);
  assert.equal(currentRemote.claim_token, claimB);
  await repositoryB.markTimelineExportDownloaded(exportToken, {
    uri: "@owned.mp4",
    fileSize: 1024,
    width: 2688,
    height: 1520,
    durationMs: 8_000,
  }, { claimToken: claimB });

  const readyInput = [{
    framePath: "derived/integration/overview.jpg",
    frameTimestamp: new Date().toISOString(),
    frameScore: 0.9,
    detectionConfidence: 0.9,
    detectionBox: { left: 0.1, top: 0.1, right: 0.8, bottom: 0.8 },
    imageWidth: 2688,
    imageHeight: 1520,
    sampledCount: 61,
    selectionMetadata: { integration: true },
    sourceKind: "overview_primary",
  }, {
    claimToken: claimB,
    exportToken,
    profileSnapshot: { id: profileId, revision: 1 },
  }];
  const [recovery, ready] = await Promise.all([
    recoveryRepository.recoverIncompleteOverviewReads({ startAt: "2026-08-08T19:08:00.000Z" }),
    repositoryB.markReady(readId, ...readyInput),
  ]);
  assert.equal(recovery.queued, 0);
  assert.equal(Number(ready.id), readId);

  const state = await pool.query(
    `SELECT automatic_start_count, claim_token, profile_revision
     FROM public.blue_iris_timeline_exports WHERE export_key = $1`,
    [exportKey]
  );
  assert.equal(state.rowCount, 1);
  assert.equal(Number(state.rows[0].automatic_start_count), 1);
  assert.equal(state.rows[0].claim_token, claimB);
  assert.equal(Number(state.rows[0].profile_revision), 1);
  console.log("overview_export_postgres_gate=passed");
} finally {
  for (const client of clients) client.release();
  if (migrationCompatibilityReadId !== null) {
    await pool.query("DELETE FROM public.plate_reads WHERE id = $1", [migrationCompatibilityReadId])
      .catch(() => {});
  }
  if (readId !== null) {
    await pool.query("DELETE FROM public.plate_reads WHERE id = $1", [readId]).catch(() => {});
  }
  if (profileId !== null) {
    await pool.query("DELETE FROM public.vehicle_overview_pair_profiles WHERE id = $1", [profileId])
      .catch(() => {});
  }
  await pool.end();
}
