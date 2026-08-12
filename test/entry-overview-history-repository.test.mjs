import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { BlueIrisVehicleFrameRepository } from "../lib/blue-iris-vehicle-frame-repository.mjs";

function mockPool(handler) {
  const calls = [];
  return {
    calls,
    async query(text, params = []) {
      calls.push({ text, params });
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return { rows: [], rowCount: 0 };
      return handler(text, params, calls);
    },
  };
}

test("Entry history migration is preview-first, bounded, restartable, and adds no automatic queue update", async () => {
  const migration = await fs.readFile(new URL("../migrations.sql", import.meta.url), "utf8");
  const section = migration.slice(migration.indexOf("-- Direction-independent Entry Overview history"));
  assert.match(section, /vehicle_entry_overview_history_profiles/);
  assert.match(section, /vehicle_entry_overview_backfill_runs/);
  assert.match(section, /vehicle_entry_overview_backfill_jobs/);
  assert.match(section, /source_camera_name[^]*Entry Overview/);
  assert.match(section, /source_camera_short_name[^]*Cam143/);
  assert.match(section, /profile_kind[^]*entry_history/);
  assert.match(section, /source_kind[^]*entry_overview_history/);
  assert.match(section, /tolerance_ms[^]*3000/);
  assert.match(section, /batch_size INTEGER NOT NULL CHECK \(batch_size BETWEEN 1 AND 500\)/);
  assert.match(section, /idx_entry_overview_backfill_active_scope[^]*WHERE status <> 'cancelled'/);
  assert.match(section, /vehicle_image_backfill_job_id/);
  assert.match(section, /prior_overview_candidate_id BIGINT/);
  assert.match(section, /prior_source_read_id INTEGER/);
  assert.match(section, /operator_retry_count SMALLINT NOT NULL DEFAULT 0/);
  assert.match(section, /operator_retry_count BETWEEN 0 AND 1/);
  assert.match(section, /operator_retry_at TIMESTAMPTZ/);
  assert.match(section, /operator_retry_error_code VARCHAR\(80\)/);
  assert.match(section, /entry_overview_history/);
  assert.match(section, /overview_backfill/);
  assert.match(section, /Disabled Entry Overview history profile snapshots cannot be revived/);
  assert.match(section, /2026081006_entry_overview_history_backfill/);
  assert.match(section, /2026081101_entry_overview_history_retry/);
  assert.doesNotMatch(section, /UPDATE public\.plate_reads\s+SET vehicle_image_status = 'pending'/);
});

test("Entry history exposes only exact terminal transient failures for one manual retry", async () => {
  const pool = mockPool((text, params) => {
    assert.match(text, /jobs\.status = 'failed'/);
    assert.match(text, /jobs\.retryable = FALSE/);
    assert.match(text, /jobs\.attempt_count >= 2/);
    assert.match(text, /jobs\.operator_retry_count < \$1/);
    assert.match(text, /jobs\.error_code = ANY\(\$2::text\[\]\)/);
    assert.match(text, /reads\.vehicle_image_backfill_job_id IS NULL/);
    assert.match(text, /reads\.vehicle_image_path IS NOT DISTINCT FROM jobs\.prior_image_path/);
    assert.equal(params[0], 1);
    assert.ok(params[1].includes("EXPORT_TIMEOUT"));
    assert.ok(params[1].includes("ENTRY_HISTORY_PROCESSING_DEADLINE"));
    assert.ok(!params[1].includes("VEHICLE_NOT_VISIBLE"));
    return { rows: [{ id: 31, read_id: 39624, error_code: "EXPORT_TIMEOUT" }], rowCount: 1 };
  });
  const repository = new BlueIrisVehicleFrameRepository(pool);
  const candidates = await repository.listEntryOverviewBackfillRetryCandidates({ limit: 5 });
  assert.deepEqual(candidates, [{ id: 31, read_id: 39624, error_code: "EXPORT_TIMEOUT" }]);
});

test("Entry history manual retry reuses the original job and preserves current image state", async () => {
  const pool = mockPool((text) => {
    if (/FROM public\.vehicle_entry_overview_backfill_jobs jobs[\s\S]*FOR UPDATE OF jobs, runs/.test(text)) {
      return { rows: [{
        id: 31,
        run_id: 3,
        read_id: 39624,
        status: "failed",
        retryable: false,
        attempt_count: 2,
        operator_retry_count: 0,
        error_code: "EXPORT_TIMEOUT",
        prior_image_path: null,
      }], rowCount: 1 };
    }
    if (/AS has_active_history/.test(text)) {
      return { rows: [{ has_active_history: false }], rowCount: 1 };
    }
    if (/UPDATE public\.plate_reads reads[\s\S]*vehicle_image_backfill_job_id = jobs\.id/.test(text)) {
      assert.match(text, /vehicle_image_status = 'pending'/);
      assert.match(text, /vehicle_image_queue_kind = 'overview_backfill'/);
      assert.match(text, /vehicle_image_attempt_count = 0/);
      assert.match(text, /vehicle_image_path IS NOT DISTINCT FROM jobs\.prior_image_path/);
      assert.doesNotMatch(text, /SET[\s\S]*vehicle_image_path =/);
      return { rows: [{ id: 39624 }], rowCount: 1 };
    }
    if (/UPDATE public\.vehicle_entry_overview_backfill_jobs[\s\S]*operator_retry_count = operator_retry_count \+ 1/.test(text)) {
      assert.match(text, /SET status = 'queued', attempt_count = 0, retryable = TRUE/);
      assert.match(text, /operator_retry_error_code = error_code/);
      return { rows: [{
        id: 31,
        run_id: 3,
        status: "queued",
        operator_retry_count: 1,
      }], rowCount: 1 };
    }
    if (/UPDATE public\.vehicle_entry_overview_backfill_runs[\s\S]*SET status = 'running'/.test(text)) {
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE public\.vehicle_entry_overview_backfill_runs runs[\s\S]*status = 'completed'/.test(text)) {
      return { rows: [], rowCount: 0 };
    }
    throw new Error(`Unexpected SQL: ${text}`);
  });
  const repository = new BlueIrisVehicleFrameRepository(pool);
  const retried = await repository.retryEntryOverviewBackfillJob(31);
  assert.equal(retried.id, 31);
  assert.equal(retried.run_id, 3);
  assert.equal(retried.status, "queued");
  assert.equal(retried.operator_retry_count, 1);
  assert.equal(pool.calls.filter(({ text }) => text === "COMMIT").length, 1);
});

test("Entry history manual retry rejects semantic failures and a consumed retry budget", async () => {
  for (const job of [
    { error_code: "VEHICLE_NOT_VISIBLE", operator_retry_count: 0 },
    { error_code: "EXPORT_TIMEOUT", operator_retry_count: 1 },
  ]) {
    const pool = mockPool((text) => {
      if (/FROM public\.vehicle_entry_overview_backfill_jobs jobs[\s\S]*FOR UPDATE OF jobs, runs/.test(text)) {
        return { rows: [{
          id: 32,
          run_id: 3,
          read_id: 39624,
          status: "failed",
          retryable: false,
          attempt_count: 2,
          ...job,
        }], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const repository = new BlueIrisVehicleFrameRepository(pool);
    await assert.rejects(
      repository.retryEntryOverviewBackfillJob(32),
      job.operator_retry_count ? /already used its one manual retry cycle/ : /not a retry-safe/,
    );
    assert.equal(pool.calls.filter(({ text }) => text === "ROLLBACK").length, 1);
    assert.equal(pool.calls.some(({ text }) => /UPDATE public\.plate_reads/.test(text)), false);
  }
});

test("Entry history profile persistence fixes Cam143 identity and versions timing changes", async () => {
  let current = null;
  let insertedRevision = 0;
  const pool = mockPool((text, params) => {
    if (/pg_advisory_xact_lock/.test(text)) return { rows: [{}], rowCount: 1 };
    if (/FROM public\.vehicle_entry_overview_history_profiles[\s\S]*FOR UPDATE/.test(text)) {
      return { rows: current ? [current] : [], rowCount: current ? 1 : 0 };
    }
    if (/UPDATE public\.vehicle_entry_overview_history_profiles/.test(text)) {
      current = { ...current, enabled: false };
      return { rows: [], rowCount: 1 };
    }
    if (/INSERT INTO public\.vehicle_entry_overview_history_profiles/.test(text)) {
      insertedRevision += 1;
      current = {
        id: insertedRevision,
        profile_key: params[0],
        revision: insertedRevision,
        profile_kind: "entry_history",
        source_kind: "entry_overview_history",
        overview_context: "entry",
        source_camera_name: "Entry Overview",
        source_camera_short_name: "Cam143",
        plate_camera_name: params[1],
        expected_delta_ms: params[2],
        tolerance_ms: 3000,
        algorithm_revision: params[3],
        enabled: true,
      };
      return { rows: [current], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL: ${text}`);
  });
  const repository = new BlueIrisVehicleFrameRepository(pool);
  const first = await repository.saveEntryOverviewHistoryProfile({
    plateCameraName: " entry lpr 1 ",
    expectedDeltaMs: 750,
    algorithmRevision: "entry-overview-history-v1",
  });
  const noOp = await repository.saveEntryOverviewHistoryProfile({
    plateCameraName: "Entry LPR 1",
    expectedDeltaMs: 750,
    algorithmRevision: "entry-overview-history-v1",
  });
  assert.equal(first.id, noOp.id);
  assert.equal(first.source_camera_name, "Entry Overview");
  assert.equal(first.source_camera_short_name, "Cam143");
  assert.equal(first.tolerance_ms, 3000);
  assert.equal(insertedRevision, 1);
});

test("Entry history confirmation retains a legacy view and requires exact prior-state CAS", async () => {
  const priorPath = "images/legacy-entry.jpg";
  const pool = mockPool((text, params) => {
    if (/FROM public\.vehicle_entry_overview_backfill_runs[\s\S]*FOR UPDATE/.test(text)) {
      return { rows: [{
        id: 7,
        preview_fingerprint: "a".repeat(64),
        status: "previewed",
        batch_size: 1,
      }], rowCount: 1 };
    }
    if (/AS has_active_batch/.test(text)) {
      return { rows: [{ has_active_batch: false }], rowCount: 1 };
    }
    if (/SELECT \* FROM public\.vehicle_entry_overview_backfill_jobs/.test(text)) {
      return { rows: [{
        id: 71,
        read_id: 1701,
        prior_image_path: priorPath,
        prior_image_status: "ready",
        prior_queue_kind: "historical",
        prior_attempt_count: 1,
        prior_retryable: false,
        prior_error_code: null,
        prior_source_kind: "legacy_plate_camera",
        prior_overview_candidate_id: 911,
        prior_source_read_id: 1700,
        prior_image_timestamp: null,
        prior_image_score: 0.4,
        prior_detection_confidence: null,
        prior_detection_box: null,
        prior_image_width: 1920,
        prior_image_height: 1080,
        prior_sampled_count: 1,
        prior_selection_metadata: { legacy: true },
      }], rowCount: 1 };
    }
    if (/UPDATE public\.plate_reads reads/.test(text)) {
      assert.match(text, /vehicle_image_path IS NOT DISTINCT FROM \$3/);
      assert.match(text, /vehicle_image_selection_metadata IS NOT DISTINCT FROM \$17::jsonb/);
      assert.match(text, /vehicle_overview_candidate_id IS NOT DISTINCT FROM \$18::bigint/);
      assert.match(text, /vehicle_image_source_read_id IS NOT DISTINCT FROM \$19::integer/);
      assert.doesNotMatch(text, /SET vehicle_image_path/);
      assert.equal(params[2], priorPath);
      assert.equal(params[17], 911);
      assert.equal(params[18], 1700);
      return { rows: [{ id: 1701 }], rowCount: 1 };
    }
    if (/UPDATE public\.vehicle_entry_overview_backfill_jobs/.test(text)) {
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE public\.vehicle_entry_overview_backfill_runs/.test(text)) {
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL: ${text}`);
  });
  const repository = new BlueIrisVehicleFrameRepository(pool);
  const result = await repository.confirmEntryOverviewBackfillRun({
    runId: 7,
    previewFingerprint: "a".repeat(64),
    limit: 1,
  });
  assert.deepEqual(result, { runId: 7, queued: 1, superseded: 0, limit: 1 });
});

test("an all-superseded Entry history batch completes instead of remaining running", async () => {
  const pool = mockPool((text) => {
    if (/FROM public\.vehicle_entry_overview_backfill_runs[\s\S]*FOR UPDATE/.test(text)) {
      return { rows: [{
        id: 8,
        preview_fingerprint: "b".repeat(64),
        status: "previewed",
        batch_size: 1,
      }], rowCount: 1 };
    }
    if (/AS has_active_batch/.test(text)) {
      return { rows: [{ has_active_batch: false }], rowCount: 1 };
    }
    if (/SELECT \* FROM public\.vehicle_entry_overview_backfill_jobs/.test(text)) {
      return { rows: [{ id: 81, read_id: 1801 }], rowCount: 1 };
    }
    if (/UPDATE public\.plate_reads reads/.test(text)) {
      return { rows: [], rowCount: 0 };
    }
    if (/UPDATE public\.vehicle_entry_overview_backfill_jobs/.test(text)) {
      return { rows: [], rowCount: 1 };
    }
    if (/SET status = CASE WHEN status = 'paused'/.test(text)) {
      return { rows: [], rowCount: 1 };
    }
    if (/SET status = 'completed'/.test(text)) {
      assert.match(text, /NOT EXISTS[\s\S]*jobs\.status IN \('previewed','queued','processing'\)/);
      return { rows: [{ id: 8 }], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL: ${text}`);
  });
  const repository = new BlueIrisVehicleFrameRepository(pool);
  const result = await repository.confirmEntryOverviewBackfillRun({
    runId: 8,
    previewFingerprint: "b".repeat(64),
    limit: 1,
  });
  assert.deepEqual(result, { runId: 8, queued: 0, superseded: 1, limit: 1 });
  assert.equal(pool.calls.filter(({ text }) => /SET status = 'completed'/.test(text)).length, 1);
});

test("Entry history confirmation rejects a second active batch under the run lock", async () => {
  const pool = mockPool((text) => {
    if (/FROM public\.vehicle_entry_overview_backfill_runs[\s\S]*FOR UPDATE/.test(text)) {
      return { rows: [{
        id: 9,
        preview_fingerprint: "c".repeat(64),
        status: "running",
        batch_size: 25,
      }], rowCount: 1 };
    }
    if (/AS has_active_batch/.test(text)) {
      assert.match(text, /jobs\.status IN \('queued','processing'\)/);
      assert.match(text, /jobs\.status = 'failed' AND jobs\.retryable = TRUE/);
      return { rows: [{ has_active_batch: true }], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL: ${text}`);
  });
  const repository = new BlueIrisVehicleFrameRepository(pool);
  await assert.rejects(
    repository.confirmEntryOverviewBackfillRun({
      runId: 9,
      previewFingerprint: "c".repeat(64),
      limit: 25,
    }),
    /already has an active batch/,
  );
  assert.equal(
    pool.calls.some(({ text }) => /SELECT \* FROM public\.vehicle_entry_overview_backfill_jobs/.test(text)),
    false,
  );
});

test("an existing Entry history run can widen its next batch to 250 reads", async () => {
  const pool = mockPool((text, params) => {
    if (/FROM public\.vehicle_entry_overview_backfill_runs[\s\S]*FOR UPDATE/.test(text)) {
      return { rows: [{
        id: 10,
        preview_fingerprint: "d".repeat(64),
        status: "running",
        batch_size: 25,
      }], rowCount: 1 };
    }
    if (/AS has_active_batch/.test(text)) {
      return { rows: [{ has_active_batch: false }], rowCount: 1 };
    }
    if (/SELECT \* FROM public\.vehicle_entry_overview_backfill_jobs/.test(text)) {
      assert.equal(params[1], 250);
      return { rows: [], rowCount: 0 };
    }
    if (/SET status = CASE WHEN status = 'paused'/.test(text)) {
      assert.match(text, /batch_size = \$2/);
      assert.deepEqual(params, [10, 250]);
      return { rows: [], rowCount: 1 };
    }
    if (/SET status = 'completed'/.test(text)) {
      return { rows: [], rowCount: 0 };
    }
    throw new Error(`Unexpected SQL: ${text}`);
  });
  const repository = new BlueIrisVehicleFrameRepository(pool);
  const result = await repository.confirmEntryOverviewBackfillRun({
    runId: 10,
    previewFingerprint: "d".repeat(64),
    limit: 250,
  });
  assert.deepEqual(result, { runId: 10, queued: 0, superseded: 0, limit: 250 });
});

test("Entry history cancellation restores exact ownership and cancels previewed jobs", async () => {
  const pool = mockPool((text) => {
    if (/UPDATE public\.vehicle_entry_overview_backfill_runs/.test(text)) {
      return { rows: [{ id: 12 }], rowCount: 1 };
    }
    if (/WITH cancelled_jobs AS MATERIALIZED/.test(text)) {
      assert.match(text, /status IN \('queued','processing','failed'\)/);
      assert.match(text, /vehicle_image_path = jobs\.prior_image_path/);
      assert.match(text, /vehicle_overview_candidate_id = jobs\.prior_overview_candidate_id/);
      assert.match(text, /vehicle_image_source_read_id = jobs\.prior_source_read_id/);
      assert.match(text, /vehicle_image_path IS NOT DISTINCT FROM jobs\.prior_image_path/);
      assert.match(text, /vehicle_overview_candidate_id IS NOT DISTINCT FROM jobs\.prior_overview_candidate_id/);
      assert.match(text, /vehicle_image_source_read_id IS NOT DISTINCT FROM jobs\.prior_source_read_id/);
      return { rows: [{ status: "cancelled" }], rowCount: 1 };
    }
    if (/WHERE run_id = \$1 AND status = 'previewed'/.test(text)) {
      return { rows: [{ id: 121 }, { id: 122 }], rowCount: 2 };
    }
    throw new Error(`Unexpected SQL: ${text}`);
  });
  const repository = new BlueIrisVehicleFrameRepository(pool);
  assert.deepEqual(await repository.cancelEntryOverviewBackfillRun(12), {
    runId: 12,
    cancelled: 3,
    superseded: 0,
  });
});

test("latest Entry history run includes bounded progress counts", async () => {
  const pool = mockPool((text, params) => {
    if (/SELECT id[\s\S]*ORDER BY CASE WHEN status IN/.test(text)) {
      return { rows: [{ id: 14 }], rowCount: 1 };
    }
    if (/SELECT \* FROM public\.vehicle_entry_overview_backfill_runs WHERE id/.test(text)) {
      assert.deepEqual(params, [14]);
      return { rows: [{ id: 14, status: "running" }], rowCount: 1 };
    }
    if (/SELECT COUNT\(\*\)::integer AS total/.test(text)) {
      return { rows: [{ total: "4", previewed: "2", previewable_remaining: "1", ready: "1" }], rowCount: 1 };
    }
    if (/SELECT id, run_id, read_id, semantic_key/.test(text)) {
      assert.deepEqual(params, [14, 5]);
      return { rows: [{ id: 141, run_id: 14 }], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL: ${text}`);
  });
  const repository = new BlueIrisVehicleFrameRepository(pool);
  const latest = await repository.getLatestEntryOverviewBackfillRun({ jobLimit: 5 });
  assert.equal(latest.id, 14);
  assert.equal(latest.counts.total, 4);
  assert.equal(latest.counts.previewed, 2);
  assert.equal(latest.counts.previewable_remaining, 1);
  assert.equal(latest.counts.ready, 1);
  assert.deepEqual(latest.jobs, [{ id: 141, run_id: 14 }]);
});

test("Entry history claim is oldest-first and globally yields to live work", async () => {
  const pool = mockPool((text, params) => {
    assert.match(text, /ORDER BY jobs\.read_timestamp, jobs\.id/);
    assert.match(text, /live\.vehicle_image_path IS NULL/);
    assert.match(text, /COALESCE\(live\.vehicle_image_queue_kind, 'live'\) IN \('live','manual'\)/);
    assert.match(text, /live\.vehicle_image_queue_kind = 'overview'/);
    assert.match(text, /live\.bi_trigger_direction_status = 'ready'/);
    assert.match(text, /COALESCE\(live\.vehicle_image_attempt_count, 0\) < 3/);
    assert.match(text, /COALESCE\(live\.vehicle_image_attempt_count, 0\) < 2/);
    assert.match(text, /source_camera_short_name AS overview_source_camera_short_name/);
    assert.match(text, /daylight_status AS entry_overview_daylight_status/);
    assert.match(text, /vehicle_overview_candidate_id IS NOT DISTINCT FROM jobs\.prior_overview_candidate_id/);
    assert.match(text, /vehicle_image_source_read_id IS NOT DISTINCT FROM jobs\.prior_source_read_id/);
    assert.match(text, /vehicle_image_attempt_count = jobs\.attempt_count/);
    assert.match(text, /NULL::text AS entry_history_direction_label/);
    assert.equal(params[0], true);
    return { rows: [{
      id: 91,
      entry_history_job_id: 9,
      entry_history_profile_kind: "entry_history",
      entry_overview_source_kind: "entry_overview_history",
      overview_source_camera_short_name: "Cam143",
      entry_history_direction_label: null,
    }], rowCount: 1 };
  });
  const repository = new BlueIrisVehicleFrameRepository(pool);
  const claimed = await repository.claimNextEntryOverviewBackfillJob();
  assert.equal(claimed.entry_history_job_id, 9);
  assert.equal(claimed.entry_history_profile_kind, "entry_history");
  assert.equal(claimed.overview_source_camera_short_name, "Cam143");
  assert.equal(claimed.entry_history_direction_label, null);
});

test("generic historical queue cannot sample Entry LPR cameras", async () => {
  const pool = mockPool((text) => {
    assert.match(text, /LOWER\(BTRIM\(camera_name\)\) NOT IN \('entry lpr 1','entry lpr 2'\)/);
    return { rows: [], rowCount: 0 };
  });
  const repository = new BlueIrisVehicleFrameRepository(pool);
  await assert.rejects(
    repository.queueHistorical({ cameraName: " entry LPR 2 " }),
    /dedicated Entry Overview \(Cam143\) backfill/,
  );
  assert.equal(pool.calls.length, 0);
  assert.deepEqual(await repository.queueHistorical(), { queued: 0 });
});

test("expired second-attempt Entry history jobs terminalize with exact provenance CAS", async () => {
  const pool = mockPool((text) => {
    if (/WITH expired_jobs AS MATERIALIZED/.test(text)) {
      assert.match(text, /jobs\.attempt_count >= 2/);
      assert.match(text, /vehicle_image_claim_token IS NOT DISTINCT FROM jobs\.claim_token/);
      assert.match(text, /vehicle_overview_candidate_id IS NOT DISTINCT FROM jobs\.prior_overview_candidate_id/);
      assert.match(text, /vehicle_image_source_read_id IS NOT DISTINCT FROM jobs\.prior_source_read_id/);
      assert.match(text, /THEN 'ENTRY_HISTORY_PROCESSING_DEADLINE'/);
      return {
        rows: [
          { run_id: 41, status: "failed" },
          { run_id: 42, status: "superseded" },
        ],
        rowCount: 2,
      };
    }
    if (/UPDATE public\.vehicle_entry_overview_backfill_runs runs/.test(text)) {
      return { rows: [{ id: 41 }], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL: ${text}`);
  });
  const repository = new BlueIrisVehicleFrameRepository(pool);
  const result = await repository.terminalizeExpiredEntryOverviewBackfillJobs({ limit: 20 });
  assert.deepEqual(result, { terminalized: 1, superseded: 1 });
  assert.equal(pool.calls.filter(({ text }) =>
    /UPDATE public\.vehicle_entry_overview_backfill_runs runs/.test(text)).length, 2);
});

test("terminal Entry history failure preserves an existing view and labels a pathless read", async () => {
  const source = await fs.readFile(
    new URL("../lib/blue-iris-vehicle-frame-repository.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("async markEntryOverviewBackfillFailed");
  const end = source.indexOf("async completeEntryOverviewBackfillRunIfIdle", start);
  const method = source.slice(start, end);
  assert.match(method, /vehicle_image_path = jobs\.prior_image_path/);
  assert.match(method, /WHEN NULLIF\(BTRIM\(COALESCE\(jobs\.prior_image_path, ''\)\), ''\) IS NULL\s+THEN \$4/);
  assert.match(method, /THEN \$3\s+ELSE jobs\.prior_error_code/);
  assert.match(method, /vehicle_overview_candidate_id = jobs\.prior_overview_candidate_id/);
  assert.match(method, /vehicle_image_source_read_id = jobs\.prior_source_read_id/);
});
