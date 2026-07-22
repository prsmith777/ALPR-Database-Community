import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildNotificationMigrationPreview,
  previewLegacyMqttRule,
  previewLegacyPushoverRule,
} from "../lib/notification-migration-preview.mjs";
import { NotificationMigrationRepository } from "../lib/notification-migration-repository.mjs";

test("Pushover rules preview as disabled exact-plate rules without credentials", () => {
  const preview = previewLegacyPushoverRule(
    { id: 4, plate_number: "DP0M90", enabled: true, priority: 1 },
    { enabled: true, configured: true, app_token: "must-not-leak", user_key: "must-not-leak" }
  );

  assert.equal(preview.ready, true);
  assert.equal(preview.proposed.enabled, false);
  assert.equal(preview.proposed.conditionTree.children[0].conditionType, "plate_match");
  assert.equal(preview.proposed.conditionTree.children[0].value.plate, "DP0M90");
  assert.equal(preview.proposed.actions[0].credentialReference, "settings:notifications.pushover");
  assert.equal(JSON.stringify(preview).includes("must-not-leak"), false);
});

test("MQTT rules preview with name, camera, broker, and destination semantics", () => {
  const preview = previewLegacyMqttRule({
    id: 7,
    name: "Family arrival",
    enabled: true,
    match_type: "known_name",
    match_value: "Liz's Lexus",
    broker_id: 2,
    broker_name: "HOMESEER",
    broker_enabled: true,
    destination_mode: "fixed_topic",
    fixed_topic: "Blue Iris/ALPR/family",
    message: "Family arrived",
    camera_names: ["Driveway", "Driveway", "Gate"],
  });

  assert.equal(preview.ready, true);
  assert.equal(preview.proposed.enabled, false);
  assert.deepEqual(
    preview.proposed.conditionTree.children.map((condition) => condition.conditionType),
    ["known_name", "camera"]
  );
  assert.deepEqual(preview.proposed.conditionTree.children[1].value.names, ["Driveway", "Gate"]);
  assert.equal(preview.proposed.actions[0].configuration.brokerName, "HOMESEER");
  assert.equal(preview.proposed.actions[0].configuration.fixedTopic, "Blue Iris/ALPR/family");
});

test("MQTT tag migration preserves the legacy known-plate boundary", () => {
  const preview = previewLegacyMqttRule({
    id: 8,
    name: "Delivery arrival",
    enabled: true,
    match_type: "tag",
    match_value: "Delivery",
    broker_id: 2,
    broker_name: "HOMESEER",
    broker_enabled: true,
    destination_mode: "per_camera",
    camera_names: ["Entry LPR 1"],
  });

  const identityGroup = preview.proposed.conditionTree.children[0];
  assert.equal(identityGroup.kind, "group");
  assert.equal(identityGroup.combinator, "all");
  assert.deepEqual(
    identityGroup.children.map((condition) => condition.conditionType),
    ["known_plate", "tag"]
  );
  assert.equal(identityGroup.children[0].operator, "is_true");
  assert.deepEqual(identityGroup.children[1].value.tags, ["Delivery"]);
});

test("migration preview is read-only and reports blockers without hiding source rules", () => {
  const preview = buildNotificationMigrationPreview({
    pushoverRules: [{ id: 1, plate_number: "ABC123", enabled: true, priority: 2 }],
    mqttRules: [
      {
        id: 2,
        name: "Broken broker",
        enabled: true,
        match_type: "any_plate",
        broker_id: 5,
        broker_name: "Garage",
        broker_enabled: false,
        destination_mode: "per_camera",
      },
    ],
    pushover: { enabled: false, configured: true },
  });

  assert.equal(preview.mode, "read_only");
  assert.equal(preview.writesPerformed, 0);
  assert.deepEqual(preview.sourceCounts, { pushover: 1, mqtt: 1, total: 2 });
  assert.equal(preview.readyCount, 0);
  assert.equal(preview.attentionCount, 2);
  assert.match(preview.rules[0].blockers.join(" "), /globally disabled/i);
  assert.match(preview.rules[1].blockers.join(" "), /broker Garage is disabled/i);
});

test("repository reads only safe legacy rule fields and returns the normalized preview", async () => {
  const queries = [];
  const pool = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes("plate_notifications")) {
        return { rows: [{ id: 1, plate_number: "ABC123", enabled: true, priority: 1 }] };
      }
      if (sql.includes("notification_rule_migrations")) return { rows: [] };
      return {
        rows: [
          {
            id: 2,
            name: "Any plate",
            enabled: true,
            match_type: "any_plate",
            broker_id: 3,
            broker_name: "HOMESEER",
            broker_enabled: true,
            destination_mode: "per_camera",
            camera_names: [],
          },
        ],
      };
    },
  };

  const repository = new NotificationMigrationRepository({ pool });
  const preview = await repository.preview({ pushover: { enabled: true, configured: true } });

  assert.equal(queries.length, 3);
  assert.equal(queries.every((sql) => /^\s*SELECT\b/i.test(sql)), true);
  assert.equal(queries.some((sql) => /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i.test(sql)), false);
  assert.equal(queries.some((sql) => /password|app_token|user_key/i.test(sql)), false);
  assert.equal(preview.sourceCounts.total, 2);
  assert.equal(preview.readyCount, 2);
  assert.equal(preview.migratedCount, 0);
  assert.equal(preview.reconcileReadyCount, 0);
  assert.equal(preview.pendingReadyCount, 2);
});

test("migration preview marks durable disabled copies without changing readiness", () => {
  const preview = buildNotificationMigrationPreview({
    mqttRules: [
      {
        id: 2,
        name: "Any plate",
        enabled: true,
        match_type: "any_plate",
        broker_id: 3,
        broker_name: "HOMESEER",
        broker_enabled: true,
        destination_mode: "per_camera",
      },
    ],
    migrationMappings: [
      {
        source_type: "mqtt",
        source_id: 2,
        target_rule_id: 41,
        created_at: "2026-07-22T16:00:00.000Z",
      },
    ],
  });

  assert.equal(preview.readyCount, 1);
  assert.equal(preview.migratedCount, 1);
  assert.equal(preview.pendingReadyCount, 0);
  assert.deepEqual(preview.rules[0].migration, {
    status: "created_disabled",
    targetRuleId: 41,
    createdAt: "2026-07-22T16:00:00.000Z",
  });
});

test("migration preview offers safe reconciliation for an older disabled tag copy", () => {
  const preview = buildNotificationMigrationPreview({
    mqttRules: [
      {
        id: 9,
        name: "Delivery arrival",
        enabled: true,
        match_type: "tag",
        match_value: "Delivery",
        broker_id: 3,
        broker_name: "HOMESEER",
        broker_enabled: true,
        destination_mode: "per_camera",
      },
    ],
    migrationMappings: [
      {
        source_type: "mqtt",
        source_id: 9,
        target_rule_id: 42,
        target_all_disabled: true,
        target_has_known_plate_guard: false,
      },
    ],
  });

  assert.equal(preview.pendingReadyCount, 0);
  assert.equal(preview.reconcileReadyCount, 1);
  assert.equal(preview.reconcileBlockedCount, 0);
  assert.equal(preview.rules[0].migration.needsReconciliation, true);
  assert.equal(preview.rules[0].migration.reconciliationSafe, true);
});

test("MQTT match types that need a value are blocked when it is missing", () => {
  for (const matchType of ["exact_plate", "known_name", "tag"]) {
    const preview = previewLegacyMqttRule({
      id: 10,
      name: "Incomplete rule",
      enabled: true,
      match_type: matchType,
      match_value: "",
      broker_id: 2,
      broker_name: "HOMESEER",
      broker_enabled: true,
    });

    assert.equal(preview.ready, false);
    assert.match(preview.blockers.join(" "), /requires a match value/i);
  }
});

test("Notifications exposes an explicitly confirmed disabled-only migration without cutover", async () => {
  const [page, component, applyComponent] = await Promise.all([
    readFile(new URL("../app/notifications/page.jsx", import.meta.url), "utf8"),
    readFile(new URL("../components/NotificationMigrationPreview.jsx", import.meta.url), "utf8"),
    readFile(new URL("../components/ApplyNotificationMigrationButton.jsx", import.meta.url), "utf8"),
  ]);

  assert.match(page, /getNotificationRuleMigrationPreview/);
  assert.match(page, /<NotificationMigrationPreview preview={migrationPreview}/);
  assert.match(component, /Unified rules migration preview/);
  assert.match(component, /performs no writes/);
  assert.match(component, /ApplyNotificationMigrationButton/);
  assert.match(applyComponent, /create_disabled_rules/);
  assert.match(applyComponent, /copied rules will remain disabled pending review/i);
  assert.match(applyComponent, /Reconcile \$\{reconcileCount\} disabled/);
  assert.match(component, /All of/);
  assert.match(component, /Any known plate/);
  assert.doesNotMatch(applyComponent, /activate all|enable all|cutover/i);
});
