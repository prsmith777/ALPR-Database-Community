import assert from "node:assert/strict";
import test from "node:test";

import { NotificationOperationsWorker } from "../lib/notification-operations-worker.mjs";
import { normalizeNotificationRuleDraft } from "../lib/notification-rule-builder-shape.mjs";
import { evaluateNotificationRule } from "../lib/notification-rule-engine.mjs";

function activityDraft(overrides = {}) {
  return {
    name: "Entry camera quiet",
    eventType: "camera.activity_check",
    timeZone: "America/Denver",
    evaluationIntervalSeconds: 300,
    quietHours: { enabled: false },
    cooldownSeconds: 0,
    conditionTree: {
      kind: "group",
      combinator: "all",
      children: [
        { kind: "condition", conditionType: "camera", operator: "in", value: { names: ["Entry LPR"] } },
        { kind: "condition", conditionType: "read_count", operator: "at_most", value: { scope: "camera", count: 0, windowSeconds: 900 } },
      ],
    },
    actions: [{ channelType: "pushover", configuration: { priority: 1, message: "" } }],
    ...overrides,
  };
}

test("camera activity drafts require a camera-scoped count window and preserve their explicit clock", () => {
  const normalized = normalizeNotificationRuleDraft(activityDraft());
  assert.equal(normalized.eventType, "camera.activity_check");
  assert.equal(normalized.timeZone, "America/Denver");
  assert.equal(normalized.evaluationIntervalSeconds, 300);
  assert.throws(() => normalizeNotificationRuleDraft(activityDraft({
    conditionTree: { kind: "group", combinator: "all", children: [{ kind: "condition", conditionType: "always", operator: "always", value: {} }] },
  })), /select at least one camera/i);
});

test("quiet hours suppress a matched rule using the event time and rule timezone", () => {
  const rule = {
    id: 9,
    name: "Overnight quiet",
    enabled: true,
    version: 1,
    eventTypes: ["plate_read.accepted"],
    timeZone: "America/Denver",
    quietHours: { enabled: true, start: "22:00", end: "06:00", weekdays: [], timeZone: "America/Denver" },
    conditionTree: { kind: "group", combinator: "all", children: [{ kind: "condition", conditionType: "always", operator: "always", value: {} }] },
    actions: [{ id: 1, enabled: true, channelType: "pushover" }],
  };
  const decision = evaluateNotificationRule(rule, {
    event: { type: "plate_read.accepted", timestamp: "2026-07-25T05:00:00.000Z" },
  });
  assert.equal(decision.outcome, "suppressed");
  assert.equal(decision.reason, "quiet-hours-active");
  assert.equal(decision.quietHours.actual.timeZone, "America/Denver");
});

test("scheduled camera checks record a trace and queue a durable Pushover delivery", async () => {
  const enqueued = [];
  const recorded = [];
  const rule = {
    id: 41,
    name: "Entry camera quiet",
    enabled: true,
    version: 2,
    eventTypes: ["camera.activity_check"],
    timeZone: "America/Denver",
    quietHours: { enabled: false },
    evaluationIntervalSeconds: 300,
    conditionTree: normalizeNotificationRuleDraft(activityDraft()).conditionTree,
    actions: [{ id: 70, channelId: 80, enabled: true, channelType: "pushover", configuration: { priority: 1, message: "" } }],
  };
  const repository = {
    async claimDueActivityRuleIds() { return [41]; },
    async loadEnabledRules() { return [rule]; },
    async loadReadCountMetrics() { return { readCounts: [{ scope: "camera", windowSeconds: 900, count: 0 }] }; },
    async recordExecutions(value) { recorded.push(value); return [{ ...value.decisions[0], executionId: 501 }]; },
    async enqueueDelivery(value) { enqueued.push(value); return { id: 601, inserted: true }; },
    async releaseExpiredPushoverLeases() { return []; },
    async claimDuePushoverDeliveries() { return []; },
  };
  const mqttRepository = {
    async loadRuntimeContext() { return { settings: { enabled: false } }; },
    async discoverCamera() { return { id: 2, cameraName: "Entry LPR", cameraKey: "entry-lpr", topicOverride: "" }; },
  };
  const worker = new NotificationOperationsWorker({
    repository,
    mqttRepository,
    now: () => new Date("2026-07-24T18:00:00.000Z"),
  });
  const result = await worker.runOnce();
  assert.equal(result.schedule.evaluated, 1);
  assert.equal(result.schedule.queued, 1);
  assert.equal(recorded[0].eventType, "camera.activity_check");
  assert.equal(enqueued[0].executionId, 501);
  assert.match(enqueued[0].payload.message, /recorded 0 reads in the last 15 minutes/);
});

test("failed Pushover delivery is written back to retry history", async () => {
  const failures = [];
  const repository = {
    async claimDueActivityRuleIds() { return []; },
    async loadEnabledRules() { return []; },
    async releaseExpiredPushoverLeases() { return []; },
    async claimDuePushoverDeliveries() { return [{ id: 77, payload: { plateNumber: "ABC123", message: "Alert" } }]; },
    async recordPushoverFailure(value) { failures.push(value); return { status: "retry" }; },
  };
  const worker = new NotificationOperationsWorker({
    repository,
    mqttRepository: {},
    sendPushover: async () => ({ success: false, error: "temporary outage" }),
    logger: { warn() {}, error() {} },
  });
  const result = await worker.runOnce();
  assert.equal(result.retry, 1);
  assert.equal(failures[0].deliveryId, 77);
  assert.match(String(failures[0].error.message), /temporary outage/);
});
