import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(new URL("../migrations.sql", import.meta.url), "utf8");
const compact = migration.replace(/\s+/g, " ");

test("unified notifications have normalized rule, condition, action, and delivery records", () => {
  for (const table of [
    "notification_rules",
    "notification_condition_groups",
    "notification_conditions",
    "notification_channels",
    "notification_actions",
    "notification_executions",
    "notification_deliveries",
    "notification_delivery_attempts",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}\\b`, "i"));
  }
});

test("new notification rules and channels are fail-closed until migration is explicit", () => {
  assert.match(compact, /notification_rules \([\s\S]*?enabled BOOLEAN NOT NULL DEFAULT FALSE/i);
  assert.match(compact, /notification_channels \([\s\S]*?enabled BOOLEAN NOT NULL DEFAULT FALSE/i);
  assert.match(migration, /migration neither copies nor changes any existing notification behavior/i);
  assert.equal(/DROP TABLE\s+(?:IF EXISTS\s+)?(?:public\.)?plate_notifications/i.test(migration), false);
  assert.equal(/DROP TABLE\s+(?:IF EXISTS\s+)?(?:public\.)?mqtt_rules/i.test(migration), false);
});

test("condition and event constraints match the deterministic evaluator contract", () => {
  for (const conditionType of [
    "plate_match",
    "camera",
    "known_plate",
    "tag",
    "watchlist",
    "confidence",
    "read_count",
    "local_time_window",
  ]) {
    assert.match(migration, new RegExp(`'${conditionType}'`));
  }
  assert.match(migration, /event_type IN \('plate_read\.accepted', 'camera\.activity_check'\)/i);
  assert.match(migration, /combinator IN \('all', 'any', 'not'\)/i);
  assert.match(migration, /notification_condition_groups_parent_same_rule/i);
  assert.match(migration, /uq_notification_condition_groups_root/i);
});

test("execution and delivery history enforce idempotence, retry, and lock state", () => {
  assert.match(migration, /execution_key VARCHAR\(100\) NOT NULL UNIQUE/i);
  assert.match(migration, /dedupe_key VARCHAR\(100\) NOT NULL UNIQUE/i);
  assert.match(migration, /notification_deliveries_due/i);
  assert.match(migration, /status IN \('pending', 'processing', 'retry', 'succeeded', 'dead', 'cancelled'\)/i);
  assert.match(migration, /notification_deliveries_lock_state/i);
  assert.match(migration, /UNIQUE \(delivery_id, attempt_number\)/i);
  assert.match(migration, /2026072201_unified_notification_foundation/i);
});
