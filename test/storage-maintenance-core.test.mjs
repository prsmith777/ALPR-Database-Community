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
import { MaintenanceAlertWorker } from "../lib/maintenance-alert-worker.mjs";
import {
  STORAGE_CLEANUP_CONFIRMATION,
  processCleanupCandidateTransaction,
  recoverInterruptedStorageCleanupRuns,
  storageCleanupInternals,
  validateAndDeleteCleanupCandidate,
} from "../lib/storage-cleanup.mjs";
import {
  clearStorageMaintenanceWebhook,
  publicStorageMaintenanceConfig,
  replaceStorageMaintenanceWebhook,
  saveStorageMaintenanceConfig,
  storageMaintenanceRepositoryInternals,
} from "../lib/storage-maintenance-repository.mjs";
import { deliverStorageMaintenanceWebhookTest } from "../lib/storage-maintenance-webhook.mjs";
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

test("new maintenance webhook deliveries never persist the destination URL", async () => {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [] };
    },
    release() {},
  };
  const repository = new MaintenanceAlertRepository({ pool: { connect: async () => client } });
  await repository.observe({
    eventKey: "storage.disk-usage",
    severity: "warning",
    message: "Storage is high.",
    details: { usedPercent: 85 },
    settings: {
      alertCooldownSeconds: 21_600,
      webhookEnabled: true,
      webhookUrl: "https://secret-hook.example.test/old",
    },
    now: new Date("2026-07-29T12:00:00.000Z"),
  });
  const insert = calls.find(({ sql }) => /INSERT INTO public\.maintenance_alert_deliveries/.test(sql));
  const payload = JSON.parse(insert.values[3]);
  assert.equal(Object.hasOwn(payload, "url"), false);
  assert.equal(JSON.stringify(payload).includes("secret-hook"), false);
});

test("maintenance webhook overview redacts destination-bearing delivery errors", async () => {
  const repository = new MaintenanceAlertRepository({
    pool: {
      async query(sql) {
        if (/maintenance_alert_state/.test(sql)) return { rows: [] };
        return { rows: [{
          id: 41,
          event_key: "storage.disk-usage",
          channel_type: "webhook",
          status: "dead",
          attempt_count: 2,
          max_attempts: 5,
          last_error: "TLS failed for https://secret-host.example.test/token-value",
        }] };
      },
    },
  });
  const overview = await repository.overview();
  assert.equal(overview.deliveries[0].lastError, "Webhook delivery failed; destination details are hidden.");
  assert.equal(JSON.stringify(overview).includes("secret-host"), false);
  assert.equal(JSON.stringify(overview).includes("token-value"), false);
});

test("maintenance webhook worker resolves the current destination at send time", async () => {
  const sent = [];
  const successes = [];
  let loadCount = 0;
  const repository = {
    async releaseExpiredLeases() {},
    async claimDue() {
      return [51, 52].map((id) => ({
        id,
        channelType: "webhook",
        payload: { url: "https://stale-secret.example.test/old", body: { event: "storage" } },
      }));
    },
    async recordSuccess(value) { successes.push(value); },
    async recordFailure() { assert.fail("current destination should deliver"); },
  };
  const worker = new MaintenanceAlertWorker({
    repository,
    loadConfig: async () => ({ notifications: { webhook: { enabled: true, signing_secret: "signing-secret" } } }),
    loadMaintenanceConfig: async () => {
      loadCount += 1;
      return {
        webhookEnabled: true,
        webhookUrl: `https://current-${loadCount}.example.test/new`,
      };
    },
    sendWebhook: async (request) => {
      sent.push(request);
      return { status: 204, requestId: request.payload.url };
    },
    logger: { warn() {}, error() {} },
  });
  const result = await worker.runBatch();
  assert.equal(loadCount, 2);
  assert.equal(sent[0].payload.url, "https://current-1.example.test/new");
  assert.equal(sent[1].payload.url, "https://current-2.example.test/new");
  assert.equal(JSON.stringify(sent).includes("stale-secret"), false);
  assert.deepEqual(successes.map((item) => item.response), [{ status: 204 }, { status: 204 }]);
  assert.equal(result.succeeded, 2);
});

test("maintenance webhook worker never sends after the destination is cleared", async () => {
  let failure = null;
  const repository = {
    async releaseExpiredLeases() {},
    async claimDue() { return [{ id: 52, channelType: "webhook", payload: { body: {} } }]; },
    async recordSuccess() { assert.fail("cleared destination cannot succeed"); },
    async recordFailure({ error }) { failure = error; return { status: "dead" }; },
  };
  const worker = new MaintenanceAlertWorker({
    repository,
    loadConfig: async () => ({ notifications: { webhook: { enabled: true, signing_secret: "secret" } } }),
    loadMaintenanceConfig: async () => ({ webhookEnabled: false, webhookUrl: "" }),
    sendWebhook: async () => assert.fail("cleared destination cannot be sent"),
    logger: { warn() {}, error() {} },
  });
  const result = await worker.runBatch();
  assert.equal(failure.retryable, false);
  assert.equal(result.dead, 1);
});

test("maintenance webhook worker only absorbs an explicit lease-loss race", async () => {
  function workerWithFailure(recordFailure) {
    return new MaintenanceAlertWorker({
      repository: {
        async releaseExpiredLeases() {},
        async claimDue() { return [{ id: 53, channelType: "webhook", payload: { body: {} } }]; },
        async recordSuccess() {},
        recordFailure,
      },
      loadConfig: async () => ({ notifications: { webhook: { enabled: true, signing_secret: "secret" } } }),
      loadMaintenanceConfig: async () => ({ webhookEnabled: false, webhookUrl: "" }),
      sendWebhook: async () => assert.fail("disabled destination cannot send"),
      logger: { warn() {}, error() {} },
    });
  }
  const retired = await workerWithFailure(async () => {
    throw new Error("Maintenance alert delivery lease was lost");
  }).runBatch();
  assert.equal(retired.retired, 1);
  await assert.rejects(
    () => workerWithFailure(async () => { throw new Error("database unavailable"); }).runBatch(),
    /database unavailable/
  );
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
      if (/SELECT webhook_url/.test(sql)) {
        return { rows: [{ webhook_url: "https://saved-secret.example.test/alpr" }] };
      }
      if (/RETURNING \*/.test(sql)) return { rows: [{
        warning_percent: 75,
        critical_percent: 90,
        check_interval_seconds: 3600,
        stale_after_seconds: 10800,
        alert_cooldown_seconds: 21600,
        email_recipients: [],
        webhook_enabled: false,
        webhook_url: "https://saved-secret.example.test/alpr",
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
  assert.equal(saved.webhookConfigured, true);
  assert.equal(Object.hasOwn(saved, "webhookUrl"), false);
  assert.equal(JSON.stringify(saved).includes("saved-secret"), false);
  assert.equal(calls[0].sql, "BEGIN");
  assert.equal(calls.at(-2).sql, "COMMIT");
  assert.equal(calls.some(({ sql }) => /maintenance\.storage_config_updated/.test(sql)), true);
  const update = calls.find(({ sql }) => /UPDATE public\.storage_maintenance_config SET/.test(sql));
  assert.doesNotMatch(update.sql, /webhook_url\s*=/);
});

test("maintenance webhook destination is omitted from every public config shape", () => {
  const privateConfig = storageMaintenanceRepositoryInternals.configFromRow({
    warning_percent: 80,
    critical_percent: 90,
    webhook_enabled: true,
    webhook_url: "https://secret-hook.example.test/alpr",
  });
  const publicConfig = publicStorageMaintenanceConfig(privateConfig);
  assert.equal(publicConfig.webhookConfigured, true);
  assert.equal(Object.hasOwn(publicConfig, "webhookUrl"), false);
  assert.equal(JSON.stringify(publicConfig).includes("secret-hook"), false);
});

test("maintenance webhook replace and clear are explicit, audited, and never return the URL", async () => {
  async function run(operation) {
    const calls = [];
    const client = {
      async query(sql, values) {
        calls.push({ sql, values });
        if (/RETURNING \*/.test(sql)) {
          return { rows: [{
            warning_percent: 80,
            critical_percent: 90,
            webhook_enabled: operation === "replace",
            webhook_url: operation === "replace" ? "https://secret-hook.example.test/alpr" : null,
          }] };
        }
        return { rows: [] };
      },
      release() { calls.push({ sql: "RELEASE" }); },
    };
    const executor = { connect: async () => client };
    const result = operation === "replace"
      ? await replaceStorageMaintenanceWebhook({
          executor,
          actor: { id: 9 },
          webhookUrl: "https://secret-hook.example.test/alpr",
        })
      : await clearStorageMaintenanceWebhook({ executor, actor: { id: 9 } });
    return { calls, result };
  }

  const replaced = await run("replace");
  assert.equal(replaced.result.webhookConfigured, true);
  assert.equal(Object.hasOwn(replaced.result, "webhookUrl"), false);
  assert.match(replaced.calls.find(({ sql }) => /audit_events/.test(sql)).values[1], /replaced/);
  assert.equal(JSON.stringify(replaced.calls.find(({ sql }) => /audit_events/.test(sql)).values).includes("secret-hook"), false);
  const replaceScrub = replaced.calls.find(({ sql }) => /UPDATE public\.maintenance_alert_deliveries/.test(sql));
  assert.match(replaceScrub.sql, /payload = payload - 'url'/);
  assert.match(replaceScrub.sql, /Maintenance webhook delivery error details were redacted/);
  assert.doesNotMatch(replaceScrub.sql, /THEN 'dead'/);

  const cleared = await run("clear");
  assert.equal(cleared.result.webhookConfigured, false);
  assert.equal(cleared.result.webhookEnabled, false);
  assert.match(cleared.calls.find(({ sql }) => /audit_events/.test(sql)).values[1], /cleared/);
  const clearRetirement = cleared.calls.find(({ sql }) => /UPDATE public\.maintenance_alert_deliveries/.test(sql));
  assert.match(clearRetirement.sql, /status IN \('pending', 'retry', 'processing'\) THEN 'dead'/);
  assert.match(clearRetirement.sql, /locked_at = CASE[\s\S]*THEN NULL/);
  assert.match(clearRetirement.sql, /Maintenance webhook delivery error details were redacted/);
});

test("maintenance webhook test reuses one event identity and does not return its destination", async () => {
  let sent = null;
  const result = await deliverStorageMaintenanceWebhookTest({
    savedWebhookUrl: "https://secret-hook.example.test/alpr",
    applicationConfig: { notifications: { webhook: { enabled: true, signing_secret: "signing-secret" } } },
    now: () => new Date("2026-07-29T12:00:00.000Z"),
    sendWebhook: async (request) => {
      sent = request;
      return { status: 204, requestId: "https://secret-hook.example.test/alpr?reflected=1" };
    },
  });
  assert.equal(sent.payload.eventId, sent.payload.idempotencyKey);
  assert.equal(sent.payload.url, "https://secret-hook.example.test/alpr");
  assert.equal(result.usedSavedDestination, true);
  assert.equal(Object.hasOwn(result, "url"), false);
  assert.equal(Object.hasOwn(result, "requestId"), false);
  assert.equal(JSON.stringify(result).includes("secret-hook"), false);
});

test("maintenance webhook UI exposes configured state and explicit write-only controls", async () => {
  const [panel, actions, service] = await Promise.all([
    readFile(new URL("../app/settings/StorageMaintenancePanel.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/actions.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/storage-maintenance-service.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(panel, /webhookConfigured \? "Configured" : "Not configured"/);
  assert.match(panel, />Replace<\/Button>/);
  assert.match(panel, />Test<\/Button>/);
  assert.match(panel, />Clear<\/Button>/);
  assert.match(panel, /request already in flight during either change may still finish/i);
  assert.doesNotMatch(panel, /settings\.webhookUrl/);
  assert.match(actions, /replaceStorageMaintenanceWebhookDestination[\s\S]*requirePermission\("maintenance\.manage"\)/);
  assert.match(actions, /testStorageMaintenanceWebhookDestination[\s\S]*requirePermission\("maintenance\.manage"\)/);
  assert.match(actions, /clearStorageMaintenanceWebhookDestination[\s\S]*requirePermission\("maintenance\.manage"\)/);
  assert.match(service, /settings: publicStorageMaintenanceConfig\(settings\)/);
  const failureHandler = actions.slice(
    actions.indexOf("function storageMaintenanceFailure"),
    actions.indexOf("export async function saveStorageMaintenanceSettings")
  );
  assert.doesNotMatch(failureHandler, /console\.error[\s\S]*error:\s*candidate/);
  assert.match(failureHandler, /errorName:/);
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
  assert.match(migration, /UPDATE public\.maintenance_alert_deliveries[\s\S]*payload = payload - 'url'/);
  assert.match(migration, /Maintenance webhook delivery error details were redacted/);
  assert.match(cleanup, /maintenance\.storage_cleanup_started/);
  assert.match(cleanup, /maintenance\.storage_cleanup_interrupted/);
  assert.match(captureWriter, /withDerivedStorageWriterLock\(writeReadyAsset\)/);
  assert.match(blueIrisWriter, /withDerivedStorageWriterLock\(writeReadyFrame\)/);
});
