import assert from "node:assert/strict";
import crypto from "node:crypto";

import pg from "pg";

import { BlueIrisVehicleFrameRepository } from "../lib/blue-iris-vehicle-frame-repository.mjs";

const OPT_IN = "OVERVIEW_FRAMING_REPAIR_POSTGRES_TEST_OPT_IN";
const EXPECTED_DATABASE = "OVERVIEW_FRAMING_REPAIR_POSTGRES_TEST_DATABASE";
const GUARD_TOKEN = "OVERVIEW_FRAMING_REPAIR_POSTGRES_TEST_GUARD_TOKEN";
const GUARD_SCOPE = "overview-framing-repair:v1";
const LOCK_NAME = "codex_overview_framing_repair_postgres_test_v1";

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
  throw new Error(`Refusing framing repair integration test: DATABASE_URL names ${urlDatabase}`);
}
if (expectedDatabase !== "fixture_test"
    && !/^codex_overview_repair_[0-9a-f]{8,32}$/.test(expectedDatabase)) {
  throw new Error("Refusing framing repair integration test: database is not an approved disposable name");
}

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 3,
  options: "-c lock_timeout=5000 -c statement_timeout=30000",
});
const repository = new BlueIrisVehicleFrameRepository(pool);
const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
let lockClient = null;
let lockHeld = false;
let profileId = null;
let readId = null;
let runId = null;
let exportToken = null;

async function guard() {
  lockClient = await pool.connect();
  const identity = await lockClient.query(
    `SELECT current_database() AS database_name,
            to_regclass('public.codex_integration_test_guard')::text AS guard_table,
            to_regclass('public.host_maintenance_environment_identity')::text
              AS environment_identity_table`,
  );
  assert.equal(identity.rows[0]?.database_name, expectedDatabase);
  assert.equal(identity.rows[0]?.guard_table, "codex_integration_test_guard");
  const sentinel = await lockClient.query(
    `SELECT COUNT(*)::integer AS count FROM public.codex_integration_test_guard
     WHERE scope = $1 AND guard_token = $2`,
    [GUARD_SCOPE, guardToken],
  );
  assert.equal(sentinel.rows[0]?.count, 1);
  if (identity.rows[0]?.environment_identity_table) {
    const live = await lockClient.query(
      "SELECT COUNT(*)::integer AS count FROM public.host_maintenance_environment_identity",
    );
    assert.equal(live.rows[0]?.count, 0, "application environment identity must be absent");
  }
  const active = await lockClient.query(
    `SELECT COUNT(*)::integer AS count
     FROM public.vehicle_overview_framing_repair_runs
     WHERE status IN ('previewed','running')`,
  );
  assert.equal(active.rows[0]?.count, 0);
  const locked = await lockClient.query(
    "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
    [LOCK_NAME],
  );
  assert.equal(locked.rows[0]?.locked, true);
  lockHeld = true;
}

try {
  await guard();
  const noOpFailureRestore = await repository.restoreOverviewFramingRepairFailure(-1, {
    claimToken: crypto.randomUUID(),
    status: "failed",
    errorCode: "FIXTURE_NOOP",
    retryable: false,
  });
  assert.equal(noOpFailureRestore, null,
    "failure restoration SQL must type-check even when no repair claim matches");
  const profile = await pool.query(
    `INSERT INTO public.vehicle_overview_pair_profiles (
       source_camera_name, source_camera_short_name, plate_camera_name,
       direction_label, source_role, overview_context, expected_delta_ms,
       tolerance_ms, priority, enabled
     ) VALUES ($1,$2,$3,'Westbound','primary','street',8500,1500,99,TRUE)
     RETURNING id, revision`,
    [`Repair Overview ${suffix}`, `RepairCam${suffix}`, `Repair LPR ${suffix}`],
  );
  profileId = Number(profile.rows[0].id);
  const imagePath = `derived/overview-repair-${suffix}.jpg`;
  const selection = {
    profileId,
    profileRevision: Number(profile.rows[0].revision),
    overviewContext: "street",
    sourceCameraName: `Repair Overview ${suffix}`,
    sourceCameraShortName: `RepairCam${suffix}`,
    expectedDeltaMs: 8500,
    toleranceMs: 1500,
  };
  const inserted = await pool.query(
    `INSERT INTO public.plate_reads (
       plate_number, camera_name, "timestamp", bi_trigger_direction_status,
       bi_trigger_direction_label, bi_trigger_direction_profile_version,
       bi_trigger_direction_algorithm, vehicle_image_status, vehicle_image_path,
       vehicle_image_timestamp, vehicle_image_queue_kind, vehicle_image_attempt_count,
       vehicle_image_retryable, vehicle_image_source_kind,
       vehicle_image_detection_confidence, vehicle_image_detection_box,
       vehicle_image_width, vehicle_image_height, vehicle_image_sampled_count,
       vehicle_image_selection_metadata, vehicle_image_updated_at
     ) VALUES (
       'RPR123',$1,'2026-08-15 17:24:00.123456+00','ready','Westbound',
       1,'blue-iris-zone-crossing-v2-primary',
       'ready',$2,'2026-08-15 17:24:08.623456+00','overview',1,FALSE,
       'overview_primary',0.95,$3::jsonb,2688,1520,11,$4::jsonb,
       '2026-08-15 17:25:00.654321+00'
     ) RETURNING id`,
    [`Repair LPR ${suffix}`, imagePath,
      JSON.stringify({ left: 0.42, top: 0.1, right: 1, bottom: 0.8 }),
      JSON.stringify(selection)],
  );
  readId = Number(inserted.rows[0].id);
  const [read] = await repository.getOverviewFramingRepairCandidates([readId]);
  const run = await repository.createOverviewFramingRepairPreview({
    previewFingerprint: crypto.randomBytes(32).toString("hex"),
    actor: null,
    items: [{
      read,
      audit: {
        actualBox: { left: 0.42, top: 0.1, right: 1, bottom: 0.8 },
        completenessTier: 0,
        edgeMargin: 0,
        edgeContacts: 1,
        repairReason: "VEHICLE_TOUCHES_IMAGE_EDGE",
      },
      profile: {
        profileId,
        profileRevision: Number(profile.rows[0].revision),
        overviewContext: "street",
        sourceCameraName: `Repair Overview ${suffix}`,
        sourceCameraShortName: `RepairCam${suffix}`,
        expectedDeltaMs: 8500,
        toleranceMs: 1500,
      },
    }],
  });
  runId = Number(run.id);
  const confirmed = await repository.confirmOverviewFramingRepairBatch(runId, {
    previewFingerprint: run.previewFingerprint,
    limit: 1,
  });
  assert.equal(confirmed.counts.queued, 1);
  const claimed = await repository.claimNextOverviewFramingRepairJob({
    requireNoLiveWork: false,
  });
  assert.equal(Number(claimed.id), readId);
  assert.equal(claimed.vehicle_image_path, imagePath);
  assert.equal(claimed.vehicle_image_status, "ready");
  assert.equal(claimed.vehicle_image_queue_kind, "overview_repair");
  assert.equal(claimed.framing_repair_prior_image_path, imagePath);
  assert.deepEqual(claimed.framing_repair_prior_detection_box, {
    left: 0.42,
    top: 0.1,
    right: 1,
    bottom: 0.8,
  });
  assert.equal(Number(claimed.framing_repair_prior_image_width), 2688);
  assert.equal(Number(claimed.framing_repair_prior_image_height), 1520);

  const repairProfileIdentity = crypto.createHash("sha256")
    .update(JSON.stringify({
      jobId: Number(claimed.framing_repair_job_id),
      kind: "overview_framing_repair",
    }))
    .digest("hex");
  const exportLedger = await repository.beginTimelineExport({
    exportKey: crypto.randomBytes(32).toString("hex"),
    readId,
    claimToken: claimed.vehicle_image_claim_token,
    sourceCameraName: `Repair Overview ${suffix}`,
    requestedStartAt: "2026-08-15T17:24:03.500Z",
    requestedDurationMs: 8_000,
    hardDeadlineAt: claimed.vehicle_image_hard_deadline_at,
    pairProfileId: profileId,
    profileRevision: Number(profile.rows[0].revision),
    algorithmRevision: "overview-timeline-export-v2",
    profileKind: "framing_repair",
    profileIdentity: repairProfileIdentity,
  });
  exportToken = exportLedger.export_token;
  assert.match(exportToken, /^[0-9a-f-]{36}$/);
  assert.equal(exportLedger.profile_kind, "framing_repair");
  assert.equal(String(exportLedger.profile_identity).trim(), repairProfileIdentity);
  const startClaim = await repository.claimTimelineExportStart(
    exportToken,
    claimed.vehicle_image_claim_token,
    [],
  );
  assert.equal(Number(startClaim.automatic_start_count), 1,
    "a claim-owned ready repair read must be permitted to start its distinct export");
  await repository.recordTimelineExportRemote(exportToken, {
    remotePath: `@repair-${suffix}.mp4`,
    uri: `@repair-${suffix}.mp4`,
    complete: true,
    progress: 100,
    utc: Date.parse("2026-08-15T17:24:03.500Z"),
    durationMs: 8_000,
    status: "ready",
  }, { claimToken: claimed.vehicle_image_claim_token });
  await repository.markTimelineExportDownloaded(exportToken, {
    uri: `@repair-${suffix}.mp4`,
    fileSize: 1024,
    width: 2688,
    height: 1520,
    durationMs: 8_000,
  }, { claimToken: claimed.vehicle_image_claim_token });

  const accepted = await repository.markOverviewFramingRepairReady(
    claimed.framing_repair_job_id,
    {
      framePath: `derived/inferior-${suffix}.jpg`,
      frameTimestamp: "2026-08-15T17:24:08.700Z",
      frameScore: 0.8,
      detectionConfidence: 0.94,
      detectionBox: { left: 0.01, top: 0.1, right: 0.99, bottom: 0.8 },
      imageWidth: 2688,
      imageHeight: 1520,
      sampledCount: 11,
      selectionMetadata: {
        finalImage: { completenessTier: 1, edgeMargin: 0.01, edgeContacts: 0 },
      },
    },
    { claimToken: claimed.vehicle_image_claim_token, exportToken },
  );
  assert.equal(accepted, null);
  const final = await pool.query(
    `SELECT reads.vehicle_image_status, reads.vehicle_image_path,
            reads.vehicle_image_queue_kind, reads.vehicle_image_claim_token,
            jobs.status AS job_status, jobs.error_code, runs.status AS run_status
     FROM public.plate_reads reads
     JOIN public.vehicle_overview_framing_repair_jobs jobs ON jobs.read_id = reads.id
     JOIN public.vehicle_overview_framing_repair_runs runs ON runs.id = jobs.run_id
     WHERE reads.id = $1 AND runs.id = $2`,
    [readId, runId],
  );
  assert.equal(final.rows[0].vehicle_image_status, "ready");
  assert.equal(final.rows[0].vehicle_image_path, imagePath);
  assert.equal(final.rows[0].vehicle_image_queue_kind, "overview");
  assert.equal(final.rows[0].vehicle_image_claim_token, null);
  assert.equal(final.rows[0].job_status, "preserved");
  assert.equal(final.rows[0].error_code, "REPLACEMENT_NOT_MORE_COMPLETE");
  assert.equal(final.rows[0].run_status, "completed");
  console.log("overview_framing_repair_postgres_gate=passed");
} finally {
  if (runId !== null) {
    await pool.query(
      "DELETE FROM public.vehicle_overview_framing_repair_runs WHERE id = $1",
      [runId],
    );
  }
  if (readId !== null) {
    await pool.query("DELETE FROM public.blue_iris_timeline_exports WHERE read_id = $1", [readId]);
    await pool.query("DELETE FROM public.plate_reads WHERE id = $1", [readId]);
  }
  if (profileId !== null) {
    await pool.query("DELETE FROM public.vehicle_overview_pair_profiles WHERE id = $1", [profileId]);
  }
  if (runId !== null || readId !== null || profileId !== null) {
    const residue = await pool.query(
      `SELECT
         (SELECT COUNT(*)::integer FROM public.vehicle_overview_framing_repair_runs
          WHERE id = $1) AS runs,
         (SELECT COUNT(*)::integer FROM public.vehicle_overview_framing_repair_jobs
          WHERE run_id = $1) AS jobs,
         (SELECT COUNT(*)::integer FROM public.blue_iris_timeline_exports
          WHERE read_id = $2) AS exports,
         (SELECT COUNT(*)::integer FROM public.plate_reads WHERE id = $2) AS reads,
         (SELECT COUNT(*)::integer FROM public.vehicle_overview_pair_profiles WHERE id = $3) AS profiles`,
      [runId, readId, profileId],
    );
    assert.deepEqual(residue.rows[0], {
      runs: 0,
      jobs: 0,
      exports: 0,
      reads: 0,
      profiles: 0,
    });
  }
  if (lockHeld) {
    await lockClient.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [LOCK_NAME]);
  }
  lockClient?.release();
  await pool.end();
}
