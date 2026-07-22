import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { NotificationMigrationRepository } from "../lib/notification-migration-repository.mjs";

const readyMqttRule = {
  id: 7,
  name: "Street any plate",
  enabled: true,
  match_type: "any_plate",
  match_value: "",
  plate_match_mode: "off",
  broker_id: 2,
  destination_mode: "per_camera",
  fixed_topic: "",
  message: "Plate received",
  broker_name: "HOMESEER",
  broker_enabled: true,
  camera_names: ["Street LPR 2"],
};

function transactionalPool({ mappings = [], mqttRule = readyMqttRule, failOn = null } = {}) {
  const calls = [];
  let released = false;
  const client = {
    async query(sql, values = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, values });
      if (failOn && normalized.includes(failOn)) throw new Error("injected migration failure");
      if (normalized.includes("FROM public.plate_notifications")) return { rows: [] };
      if (normalized.includes("FROM public.mqtt_rules")) return { rows: [mqttRule] };
      if (normalized.startsWith("SELECT source_type")) return { rows: mappings };
      if (normalized.startsWith("SELECT r.enabled")) {
        return { rows: [{ enabled: false, has_enabled_delivery: false }] };
      }
      if (normalized.startsWith("INSERT INTO public.notification_rules")) {
        return { rowCount: 1, rows: [{ id: 51 }] };
      }
      if (normalized.startsWith("INSERT INTO public.notification_condition_groups")) {
        return { rowCount: 1, rows: [{ id: 61 }] };
      }
      if (normalized.startsWith("INSERT INTO public.notification_channels")) {
        return { rowCount: 1, rows: [{ id: 71 }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {
      released = true;
    },
  };
  return {
    calls,
    client,
    get released() {
      return released;
    },
    pool: {
      query: (...args) => client.query(...args),
      connect: async () => client,
    },
  };
}

test("disabled migration copies a ready legacy rule atomically and audits it", async () => {
  const fixture = transactionalPool();
  const repository = new NotificationMigrationRepository({ pool: fixture.pool });
  const result = await repository.applyDisabledMigration({ actor: { id: 9 } });

  assert.equal(result.mode, "disabled_only");
  assert.equal(result.createdCount, 1);
  assert.equal(result.reconciledCount, 0);
  assert.equal(result.skippedCount, 0);
  assert.equal(result.blockedCount, 0);
  assert.equal(result.allCreatedDisabled, true);
  assert.equal(result.legacyDeliveryChanged, false);
  assert.deepEqual(result.created[0], {
    sourceType: "mqtt",
    sourceId: 7,
    targetRuleId: 51,
    name: "Street any plate",
    enabled: false,
  });
  assert.ok(fixture.calls.some(({ sql }) => sql === "BEGIN"));
  assert.ok(fixture.calls.some(({ sql }) => sql === "COMMIT"));
  assert.ok(!fixture.calls.some(({ sql }) => sql === "ROLLBACK"));
  assert.ok(
    fixture.calls.some(
      ({ sql }) => sql.includes("INSERT INTO public.notification_rules") && sql.includes("FALSE")
    )
  );
  assert.ok(
    fixture.calls.some(
      ({ sql }) => sql.includes("INSERT INTO public.notification_channels") && sql.includes("FALSE")
    )
  );
  assert.ok(
    fixture.calls.some(
      ({ sql }) => sql.includes("INSERT INTO public.notification_actions") && sql.includes("FALSE")
    )
  );
  assert.ok(
    fixture.calls.some(({ sql }) => sql.includes("INSERT INTO public.notification_rule_migrations"))
  );
  const audit = fixture.calls.find(({ sql }) => sql.includes("INSERT INTO public.audit_events"));
  assert.ok(audit);
  assert.equal(audit.values[0], 9);
  assert.deepEqual(JSON.parse(audit.values[1]), {
    createdCount: 1,
    reconciledCount: 0,
    skippedCount: 0,
    blockedCount: 0,
    created: [{ sourceType: "mqtt", sourceId: 7, targetRuleId: 51 }],
    reconciled: [],
    allCreatedDisabled: true,
    legacyDeliveryChanged: false,
  });
  assert.equal(fixture.released, true);
});

test("disabled migration safely skips a source that already has a durable mapping", async () => {
  const fixture = transactionalPool({
    mappings: [
      {
        source_type: "mqtt",
        source_id: 7,
        target_rule_id: 44,
        created_at: "2026-07-22T16:00:00.000Z",
      },
    ],
  });
  const repository = new NotificationMigrationRepository({ pool: fixture.pool });
  const result = await repository.applyDisabledMigration({ actor: { id: 9 } });

  assert.equal(result.createdCount, 0);
  assert.equal(result.reconciledCount, 0);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.skipped[0].targetRuleId, 44);
  assert.ok(!fixture.calls.some(({ sql }) => sql.includes("INSERT INTO public.notification_rules")));
  assert.ok(!fixture.calls.some(({ sql }) => sql.includes("INSERT INTO public.notification_channels")));
  assert.ok(!fixture.calls.some(({ sql }) => sql.includes("INSERT INTO public.notification_actions")));
  assert.ok(fixture.calls.some(({ sql }) => sql === "COMMIT"));
});

test("disabled migration reconciles an older tag copy only while delivery remains disabled", async () => {
  const fixture = transactionalPool({
    mqttRule: {
      ...readyMqttRule,
      id: 9,
      name: "Delivery arrival",
      match_type: "tag",
      match_value: "Delivery",
    },
    mappings: [
      {
        source_type: "mqtt",
        source_id: 9,
        target_rule_id: 44,
        target_all_disabled: true,
        target_has_known_plate_guard: false,
      },
    ],
  });
  const repository = new NotificationMigrationRepository({ pool: fixture.pool });
  const result = await repository.applyDisabledMigration({ actor: { id: 9 } });

  assert.equal(result.createdCount, 0);
  assert.equal(result.reconciledCount, 1);
  assert.equal(result.skippedCount, 0);
  assert.equal(result.blockedCount, 0);
  assert.deepEqual(result.reconciled[0], {
    sourceType: "mqtt",
    sourceId: 9,
    targetRuleId: 44,
    name: "Delivery arrival",
    enabled: false,
  });
  assert.ok(
    fixture.calls.some(({ sql, values }) =>
      sql.startsWith("DELETE FROM public.notification_condition_groups") && values[0] === 44
    )
  );
  assert.ok(
    fixture.calls.some(({ sql, values }) =>
      sql.startsWith("UPDATE public.notification_rules") && values[0] === 44 && values[1] === 9
    )
  );
  assert.ok(
    fixture.calls.some(
      ({ sql, values }) =>
        sql.startsWith("INSERT INTO public.notification_conditions") &&
        values[1] === "known_plate"
    )
  );
});

test("disabled migration blocks reconciliation if any unified delivery path is enabled", async () => {
  const fixture = transactionalPool({
    mqttRule: {
      ...readyMqttRule,
      id: 9,
      match_type: "tag",
      match_value: "Delivery",
    },
    mappings: [
      {
        source_type: "mqtt",
        source_id: 9,
        target_rule_id: 44,
        target_all_disabled: false,
        target_has_known_plate_guard: false,
      },
    ],
  });
  const repository = new NotificationMigrationRepository({ pool: fixture.pool });
  const result = await repository.applyDisabledMigration({ actor: { id: 9 } });

  assert.equal(result.reconciledCount, 0);
  assert.equal(result.blockedCount, 1);
  assert.match(result.blocked[0].blockers.join(" "), /must remain disabled/i);
  assert.ok(
    !fixture.calls.some(({ sql }) =>
      sql.startsWith("DELETE FROM public.notification_condition_groups")
    )
  );
});

test("disabled migration rolls the whole transaction back when any copy fails", async () => {
  const fixture = transactionalPool({ failOn: "INSERT INTO public.notification_actions" });
  const repository = new NotificationMigrationRepository({ pool: fixture.pool });

  await assert.rejects(
    repository.applyDisabledMigration({ actor: { id: 9 } }),
    /injected migration failure/
  );
  assert.ok(fixture.calls.some(({ sql }) => sql === "ROLLBACK"));
  assert.ok(!fixture.calls.some(({ sql }) => sql === "COMMIT"));
  assert.equal(fixture.released, true);
});

test("server action requires notification permission and explicit disabled-only confirmation", async () => {
  const actions = await readFile(new URL("../app/actions.js", import.meta.url), "utf8");
  assert.match(
    actions,
    /applyDisabledNotificationRuleMigration[\s\S]*?requirePermission\("notification\.manage"\)/
  );
  assert.match(actions, /confirmation[\s\S]*?create_disabled_rules/);
  assert.match(actions, /applyDisabledNotificationMigration\(\{ actor: principal \}\)/);
});
