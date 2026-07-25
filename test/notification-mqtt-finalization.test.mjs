import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  NotificationMqttFinalizationRepository,
  notificationMqttFinalizationInternals,
} from "../lib/notification-mqtt-finalization-repository.mjs";

function readyRow(overrides = {}) {
  return {
    migration_id: 21,
    source_id: 4,
    target_rule_id: 3,
    source_enabled: false,
    target_name: "Entry LPR 1 Match Family Tag",
    target_enabled: true,
    action_count: 1,
    all_delivery_enabled: true,
    all_mqtt: true,
    latest_direction: "cutover",
    cutover_at: "2026-07-24T18:00:00.000Z",
    successful_delivery_id: 701,
    successful_delivery_at: "2026-07-24T19:00:00.000Z",
    legacy_snapshot: {
      schemaVersion: 1,
      sourceType: "mqtt",
      sourceId: 4,
      name: "Entry LPR 1 Match Family Tag",
      broker: { id: 1, name: "HOMESEER" },
      cameras: [{ id: 1, cameraName: "Entry LPR 1", cameraKey: "entry-lpr-1" }],
    },
    ...overrides,
  };
}

test("finalization preview requires active unified MQTT delivery after cutover", async () => {
  const pool = {
    async query(sql) {
      if (sql.includes("FROM public.notification_rule_migrations m")) {
        return { rows: [readyRow(), readyRow({ migration_id: 22, source_id: 5, target_rule_id: 4, successful_delivery_id: null })] };
      }
      if (sql.includes("COUNT(*)::integer AS count")) return { rows: [{ count: 0 }] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const preview = await new NotificationMqttFinalizationRepository({ pool }).preview();
  assert.equal(preview.readyCount, 1);
  assert.equal(preview.blockerCount, 1);
  assert.equal(preview.canFinalize, false);
  assert.match(preview.blockers[0].message, /successful unified MQTT delivery/i);
  assert.match(notificationMqttFinalizationInternals.FINALIZATION_STATE_QUERY, /published_at >= transition\.occurred_at/);
  assert.match(notificationMqttFinalizationInternals.FINALIZATION_STATE_QUERY, /notification_runtime' = 'unified-v1'/);
});

test("finalization archives snapshots, deletes disabled sources, and appends audit evidence atomically", async () => {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      const compact = sql.replace(/\s+/g, " ").trim();
      calls.push({ sql: compact, values });
      if (compact.includes("FROM public.notification_rule_migrations m")) return { rows: [readyRow()] };
      if (compact.startsWith("DELETE FROM public.mqtt_rules")) return { rows: [{ id: 4 }] };
      return { rows: [] };
    },
    release() { calls.push({ sql: "RELEASE", values: [] }); },
  };
  const pool = { query: client.query, async connect() { return client; } };
  const result = await new NotificationMqttFinalizationRepository({ pool }).finalize({ actor: { id: 9 } });
  assert.deepEqual(result, { finalizedCount: 1, targetRuleIds: [3] });
  assert.equal(calls[0].sql, "BEGIN");
  assert.ok(calls.some((call) => call.sql.includes("pg_advisory_xact_lock")));
  const deletion = calls.find((call) => call.sql.startsWith("DELETE FROM public.mqtt_rules"));
  assert.deepEqual(deletion.values, [4]);
  const archive = calls.find((call) => call.sql.startsWith("UPDATE public.notification_rule_migrations"));
  assert.equal(JSON.parse(archive.values[1]).broker.name, "HOMESEER");
  assert.equal(archive.values[2], 9);
  const audit = calls.find((call) => call.sql.includes("notification.mqtt_migration_finalized"));
  assert.equal(JSON.parse(audit.values[2]).successfulDeliveryId, 701);
  assert.match(JSON.parse(audit.values[2]).legacySnapshotSha256, /^[0-9a-f]{64}$/);
  assert.ok(calls.some((call) => call.sql === "COMMIT"));
  assert.equal(calls.at(-1).sql, "RELEASE");
});

test("a finalization blocker rolls back without deleting a legacy source", async () => {
  const calls = [];
  const client = {
    async query(sql) {
      const compact = sql.replace(/\s+/g, " ").trim();
      calls.push(compact);
      if (compact.includes("FROM public.notification_rule_migrations m")) {
        return { rows: [readyRow({ successful_delivery_id: null })] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = { query: client.query, async connect() { return client; } };
  await assert.rejects(
    new NotificationMqttFinalizationRepository({ pool }).finalize({ actor: { id: 9 } }),
    /verified post-cutover delivery/i
  );
  assert.equal(calls.some((sql) => sql.startsWith("DELETE FROM public.mqtt_rules")), false);
  assert.ok(calls.includes("ROLLBACK"));
});

test("the UI exposes one explicit finalization action and retires legacy rule management", async () => {
  const [actions, panel, mqttAdmin, migration] = await Promise.all([
    readFile(new URL("../app/actions.js", import.meta.url), "utf8"),
    readFile(new URL("../components/NotificationMqttFinalizationPanel.jsx", import.meta.url), "utf8"),
    readFile(new URL("../components/mqtt/MqttAdmin.jsx", import.meta.url), "utf8"),
    readFile(new URL("../migrations.sql", import.meta.url), "utf8"),
  ]);
  assert.match(actions, /finalizeMqttNotificationMigration[\s\S]*?requirePermission\("notification\.manage"\)/);
  assert.match(actions, /finalize_mqtt_migration/);
  assert.match(panel, /permanently removes the legacy MQTT rules/i);
  assert.doesNotMatch(mqttAdmin, /MqttRules|value="rules"/);
  assert.match(migration, /legacy_snapshot JSONB/);
  assert.match(migration, /finalized_at TIMESTAMPTZ/);
});
