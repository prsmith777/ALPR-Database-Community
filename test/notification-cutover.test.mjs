import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  NotificationCutoverRepository,
  notificationCutoverRepositoryInternals,
} from "../lib/notification-cutover-repository.mjs";

function approvedShadow(status = "approved") {
  const intentional = status === "approved_intentional";
  const current = status === "approved" || intentional;
  return {
    rules: [
      {
        targetRule: { id: 51 },
        status,
        positiveMatchCount: status === "approved" ? 5 : 0,
        unifiedPositiveMatchCount: intentional ? 4 : status === "approved" ? 5 : 0,
        mismatchCount: intentional ? 4 : 0,
        expansionCount: intentional ? 4 : 0,
        regressionCount: 0,
        reportFingerprint: "a".repeat(64),
        latestReview: {
          current,
          approvalMode: intentional ? "intentional_expansion" : "parity",
        },
      },
    ],
  };
}

function transactionalPool({ cutoverActive = false, shadowStatus = "approved", destinationMismatch = false } = {}) {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, values });
      if (normalized.includes("WHERE r.id = $1::bigint") && normalized.includes("FOR UPDATE OF r")) {
        return {
          rows: [{
            migration_id: 10,
            source_type: "mqtt",
            source_id: 7,
            target_rule_id: 51,
            name: "Family arrival",
            enabled: cutoverActive,
            version: 2,
            cooldown_seconds: 0,
          }],
        };
      }
      if (normalized.includes("FROM public.mqtt_rules") && normalized.endsWith("FOR UPDATE")) {
        return { rows: [{
          id: 7,
          enabled: !cutoverActive,
          broker_id: 2,
          destination_mode: "fixed_topic",
          fixed_topic: "Blue Iris/ALPR/family",
          message: "Family arrived",
        }] };
      }
      if (normalized.startsWith("SELECT a.id AS action_id")) {
        return {
          rows: [{
            action_id: 71,
            action_enabled: cutoverActive,
            channel_id: 81,
            channel_enabled: cutoverActive,
            channel_type: "mqtt",
            credential_reference: "mqtt-broker:2",
            configuration: {
              brokerId: 2,
              destinationMode: "fixed_topic",
              fixedTopic: destinationMismatch ? "wrong/topic" : "Blue Iris/ALPR/family",
              message: "Family arrived",
            },
          }],
        };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  return {
    calls,
    pool: { query: (...args) => client.query(...args), connect: async () => client },
    shadowRepositoryFactory: () => ({ async review() { return approvedShadow(shadowStatus); } }),
  };
}

function orphanedPool({ sourceExists = false, transitionCount = 0, deliveryEnabled = false } = {}) {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, values });
      if (
        normalized.includes("AS source_exists") &&
        normalized.includes("FOR UPDATE OF m, r")
      ) {
        return {
          rows: [{
            migration_id: 12,
            source_type: "mqtt",
            source_id: 99,
            target_rule_id: 61,
            name: "Removed delivery rule",
            enabled: false,
            version: 3,
            source_exists: sourceExists,
            transition_count: transitionCount,
          }],
        };
      }
      if (normalized.startsWith("SELECT a.id AS action_id")) {
        return {
          rows: [{
            action_id: 71,
            action_enabled: deliveryEnabled,
            channel_id: 81,
            channel_enabled: deliveryEnabled,
          }],
        };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  return {
    calls,
    pool: { query: (...args) => client.query(...args), connect: async () => client },
  };
}

test("guarded cutover atomically disables legacy before enabling the approved unified rule", async () => {
  const fixture = transactionalPool();
  const repository = new NotificationCutoverRepository({
    pool: fixture.pool,
    shadowRepositoryFactory: fixture.shadowRepositoryFactory,
  });
  const result = await repository.cutover({ ruleId: 51, actor: { id: 9 } });

  assert.deepEqual(result, {
    ruleId: 51,
    state: "unified_active",
    legacyEnabled: false,
    unifiedEnabled: true,
  });
  const legacyOff = fixture.calls.findIndex(({ sql }) => sql.startsWith("UPDATE public.mqtt_rules SET enabled = FALSE"));
  const unifiedOn = fixture.calls.findIndex(({ sql }) => sql.startsWith("UPDATE public.notification_rules SET enabled = TRUE"));
  assert.ok(legacyOff >= 0 && unifiedOn > legacyOff);
  assert.ok(fixture.calls.some(({ sql }) => sql.includes("INSERT INTO public.notification_rule_cutover_events")));
  assert.ok(fixture.calls.some(({ sql, values }) =>
    sql.includes("INSERT INTO public.audit_events") && values[1] === "notification.rule_cutover"
  ));
  assert.ok(fixture.calls.some(({ sql }) => sql === "COMMIT"));
});

test("guarded cutover accepts a current approved expansion with no lost legacy matches", async () => {
  const fixture = transactionalPool({ shadowStatus: "approved_intentional" });
  const repository = new NotificationCutoverRepository({
    pool: fixture.pool,
    shadowRepositoryFactory: fixture.shadowRepositoryFactory,
  });
  const result = await repository.cutover({ ruleId: 51, actor: { id: 9 } });
  assert.equal(result.state, "unified_active");
  const event = fixture.calls.find(({ sql }) =>
    sql.includes("INSERT INTO public.notification_rule_cutover_events")
  );
  assert.ok(event);
  const metadata = JSON.parse(event.values[4]);
  assert.equal(metadata.approvalMode, "intentional_expansion");
  assert.equal(metadata.expansionCount, 4);
  assert.equal(metadata.regressionCount, 0);
});

test("cutover is refused when positive evidence is not currently approved", async () => {
  const fixture = transactionalPool({ shadowStatus: "no_positive_matches" });
  const repository = new NotificationCutoverRepository({
    pool: fixture.pool,
    shadowRepositoryFactory: fixture.shadowRepositoryFactory,
  });
  await assert.rejects(
    repository.cutover({ ruleId: 51, actor: { id: 9 } }),
    /current administrator-approved shadow evidence/
  );
  assert.ok(fixture.calls.some(({ sql }) => sql === "ROLLBACK"));
  assert.ok(!fixture.calls.some(({ sql }) => sql.startsWith("UPDATE public.mqtt_rules SET enabled = FALSE")));
});

test("cutover is refused when the disabled unified destination drifted from legacy", async () => {
  const fixture = transactionalPool({ destinationMismatch: true });
  const repository = new NotificationCutoverRepository({
    pool: fixture.pool,
    shadowRepositoryFactory: fixture.shadowRepositoryFactory,
  });
  await assert.rejects(
    repository.cutover({ ruleId: 51, actor: { id: 9 } }),
    /destination no longer matches the legacy source rule/
  );
  assert.ok(fixture.calls.some(({ sql }) => sql === "ROLLBACK"));
  assert.ok(!fixture.calls.some(({ sql }) => sql.startsWith("UPDATE public.mqtt_rules SET enabled = FALSE")));
});

test("rollback atomically disables unified delivery before restoring the legacy rule", async () => {
  const fixture = transactionalPool({ cutoverActive: true });
  const repository = new NotificationCutoverRepository({
    pool: fixture.pool,
    shadowRepositoryFactory: fixture.shadowRepositoryFactory,
  });
  const result = await repository.rollback({ ruleId: 51, actor: { id: 9 } });
  assert.equal(result.state, "legacy_active");
  const unifiedOff = fixture.calls.findIndex(({ sql }) => sql.startsWith("UPDATE public.notification_rules SET enabled = FALSE"));
  const legacyOn = fixture.calls.findIndex(({ sql }) => sql.startsWith("UPDATE public.mqtt_rules SET enabled = TRUE"));
  assert.ok(unifiedOff >= 0 && legacyOn > unifiedOff);
  assert.ok(fixture.calls.some(({ sql, values }) =>
    sql.includes("INSERT INTO public.audit_events") && values[1] === "notification.rule_rollback"
  ));
});

test("an orphaned disabled migration is retired without deleting its rule or evidence", async () => {
  const fixture = orphanedPool();
  const repository = new NotificationCutoverRepository({ pool: fixture.pool });
  const result = await repository.retireOrphaned({
    ruleId: 61,
    actor: { id: 9 },
  });

  assert.deepEqual(result, {
    ruleId: 61,
    state: "retired",
    targetRuleDeleted: false,
    evidenceDeleted: false,
    deliveryChanged: false,
  });
  assert.ok(fixture.calls.some(({ sql }) =>
    sql.startsWith("UPDATE public.notification_rule_migrations") &&
    sql.includes("retired_at = CURRENT_TIMESTAMP")
  ));
  assert.ok(fixture.calls.some(({ sql, values }) =>
    sql.includes("INSERT INTO public.audit_events") &&
    values[1] === "61"
  ));
  assert.ok(!fixture.calls.some(({ sql }) => /^DELETE /i.test(sql)));
  assert.ok(fixture.calls.some(({ sql }) => sql === "COMMIT"));
});

test("orphan retirement refuses an existing source or prior cutover history", async () => {
  for (const fixture of [
    orphanedPool({ sourceExists: true }),
    orphanedPool({ transitionCount: 1 }),
  ]) {
    const repository = new NotificationCutoverRepository({ pool: fixture.pool });
    await assert.rejects(
      repository.retireOrphaned({ ruleId: 61, actor: { id: 9 } }),
      /removed legacy source|cutover history/
    );
    assert.ok(fixture.calls.some(({ sql }) => sql === "ROLLBACK"));
  }
});

test("cutover state exposes runtime and approval blockers", () => {
  const mapped = notificationCutoverRepositoryInternals.mapState(
    {
      migration_id: 10,
      source_type: "pushover",
      source_id: 8,
      target_rule_id: 52,
      target_name: "Plate ABC123",
      target_version: 1,
      source_enabled: true,
      target_enabled: false,
      action_count: 1,
      all_delivery_disabled: true,
      all_delivery_enabled: false,
      runtime_supported: false,
      target_cooldown_seconds: 0,
      source_configuration: null,
      delivery_configurations: [],
    },
    { status: "approved", latestReview: { current: true }, positiveMatchCount: 1, mismatchCount: 0 }
  );
  assert.equal(mapped.state, "legacy_active");
  assert.equal(mapped.canCutover, false);
  assert.match(mapped.blockers.join(" "), /adapter is not available/i);
});

test("cutover state exposes safely disabled copies whose source was removed", () => {
  const mapped = notificationCutoverRepositoryInternals.mapState({
    migration_id: 12,
    source_type: "mqtt",
    source_id: 99,
    target_rule_id: 61,
    target_name: "Removed delivery rule",
    target_version: 3,
    source_enabled: null,
    target_enabled: false,
    action_count: 1,
    all_delivery_disabled: true,
    all_delivery_enabled: false,
    runtime_supported: true,
    target_cooldown_seconds: 0,
    source_configuration: null,
    delivery_configurations: [],
    latest_direction: null,
  });
  assert.equal(mapped.state, "source_removed");
  assert.equal(mapped.canRetire, true);
  assert.equal(mapped.canCutover, false);
  assert.match(mapped.blockers.join(" "), /can be retired/i);
});

test("cutover UI and schema preserve explicit confirmation, rollback, and audit boundaries", async () => {
  const [actions, component, page, migration, route] = await Promise.all([
    readFile(new URL("../app/actions.js", import.meta.url), "utf8"),
    readFile(new URL("../components/NotificationCutoverPanel.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/notifications/page.jsx", import.meta.url), "utf8"),
    readFile(new URL("../migrations.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/api/plate-reads/route.js", import.meta.url), "utf8"),
  ]);
  assert.match(actions, /cutoverUnifiedNotificationRule[\s\S]*?requirePermission\("notification\.manage"\)/);
  assert.match(actions, /cutover_one_rule/);
  assert.match(actions, /rollback_one_rule/);
  assert.match(actions, /retire_orphaned_migration/);
  assert.match(component, /atomically restores its legacy rule/);
  assert.match(component, /Retire orphaned migration/);
  assert.match(page, /NotificationCutoverPanel/);
  assert.match(migration, /notification_rule_cutover_events is append-only/);
  assert.match(migration, /retired_at TIMESTAMPTZ/);
  assert.match(route, /notificationService\.processAcceptedRead\(acceptedRead\)/);
});
