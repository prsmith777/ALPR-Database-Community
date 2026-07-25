import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  normalizeNotificationRuleDraft,
  parseNotificationRuleDraft,
} from "../lib/notification-rule-builder-shape.mjs";
import { NotificationRuleBuilderRepository } from "../lib/notification-rule-builder-repository.mjs";
import { preferredRuleTimeZone, scheduleConditionTimeZone, syncQuietHoursTimeZone } from "../lib/notification-rule-time-zone.mjs";

function validDraft(overrides = {}) {
  return {
    name: "After-hours monitored vehicle",
    description: "Notify when a monitored plate arrives overnight.",
    cooldownSeconds: 900,
    conditionTree: {
      kind: "group",
      combinator: "all",
      children: [
        { kind: "condition", conditionType: "watchlist", operator: "is_true", value: { expected: true } },
        {
          kind: "group",
          combinator: "any",
          children: [
            { kind: "condition", conditionType: "camera", operator: "in", value: { names: ["Driveway"] } },
            { kind: "condition", conditionType: "tag", operator: "any", value: { tags: ["Delivery"] } },
          ],
        },
      ],
    },
    actions: [
      { channelType: "pushover", configuration: { priority: 1, message: "Monitored arrival" } },
      { channelType: "mqtt", configuration: { brokerId: 2, destinationMode: "fixed_topic", fixedTopic: "alpr/alerts" } },
    ],
    ...overrides,
  };
}

test("the rule builder validates nested conditions and keeps new actions credential-reference only", () => {
  const draft = normalizeNotificationRuleDraft(validDraft());
  assert.equal(draft.conditionTree.children[1].combinator, "any");
  assert.equal(draft.actions[0].credentialReference, "settings:notifications.pushover");
  assert.equal(draft.actions[1].credentialReference, "mqtt-broker:2");
  assert.equal(draft.actions[1].configuration.fixedTopic, "alpr/alerts");
});

test("the rule builder fails closed for invalid destinations and missing actions", () => {
  assert.throws(
    () => normalizeNotificationRuleDraft(validDraft({ actions: [] })),
    /at least one notification action/i
  );
  assert.throws(
    () => normalizeNotificationRuleDraft(validDraft({ actions: [{ channelType: "mqtt", configuration: { brokerId: 2, destinationMode: "fixed_topic", fixedTopic: "alpr/#" } }] })),
    /wildcard/i
  );
});

test("serialized rule drafts have a bounded, validated parser", () => {
  assert.equal(parseNotificationRuleDraft(JSON.stringify(validDraft())).name, "After-hours monitored vehicle");
  assert.throws(() => parseNotificationRuleDraft("not-json"), /payload is invalid/i);
});

test("advanced drafts retain deep groups, count windows, and explicit plate strategies", () => {
  const draft = validDraft({
    conditionTree: {
      kind: "group",
      combinator: "all",
      children: [{
        kind: "group",
        combinator: "any",
        children: [{
          kind: "group",
          combinator: "not",
          children: [{ kind: "condition", conditionType: "plate_match", operator: "matches", value: { plate: "TEST*", strategy: "wildcard" } }],
        }],
      }, {
        kind: "condition",
        conditionType: "read_count",
        operator: "at_least",
        value: { scope: "plate", count: 3, windowSeconds: 600 },
      }],
    },
  });
  const normalized = normalizeNotificationRuleDraft(draft);
  assert.equal(normalized.conditionTree.children[0].children[0].combinator, "not");
  assert.equal(normalized.conditionTree.children[1].value.windowSeconds, 600);
  assert.equal(normalized.conditionTree.children[0].children[0].children[0].value.strategy, "wildcard");
});

test("scheduled camera drafts bind the event type consistently in PostgreSQL", async () => {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, values });
      if (normalized.startsWith("INSERT INTO public.notification_rules")) {
        return { rows: [{ id: 41, version: 1 }] };
      }
      if (normalized.startsWith("INSERT INTO public.notification_condition_groups")) {
        return { rows: [{ id: 51 }] };
      }
      if (normalized.startsWith("INSERT INTO public.notification_channels")) {
        return { rows: [{ id: 61 }] };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const repository = new NotificationRuleBuilderRepository({
    pool: { query: (...args) => client.query(...args), connect: async () => client },
  });

  const result = await repository.createDraft({
    actor: { id: 9 },
    draft: validDraft({
      eventType: "camera.activity_check",
      timeZone: "America/Denver",
      evaluationIntervalSeconds: 60,
      quietHours: { enabled: true, start: "22:00", end: "06:00", timeZone: "America/Denver", days: [] },
      conditionTree: {
        kind: "group",
        combinator: "all",
        children: [
          { kind: "condition", conditionType: "camera", operator: "in", value: { names: ["Entry LPR 1"] } },
          { kind: "condition", conditionType: "read_count", operator: "at_most", value: { scope: "camera", count: 0, windowSeconds: 900 } },
        ],
      },
      actions: [{ channelType: "mqtt", configuration: { brokerId: 1, destinationMode: "per_camera" } }],
    }),
  });

  const insert = calls.find(({ sql }) => sql.startsWith("INSERT INTO public.notification_rules"));
  assert.equal(result.enabled, false);
  assert.equal(insert.values[2], "camera.activity_check");
  assert.match(insert.sql, /\$3::text/);
  assert.ok(calls.some(({ sql }) => sql === "COMMIT"));
});

test("new calendar rules prefer the browser clock and keep quiet hours aligned", () => {
  assert.equal(preferredRuleTimeZone({ browserTimeZone: "America/Denver", configuredTimeZone: "UTC" }), "America/Denver");
  assert.equal(preferredRuleTimeZone({ browserTimeZone: "invalid", configuredTimeZone: "America/Chicago" }), "America/Chicago");
  assert.equal(syncQuietHoursTimeZone({
    quietHours: { enabled: true, timeZone: "UTC" },
    priorRuleTimeZone: "UTC",
    nextRuleTimeZone: "America/Denver",
  }).timeZone, "America/Denver");
  assert.equal(syncQuietHoursTimeZone({
    quietHours: { enabled: true, timeZone: "America/New_York" },
    priorRuleTimeZone: "UTC",
    nextRuleTimeZone: "America/Denver",
  }).timeZone, "America/New_York");
});

test("new schedule conditions inherit the rule clock instead of the server clock", () => {
  assert.equal(scheduleConditionTimeZone({ ruleTimeZone: "America/Denver", configuredTimeZone: "UTC" }), "America/Denver");
  assert.equal(scheduleConditionTimeZone({ ruleTimeZone: "invalid", configuredTimeZone: "America/Chicago" }), "America/Chicago");
});

test("finalized and retired migration targets return to the normal rule builder", async () => {
  const queries = [];
  const pool = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      queries.push(normalized);
      return { rows: [] };
    },
  };

  await new NotificationRuleBuilderRepository({ pool }).overview();

  const ruleQuery = queries.find((sql) => sql.includes("FROM public.notification_rules r"));
  assert.ok(ruleQuery);
  assert.match(ruleQuery, /m\.target_rule_id = r\.id/);
  assert.match(ruleQuery, /m\.retired_at IS NULL/);
  assert.match(ruleQuery, /m\.finalized_at IS NULL/);
  assert.match(ruleQuery, /AS migrated_from_legacy/);
  assert.match(ruleQuery, /r\.deleted_at IS NULL/);
});

test("legacy UTC repair is limited to tracked migrated rules", async () => {
  const migrations = await readFile(new URL("../migrations.sql", import.meta.url), "utf8");
  const repair = migrations.match(/-- Legacy copies predate explicit rule clocks[\s\S]*?(?=INSERT INTO public\.schema_migrations)/)?.[0];
  assert.ok(repair);
  assert.match(repair, /rule\.time_zone = 'UTC'/);
  assert.match(repair, /notification_rule_migrations migration/);
  assert.match(repair, /migration\.target_rule_id = rule\.id/);
  assert.match(repair, /settings\.local_timezone/);
  assert.match(repair, /condition\.condition_type = 'local_time_window'/);
});

test("deleting a disabled rule hides it atomically while preserving history", async () => {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, values });
      if (normalized.includes("SELECT r.*")) {
        return { rows: [{
          id: 44,
          name: "Entry LPR 1 Match Delivery Tag",
          description: "",
          enabled: false,
          event_type: "plate_read.accepted",
          time_zone: "America/Denver",
          quiet_hours: { enabled: false },
          cooldown_seconds: 0,
          version: 3,
          managed_by_migration: false,
        }] };
      }
      if (normalized.includes("SELECT g.*")) {
        return { rows: [{ id: 51, rule_id: 44, parent_group_id: null, combinator: "all", position: 0 }] };
      }
      if (normalized.includes("SELECT c.*")) return { rows: [] };
      if (normalized.includes("SELECT a.*")) {
        return { rows: [{
          id: 61,
          rule_id: 44,
          channel_id: 71,
          enabled: false,
          position: 0,
          configuration: {},
          channel_name: "Delivery MQTT",
          channel_type: "mqtt",
          channel_enabled: false,
          channel_configuration: {},
        }] };
      }
      if (normalized.startsWith("SELECT COUNT(*)::integer AS count")) return { rows: [{ count: 0 }] };
      if (normalized.startsWith("UPDATE public.notification_deliveries")) return { rows: [], rowCount: 2 };
      if (normalized.startsWith("UPDATE public.notification_rules")) {
        return { rows: [{ id: 44, name: "Entry LPR 1 Match Delivery Tag", version: 3 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const repository = new NotificationRuleBuilderRepository({
    pool: { query: (...args) => client.query(...args), connect: async () => client },
  });

  const result = await repository.deleteRule({
    id: 44,
    expectedName: "Entry LPR 1 Match Delivery Tag",
    actor: { id: 9 },
  });

  assert.deepEqual(result, {
    ruleId: 44,
    name: "Entry LPR 1 Match Delivery Tag",
    version: 3,
    deleted: true,
    cancelledDeliveries: 2,
  });
  assert.ok(calls.some(({ sql }) => sql.includes("status = 'cancelled'")));
  assert.ok(calls.some(({ sql }) => sql.includes("deleted_at = CURRENT_TIMESTAMP")));
  assert.ok(calls.some(({ sql, values }) => sql.startsWith("INSERT INTO public.audit_events") && values[0] === 9 && values[1] === "notification.rule_deleted"));
  assert.equal(calls.at(-1).sql, "COMMIT");
});
