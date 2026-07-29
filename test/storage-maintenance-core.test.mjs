import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  automaticCleanupDecision,
  DEFAULT_STORAGE_MAINTENANCE_CONFIG,
  isMaintenanceSchedulerDisabled,
  normalizeStorageMaintenanceConfig,
  runtimeLiveness,
  storageMonitorFailureDelay,
  storageSeverity,
} from "../lib/storage-maintenance-policy.mjs";
import {
  collectStorageBreakdown,
  measureStorageTree,
  normalizeHostStorageSnapshot,
  readHostStorageSnapshot,
} from "../lib/storage-breakdown.mjs";
import { decideMaintenanceAlert } from "../lib/maintenance-alerts.mjs";
import { MaintenanceAlertRepository } from "../lib/maintenance-alert-repository.mjs";
import {
  STORAGE_CLEANUP_CONFIRMATION,
  processCleanupCandidateTransaction,
  recoverInterruptedStorageCleanupRuns,
  storageCleanupInternals,
  validateAndDeleteCleanupCandidate,
} from "../lib/storage-cleanup.mjs";
import { saveStorageMaintenanceConfig } from "../lib/storage-maintenance-repository.mjs";
import { withStorageCleanupWriterLock } from "../lib/storage-maintenance-lock.mjs";

function fileStats({ size = 10, mtime = "2026-07-01T00:00:00.000Z", symlink = false, dev = 1, ino = 2 } = {}) {
  return {
    size,
    mtime: new Date(mtime),
    dev,
    ino,
    isFile: () => !symlink,
    isSymbolicLink: () => symlink,
  };
}

test("storage maintenance defaults align with an hourly healthy scheduler and automation stays impossible", () => {
  assert.equal(DEFAULT_STORAGE_MAINTENANCE_CONFIG.checkIntervalSeconds, 3600);
  assert.equal(DEFAULT_STORAGE_MAINTENANCE_CONFIG.staleAfterSeconds, 10_800);
  const normalized = normalizeStorageMaintenanceConfig({
    warningPercent: 95,
    criticalPercent: 90,
    cleanupEnabled: true,
    automaticCategories: ["derived"],
  });
  assert.equal(normalized.criticalPercent > normalized.warningPercent, true);
  assert.equal(normalized.cleanupEnabled, false);
  assert.deepEqual(normalized.automaticCategories, []);
  assert.deepEqual(automaticCleanupDecision(normalized).categories, []);
  assert.equal(storageSeverity(79.9, normalized), "ok");
  assert.equal(storageSeverity(95, normalized), "warning");
  assert.equal(storageSeverity(99, normalized), "critical");
  assert.equal(runtimeLiveness("2026-07-29T00:00:00Z", {
    now: "2026-07-29T02:59:59Z",
    staleAfterSeconds: normalized.staleAfterSeconds,
  }).status, "healthy");
  assert.equal(isMaintenanceSchedulerDisabled({
    maintenance: { enabled: false },
    reconciliation: { enabled: false },
  }), true);
  assert.equal(isMaintenanceSchedulerDisabled({
    maintenance: { enabled: true },
    reconciliation: { enabled: false },
  }), false);
});

test("maintenance alert policy rate-limits repeats but immediately sends escalation and one recovery", () => {
  const warning = {
    severity: "warning",
    last_notified_at: "2026-07-29T00:00:00.000Z",
    next_eligible_at: "2026-07-29T06:00:00.000Z",
  };
  assert.equal(decideMaintenanceAlert({ previous: warning, severity: "warning", now: "2026-07-29T01:00:00Z" }).reason, "rate-limited");
  assert.equal(decideMaintenanceAlert({ previous: warning, severity: "critical", now: "2026-07-29T01:00:00Z" }).reason, "escalated");
  const recovery = decideMaintenanceAlert({ previous: warning, severity: "ok", now: "2026-07-29T01:00:00Z" });
  assert.equal(recovery.notify, true);
  assert.equal(recovery.reason, "recovered");
  const briefRecovery = {
    severity: "ok",
    resolved_at: "2026-07-29T01:00:00.000Z",
    last_notified_at: "2026-07-29T01:00:00.000Z",
    next_eligible_at: "2026-07-29T07:00:00.000Z",
  };
  assert.equal(decideMaintenanceAlert({
    previous: briefRecovery,
    severity: "warning",
    now: "2026-07-29T02:00:00Z",
  }).reason, "rate-limited");
  assert.equal(decideMaintenanceAlert({
    previous: briefRecovery,
    severity: "critical",
    now: "2026-07-29T02:00:00Z",
  }).reason, "escalated");
  assert.equal(decideMaintenanceAlert({ previous: { severity: "ok" }, severity: "ok" }).notify, false);
});

test("rate-limited alert observations persist an explicit suppression count without enqueueing delivery", async () => {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (/SELECT \* FROM public\.maintenance_alert_state/.test(sql)) {
        return { rows: [{
          event_key: "storage.disk-usage",
          severity: "warning",
          last_notified_at: "2026-07-29T00:00:00.000Z",
          next_eligible_at: "2026-07-29T06:00:00.000Z",
        }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const repository = new MaintenanceAlertRepository({ pool: { connect: async () => client } });
  const observed = await repository.observe({
    eventKey: "storage.disk-usage",
    severity: "warning",
    message: "Storage remains high.",
    details: { usedPercent: 82 },
    settings: { alertCooldownSeconds: 21_600, emailEnabled: true, emailRecipients: ["admin@example.com"] },
    now: new Date("2026-07-29T01:00:00.000Z"),
  });
  assert.equal(observed.reason, "rate-limited");
  assert.equal(observed.notified, false);
  const stateWrite = calls.find(({ sql }) => /suppressed_count, details/.test(sql));
  assert.equal(stateWrite.values[7], 1);
  assert.equal(calls.some(({ sql }) => /INSERT INTO public\.maintenance_alert_deliveries/.test(sql)), false);
});

test("host storage snapshots are exact, exclude Docker volumes, and reject stale or symbolic-link inputs", async () => {
  const snapshot = normalizeHostStorageSnapshot({
    schemaVersion: 1,
    measuredAt: "2026-07-29T12:00:00.000Z",
    docker: { imagesBytes: 10, containersBytes: 20, buildCacheBytes: 30, totalBytes: 60 },
    backups: { bytes: 70, count: 2, latestVerifiedAt: "2026-07-29T11:00:00.000Z" },
  }, { now: "2026-07-29T12:05:00.000Z" });
  assert.equal(snapshot.docker.bytes, 60);
  assert.match(snapshot.docker.note, /volumes are excluded/i);
  await assert.rejects(async () => normalizeHostStorageSnapshot({ ...snapshot, measuredAt: "2026-07-28T00:00:00Z" }, {
    now: "2026-07-29T12:05:00Z",
  }), /stale/);
  assert.throws(() => normalizeHostStorageSnapshot({
    schemaVersion: 1,
    measuredAt: "2026-07-29T12:10:01.000Z",
    docker: { imagesBytes: 0, containersBytes: 0, buildCacheBytes: 0, totalBytes: 0 },
    backups: { bytes: 0, count: 0 },
  }, { now: "2026-07-29T12:00:00.000Z" }), /future-dated/);
  const linked = await readHostStorageSnapshot({
    snapshotPath: "/metrics.json",
    fileStat: async () => ({ isFile: () => false, isSymbolicLink: () => true }),
    read: async () => "{}",
  });
  assert.match(linked.error, /regular file/);
});

test("storage tree traversal stops at hard bounds and labels partial measurements", async () => {
  const entries = ["one.jpg", "two.jpg"].map((name) => ({
    name,
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
  }));
  const bounded = await measureStorageTree("/storage/images", {
    readDirectory: async () => entries,
    pathStat: async () => fileStats({ size: 10 }),
    maxFiles: 1,
    maxDepth: 2,
    timeBudgetMs: 1000,
    clock: () => 0,
  });
  assert.equal(bounded.count, 1);
  assert.equal(bounded.partial, true);
  assert.deepEqual(bounded.partialReasons, ["max-files"]);
});

test("exact storage breakdown uses a single-flight cache", async () => {
  let measurementCalls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const measureTree = async () => {
    measurementCalls += 1;
    await gate;
    return { bytes: 10, count: 1, skipped: 0, errorCount: 0 };
  };
  const options = {
    storagePath: "/storage",
    databaseBytes: 5,
    hostSnapshotPath: "",
    cacheHost: {},
    now: "2026-07-29T12:00:00Z",
    measureTree,
    loadHostSnapshot: async () => ({ snapshot: null, error: null }),
  };
  const cacheHost = {};
  const first = collectStorageBreakdown({ ...options, cacheHost });
  const second = collectStorageBreakdown({ ...options, cacheHost });
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left, right);
  assert.equal(measurementCalls, 3);
  assert.equal(left.sourceImages.bytes, 10);
});

test("manual cleanup accepts only unchanged, unreferenced derived files and checks all five reference columns", async () => {
  const calls = [];
  let removed = null;
  const candidate = {
    relative_path: "derived/2026/vehicle.jpg",
    observed_size_bytes: 40,
    observed_modified_at: "2026-07-01T00:00:00.000Z",
  };
  const outcome = await validateAndDeleteCleanupCandidate({
    query: async (sql, values) => {
      calls.push({ sql, values });
      return { rows: [{ referenced: false }] };
    },
    storagePath: "/storage",
    item: candidate,
    fileLstat: async () => fileStats({ size: 40 }),
    resolveRealPath: async (value) => value,
    removeFile: async (value) => { removed = value; },
  });
  assert.deepEqual(outcome, { status: "deleted", reclaimedBytes: 40 });
  assert.match(removed.replaceAll("\\", "/"), /\/storage\/derived\/2026\/vehicle\.jpg$/);
  assert.deepEqual(calls[0].values, [candidate.relative_path]);
  for (const column of ["image_path", "thumbnail_path", "vehicle_image_path", "source_image_path", "derived_path"]) {
    assert.match(calls[0].sql, new RegExp(column));
  }
  await assert.rejects(() => validateAndDeleteCleanupCandidate({
    query: async () => ({ rows: [{ referenced: false }] }),
    storagePath: "/storage",
    item: { ...candidate, relative_path: "images/source.jpg" },
  }), /Only derived-file orphans/);
});

test("manual cleanup rejects a symbolic-link ancestor even when its real target remains inside storage", async () => {
  const candidate = {
    relative_path: "derived/link/vehicle.jpg",
    observed_size_bytes: 40,
    observed_modified_at: "2026-07-01T00:00:00.000Z",
  };
  await assert.rejects(() => validateAndDeleteCleanupCandidate({
    query: async () => ({ rows: [{ referenced: false }] }),
    storagePath: "/storage",
    item: candidate,
    fileLstat: async (value) => fileStats({
      size: 40,
      symlink: value.replaceAll("\\", "/").endsWith("/derived/link"),
    }),
    resolveRealPath: async (value) => value.replace("/derived/link", "/derived/real"),
    removeFile: async () => assert.fail("symbolic-link candidate must not be removed"),
  }), /symbolic links/);
});

test("cleanup locks both reference tables before checking references and unlinking", async () => {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [] };
    },
  };
  const outcome = await processCleanupCandidateTransaction({
    client,
    runId: 22,
    item: { id: 33, observed_size_bytes: 40 },
    storagePath: "/storage",
    completedAt: () => new Date("2026-07-29T12:00:00Z"),
    deleteCandidate: async ({ query }) => {
      await query("SELECT five_column_reference_check");
      calls.push({ sql: "UNLINK derived/file.jpg" });
      return { status: "deleted", reclaimedBytes: 40 };
    },
  });
  assert.equal(outcome.status, "deleted");
  assert.deepEqual(calls.slice(0, 5).map(({ sql }) => sql.split("\n")[0]), [
    "BEGIN",
    "LOCK TABLE public.plate_reads, public.capture_assets IN SHARE MODE",
    "SELECT five_column_reference_check",
    "UNLINK derived/file.jpg",
    "UPDATE public.maintenance_cleanup_items SET",
  ]);
  assert.equal(calls.at(-1).sql, "COMMIT");
});

test("derived writers hold a shared cleanup advisory lock across file and reference writes", async () => {
  const events = [];
  let poolConnects = 0;
  const client = {
    async query(sql) { events.push(sql); return { rows: [] }; },
    release(error) { events.push(error ? "DESTROY" : "RELEASE"); },
  };
  await withStorageCleanupWriterLock({ connect: async () => {
    poolConnects += 1;
    return client;
  } }, async (lockedClient) => {
    events.push("WRITE DERIVED FILE");
    await lockedClient.query("COMMIT DERIVED REFERENCE");
  });
  assert.equal(poolConnects, 1);
  assert.deepEqual(events, [
    "SELECT pg_advisory_lock_shared(hashtext($1))",
    "WRITE DERIVED FILE",
    "COMMIT DERIVED REFERENCE",
    "SELECT pg_advisory_unlock_shared(hashtext($1))",
    "RELEASE",
  ]);
  assert.equal(storageMonitorFailureDelay(3600), 300);
  assert.equal(storageMonitorFailureDelay(0), 30);
});

test("an advisory unlock failure destroys the pooled session", async () => {
  const releases = [];
  const unlockError = new Error("connection lost during unlock");
  const client = {
    async query(sql) {
      if (/unlock_shared/.test(sql)) throw unlockError;
      return { rows: [] };
    },
    release(error) { releases.push(error); },
  };
  await assert.rejects(
    withStorageCleanupWriterLock({ connect: async () => client }, async () => "done"),
    /connection lost during unlock/
  );
  assert.deepEqual(releases, [unlockError]);
});

test("post-unlink bookkeeping failure rolls back and persists reconciliation-required failure", async () => {
  const calls = [];
  let firstUpdate = true;
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (/UPDATE public\.maintenance_cleanup_items SET/.test(sql) && firstUpdate) {
        firstUpdate = false;
        throw new Error("write interrupted");
      }
      return { rows: [] };
    },
  };
  const outcome = await processCleanupCandidateTransaction({
    client,
    runId: 22,
    item: { id: 33, observed_size_bytes: 40 },
    storagePath: "/storage",
    deleteCandidate: async () => ({ status: "deleted", reclaimedBytes: 40 }),
  });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.reconciliationRequired, true);
  assert.equal(outcome.reclaimedBytes, 40);
  assert.deepEqual(calls.filter(({ sql }) => ["BEGIN", "ROLLBACK", "COMMIT"].includes(sql)).map(({ sql }) => sql), [
    "BEGIN", "ROLLBACK", "BEGIN", "COMMIT",
  ]);
});

test("interrupted cleanup recovery returns without marking while the cleanup advisory lock is active", async () => {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ locked: false }] };
      throw new Error("Recovery update must not run while cleanup is active");
    },
    release() { calls.push({ sql: "RELEASE" }); },
  };
  const recovered = await recoverInterruptedStorageCleanupRuns({ executor: { connect: async () => client } });
  assert.deepEqual(recovered, []);
  assert.equal(calls.some(({ sql }) => /WITH interrupted/.test(sql)), false);
  assert.equal(calls.at(-1).sql, "RELEASE");
});

test("interrupted cleanup recovery casts its timestamp parameter explicitly", async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ locked: true }] };
      return { rows: [] };
    },
    release() {},
  };
  await recoverInterruptedStorageCleanupRuns({
    executor: { connect: async () => client },
    now: new Date("2026-07-29T19:00:00.000Z"),
  });
  const recoverySql = calls.find((sql) => /WITH interrupted/.test(sql));
  assert.match(recoverySql, /completed_at = \$1::timestamptz/);
  assert.match(recoverySql, /started_at < \$1::timestamptz - make_interval/);
});

test("cleanup preview tokens are actor-bound when claimed", async () => {
  let actorParameter = null;
  const client = {
    async query(sql, values) {
      if (/preview\.actor_user_id IS NOT DISTINCT/.test(sql)) {
        actorParameter = values[1];
        return { rows: [] };
      }
      return { rows: [] };
    },
    release() {},
  };
  await assert.rejects(() => storageCleanupInternals.claimCleanupExecution({
    pool: { connect: async () => client },
    previewToken: "token",
    confirmation: STORAGE_CLEANUP_CONFIRMATION,
    actor: { id: 9 },
    now: new Date(),
  }), /invalid or has already been used/);
  assert.equal(actorParameter, 9);
});

test("maintenance settings update and audit use one transaction and force destructive defaults off", async () => {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (/RETURNING \*/.test(sql)) return { rows: [{
        warning_percent: 75,
        critical_percent: 90,
        check_interval_seconds: 3600,
        stale_after_seconds: 10800,
        alert_cooldown_seconds: 21600,
        email_recipients: [],
        cleanup_enabled: false,
        cleanup_interval_seconds: 86400,
        automatic_categories: [],
        orphan_grace_seconds: 604800,
      }] };
      return { rows: [] };
    },
    release() { calls.push({ sql: "RELEASE" }); },
  };
  const saved = await saveStorageMaintenanceConfig({
    executor: { connect: async () => client },
    config: { warningPercent: 75, criticalPercent: 90, cleanupEnabled: true, automaticCategories: ["derived"] },
    actor: { id: 9 },
  });
  assert.equal(saved.cleanupEnabled, false);
  assert.deepEqual(saved.automaticCategories, []);
  assert.equal(calls[0].sql, "BEGIN");
  assert.equal(calls.at(-2).sql, "COMMIT");
  assert.equal(calls.some(({ sql }) => /maintenance\.storage_config_updated/.test(sql)), true);
});

test("schema and migration preserve the empty auto allowlist and no domain-record cleanup SQL", async () => {
  const [migration, schema, cleanup, captureWriter, blueIrisWriter] = await Promise.all([
    readFile(new URL("../migrations.sql", import.meta.url), "utf8"),
    readFile(new URL("../schema.sql", import.meta.url), "utf8"),
    readFile(new URL("../lib/storage-cleanup.mjs", import.meta.url), "utf8"),
    readFile(new URL("../lib/capture-asset-service.mjs", import.meta.url), "utf8"),
    readFile(new URL("../lib/blue-iris-vehicle-frame.mjs", import.meta.url), "utf8"),
  ]);
  for (const source of [migration, schema]) {
    assert.match(source, /storage_maintenance_automatic_categories_empty/);
    assert.match(source, /automatic_categories = '\[\]'::JSONB/);
    assert.match(source, /suppressed_count BIGINT NOT NULL DEFAULT 0/);
  }
  assert.equal(STORAGE_CLEANUP_CONFIRMATION, "DELETE DERIVED ORPHANS");
  assert.doesNotMatch(cleanup, /DELETE\s+FROM\s+public\.(?:plate_reads|capture_assets)|TRUNCATE/i);
  assert.match(storageCleanupInternals.REFERENCE_CHECK_SQL, /source_image_path/);
  assert.match(migration, /updated_by_user_id BIGINT REFERENCES public\.users\(id\) ON DELETE SET NULL/);
  assert.match(migration, /notification_rule_cutover_events[\s\S]*actor_user_id BIGINT REFERENCES public\.users\(id\) ON DELETE SET NULL/);
  assert.match(migration, /constraint_record\.contype = 'f'[\s\S]*column_record\.attname = 'updated_by_user_id'/);
  assert.match(cleanup, /maintenance\.storage_cleanup_started/);
  assert.match(cleanup, /maintenance\.storage_cleanup_interrupted/);
  assert.match(captureWriter, /withDerivedStorageWriterLock\(writeReadyAsset\)/);
  assert.match(blueIrisWriter, /withDerivedStorageWriterLock\(writeReadyFrame\)/);
});
