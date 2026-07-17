import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const migrationSql = await fs.readFile("migrations.sql", "utf8");

test("MQTT v2 migration creates the separated integration model", () => {
  for (const table of [
    "mqtt_settings",
    "mqtt_cameras",
    "mqtt_rules",
    "mqtt_rule_cameras",
  ]) {
    assert.match(
      migrationSql,
      new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}\\b`, "i")
    );
  }
});

test("broker credentials are retained while connection fields are extended", () => {
  assert.match(
    migrationSql,
    /ALTER TABLE IF EXISTS public\.mqttbrokers[\s\S]*ADD COLUMN IF NOT EXISTS enabled/i
  );
  assert.match(migrationSql, /ADD COLUMN IF NOT EXISTS client_id/i);
  assert.equal(/DROP TABLE\s+(?:IF EXISTS\s+)?(?:public\.)?mqttbrokers/i.test(migrationSql), false);
  assert.equal(/DROP TABLE\s+(?:IF EXISTS\s+)?(?:public\.)?mqttnotifications/i.test(migrationSql), false);
});

test("new MQTT publishing is disabled until an administrator configures it", () => {
  assert.match(
    migrationSql,
    /CREATE TABLE IF NOT EXISTS public\.mqtt_settings[\s\S]*enabled BOOLEAN NOT NULL DEFAULT FALSE/i
  );
  assert.match(
    migrationSql,
    /base_topic VARCHAR\(512\) NOT NULL DEFAULT 'Blue Iris\/ALPR'/i
  );
  assert.match(
    migrationSql,
    /camera_topic_template VARCHAR\(512\) NOT NULL DEFAULT '\{base_topic\}\/\{camera_key\}'/i
  );
  assert.match(
    migrationSql,
    /local_timezone VARCHAR\(100\) NOT NULL DEFAULT 'UTC'/i
  );
});

test("rule constraints cover match types, fuzzy limits, and destinations", () => {
  for (const matchType of [
    "any_plate",
    "exact_plate",
    "any_known_plate",
    "known_name",
    "tag",
  ]) {
    assert.match(migrationSql, new RegExp(`'${matchType}'`));
  }

  assert.match(migrationSql, /fuzzy_max_distance BETWEEN 0 AND 2/i);
  assert.match(migrationSql, /fuzzy_min_length BETWEEN 1 AND 20/i);
  assert.match(migrationSql, /destination_mode IN \('per_camera', 'fixed_topic'\)/i);
  assert.match(migrationSql, /mqtt_rules_match_value_required/i);
  assert.match(migrationSql, /mqtt_rules_fixed_topic_required/i);
});

test("camera identity uses a stable constrained key and case-insensitive name uniqueness", () => {
  assert.match(
    migrationSql,
    /camera_key ~ '\^\[a-z0-9\]\+\(-\[a-z0-9\]\+\)\*\$'/i
  );
  assert.match(
    migrationSql,
    /CREATE UNIQUE INDEX IF NOT EXISTS mqtt_cameras_camera_name_lower_key[\s\S]*LOWER\(camera_name\)/i
  );
});

test("the migration is written to be safely repeatable", () => {
  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS public\.mqtt_settings/i);
  assert.match(migrationSql, /INSERT INTO public\.mqtt_settings \(id\)[\s\S]*ON CONFLICT \(id\) DO NOTHING/i);
  assert.match(migrationSql, /CREATE INDEX IF NOT EXISTS idx_mqtt_rules_enabled/i);
  assert.match(migrationSql, /DROP TRIGGER IF EXISTS mqtt_rules_set_updated_at/i);
  assert.match(migrationSql, /CREATE OR REPLACE FUNCTION public\.mqtt_set_updated_at/i);
});
