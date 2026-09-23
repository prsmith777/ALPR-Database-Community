import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL("../migrations.sql", import.meta.url);
const migrationSql = await readFile(migrationUrl, "utf8");

function compactSql(value) {
  return value.replace(/\s+/g, " ").trim();
}

const compactMigration = compactSql(migrationSql);

test("MQTT outbox migration creates delivery and attempt activity tables", () => {
  assert.match(
    compactMigration,
    /CREATE TABLE IF NOT EXISTS public\.mqtt_deliveries \(/i
  );
  assert.match(
    compactMigration,
    /CREATE TABLE IF NOT EXISTS public\.mqtt_delivery_attempts \(/i
  );
  assert.match(
    compactMigration,
    /payload JSONB NOT NULL/i
  );
  assert.match(
    compactMigration,
    /dedupe_key VARCHAR\(80\) NOT NULL UNIQUE/i
  );
});

test("MQTT outbox status, retry, payload, and worker-lock safeguards are enforced", () => {
  assert.match(
    compactMigration,
    /status IN \('pending', 'processing', 'retry', 'succeeded', 'dead'\)/i
  );
  assert.match(
    compactMigration,
    /qos BETWEEN 0 AND 2/i
  );
  assert.match(
    compactMigration,
    /max_attempts BETWEEN 1 AND 20/i
  );
  assert.match(
    compactMigration,
    /jsonb_typeof\(payload\) = 'object'/i
  );
  assert.match(
    compactMigration,
    /mqtt_deliveries_lock_state/i
  );
  assert.match(
    compactMigration,
    /mqtt_deliveries_published_state/i
  );
});

test("MQTT outbox supports efficient due-work claims and recent activity views", () => {
  assert.match(
    compactMigration,
    /idx_mqtt_deliveries_due/i
  );
  assert.match(
    compactMigration,
    /WHERE status IN \('pending', 'retry'\)/i
  );
  assert.match(
    compactMigration,
    /idx_mqtt_deliveries_created_at/i
  );
  assert.match(
    compactMigration,
    /UNIQUE \(delivery_id, attempt_number\)/i
  );
});

test("MQTT delivery timestamps use the shared idempotent updated-at trigger", () => {
  assert.match(
    compactMigration,
    /DROP TRIGGER IF EXISTS mqtt_deliveries_set_updated_at ON public\.mqtt_deliveries/i
  );
  assert.match(
    compactMigration,
    /CREATE TRIGGER mqtt_deliveries_set_updated_at BEFORE UPDATE ON public\.mqtt_deliveries/i
  );
});
