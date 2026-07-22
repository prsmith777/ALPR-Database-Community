import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildNotificationShadowReview } from "../lib/notification-shadow-review.mjs";
import { notificationShadowReviewRepositoryInternals } from "../lib/notification-shadow-review-repository.mjs";

function targetRule({ id = 51, conditionTree } = {}) {
  return {
    id,
    name: "Disabled unified copy",
    enabled: false,
    eventType: "plate_read.accepted",
    cooldownSeconds: 0,
    version: 1,
    conditionTree,
    actions: [
      {
        id: 71,
        enabled: false,
        channelType: "mqtt",
        channelEnabled: false,
      },
    ],
  };
}

function read(overrides = {}) {
  return {
    id: 101,
    plate_number: "ABC123",
    observed_plate: "ABC123",
    timestamp: "2026-07-22T18:00:00.000Z",
    camera_name: "Street LPR",
    mqtt_camera_id: 11,
    camera_key: "street-lpr",
    confidence: 91,
    known_plate: false,
    known_name: "",
    tags: [],
    watchlisted: false,
    ...overrides,
  };
}

test("shadow review compares legacy and unified semantics without enabling delivery", () => {
  const report = buildNotificationShadowReview({
    entries: [
      {
        sourceType: "mqtt",
        sourceId: 7,
        sourceRule: {
          id: 7,
          name: "Any street plate",
          enabled: true,
          match_type: "any_plate",
          camera_ids: [11],
        },
        targetRule: targetRule({
          conditionTree: {
            kind: "group",
            combinator: "all",
            children: [
              { kind: "condition", conditionType: "always", operator: "is_true", value: {} },
              { kind: "condition", conditionType: "camera", operator: "in", value: { names: ["Street LPR"] } },
            ],
          },
        }),
      },
    ],
    recentReads: [read(), read({ id: 102, mqtt_camera_id: 12, camera_name: "Garage" })],
  });

  assert.equal(report.mode, "read_only_shadow");
  assert.equal(report.deliveryAttempts, 0);
  assert.equal(report.rules[0].sampleCount, 1, "camera-scoped rules use only relevant reads");
  assert.equal(report.rules[0].agreementCount, 1);
  assert.equal(report.rules[0].mismatchCount, 0);
  assert.equal(report.rules[0].positiveMatchCount, 1);
  assert.equal(report.rules[0].status, "ready");
  assert.equal(report.rules[0].allDisabled, true);
  assert.equal(report.rules[0].noDeliveries, true);
  assert.equal(report.rules[0].decisions[0].unifiedReason, "no-enabled-actions");
});

test("shadow review replays the effective plate identity used by live legacy MQTT", () => {
  const report = buildNotificationShadowReview({
    entries: [
      {
        sourceType: "mqtt",
        sourceId: 4,
        sourceRule: {
          id: 4,
          name: "Family arrival",
          enabled: true,
          match_type: "tag",
          match_value: "Family",
          plate_match_mode: "off",
          camera_ids: [11],
        },
        targetRule: targetRule({
          conditionTree: {
            kind: "group",
            combinator: "all",
            children: [
              { kind: "condition", conditionType: "known_plate", operator: "is_true", value: { expected: true } },
              { kind: "condition", conditionType: "tag", operator: "any", value: { tags: ["Family"] } },
            ],
          },
        }),
      },
    ],
    recentReads: [
      read({
        plate_number: "DPOM90",
        observed_plate: "BDPOM90",
        known_plate: true,
        known_name: "Liz's Lexus",
        tags: ["Family"],
      }),
    ],
    knownPlates: [{ plate_number: "DPOM90", name: "Liz's Lexus", tags: ["Family"] }],
  });

  assert.equal(report.rules[0].mismatchCount, 0);
  assert.equal(report.rules[0].positiveMatchCount, 1);
  assert.equal(report.rules[0].decisions[0].legacyReason, "matched");
});

test("migrated MQTT tag rules do not match tagged plates outside the known set", () => {
  const report = buildNotificationShadowReview({
    entries: [
      {
        sourceType: "mqtt",
        sourceId: 3,
        sourceRule: {
          id: 3,
          name: "Delivery arrival",
          enabled: true,
          match_type: "tag",
          match_value: "Delivery",
          plate_match_mode: "off",
          camera_ids: [11],
        },
        targetRule: targetRule({
          conditionTree: {
            kind: "group",
            combinator: "all",
            children: [
              { kind: "condition", conditionType: "known_plate", operator: "is_true", value: { expected: true } },
              { kind: "condition", conditionType: "tag", operator: "any", value: { tags: ["Delivery"] } },
            ],
          },
        }),
      },
    ],
    recentReads: [read({ plate_number: "Y157026", observed_plate: "Y157026", tags: ["Delivery"] })],
    knownPlates: [],
  });

  assert.equal(report.rules[0].mismatchCount, 0);
  assert.equal(report.rules[0].positiveMatchCount, 0);
  assert.equal(report.rules[0].status, "no_positive_matches");
  assert.equal(report.rules[0].decisions[0].legacyMatched, false);
  assert.equal(report.rules[0].decisions[0].unifiedMatched, false);
});

test("shadow review surfaces a semantic mismatch and blocks approval readiness", () => {
  const report = buildNotificationShadowReview({
    entries: [
      {
        sourceType: "pushover",
        sourceId: 8,
        sourceRule: { id: 8, plate_number: "ABC123", enabled: true },
        targetRule: targetRule({
          id: 52,
          conditionTree: {
            kind: "group",
            combinator: "all",
            children: [
              {
                kind: "condition",
                conditionType: "plate_match",
                operator: "matches",
                value: { plate: "XYZ999", mode: "off" },
              },
            ],
          },
        }),
      },
    ],
    recentReads: [read()],
  });

  assert.equal(report.rules[0].mismatchCount, 1);
  assert.equal(report.rules[0].status, "needs_review");
  assert.equal(report.rules[0].decisions[0].legacyMatched, true);
  assert.equal(report.rules[0].decisions[0].unifiedMatched, false);
});

test("approval applies only to the exact rule version and evidence fingerprint", () => {
  const input = {
    entries: [
      {
        sourceType: "pushover",
        sourceId: 8,
        sourceRule: { id: 8, plate_number: "ABC123", enabled: true },
        targetRule: targetRule({
          id: 52,
          conditionTree: {
            kind: "group",
            combinator: "all",
            children: [
              { kind: "condition", conditionType: "plate_match", operator: "matches", value: { plate: "ABC123", mode: "off" } },
            ],
          },
        }),
      },
    ],
    recentReads: [read()],
  };
  const first = buildNotificationShadowReview(input);
  const fingerprint = first.rules[0].reportFingerprint;
  const approved = buildNotificationShadowReview({
    ...input,
    reviews: [
      {
        id: 1,
        rule_id: 52,
        sample_count: 1,
        report_fingerprint: fingerprint,
        reviewed_at: "2026-07-22T18:05:00.000Z",
        reviewer_name: "admin",
      },
    ],
  });
  assert.equal(approved.rules[0].status, "approved");
  assert.equal(approved.rules[0].latestReview.current, true);

  const changed = buildNotificationShadowReview({ ...input, recentReads: [read(), read({ id: 103 })], reviews: approved.rules[0].latestReview ? [{ rule_id: 52, sample_count: 1, report_fingerprint: fingerprint, reviewed_at: "2026-07-22T18:05:00.000Z" }] : [] });
  assert.equal(changed.rules[0].status, "ready");
  assert.equal(changed.rules[0].latestReview.current, false);
});

test("negative-only agreement waits for a positive match before approval", () => {
  const report = buildNotificationShadowReview({
    entries: [
      {
        sourceType: "pushover",
        sourceId: 8,
        sourceRule: { id: 8, plate_number: "TARGET1", enabled: true },
        targetRule: targetRule({
          id: 52,
          conditionTree: {
            kind: "group",
            combinator: "all",
            children: [
              { kind: "condition", conditionType: "plate_match", operator: "matches", value: { plate: "TARGET1", mode: "off" } },
            ],
          },
        }),
      },
    ],
    recentReads: [read()],
  });
  assert.equal(report.rules[0].agreementCount, 1);
  assert.equal(report.rules[0].positiveMatchCount, 0);
  assert.equal(report.rules[0].status, "no_positive_matches");
});

test("condition rows hydrate into the nested evaluator tree", () => {
  const trees = notificationShadowReviewRepositoryInternals.buildConditionTrees(
    [
      { id: 1, rule_id: 51, parent_group_id: null, combinator: "all", negated: false, position: 0 },
      { id: 2, rule_id: 51, parent_group_id: 1, combinator: "any", negated: false, position: 1 },
    ],
    [
      { id: 3, group_id: 1, condition_type: "always", operator: "is_true", operand: {}, position: 0 },
      { id: 4, group_id: 2, condition_type: "tag", operator: "any", operand: { tags: ["visitor"] }, position: 0 },
    ]
  );
  const root = trees.get("51");
  assert.equal(root.children[0].conditionType, "always");
  assert.equal(root.children[1].combinator, "any");
  assert.equal(root.children[1].children[0].value.tags[0], "visitor");
});

test("shadow review UI and approval action preserve permission and no-delivery boundaries", async () => {
  const [actions, page, component, migration] = await Promise.all([
    readFile(new URL("../app/actions.js", import.meta.url), "utf8"),
    readFile(new URL("../app/notifications/page.jsx", import.meta.url), "utf8"),
    readFile(new URL("../components/UnifiedRuleShadowReview.jsx", import.meta.url), "utf8"),
    readFile(new URL("../migrations.sql", import.meta.url), "utf8"),
  ]);
  assert.match(actions, /getUnifiedNotificationRuleReview[\s\S]*?requirePermission\("notification\.manage"\)/);
  assert.match(actions, /approveUnifiedNotificationRuleReview[\s\S]*?requirePermission\("notification\.manage"\)/);
  assert.match(actions, /approve_disabled_shadow_review/);
  assert.match(page, /UnifiedRuleShadowReview/);
  assert.match(component, /writes no executions, publishes no messages, and attempts no delivery/);
  assert.match(migration, /notification_rule_shadow_reviews is append-only/);
  assert.match(migration, /mismatch_count INTEGER NOT NULL DEFAULT 0 CHECK \(mismatch_count = 0\)/);
});
