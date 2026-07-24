import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeNotificationRuleDraft,
  parseNotificationRuleDraft,
} from "../lib/notification-rule-builder-shape.mjs";

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
