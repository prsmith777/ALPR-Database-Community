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
const plateSuffix = suffix.slice(0, 6);
const overviewCamera = `Codex Overview ${suffix}`;
const plateCamera = `Codex LPR ${suffix}`;
let readId = null;
let profileId = null;
let migrationCompatibilityReadId = null;
let migrationCompatibilityProfileId = null;
let caseProfileId = null;
const historyReadIds = [];
const historyRunIds = [];
const historyProfileIds = [];
const historyCandidateIds = [];
const clients = [];

function connectedSession(client) {
  return {
    query: (...args) => client.query(...args),
  };
}

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
       vehicle_image_status, vehicle_image_attempt_count, vehicle_image_retryable,
       vehicle_image_source_kind
     ) VALUES (
       'MIGTEST', $1, CURRENT_TIMESTAMP - INTERVAL '1 minute',
       'ready', 'Eastbound', 1, 'blue-iris-zone-crossing-v1',
       'overview', 'processing', 1, TRUE, 'entry_overview_primary'
     ) RETURNING id`,
    [plateCamera]
  );
  migrationCompatibilityReadId = Number(migrationCompatibilityRead.rows[0].id);
  const migrationCompatibilityProfile = await pool.query(
    `INSERT INTO public.vehicle_overview_pair_profiles (
       source_camera_name, source_camera_short_name, plate_camera_name,
       direction_label, source_role, overview_context, expected_delta_ms,
       tolerance_ms, priority, enabled
     ) VALUES ($1, 'Cam143', $2, 'Entering', 'primary', 'entry', 0, 1500, 90, TRUE)
     RETURNING id`,
    [`Migration Entry Overview ${suffix}`, `Migration Entry LPR ${suffix}`]
  );
  migrationCompatibilityProfileId = Number(migrationCompatibilityProfile.rows[0].id);
  await pool.query(migrations);

  // A legacy case-variant duplicate must stop the migration with a clear,
  // non-destructive diagnostic rather than choosing a profile silently.
  const duplicateClient = await pool.connect();
  clients.push(duplicateClient);
  await duplicateClient.query("BEGIN");
  try {
    await duplicateClient.query("DROP INDEX public.idx_vehicle_overview_primary_profile_identity");
    await duplicateClient.query(
      `INSERT INTO public.vehicle_overview_pair_profiles (
         source_camera_name, plate_camera_name, direction_label, source_role,
         overview_context, expected_delta_ms, tolerance_ms, priority, enabled
       ) VALUES
         ($1, $2, $3, 'primary', 'street', 0, 1500, 91, TRUE),
         (LOWER($1), LOWER($2), LOWER($3), 'primary', 'street', 0, 1500, 92, TRUE)`,
      [`Duplicate Overview ${suffix}`, `Duplicate LPR ${suffix}`, `Duplicate Direction ${suffix}`]
    );
    await assert.rejects(
      duplicateClient.query(migrations),
      /Duplicate enabled primary overview profiles/
    );
  } finally {
    await duplicateClient.query("ROLLBACK").catch(() => {});
  }

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
  const repositoryA = new BlueIrisVehicleFrameRepository(connectedSession(clientA));
  const repositoryB = new BlueIrisVehicleFrameRepository(connectedSession(clientB));
  const recoveryRepository = new BlueIrisVehicleFrameRepository(connectedSession(recoveryClient));

  // Two independent sessions saving case variants serialize on the normalized
  // advisory key and converge on one database-enforced primary identity.
  const profileInput = {
    sourceCameraName: `Canonical Overview ${suffix}`,
    plateCameraName: `Canonical LPR ${suffix}`,
    directionLabel: `Canonical Direction ${suffix}`,
    sourceRole: "primary",
    overviewContext: "street",
    expectedDeltaMs: 0,
    toleranceMs: 1500,
    priority: 93,
    enabled: true,
  };
  const canonicalProfiles = await Promise.all([
    repositoryA.saveOverviewPairProfile(profileInput),
    repositoryB.saveOverviewPairProfile({
      ...profileInput,
      sourceCameraName: profileInput.sourceCameraName.toLowerCase(),
      plateCameraName: profileInput.plateCameraName.toLowerCase(),
      directionLabel: profileInput.directionLabel.toLowerCase(),
    }),
  ]);
  assert.equal(new Set(canonicalProfiles.map((row) => Number(row.id))).size, 1);
  caseProfileId = Number(canonicalProfiles[0].id);
  const canonicalCount = await pool.query(
    `SELECT COUNT(*)::integer AS count
     FROM public.vehicle_overview_pair_profiles
     WHERE enabled = TRUE AND source_role = 'primary'
       AND LOWER(BTRIM(plate_camera_name)) = LOWER(BTRIM($1))
       AND LOWER(BTRIM(direction_label)) = LOWER(BTRIM($2))`,
    [profileInput.plateCameraName, profileInput.directionLabel]
  );
  assert.equal(Number(canonicalCount.rows[0].count), 1);

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

  // Direction-independent Entry history profiles are immutable snapshots. A
  // no-op keeps its revision; a timing change creates a new enabled revision.
  const historyV1 = await repositoryA.saveEntryOverviewHistoryProfile({
    plateCameraName: "Entry LPR 1",
    expectedDeltaMs: 0,
    algorithmRevision: "entry-overview-history-pg-v1",
  });
  historyProfileIds.push(Number(historyV1.id));
  const historyNoOp = await repositoryA.saveEntryOverviewHistoryProfile({
    plateCameraName: "entry lpr 1",
    expectedDeltaMs: 0,
    algorithmRevision: "entry-overview-history-pg-v1",
  });
  assert.equal(Number(historyNoOp.id), Number(historyV1.id));
  const historyProfile = await repositoryA.saveEntryOverviewHistoryProfile({
    plateCameraName: "Entry LPR 1",
    expectedDeltaMs: 500,
    algorithmRevision: "entry-overview-history-pg-v1",
  });
  historyProfileIds.push(Number(historyProfile.id));
  assert.equal(Number(historyProfile.revision), Number(historyV1.revision) + 1);
  await assert.rejects(
    pool.query(
      `UPDATE public.vehicle_entry_overview_history_profiles
       SET expected_delta_ms = expected_delta_ms + 1 WHERE id = $1`,
      [historyProfile.id],
    ),
    /snapshots are immutable/,
  );
  await assert.rejects(
    pool.query(
      `UPDATE public.vehicle_entry_overview_history_profiles
       SET enabled = TRUE, disabled_at = NULL WHERE id = $1`,
      [historyV1.id],
    ),
    /cannot be revived/,
  );

  const historyBase = new Date(Date.now() - 20 * 60_000);
  const historyCandidate = await pool.query(
    `INSERT INTO public.vehicle_overview_candidates (
       event_identity, source_camera_name, event_timestamp,
       daylight_status, status, retryable
     ) VALUES ($1, 'Legacy Overview', $2::timestamptz, 'daytime', 'associated', FALSE)
     RETURNING id`,
    [crypto.randomBytes(32).toString("hex"), historyBase.toISOString()],
  );
  const historyCandidateId = Number(historyCandidate.rows[0].id);
  historyCandidateIds.push(historyCandidateId);
  const insertHistoryRead = async ({
    plate,
    offsetMs,
    path = null,
    status = null,
    queueKind = null,
    sourceKind = null,
    overviewCandidateId = null,
    sourceReadId = null,
  }) => {
    const inserted = await pool.query(
      `INSERT INTO public.plate_reads (
         plate_number, camera_name, "timestamp", vehicle_image_path,
         vehicle_image_status, vehicle_image_queue_kind,
         vehicle_image_attempt_count, vehicle_image_retryable,
         vehicle_image_source_kind, vehicle_overview_candidate_id,
         vehicle_image_source_read_id, vehicle_image_selection_metadata
       ) VALUES (
         $1, 'Entry LPR 1', $2::timestamptz, $3, $4, $5, 0, TRUE,
         $6, $7::bigint, $8::integer, $9::jsonb
       )
       RETURNING id`,
      [plate, new Date(historyBase.getTime() + offsetMs).toISOString(), path,
        status, queueKind, sourceKind, overviewCandidateId, sourceReadId,
        JSON.stringify(path ? { prior: plate } : {})],
    );
    const id = Number(inserted.rows[0].id);
    historyReadIds.push(id);
    return id;
  };
  const legacyHistoryReadId = await insertHistoryRead({
    plate: `HLEG${plateSuffix}`,
    offsetMs: 0,
    path: `images/history-${suffix}-legacy.jpg`,
    status: "ready",
    queueKind: "historical",
    sourceKind: "legacy_plate_camera",
    overviewCandidateId: historyCandidateId,
    sourceReadId: readId,
  });
  const missingHistoryReadId = await insertHistoryRead({
    plate: `HMIS${plateSuffix}`,
    offsetMs: 1_000,
  });
  const protectedHistoryReadId = await insertHistoryRead({
    plate: `HPRO${plateSuffix}`,
    offsetMs: 2_000,
    path: `derived/history-${suffix}-protected.jpg`,
    status: "failed",
    sourceKind: "entry_overview_primary",
  });
  const nightHistoryReadId = await insertHistoryRead({
    plate: `HNIT${plateSuffix}`,
    offsetMs: 3_000,
  });
  const exhaustedLiveRead = await pool.query(
    `INSERT INTO public.plate_reads (
       plate_number, camera_name, "timestamp", vehicle_image_status,
       vehicle_image_queue_kind, vehicle_image_attempt_count, vehicle_image_retryable
     ) VALUES ($1, $2, $3::timestamptz, 'failed', 'live', 3, TRUE)
     RETURNING id`,
    [`XLIV${plateSuffix}`, `Exhausted Live ${suffix}`,
      new Date(historyBase.getTime() + 4_000).toISOString()],
  );
  historyReadIds.push(Number(exhaustedLiveRead.rows[0].id));
  for (const id of [legacyHistoryReadId, protectedHistoryReadId]) {
    await pool.query(
      `INSERT INTO public.vehicle_attribute_observations (
         read_id, attribute_key, status, attribute_value, confidence,
         provider, model_version, raw_result
       ) VALUES ($1, 'color', 'ready', 'red', 0.9,
                 'local-hsv-histogram', 'vehicle-color-hsv-v2', '{"reason":null}'::jsonb)`,
      [id],
    );
  }
  await pool.query(
    `INSERT INTO public.vehicle_attribute_observations (
       read_id, attribute_key, status, attribute_value, confidence,
       provider, model_version, raw_result
     ) VALUES ($1, 'color', 'unknown', NULL, NULL,
               'local-hsv-histogram', 'vehicle-color-hsv-v2',
               '{"reason":"monochrome_capture"}'::jsonb)`,
    [nightHistoryReadId],
  );

  const historyScope = {
    startAt: new Date(historyBase.getTime() - 1_000).toISOString(),
    endAt: new Date(historyBase.getTime() + 10_000).toISOString(),
    plateCameraNames: ["Entry LPR 1"],
    batchSize: 10,
    algorithmRevision: "entry-overview-history-pg-v1",
  };
  const preview = await repositoryA.previewEntryOverviewBackfillRun(historyScope);
  historyRunIds.push(Number(preview.id));
  assert.equal(preview.counts.total, 4);
  assert.equal(preview.counts.eligible, 1);
  assert.equal(preview.counts.needs_preflight, 1);
  assert.equal(preview.counts.preserved, 1);
  assert.equal(preview.counts.nighttime, 1);
  assert.equal(preview.counts.upgrade_candidates, 1);
  assert.equal(preview.counts.missing_candidates, 1);
  const concurrentConfirmations = await Promise.allSettled([
    repositoryA.confirmEntryOverviewBackfillRun({
      runId: preview.id,
      previewFingerprint: preview.preview_fingerprint,
      limit: 10,
    }),
    repositoryB.confirmEntryOverviewBackfillRun({
      runId: preview.id,
      previewFingerprint: preview.preview_fingerprint,
      limit: 10,
    }),
  ]);
  const confirmationWinners = concurrentConfirmations.filter(({ status }) => status === "fulfilled");
  const confirmationLosers = concurrentConfirmations.filter(({ status }) => status === "rejected");
  assert.equal(confirmationWinners.length, 1);
  assert.equal(confirmationLosers.length, 1);
  assert.match(String(confirmationLosers[0].reason?.message || ""), /already has an active batch/);
  const confirmed = confirmationWinners[0].value;
  assert.equal(confirmed.queued, 2);
  const activeHistoryBatch = await pool.query(
    `SELECT COUNT(*)::integer AS count
     FROM public.vehicle_entry_overview_backfill_jobs
     WHERE run_id = $1 AND status = 'queued'`,
    [preview.id],
  );
  assert.equal(Number(activeHistoryBatch.rows[0].count), 2);
  const retained = await pool.query(
    `SELECT vehicle_image_path, vehicle_image_source_kind, vehicle_image_queue_kind,
            vehicle_overview_candidate_id, vehicle_image_source_read_id
     FROM public.plate_reads WHERE id = $1`,
    [legacyHistoryReadId],
  );
  assert.equal(retained.rows[0].vehicle_image_path, `images/history-${suffix}-legacy.jpg`);
  assert.equal(retained.rows[0].vehicle_image_source_kind, "legacy_plate_camera");
  assert.equal(retained.rows[0].vehicle_image_queue_kind, "overview_backfill");
  assert.equal(Number(retained.rows[0].vehicle_overview_candidate_id), historyCandidateId);
  assert.equal(Number(retained.rows[0].vehicle_image_source_read_id), readId);
  const protectedView = await pool.query(
    `SELECT vehicle_image_path, vehicle_image_status, vehicle_image_source_kind,
            vehicle_image_queue_kind, vehicle_image_backfill_job_id
     FROM public.plate_reads WHERE id = $1`,
    [protectedHistoryReadId],
  );
  assert.equal(protectedView.rows[0].vehicle_image_path, `derived/history-${suffix}-protected.jpg`);
  assert.equal(protectedView.rows[0].vehicle_image_status, "failed");
  assert.equal(protectedView.rows[0].vehicle_image_source_kind, "entry_overview_primary");
  assert.equal(protectedView.rows[0].vehicle_image_queue_kind, null);
  assert.equal(protectedView.rows[0].vehicle_image_backfill_job_id, null);

  // The history queue yields while claimable live/primary work is outstanding.
  // A protected saved-image row and exhausted failures cannot block it forever.
  assert.equal(await repositoryA.claimNextEntryOverviewBackfillJob(), null);
  await pool.query(
    `UPDATE public.plate_reads
     SET vehicle_image_status = 'ready', vehicle_image_retryable = FALSE,
         vehicle_image_claim_token = NULL,
         vehicle_image_processing_deadline_at = NULL,
         vehicle_image_hard_deadline_at = NULL
     WHERE id = $1`,
    [migrationCompatibilityReadId],
  );
  const historyClaim = await repositoryA.claimNextEntryOverviewBackfillJob();
  assert.equal(Number(historyClaim.id), legacyHistoryReadId);
  assert.equal(historyClaim.entry_history_profile_kind, "entry_history");
  assert.equal(historyClaim.entry_overview_source_kind, "entry_overview_history");
  assert.equal(historyClaim.overview_source_camera_short_name, "Cam143");
  assert.equal(historyClaim.entry_history_direction_label, null);
  assert.equal(historyClaim.vehicle_image_path, `images/history-${suffix}-legacy.jpg`);

  const historyExportKey = crypto.createHash("sha256")
    .update(String(historyClaim.entry_history_semantic_key).trim())
    .digest("hex");
  const historyExport = await repositoryA.beginTimelineExport({
    exportKey: historyExportKey,
    readId: legacyHistoryReadId,
    claimToken: historyClaim.vehicle_image_claim_token,
    sourceCameraName: "Entry Overview",
    requestedStartAt: new Date(
      new Date(historyClaim.entry_overview_anchor_at).getTime() - 3_000,
    ).toISOString(),
    requestedDurationMs: 8_000,
    hardDeadlineAt: historyClaim.vehicle_image_hard_deadline_at,
    profileRevision: historyClaim.entry_history_profile_revision,
    algorithmRevision: historyClaim.entry_history_algorithm_revision,
    profileKind: historyClaim.entry_history_profile_kind,
    profileIdentity: String(historyClaim.entry_history_profile_key).trim(),
  });
  const historyExportAgain = await repositoryA.beginTimelineExport({
    exportKey: historyExportKey,
    readId: legacyHistoryReadId,
    claimToken: historyClaim.vehicle_image_claim_token,
    sourceCameraName: "Entry Overview",
    requestedStartAt: new Date(
      new Date(historyClaim.entry_overview_anchor_at).getTime() - 3_000,
    ).toISOString(),
    requestedDurationMs: 8_000,
    hardDeadlineAt: historyClaim.vehicle_image_hard_deadline_at,
    profileRevision: historyClaim.entry_history_profile_revision,
    algorithmRevision: historyClaim.entry_history_algorithm_revision,
    profileKind: historyClaim.entry_history_profile_kind,
    profileIdentity: String(historyClaim.entry_history_profile_key).trim(),
  });
  assert.equal(historyExportAgain.export_token, historyExport.export_token);
  await repositoryA.markTimelineExportDownloaded(historyExport.export_token, {
    uri: "@entry-history-owned.mp4",
    fileSize: 2048,
    width: 2688,
    height: 1520,
    durationMs: 8_000,
  }, { claimToken: historyClaim.vehicle_image_claim_token });
  const historyReady = await repositoryA.markEntryOverviewBackfillReady(
    historyClaim.entry_history_job_id,
    {
      framePath: `derived/history-${suffix}-cam143.jpg`,
      frameTimestamp: historyClaim.entry_overview_anchor_at,
      frameScore: 0.95,
      detectionConfidence: 0.94,
      detectionBox: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.9 },
      imageWidth: 2688,
      imageHeight: 1520,
      sampledCount: 61,
      selectionMetadata: { history: true },
    },
    {
      claimToken: historyClaim.vehicle_image_claim_token,
      exportToken: historyExport.export_token,
    },
  );
  assert.equal(historyReady.priorImagePath, `images/history-${suffix}-legacy.jpg`);
  const historyReadyRead = await pool.query(
    `SELECT vehicle_image_path, vehicle_image_source_kind,
            vehicle_overview_candidate_id, vehicle_image_source_read_id
     FROM public.plate_reads WHERE id = $1`,
    [legacyHistoryReadId],
  );
  assert.equal(historyReadyRead.rows[0].vehicle_image_path, `derived/history-${suffix}-cam143.jpg`);
  assert.equal(historyReadyRead.rows[0].vehicle_image_source_kind, "entry_overview_history");
  assert.equal(historyReadyRead.rows[0].vehicle_overview_candidate_id, null);
  assert.equal(historyReadyRead.rows[0].vehicle_image_source_read_id, null);

  // A complete concurrent winner after confirmation must defeat the history
  // READY CAS; its image and ownership provenance remain untouched.
  const supersededClaim = await repositoryA.claimNextEntryOverviewBackfillJob();
  assert.equal(Number(supersededClaim.id), missingHistoryReadId);
  const supersededExportKey = crypto.createHash("sha256")
    .update(String(supersededClaim.entry_history_semantic_key).trim())
    .digest("hex");
  const supersededExport = await repositoryA.beginTimelineExport({
    exportKey: supersededExportKey,
    readId: missingHistoryReadId,
    claimToken: supersededClaim.vehicle_image_claim_token,
    sourceCameraName: "Entry Overview",
    requestedStartAt: new Date(
      new Date(supersededClaim.entry_overview_anchor_at).getTime() - 3_000,
    ).toISOString(),
    requestedDurationMs: 8_000,
    hardDeadlineAt: supersededClaim.vehicle_image_hard_deadline_at,
    profileRevision: supersededClaim.entry_history_profile_revision,
    algorithmRevision: supersededClaim.entry_history_algorithm_revision,
    profileKind: supersededClaim.entry_history_profile_kind,
    profileIdentity: String(supersededClaim.entry_history_profile_key).trim(),
  });
  await repositoryA.markTimelineExportDownloaded(supersededExport.export_token, {
    uri: "@entry-history-superseded.mp4",
    fileSize: 2048,
    width: 2688,
    height: 1520,
    durationMs: 8_000,
  }, { claimToken: supersededClaim.vehicle_image_claim_token });
  await pool.query(
    `UPDATE public.plate_reads
     SET vehicle_image_path = $2, vehicle_image_status = 'ready',
         vehicle_image_queue_kind = NULL, vehicle_image_retryable = FALSE,
         vehicle_image_source_kind = 'overview_pair_share',
         vehicle_overview_candidate_id = $3,
         vehicle_image_source_read_id = $4,
         vehicle_image_claim_token = NULL,
         vehicle_image_backfill_job_id = NULL,
         vehicle_image_processing_deadline_at = NULL,
         vehicle_image_hard_deadline_at = NULL
     WHERE id = $1`,
    [missingHistoryReadId, `derived/history-${suffix}-concurrent.jpg`, historyCandidateId, readId],
  );
  const lostReady = await repositoryA.markEntryOverviewBackfillReady(
    supersededClaim.entry_history_job_id,
    {
      framePath: `derived/history-${suffix}-must-not-win.jpg`,
      frameTimestamp: supersededClaim.entry_overview_anchor_at,
      frameScore: 0.99,
      detectionConfidence: 0.99,
      detectionBox: { left: 0, top: 0, right: 1, bottom: 1 },
      imageWidth: 2688,
      imageHeight: 1520,
      sampledCount: 61,
      selectionMetadata: { mustNotWin: true },
    },
    {
      claimToken: supersededClaim.vehicle_image_claim_token,
      exportToken: supersededExport.export_token,
    },
  );
  assert.equal(lostReady, null);
  const supersededFailure = await repositoryA.markEntryOverviewBackfillFailed(
    supersededClaim.entry_history_job_id,
    {
      claimToken: supersededClaim.vehicle_image_claim_token,
      errorCode: "ENTRY_HISTORY_SOURCE_CHANGED",
      retryable: false,
    },
  );
  assert.equal(supersededFailure.status, "superseded");
  const concurrentWinner = await pool.query(
    `SELECT vehicle_image_path, vehicle_image_source_kind,
            vehicle_overview_candidate_id, vehicle_image_source_read_id
     FROM public.plate_reads WHERE id = $1`,
    [missingHistoryReadId],
  );
  assert.equal(concurrentWinner.rows[0].vehicle_image_path, `derived/history-${suffix}-concurrent.jpg`);
  assert.equal(concurrentWinner.rows[0].vehicle_image_source_kind, "overview_pair_share");
  assert.equal(Number(concurrentWinner.rows[0].vehicle_overview_candidate_id), historyCandidateId);
  assert.equal(Number(concurrentWinner.rows[0].vehicle_image_source_read_id), readId);
  const completedMainRun = await repositoryA.getEntryOverviewBackfillRun(preview.id);
  assert.equal(completedMainRun.status, "completed");

  // Cancellation is restartable: it cancels previewed jobs, releases the
  // active-scope uniqueness, and a new run reuses the same semantic job key.
  const restartBase = new Date(historyBase.getTime() + 30_000);
  const restartReadId = await insertHistoryRead({
    plate: `HRST${suffix}`,
    offsetMs: 30_000,
    path: `images/history-${suffix}-restart-prior.jpg`,
    status: "ready",
    sourceKind: "legacy_plate_camera",
    overviewCandidateId: historyCandidateId,
    sourceReadId: readId,
  });
  const restartScope = {
    startAt: new Date(restartBase.getTime() - 1_000).toISOString(),
    endAt: new Date(restartBase.getTime() + 1_000).toISOString(),
    plateCameraNames: ["Entry LPR 1"],
    batchSize: 1,
    algorithmRevision: "entry-overview-history-pg-v1",
  };
  const cancelledPreview = await repositoryA.previewEntryOverviewBackfillRun(restartScope);
  historyRunIds.push(Number(cancelledPreview.id));
  await repositoryA.cancelEntryOverviewBackfillRun(cancelledPreview.id);
  const restartedPreview = await repositoryA.previewEntryOverviewBackfillRun(restartScope);
  historyRunIds.push(Number(restartedPreview.id));
  assert.notEqual(Number(restartedPreview.id), Number(cancelledPreview.id));
  const latestRestart = await repositoryA.getLatestEntryOverviewBackfillRun({ jobLimit: 1 });
  assert.equal(Number(latestRestart.id), Number(restartedPreview.id));
  const semanticRows = await pool.query(
    `SELECT semantic_key, status FROM public.vehicle_entry_overview_backfill_jobs
     WHERE read_id = $1 ORDER BY id`,
    [restartReadId],
  );
  assert.equal(semanticRows.rowCount, 2);
  assert.equal(semanticRows.rows[0].semantic_key, semanticRows.rows[1].semantic_key);
  assert.equal(semanticRows.rows[0].status, "cancelled");
  await repositoryA.confirmEntryOverviewBackfillRun({
    runId: restartedPreview.id,
    previewFingerprint: restartedPreview.preview_fingerprint,
    limit: 1,
  });
  await repositoryA.cancelEntryOverviewBackfillRun(restartedPreview.id);
  const cancelledRestartRead = await pool.query(
    `SELECT vehicle_image_path, vehicle_image_status, vehicle_image_source_kind,
            vehicle_overview_candidate_id, vehicle_image_source_read_id,
            vehicle_image_backfill_job_id
     FROM public.plate_reads WHERE id = $1`,
    [restartReadId],
  );
  assert.equal(
    cancelledRestartRead.rows[0].vehicle_image_path,
    `images/history-${suffix}-restart-prior.jpg`,
  );
  assert.equal(cancelledRestartRead.rows[0].vehicle_image_status, "ready");
  assert.equal(cancelledRestartRead.rows[0].vehicle_image_source_kind, "legacy_plate_camera");
  assert.equal(Number(cancelledRestartRead.rows[0].vehicle_overview_candidate_id), historyCandidateId);
  assert.equal(Number(cancelledRestartRead.rows[0].vehicle_image_source_read_id), readId);
  assert.equal(cancelledRestartRead.rows[0].vehicle_image_backfill_job_id, null);

  // Confirmation with no previewable jobs is terminal rather than leaving a
  // permanently running campaign.
  const zeroPreview = await repositoryA.previewEntryOverviewBackfillRun({
    ...historyScope,
    startAt: new Date(historyBase.getTime() + 1_500).toISOString(),
    endAt: new Date(historyBase.getTime() + 3_500).toISOString(),
  });
  historyRunIds.push(Number(zeroPreview.id));
  const zeroConfirmed = await repositoryA.confirmEntryOverviewBackfillRun({
    runId: zeroPreview.id,
    previewFingerprint: zeroPreview.preview_fingerprint,
    limit: 10,
  });
  assert.equal(zeroConfirmed.queued, 0);
  const zeroState = await repositoryA.getEntryOverviewBackfillRun(zeroPreview.id);
  assert.equal(zeroState.status, "completed");

  // A terminal failure never removes or relabels the prior view and restores
  // candidate/source provenance exactly.
  const preservedFailureReadId = await insertHistoryRead({
    plate: `HFAIL${suffix}`,
    offsetMs: 40_000,
    path: `images/history-${suffix}-failure-prior.jpg`,
    status: "ready",
    sourceKind: "legacy_plate_camera",
    overviewCandidateId: historyCandidateId,
    sourceReadId: readId,
  });
  const preservedFailurePreview = await repositoryA.previewEntryOverviewBackfillRun({
    ...historyScope,
    startAt: new Date(historyBase.getTime() + 39_000).toISOString(),
    endAt: new Date(historyBase.getTime() + 41_000).toISOString(),
  });
  historyRunIds.push(Number(preservedFailurePreview.id));
  await repositoryA.confirmEntryOverviewBackfillRun({
    runId: preservedFailurePreview.id,
    previewFingerprint: preservedFailurePreview.preview_fingerprint,
    limit: 1,
  });
  const preservedFailureClaim = await repositoryA.claimNextEntryOverviewBackfillJob();
  assert.equal(Number(preservedFailureClaim.id), preservedFailureReadId);
  await repositoryA.recordEntryOverviewBackfillDaylight(
    preservedFailureClaim.entry_history_job_id,
    preservedFailureClaim.vehicle_image_claim_token,
    { status: "eligible", evidence: { evaluated: true, eligible: true } },
  );
  await repositoryA.markEntryOverviewBackfillFailed(
    preservedFailureClaim.entry_history_job_id,
    {
      claimToken: preservedFailureClaim.vehicle_image_claim_token,
      errorCode: "RECORDING_UNAVAILABLE",
      retryable: false,
      unavailable: true,
    },
  );
  const preservedFailureRead = await pool.query(
    `SELECT vehicle_image_path, vehicle_image_status, vehicle_image_source_kind,
            vehicle_overview_candidate_id, vehicle_image_source_read_id,
            vehicle_image_backfill_job_id
     FROM public.plate_reads WHERE id = $1`,
    [preservedFailureReadId],
  );
  assert.equal(
    preservedFailureRead.rows[0].vehicle_image_path,
    `images/history-${suffix}-failure-prior.jpg`,
  );
  assert.equal(preservedFailureRead.rows[0].vehicle_image_status, "ready");
  assert.equal(preservedFailureRead.rows[0].vehicle_image_source_kind, "legacy_plate_camera");
  assert.equal(Number(preservedFailureRead.rows[0].vehicle_overview_candidate_id), historyCandidateId);
  assert.equal(Number(preservedFailureRead.rows[0].vehicle_image_source_read_id), readId);
  assert.equal(preservedFailureRead.rows[0].vehicle_image_backfill_job_id, null);

  // A pathless preflight failure remains visibly terminal after the campaign
  // claim is released.
  const unverifiedReadId = await insertHistoryRead({
    plate: `HUVR${suffix}`,
    offsetMs: 50_000,
  });
  const unverifiedPreview = await repositoryA.previewEntryOverviewBackfillRun({
    ...historyScope,
    startAt: new Date(historyBase.getTime() + 49_000).toISOString(),
    endAt: new Date(historyBase.getTime() + 51_000).toISOString(),
  });
  historyRunIds.push(Number(unverifiedPreview.id));
  await repositoryA.confirmEntryOverviewBackfillRun({
    runId: unverifiedPreview.id,
    previewFingerprint: unverifiedPreview.preview_fingerprint,
    limit: 1,
  });
  const unverifiedClaim = await repositoryA.claimNextEntryOverviewBackfillJob();
  assert.equal(Number(unverifiedClaim.id), unverifiedReadId);
  await repositoryA.recordEntryOverviewBackfillDaylight(
    unverifiedClaim.entry_history_job_id,
    unverifiedClaim.vehicle_image_claim_token,
    { status: "unverified", evidence: { evaluated: false, eligible: false } },
  );
  await repositoryA.markEntryOverviewBackfillFailed(
    unverifiedClaim.entry_history_job_id,
    {
      claimToken: unverifiedClaim.vehicle_image_claim_token,
      errorCode: "DAYLIGHT_UNVERIFIED",
      retryable: false,
      unavailable: true,
    },
  );
  const unverifiedRead = await pool.query(
    `SELECT vehicle_image_path, vehicle_image_status, vehicle_image_error_code,
            vehicle_image_queue_kind, vehicle_image_backfill_job_id
     FROM public.plate_reads WHERE id = $1`,
    [unverifiedReadId],
  );
  assert.equal(unverifiedRead.rows[0].vehicle_image_path, null);
  assert.equal(unverifiedRead.rows[0].vehicle_image_status, "unavailable");
  assert.equal(unverifiedRead.rows[0].vehicle_image_error_code, "DAYLIGHT_UNVERIFIED");
  assert.equal(unverifiedRead.rows[0].vehicle_image_queue_kind, null);
  assert.equal(unverifiedRead.rows[0].vehicle_image_backfill_job_id, null);

  // A crashed second attempt is terminalized with no third claim and the run
  // becomes idle/completed.
  const expiredReadId = await insertHistoryRead({
    plate: `HEXP${suffix}`,
    offsetMs: 60_000,
  });
  const expiredPreview = await repositoryA.previewEntryOverviewBackfillRun({
    ...historyScope,
    startAt: new Date(historyBase.getTime() + 59_000).toISOString(),
    endAt: new Date(historyBase.getTime() + 61_000).toISOString(),
  });
  historyRunIds.push(Number(expiredPreview.id));
  await repositoryA.confirmEntryOverviewBackfillRun({
    runId: expiredPreview.id,
    previewFingerprint: expiredPreview.preview_fingerprint,
    limit: 1,
  });
  const expiredClaimOne = await repositoryA.claimNextEntryOverviewBackfillJob();
  await repositoryA.markEntryOverviewBackfillFailed(
    expiredClaimOne.entry_history_job_id,
    {
      claimToken: expiredClaimOne.vehicle_image_claim_token,
      errorCode: "BLUE_IRIS_INITIALIZATION_FAILED",
      retryable: true,
      nextAttemptAt: new Date(Date.now() - 1_000).toISOString(),
    },
  );
  const expiredClaimTwo = await repositoryA.claimNextEntryOverviewBackfillJob();
  assert.equal(Number(expiredClaimTwo.id), expiredReadId);
  await pool.query(
    `UPDATE public.vehicle_entry_overview_backfill_jobs
     SET heartbeat_at = CURRENT_TIMESTAMP - INTERVAL '10 minutes',
         processing_deadline_at = CURRENT_TIMESTAMP - INTERVAL '5 minutes',
         hard_deadline_at = CURRENT_TIMESTAMP - INTERVAL '1 minute',
         updated_at = CURRENT_TIMESTAMP - INTERVAL '10 minutes'
     WHERE id = $1`,
    [expiredClaimTwo.entry_history_job_id],
  );
  await pool.query(
    `UPDATE public.plate_reads
     SET vehicle_image_heartbeat_at = CURRENT_TIMESTAMP - INTERVAL '10 minutes',
         vehicle_image_processing_deadline_at = CURRENT_TIMESTAMP - INTERVAL '5 minutes',
         vehicle_image_hard_deadline_at = CURRENT_TIMESTAMP - INTERVAL '1 minute',
         vehicle_image_updated_at = CURRENT_TIMESTAMP - INTERVAL '10 minutes'
     WHERE id = $1`,
    [expiredReadId],
  );
  assert.deepEqual(
    await repositoryA.terminalizeExpiredEntryOverviewBackfillJobs(),
    { terminalized: 1, superseded: 0 },
  );
  const expiredState = await pool.query(
    `SELECT reads.vehicle_image_status, reads.vehicle_image_error_code,
            reads.vehicle_image_backfill_job_id, jobs.status AS job_status,
            jobs.retryable, runs.status AS run_status
     FROM public.plate_reads reads
     JOIN public.vehicle_entry_overview_backfill_jobs jobs ON jobs.read_id = reads.id
     JOIN public.vehicle_entry_overview_backfill_runs runs ON runs.id = jobs.run_id
     WHERE reads.id = $1 AND jobs.run_id = $2`,
    [expiredReadId, expiredPreview.id],
  );
  assert.equal(expiredState.rows[0].vehicle_image_status, "failed");
  assert.equal(expiredState.rows[0].vehicle_image_error_code, "ENTRY_HISTORY_PROCESSING_DEADLINE");
  assert.equal(expiredState.rows[0].vehicle_image_backfill_job_id, null);
  assert.equal(expiredState.rows[0].job_status, "failed");
  assert.equal(expiredState.rows[0].retryable, false);
  assert.equal(expiredState.rows[0].run_status, "completed");
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
  if (caseProfileId !== null) {
    await pool.query("DELETE FROM public.vehicle_overview_pair_profiles WHERE id = $1", [caseProfileId])
      .catch(() => {});
  }
  if (migrationCompatibilityProfileId !== null) {
    await pool.query(
      "DELETE FROM public.vehicle_overview_pair_profiles WHERE id = $1",
      [migrationCompatibilityProfileId]
    ).catch(() => {});
  }
  if (historyRunIds.length) {
    await pool.query(
      "DELETE FROM public.vehicle_entry_overview_backfill_jobs WHERE run_id = ANY($1::bigint[])",
      [historyRunIds],
    ).catch(() => {});
    await pool.query(
      "DELETE FROM public.vehicle_entry_overview_backfill_runs WHERE id = ANY($1::bigint[])",
      [historyRunIds],
    ).catch(() => {});
  }
  if (historyReadIds.length) {
    await pool.query("DELETE FROM public.plate_reads WHERE id = ANY($1::integer[])", [historyReadIds])
      .catch(() => {});
  }
  if (historyCandidateIds.length) {
    await pool.query(
      "DELETE FROM public.vehicle_overview_candidates WHERE id = ANY($1::bigint[])",
      [historyCandidateIds],
    ).catch(() => {});
  }
  if (historyProfileIds.length) {
    await pool.query(
      "DELETE FROM public.vehicle_entry_overview_history_profiles WHERE id = ANY($1::bigint[])",
      [historyProfileIds],
    ).catch(() => {});
  }
  await pool.end();
}
