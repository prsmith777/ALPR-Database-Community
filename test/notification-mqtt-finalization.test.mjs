import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import {
  NotificationLegacyFinalizationRepository,
  notificationLegacyFinalizationInternals,
} from "../lib/notification-mqtt-finalization-repository.mjs";

function readyRow(overrides = {}) {
  const sourceType = overrides.source_type || "mqtt";
  return {
    migration_id: 21,
    source_type: sourceType,
    source_id: 4,
    target_rule_id: 3,
    source_enabled: false,
    target_name: sourceType === "mqtt" ? "Family MQTT" : "ABC123 Pushover",
    target_enabled: true,
    action_count: 1,
    all_delivery_enabled: true,
    all_expected_channel: true,
    latest_direction: "cutover",
    cutover_at: "2026-07-24T18:00:00.000Z",
    successful_delivery_id: 701,
    successful_delivery_at: "2026-07-24T19:00:00.000Z",
    legacy_snapshot: sourceType === "mqtt"
      ? { schemaVersion: 1, sourceType: "mqtt", sourceId: 4, name: "Family MQTT", broker: { id: 1, name: "HOMESEER" }, cameras: [] }
      : { schemaVersion: 1, sourceType: "pushover", sourceId: 4, plateNumber: "ABC123", priority: 1 },
    ...overrides,
  };
}

test("finalization preview requires successful unified delivery for MQTT and Pushover", async () => {
  const pool = {
    async query(sql) {
      if (sql.includes("FROM public.notification_rule_migrations m")) {
        return { rows: [
          readyRow(),
          readyRow({ migration_id: 22, source_type: "pushover", source_id: 5, target_rule_id: 4 }),
          readyRow({ migration_id: 23, source_type: "pushover", source_id: 6, target_rule_id: 5, successful_delivery_id: null }),
        ] };
      }
      if (sql.includes("COUNT(*)::integer AS count")) return { rows: [{ source_type: "mqtt", count: 1 }] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const preview = await new NotificationLegacyFinalizationRepository({ pool }).preview();
  assert.equal(preview.readyCount, 2);
  assert.equal(preview.blockerCount, 1);
  assert.equal(preview.finalizedCount, 1);
  assert.equal(preview.canFinalize, false);
  assert.match(preview.blockers[0].message, /successful unified Pushover delivery/i);
  assert.match(notificationLegacyFinalizationInternals.FINALIZATION_STATE_QUERY, /notification_runtime' = 'unified-v1'/);
  assert.match(notificationLegacyFinalizationInternals.FINALIZATION_STATE_QUERY, /FROM public\.notification_deliveries/);
  assert.match(notificationLegacyFinalizationInternals.FINALIZATION_STATE_QUERY, /e\.rule_id = target\.id/);
});

test("finalization archives snapshots, deletes both source types, and appends audit evidence atomically", async () => {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      const compact = sql.replace(/\s+/g, " ").trim();
      calls.push({ sql: compact, values });
      if (compact.includes("FROM public.notification_rule_migrations m")) {
        return { rows: [readyRow(), readyRow({ migration_id: 22, source_type: "pushover", source_id: 5, target_rule_id: 4 })] };
      }
      if (compact.startsWith("DELETE FROM public.mqtt_rules")) return { rows: [{ id: 4 }] };
      if (compact.startsWith("DELETE FROM public.plate_notifications")) return { rows: [{ id: 5 }] };
      return { rows: [] };
    },
    release() { calls.push({ sql: "RELEASE", values: [] }); },
  };
  const pool = { query: (...args) => client.query(...args), async connect() { return client; } };
  const result = await new NotificationLegacyFinalizationRepository({ pool }).finalize({ actor: { id: 9 } });
  assert.deepEqual(result, { finalizedCount: 2, sourceTypes: ["mqtt", "pushover"], targetRuleIds: [3, 4] });
  assert.equal(calls[0].sql, "BEGIN");
  assert.ok(calls.some((call) => call.sql.startsWith("DELETE FROM public.mqtt_rules")));
  assert.ok(calls.some((call) => call.sql.startsWith("DELETE FROM public.plate_notifications")));
  const archives = calls.filter((call) => call.sql.startsWith("UPDATE public.notification_rule_migrations"));
  assert.equal(JSON.parse(archives[0].values[1]).broker.name, "HOMESEER");
  assert.equal(JSON.parse(archives[1].values[1]).plateNumber, "ABC123");
  const audits = calls.filter((call) => call.sql.includes("notification.legacy_migration_finalized"));
  assert.equal(audits.length, 2);
  assert.match(JSON.parse(audits[1].values[2]).legacySnapshotSha256, /^[0-9a-f]{64}$/);
  assert.ok(calls.some((call) => call.sql === "COMMIT"));
  assert.equal(calls.at(-1).sql, "RELEASE");
});

test("a finalization blocker rolls back without deleting a legacy source", async () => {
  const calls = [];
  const client = {
    async query(sql) {
      const compact = sql.replace(/\s+/g, " ").trim();
      calls.push(compact);
      if (compact.includes("FROM public.notification_rule_migrations m")) return { rows: [readyRow({ successful_delivery_id: null })] };
      return { rows: [] };
    },
    release() {},
  };
  const pool = { query: (...args) => client.query(...args), async connect() { return client; } };
  await assert.rejects(
    new NotificationLegacyFinalizationRepository({ pool }).finalize({ actor: { id: 9 } }),
    /verified post-cutover delivery/i
  );
  assert.equal(calls.some((sql) => sql.startsWith("DELETE FROM public.mqtt_rules")), false);
  assert.ok(calls.includes("ROLLBACK"));
});

test("the UI exposes one explicit finalization action and no legacy rule editor", async () => {
  const [actions, panel, page, migration, channelTest, channelTestRoute, database] = await Promise.all([
    readFile(new URL("../app/actions.js", import.meta.url), "utf8"),
    readFile(new URL("../components/NotificationLegacyFinalizationPanel.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/notifications/page.jsx", import.meta.url), "utf8"),
    readFile(new URL("../migrations.sql", import.meta.url), "utf8"),
    readFile(new URL("../components/NotificationChannelTestPanel.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/notifications/channels/test/route.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/db.js", import.meta.url), "utf8"),
  ]);
  assert.match(actions, /finalizeLegacyNotificationMigration[\s\S]*?requirePermission\("notification\.manage"\)/);
  assert.match(actions, /finalize_legacy_notification_migration/);
  assert.match(panel, /permanently removes the legacy MQTT and Pushover rules/i);
  assert.doesNotMatch(page, /NotificationsTable|Legacy exact-plate Pushover rules/);
  assert.doesNotMatch(actions, /addNotificationPlate|toggleNotification\(|deleteNotification\(|updateNotificationPriority/);
  assert.doesNotMatch(database, /export async function (?:getNotificationPlates|addNotificationPlate|toggleNotification|deleteNotification|updateNotificationPriorityDB)/);
  assert.match(channelTest, /Send test Pushover/);
  assert.match(channelTestRoute, /channelType === "pushover"/);
  await assert.rejects(access(new URL("../components/NotificationsTable.jsx", import.meta.url)));
  assert.match(migration, /2026072404_finalize_legacy_pushover_rules/);
});
