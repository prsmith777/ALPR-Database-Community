import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AUTOMATIC_CLEANUP_ACKNOWLEDGEMENT,
  AUTOMATIC_CLEANUP_CATEGORY,
  AUTOMATIC_CLEANUP_CONFIRMATION,
  acknowledgeAutomaticCleanupFailure,
  automaticStorageCleanupInternals,
  runScheduledStorageCleanup,
  setAutomaticCleanupApproval,
} from "../lib/automatic-storage-cleanup.mjs";
import {
  processCleanupCandidateTransaction,
  recoverInterruptedStorageCleanupRuns,
  validateAndDeleteCleanupCandidate,
} from "../lib/storage-cleanup.mjs";
import {
  AUTOMATIC_CLEANUP_CATEGORIES,
  AUTOMATIC_CLEANUP_LIMITS,
} from "../lib/storage-maintenance-policy.mjs";
import { getPostgresMaintenanceObservability } from "../lib/postgres-maintenance-observability.mjs";

function fileStats({ size = 40, modifiedAt = "2026-07-01T00:00:00Z", nlink = 1 } = {}) {
  return {
    size,
    mtime: new Date(modifiedAt),
    dev: 1,
    ino: 2,
    nlink,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
}

test("automatic cleanup policy permits exactly derived orphans with immutable hard caps", () => {
  assert.deepEqual(AUTOMATIC_CLEANUP_CATEGORIES, ["derived-orphans"]);
  assert.deepEqual(AUTOMATIC_CLEANUP_LIMITS, {
    maximumFiles: 100,
    maximumBytes: 1_073_741_824,
    maximumDurationMs: 300_000,
    minimumIntervalSeconds: 86_400,
    minimumGraceSeconds: 604_800,
    reconciliationFreshnessSeconds: 691_200,
  });
  assert.equal(AUTOMATIC_CLEANUP_CATEGORY, "derived-orphans");
});

test("approval activation is typed, actor-bound, append-only, and default-off", async () => {
  await assert.rejects(
    setAutomaticCleanupApproval({
      executor: { connect: async () => assert.fail("invalid confirmation must fail before database access") },
      actor: { id: 8 },
      enabled: true,
      confirmation: "yes",
    }),
    new RegExp(AUTOMATIC_CLEANUP_CONFIRMATION)
  );
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (/SELECT revision/.test(sql)) return { rows: [{ revision: 4 }] };
      if (/INSERT INTO public\.storage_cleanup_automatic_approvals/.test(sql)) return { rows: [{
        category: AUTOMATIC_CLEANUP_CATEGORY,
        revision: 5,
        enabled: true,
        interval_seconds: 86_400,
        grace_seconds: 604_800,
        actor_user_id: 8,
        created_at: "2026-07-29T00:00:00Z",
      }] };
      return { rows: [] };
    },
    release() { calls.push({ sql: "RELEASE" }); },
  };
  const result = await setAutomaticCleanupApproval({
    executor: { connect: async () => client },
    actor: { id: 8 },
    enabled: true,
    confirmation: AUTOMATIC_CLEANUP_CONFIRMATION,
    intervalSeconds: 1,
    graceSeconds: 1,
    now: new Date("2026-07-29T00:00:00Z"),
  });
  assert.equal(result.revision, 5);
  assert.equal(result.actorUserId, 8);
  const insert = calls.find(({ sql }) => /INSERT INTO public\.storage_cleanup_automatic_approvals/.test(sql));
  assert.deepEqual(insert.values.slice(0, 6), [AUTOMATIC_CLEANUP_CATEGORY, 5, true, 86_400, 604_800, 8]);
  assert.equal(calls.find(({ sql }) => /audit_events/.test(sql)).values[1], "maintenance.automatic_cleanup_approved");
});

test("cleanup rejects hard-linked files before reference checks or unlink", async () => {
  let queried = false;
  let removed = false;
  const outcome = await validateAndDeleteCleanupCandidate({
    query: async () => { queried = true; return { rows: [{ referenced: false }] }; },
    storagePath: "/storage",
    item: {
      relative_path: "derived/vehicle.jpg",
      observed_size_bytes: 40,
      observed_modified_at: "2026-07-01T00:00:00Z",
    },
    fileLstat: async () => fileStats({ nlink: 2 }),
    resolveRealPath: async (value) => value,
    removeFile: async () => { removed = true; },
  });
  assert.deepEqual(outcome, { status: "skipped-unsafe", reclaimedBytes: 0 });
  assert.equal(queried, false);
  assert.equal(removed, false);
});

test("automatic claim requires latest fresh zero-error reconciliation and scan-time/age gates", async () => {
  const calls = [];
  const now = new Date("2026-07-29T12:00:00Z");
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (/storage_cleanup_automatic_approvals/.test(sql)) return { rows: [{ enabled: true, revision: 2, interval_seconds: 86_400, grace_seconds: 604_800 }] };
      if (/storage_cleanup_automatic_state[\s\S]*FOR UPDATE/.test(sql)) return { rows: [{ circuit_breaker_open: false, next_run_at: "2026-07-29T11:00:00Z" }] };
      if (/storage_reconciliation_runs ORDER BY/.test(sql)) return { rows: [{ id: 44, status: "completed", error_count: 0, scan_started_at: "2026-07-29T10:00:00Z", completed_at: "2026-07-29T11:00:00Z" }] };
      if (/WITH eligible AS/.test(sql)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO public\.maintenance_runs/.test(sql)) return { rows: [{ id: 90 }] };
      if (/SELECT \* FROM public\.maintenance_cleanup_items/.test(sql)) return { rows: [] };
      return { rows: [], rowCount: 0 };
    },
  };
  const claim = await automaticStorageCleanupInternals.claimAutomaticRun(client, now);
  assert.equal(claim.status, "running");
  assert.equal(claim.reconciliationRunId, 44);
  const eligibility = calls.find(({ sql }) => /WITH eligible AS/.test(sql));
  assert.match(eligibility.sql, /item\.modified_at < \$2::timestamptz/);
  assert.match(eligibility.sql, /make_interval\(secs => \$4\)/);
  assert.match(eligibility.sql, /cumulative_bytes <= \$5/);
  assert.match(eligibility.sql, /LIMIT \$6/);
  assert.deepEqual(eligibility.values.slice(4), [AUTOMATIC_CLEANUP_LIMITS.maximumBytes, AUTOMATIC_CLEANUP_LIMITS.maximumFiles]);
  const runInsert = calls.find(({ sql }) => /INSERT INTO public\.maintenance_runs/.test(sql));
  assert.match(runInsert.sql, /source_reconciliation_run_id/);
  assert.equal(runInsert.values[2], 44);
});

test("five-minute boundary completes a bounded partial run without opening the breaker", async () => {
  const calls = [];
  const start = new Date("2026-07-29T12:00:00Z");
  const times = [start, new Date(start.getTime() + 300_000), new Date(start.getTime() + 300_000)];
  const item = { id: 1, relative_path: "derived/a.jpg", observed_size_bytes: 40, observed_modified_at: "2026-07-01T00:00:00Z" };
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ locked: true }] };
      if (/storage_cleanup_automatic_approvals/.test(sql)) return { rows: [{ enabled: true, revision: 2, interval_seconds: 86_400, grace_seconds: 604_800 }] };
      if (/storage_cleanup_automatic_state[\s\S]*FOR UPDATE/.test(sql)) return { rows: [{ circuit_breaker_open: false, next_run_at: "2026-07-29T11:00:00Z" }] };
      if (/storage_reconciliation_runs ORDER BY/.test(sql)) return { rows: [{ id: 44, status: "completed", error_count: 0, scan_started_at: "2026-07-29T10:00:00Z", completed_at: "2026-07-29T11:00:00Z" }] };
      if (/WITH eligible AS/.test(sql)) return { rows: [{ relative_path: item.relative_path, size_bytes: 40, modified_at: item.observed_modified_at }], rowCount: 1 };
      if (/INSERT INTO public\.maintenance_runs/.test(sql)) return { rows: [{ id: 90 }] };
      if (/SELECT \* FROM public\.maintenance_cleanup_items/.test(sql)) return { rows: [item] };
      return { rows: [], rowCount: 0 };
    },
    release() { calls.push({ sql: "RELEASE" }); },
  };
  const result = await runScheduledStorageCleanup({
    pool: { connect: async () => client },
    storagePath: "/storage",
    now: () => times.shift() || times.at(-1) || new Date(start.getTime() + 300_000),
    processCandidate: async () => assert.fail("duration boundary must stop before unlink"),
  });
  assert.equal(result.status, "completed");
  assert.equal(result.boundedStop, true);
  assert.equal(calls.some(({ sql }) => /automatic_cleanup_suspended/.test(sql)), false);
  assert.equal(calls.some(({ sql }) => /status = 'completed'/.test(sql)), true);
  assert.equal(calls.some(({ sql }) => /job_name = 'storage-reconciliation'/.test(sql)), true);
});

test("breaker persistence makes reconciliation due and acknowledgement is separately typed", async () => {
  const calls = [];
  const client = { async query(sql, values) { calls.push({ sql, values }); return { rows: [] }; } };
  await automaticStorageCleanupInternals.openCircuitBreaker(client, {
    runId: 9,
    reconciliationRunId: 4,
    error: new Error("unlink failed"),
    now: new Date("2026-07-29T12:00:00Z"),
  });
  assert.equal(calls.some(({ sql }) => /circuit_breaker_open = TRUE/.test(sql)), true);
  assert.equal(calls.some(({ sql }) => /job_name = 'storage-reconciliation'/.test(sql)), true);
  assert.equal(AUTOMATIC_CLEANUP_ACKNOWLEDGEMENT, "ACKNOWLEDGE AUTOMATIC CLEANUP FAILURE");
});

test("acknowledgement immutably binds the failed run to the fresh reconciliation", async () => {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (/storage_cleanup_automatic_state[\s\S]*FOR UPDATE/.test(sql)) return { rows: [{
        circuit_breaker_open: true,
        circuit_breaker_opened_at: "2026-07-29T10:00:00Z",
        circuit_breaker_run_id: 55,
      }] };
      if (/FROM public\.storage_reconciliation_runs[\s\S]*scan_started_at >/.test(sql)) return { rowCount: 1, rows: [{ id: 60 }] };
      if (/SELECT \* FROM public\.storage_cleanup_automatic_approvals/.test(sql)) return { rows: [{ enabled: true, interval_seconds: 86_400 }] };
      return { rows: [] };
    },
    release() {},
  };
  const result = await acknowledgeAutomaticCleanupFailure({
    executor: { connect: async () => client },
    actor: { id: 8 },
    confirmation: AUTOMATIC_CLEANUP_ACKNOWLEDGEMENT,
    now: new Date("2026-07-29T12:00:00Z"),
  });
  assert.deepEqual(result, { acknowledged: true, acknowledgedRunId: 55, reconciliationRunId: 60 });
  const update = calls.find(({ sql }) => /acknowledged_run_id = \$7/.test(sql));
  assert.ok(update);
  assert.equal(update.values[5], 60);
  assert.equal(update.values[6], 55);
  assert.match(update.sql, /acknowledgement_reconciliation_run_id = \$6/);
});

test("acknowledged old failure stays cleared across later successful cleanup cycles", async () => {
  const hazardCalls = [];
  let reconciliationId = 61;
  let maintenanceRunId = 90;
  const state = {
    circuit_breaker_open: false,
    next_run_at: "2026-07-29T11:00:00Z",
    acknowledged_at: "2026-07-29T12:00:00Z",
    acknowledged_run_id: 55,
    acknowledgement_reconciliation_run_id: 60,
    source_reconciliation_run_id: 61,
  };
  const client = {
    async query(sql, values) {
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ locked: true }] };
      if (/SELECT \* FROM public\.storage_cleanup_automatic_approvals/.test(sql)) return { rows: [{ enabled: true, revision: 2, interval_seconds: 86_400, grace_seconds: 604_800 }] };
      if (/storage_cleanup_automatic_state[\s\S]*FOR UPDATE/.test(sql)) return { rows: [{ ...state }] };
      if (/FROM public\.maintenance_runs run/.test(sql)) {
        hazardCalls.push(values);
        return { rows: [{ id: 55, status: "failed", acknowledged_after_fresh_reconciliation: true }] };
      }
      if (/storage_reconciliation_runs ORDER BY/.test(sql)) return { rows: [{ id: reconciliationId, status: "completed", error_count: 0, scan_started_at: "2026-07-30T10:00:00Z", completed_at: "2026-07-30T11:00:00Z" }] };
      if (/WITH eligible AS/.test(sql)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO public\.maintenance_runs/.test(sql)) return { rows: [{ id: maintenanceRunId++ }] };
      if (/SELECT \* FROM public\.maintenance_cleanup_items/.test(sql)) return { rows: [] };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const first = await runScheduledStorageCleanup({
    pool: { connect: async () => client },
    storagePath: "/storage",
    now: () => new Date("2026-07-30T12:00:00Z"),
  });
  assert.equal(first.status, "completed");
  reconciliationId = 62;
  state.source_reconciliation_run_id = 62;
  state.next_run_at = "2026-07-31T11:00:00Z";
  const second = await runScheduledStorageCleanup({
    pool: { connect: async () => client },
    storagePath: "/storage",
    now: () => new Date("2026-07-31T12:00:00Z"),
  });
  assert.equal(second.status, "completed");
  assert.equal(hazardCalls.length, 2);
  for (const values of hazardCalls) {
    assert.equal(values[1], 55, "hazard acknowledgement stays bound to failed run 55");
    assert.equal(values[2], 60, "hazard acknowledgement stays bound to reconciliation 60");
  }
});

test("automatic candidate transactions apply remaining-budget database timeouts", async () => {
  const calls = [];
  const client = { async query(sql, values) { calls.push({ sql, values }); return { rows: [] }; } };
  await processCleanupCandidateTransaction({
    client,
    runId: 9,
    item: { id: 2 },
    storagePath: "/storage",
    lockTimeoutMs: 5_000,
    statementTimeoutMs: 123_456,
    deleteCandidate: async () => ({ status: "skipped-missing", reclaimedBytes: 0 }),
  });
  assert.equal(calls[0].sql, "BEGIN");
  assert.match(calls[1].sql, /set_config\('lock_timeout'/);
  assert.deepEqual(calls[1].values, ["5000ms", "123456ms"]);
  assert.match(calls[2].sql, /LOCK TABLE public\.plate_reads, public\.capture_assets IN SHARE MODE/);
});

test("crash recovery atomically opens the automatic breaker and makes reconciliation due", async () => {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ locked: true }] };
      if (/WITH interrupted/.test(sql)) return { rows: [{ id: 19 }] };
      return { rows: [] };
    },
    release() {},
  };
  const recovered = await recoverInterruptedStorageCleanupRuns({
    executor: { connect: async () => client },
    now: new Date("2026-07-29T12:00:00Z"),
  });
  assert.deepEqual(recovered, [19]);
  const recovery = calls.find(({ sql }) => /WITH interrupted/.test(sql)).sql;
  assert.match(recovery, /automatic_interrupted/);
  assert.match(recovery, /circuit_breaker_open = TRUE/);
  assert.match(recovery, /job_name = 'storage-reconciliation'/);
  assert.match(recovery, /maintenance\.automatic_cleanup_suspended/);
});

test("claim remains fail-closed when a failed automatic run lacks acknowledged fresh reconciliation", async () => {
  const calls = [];
  const client = { async query(sql, values) {
    calls.push({ sql, values });
    if (/storage_cleanup_automatic_approvals/.test(sql)) return { rows: [{ enabled: true, revision: 2, interval_seconds: 86_400, grace_seconds: 604_800 }] };
    if (/storage_cleanup_automatic_state[\s\S]*FOR UPDATE/.test(sql)) return { rows: [{ circuit_breaker_open: false, next_run_at: "2026-07-29T11:00:00Z", acknowledged_at: null }] };
    if (/FROM public\.maintenance_runs run/.test(sql)) return { rows: [{ id: 55, status: "failed", acknowledged_after_fresh_reconciliation: false }] };
    return { rows: [] };
  } };
  const result = await automaticStorageCleanupInternals.claimAutomaticRun(client, new Date("2026-07-29T12:00:00Z"));
  assert.deepEqual(result, { status: "suspended-invariant", runId: 55 });
  assert.equal(calls.some(({ sql }) => /WITH eligible AS/.test(sql)), false);
});

test("breaker persistence failure is surfaced while the run invariant remains fail-closed", async () => {
  let beginCount = 0;
  const item = { id: 1, relative_path: "derived/a.jpg", observed_size_bytes: 40, observed_modified_at: "2026-07-01T00:00:00Z" };
  const client = {
    async query(sql) {
      if (sql === "BEGIN") {
        beginCount += 1;
        if (beginCount === 2) throw new Error("breaker database unavailable");
        return { rows: [] };
      }
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ locked: true }] };
      if (/storage_cleanup_automatic_approvals/.test(sql)) return { rows: [{ enabled: true, revision: 2, interval_seconds: 86_400, grace_seconds: 604_800 }] };
      if (/storage_cleanup_automatic_state[\s\S]*FOR UPDATE/.test(sql)) return { rows: [{ circuit_breaker_open: false, next_run_at: "2026-07-29T11:00:00Z" }] };
      if (/FROM public\.maintenance_runs run/.test(sql)) return { rows: [] };
      if (/storage_reconciliation_runs ORDER BY/.test(sql)) return { rows: [{ id: 44, status: "completed", error_count: 0, scan_started_at: "2026-07-29T10:00:00Z", completed_at: "2026-07-29T11:00:00Z" }] };
      if (/WITH eligible AS/.test(sql)) return { rows: [{ relative_path: item.relative_path, size_bytes: 40, modified_at: item.observed_modified_at }], rowCount: 1 };
      if (/INSERT INTO public\.maintenance_runs/.test(sql)) return { rows: [{ id: 90 }] };
      if (/SELECT \* FROM public\.maintenance_cleanup_items/.test(sql)) return { rows: [item] };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  await assert.rejects(
    runScheduledStorageCleanup({
      pool: { connect: async () => client },
      storagePath: "/storage",
      now: () => new Date("2026-07-29T12:00:00Z"),
      processCandidate: async () => { throw new Error("candidate failed"); },
    }),
    /candidate failed; circuit breaker persistence failed: breaker database unavailable[\s\S]*failed\/running-run invariant/
  );
});

test("PostgreSQL maintenance observability is read-only and highlights table debt and XID age", async () => {
  let call = 0;
  const executor = { async query() {
    call += 1;
    if (call === 1) return { rows: [{ database_name: "alpr", database_bytes: 123, stats_reset: null }] };
    if (call === 2) return { rows: [{ table_count: 2, live_tuples: 20_000, dead_tuples: 12_000 }] };
    if (call === 3) return { rows: [{ schemaname: "public", relname: "plate_reads", live_tuples: 20_000, dead_tuples: 12_000, dead_percent: 37.5 }] };
    return { rows: [{ transaction_id_age: 10_000, freeze_max_age: 200_000_000 }] };
  } };
  const result = await getPostgresMaintenanceObservability({ executor });
  assert.equal(result.executionEnabled, false);
  assert.equal(result.tables[0].needsAttention, true);
  assert.equal(result.transactionIdAge, 10_000);
  const source = await readFile(new URL("../lib/postgres-maintenance-observability.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /VACUUM\s*\(|VACUUM\s+ANALYZE|spawn\(|exec\(/i);
});

test("schema and UI expose a separate admin permission and no backup/restore execution", async () => {
  const [migration, schema, actions, panel] = await Promise.all([
    readFile(new URL("../migrations.sql", import.meta.url), "utf8"),
    readFile(new URL("../schema.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/actions.js", import.meta.url), "utf8"),
    readFile(new URL("../app/settings/StorageMaintenancePanel.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(migration, /maintenance\.automatic_cleanup\.approve/);
  assert.match(migration, /storage_cleanup_automatic_approvals/);
  assert.match(migration, /source_reconciliation_run_id/);
  assert.match(migration, /maintenance_runs_source_reconciliation_fkey/);
  assert.match(migration, /storage_cleanup_state_source_reconciliation_fkey/);
  assert.match(migration, /storage_cleanup_state_acknowledged_run_fkey/);
  assert.match(migration, /storage_cleanup_state_ack_reconciliation_fkey/);
  assert.match(migration, /storage_cleanup_ack_evidence/);
  assert.match(migration, /conrelid = 'public\.storage_cleanup_automatic_state'::regclass/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS source_reconciliation_run_id BIGINT;/);
  assert.match(schema, /category = 'derived-orphans'/);
  assert.doesNotMatch(schema, /source_reconciliation_run_id BIGINT REFERENCES public\.storage_reconciliation_runs/);
  assert.match(actions, /setAutomaticStorageCleanupApproval[\s\S]*requirePermission\("maintenance\.automatic_cleanup\.approve"\)/);
  assert.match(panel, /ENABLE AUTOMATIC DERIVED CLEANUP|automatic\.activationConfirmation/);
  assert.match(panel, /PostgreSQL maintenance observability/);
  assert.match(panel, /scheduler admits new candidates for at most five minutes/);
  assert.match(panel, /\{automaticApproval\?\.enabled && \(/);
  assert.doesNotMatch(panel, /\{automaticApproval\?\.enabled && !automaticState\?\.circuitBreakerOpen/);
  assert.doesNotMatch(actions, /pg_dump|pg_restore|VACUUM\s+ANALYZE|docker\s+(?:rm|rmi)/i);
});
