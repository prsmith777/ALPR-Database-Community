import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { NotificationRuleDraftRepository } from "../lib/notification-rule-draft-repository.mjs";
import { buildNotificationShadowReview } from "../lib/notification-shadow-review.mjs";

function draftPool({ deliveryEnabled = false, includeKnownGuard = true } = {}) {
  const calls = [];
  const conditionRows = [
    ...(includeKnownGuard
      ? [{ id: 1, group_id: 61, condition_type: "known_plate", operator: "is_true", operand: { expected: true }, position: 0 }]
      : []),
    { id: 2, group_id: 61, condition_type: "tag", operator: "any", operand: { tags: ["Delivery"] }, position: 1 },
    { id: 3, group_id: 61, condition_type: "camera", operator: "in", operand: { names: ["Entry LPR 1"] }, position: 2 },
  ];
  const client = {
    async query(sql, values = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, values });
      if (normalized.includes("FROM public.notification_rule_migrations m")) {
        return { rows: [{ source_type: "mqtt", source_id: 7, id: 51, name: "Delivery arrival", enabled: false, event_type: "plate_read.accepted", cooldown_seconds: 0, version: 2 }] };
      }
      if (normalized.startsWith("SELECT a.id, a.enabled AS action_enabled")) {
        return { rows: [{ id: 71, action_enabled: deliveryEnabled, channel_id: 81, channel_enabled: deliveryEnabled }] };
      }
      if (normalized.startsWith("SELECT id, parent_group_id")) {
        return { rows: [{ id: 61, parent_group_id: null, combinator: "all", negated: false, position: 0 }] };
      }
      if (normalized.startsWith("SELECT c.id, c.group_id")) return { rows: conditionRows };
      if (normalized.startsWith("UPDATE public.notification_rules")) {
        return { rowCount: 1, rows: [{ id: 51, version: 3 }] };
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

test("disabled tag rule can remove the known-plate guard without enabling delivery", async () => {
  const fixture = draftPool();
  const repository = new NotificationRuleDraftRepository({ pool: fixture.pool });
  const result = await repository.updateTagCameraRule({
    ruleId: 51,
    requireKnownPlate: false,
    tags: ["Delivery"],
    cameras: ["Entry LPR 1", "Entry LPR 2"],
    actor: { id: 9 },
  });

  assert.equal(result.version, 3);
  assert.equal(result.requireKnownPlate, false);
  assert.equal(result.ruleRemainedDisabled, true);
  assert.equal(result.deliveryAttempts, 0);
  const insertedTypes = fixture.calls
    .filter(({ sql }) => sql.startsWith("INSERT INTO public.notification_conditions"))
    .map(({ values }) => values[1]);
  assert.deepEqual(insertedTypes, ["tag", "camera"]);
  assert.ok(fixture.calls.some(({ sql }) => sql.startsWith("DELETE FROM public.notification_conditions")));
  assert.ok(fixture.calls.some(({ sql }) => sql === "COMMIT"));
  assert.ok(!fixture.calls.some(({ sql }) => /SET enabled = TRUE/i.test(sql)));
});

test("rule editing fails closed if an action or channel is enabled", async () => {
  const fixture = draftPool({ deliveryEnabled: true });
  const repository = new NotificationRuleDraftRepository({ pool: fixture.pool });
  await assert.rejects(
    repository.updateTagCameraRule({
      ruleId: 51,
      tags: ["Delivery"],
      cameras: ["Entry LPR 1"],
    }),
    /rule, channel, and actions to remain disabled/i
  );
  assert.ok(fixture.calls.some(({ sql }) => sql === "ROLLBACK"));
  assert.ok(!fixture.calls.some(({ sql }) => sql.startsWith("DELETE FROM public.notification_conditions")));
});

test("no-delivery simulator matches an unknown tagged plate without writing", async () => {
  const fixture = draftPool({ includeKnownGuard: false });
  const repository = new NotificationRuleDraftRepository({ pool: fixture.pool });
  const result = await repository.simulate({
    ruleId: 51,
    plateNumber: "Y157047",
    cameraName: "Entry LPR 1",
    tags: ["Delivery"],
    knownPlate: false,
  });

  assert.equal(result.matched, true);
  assert.equal(result.reason, "no-enabled-actions");
  assert.equal(result.deliveryAttempts, 0);
  assert.equal(result.ruleRemainedDisabled, true);
  assert.ok(fixture.calls.every(({ sql }) => sql.startsWith("SELECT")));
  assert.ok(fixture.calls.every(({ sql }) => !sql.includes("FOR UPDATE")));
});

test("shadow review classifies tag-only behavior as a safe intentional expansion", () => {
  const report = buildNotificationShadowReview({
    entries: [{
      sourceType: "mqtt",
      sourceId: 7,
      sourceRule: {
        id: 7,
        name: "Delivery arrival",
        enabled: true,
        match_type: "tag",
        match_value: "Delivery",
        camera_ids: [1],
      },
      targetRule: {
        id: 51,
        name: "Delivery arrival",
        enabled: false,
        eventType: "plate_read.accepted",
        version: 3,
        conditionTree: {
          kind: "group",
          combinator: "all",
          children: [
            { kind: "condition", conditionType: "tag", operator: "any", value: { tags: ["Delivery"] } },
            { kind: "condition", conditionType: "camera", operator: "in", value: { names: ["Entry LPR 1"] } },
          ],
        },
        actions: [{ enabled: false, channelEnabled: false }],
      },
    }],
    recentReads: [{
      id: 100,
      plate_number: "Y157047",
      observed_plate: "Y157047",
      timestamp: "2026-07-22T23:08:33.000Z",
      camera_name: "Entry LPR 1",
      mqtt_camera_id: 1,
      tags: ["Delivery"],
      known_plate: false,
    }],
    knownPlates: [],
  });

  assert.equal(report.rules[0].status, "intentional_expansion");
  assert.equal(report.rules[0].expansionCount, 1);
  assert.equal(report.rules[0].regressionCount, 0);
  assert.equal(report.rules[0].unifiedPositiveMatchCount, 1);
  assert.equal(report.deliveryAttempts, 0);
});

test("editor UI and server actions preserve disabled-only and no-delivery boundaries", async () => {
  const [actions, editor, page, migration] = await Promise.all([
    readFile(new URL("../app/actions.js", import.meta.url), "utf8"),
    readFile(new URL("../components/NotificationRuleDraftEditor.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/notifications/page.jsx", import.meta.url), "utf8"),
    readFile(new URL("../migrations.sql", import.meta.url), "utf8"),
  ]);
  assert.match(actions, /updateDisabledUnifiedNotificationRule[\s\S]*?requirePermission\("notification\.manage"\)/);
  assert.match(actions, /simulateDisabledUnifiedNotificationRule[\s\S]*?requirePermission\("notification\.manage"\)/);
  assert.match(actions, /save_disabled_rule_draft/);
  assert.match(editor, /No-delivery simulator/);
  assert.match(editor, /Clear this for a true tag-only rule/);
  assert.match(page, /NotificationRuleDraftEditor/);
  assert.match(migration, /intentional_expansion/);
});
