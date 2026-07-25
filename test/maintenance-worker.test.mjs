import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildRetentionPreview,
  calculateRetentionPreview,
  normalizeRetentionSettings,
  RETENTION_PLAN_SQL,
} from "../lib/maintenance-plan.mjs";
import {
  getMaintenanceRuntimeConfig,
  startMaintenanceRuntime,
} from "../lib/maintenance-runtime.mjs";
import { runDueRetentionPreview } from "../lib/maintenance-repository.mjs";

test("retention preview normalizes bounds and never represents destructive work", async () => {
  assert.deepEqual(normalizeRetentionSettings({ maxRecords: 5, retentionMonths: 999 }), {
    maxRecords: 1_000,
    retentionMonths: 120,
  });

  const queries = [];
  const preview = await calculateRetentionPreview({
    settings: { maxRecords: 25_000, retentionMonths: 6 },
    query: async (sql, values) => {
      queries.push({ sql, values });
      return {
        rows: [{
          read_count: "30000",
          retention_cutoff: "2026-01-25T00:00:00.000Z",
          record_candidate_count: "5000",
          record_source_reference_count: "4900",
          record_thumbnail_reference_count: "4800",
          retention_eligible_read_count: "7000",
          retention_source_reference_count: "6800",
          retention_thumbnail_reference_count: "6700",
        }],
      };
    },
  });

  assert.equal(queries[0].sql, RETENTION_PLAN_SQL);
  assert.deepEqual(queries[0].values, [25_000, 6]);
  assert.equal(preview.mode, "dry-run");
  assert.equal(preview.destructive, false);
  assert.equal(preview.recordPruning.candidateReads, 5_000);
  assert.equal(preview.retention.eligibleReads, 7_000);
  assert.match(preview.note, /no filesystem scan or deletion/i);
  assert.doesNotMatch(RETENTION_PLAN_SQL, /\bDELETE\b|\bUPDATE\b|\bTRUNCATE\b/i);

  assert.equal(buildRetentionPreview().destructive, false);
});

test("maintenance runtime schedules a dry-run worker and prevents in-process overlap", async () => {
  const callbacks = [];
  let releaseRun;
  let runCalls = 0;
  const runGate = new Promise((resolve) => { releaseRun = resolve; });
  const stateHost = {};
  const result = await startMaintenanceRuntime({
    stateHost,
    env: {
      MAINTENANCE_PREVIEW_INITIAL_DELAY_SECONDS: "10",
      MAINTENANCE_PREVIEW_POLL_SECONDS: "10",
      MAINTENANCE_PREVIEW_INTERVAL_SECONDS: "3600",
    },
    schedule(callback, delay) {
      callbacks.push({ callback, delay });
      return { unref() {} };
    },
    async getDatabase() {
      return { query: async () => ({ rows: [] }) };
    },
    async ensureState(options) {
      assert.equal(options.enabled, true);
      assert.equal(options.intervalSeconds, 3600);
    },
    async loadSettings() {
      return { general: { maxRecords: 50_000, retention: 4 } };
    },
    async runDue(options) {
      runCalls += 1;
      assert.deepEqual(options.settings, { maxRecords: 50_000, retentionMonths: 4 });
      await runGate;
      return { status: "not-due" };
    },
  });

  assert.deepEqual(result, { status: "started", reused: false, enabled: true, mode: "dry-run" });
  assert.equal(callbacks[0].delay, 10_000);
  const first = callbacks[0].callback();
  const second = callbacks[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runCalls, 1);
  releaseRun();
  await Promise.all([first, second]);
  assert.equal(callbacks.length, 2);

  const reused = await startMaintenanceRuntime({ stateHost });
  assert.equal(reused.reused, true);
});

test("maintenance runtime configuration remains dry-run only", () => {
  const config = getMaintenanceRuntimeConfig({
    MAINTENANCE_PREVIEW_ENABLED: "false",
    MAINTENANCE_PREVIEW_INTERVAL_SECONDS: "1",
  });
  assert.equal(config.enabled, false);
  assert.equal(config.mode, "dry-run");
  assert.equal(config.intervalSeconds, 3_600);
});

test("database advisory locking makes the durable preview single-flight", async () => {
  const statements = [];
  let released = false;
  const client = {
    async query(sql, values) {
      statements.push({ sql, values });
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ locked: true }], rowCount: 1 };
      if (/UPDATE public\.maintenance_job_state[\s\S]*RETURNING job_name/.test(sql)) {
        return { rows: [{ job_name: "retention-preview" }], rowCount: 1 };
      }
      if (sql === RETENTION_PLAN_SQL) {
        return { rows: [{ read_count: "100" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release() { released = true; },
  };

  const result = await runDueRetentionPreview({
    pool: { connect: async () => client },
    settings: { maxRecords: 10_000, retentionMonths: 3 },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.preview.destructive, false);
  assert.equal(released, true);
  assert.equal(statements.some(({ sql }) => /pg_try_advisory_lock/.test(sql)), true);
  assert.equal(statements.some(({ sql }) => /pg_advisory_unlock/.test(sql)), true);
  assert.equal(statements.some(({ sql }) => /\bDELETE\b|\bTRUNCATE\b/i.test(sql)), false);
});

test("ingestion no longer invokes cleanup and maintenance schema is dry-run constrained", async () => {
  const [route, database, fileStorage, obsoleteCleanup, migrations] = await Promise.all([
    readFile(new URL("../app/api/plate-reads/route.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/db.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/fileStorage.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/cleanupService.js", import.meta.url), "utf8").catch(() => null),
    readFile(new URL("../migrations.sql", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(route, /cleanupOldRecords|cleanupOldFiles/);
  assert.doesNotMatch(database, /export async function cleanupOldRecords/);
  assert.doesNotMatch(fileStorage, /cleanupOldFiles\(/);
  assert.equal(obsoleteCleanup, null);
  assert.match(migrations, /CREATE TABLE IF NOT EXISTS public\.maintenance_job_state/);
  assert.match(migrations, /CHECK \(mode = 'dry-run'\)/);
});
