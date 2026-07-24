import assert from "node:assert/strict";
import test from "node:test";

import { NotificationAcceptedReadService } from "../lib/notification-accepted-read-service.mjs";

function unifiedRule(overrides = {}) {
  return {
    id: 51,
    name: "Delivery arrival",
    enabled: true,
    eventTypes: ["plate_read.accepted"],
    cooldownSeconds: 0,
    version: 2,
    conditionTree: {
      kind: "group",
      combinator: "all",
      children: [
        { kind: "condition", conditionType: "known_plate", operator: "is_true", value: { expected: true } },
        { kind: "condition", conditionType: "tag", operator: "any", value: { tags: ["Delivery"] } },
        { kind: "condition", conditionType: "camera", operator: "in", value: { names: ["Entry LPR 1"] } },
      ],
    },
    actions: [
      {
        id: 71,
        enabled: true,
        channelType: "mqtt",
        configuration: {
          brokerId: 2,
          destinationMode: "per_camera",
          message: "Delivery arrived",
        },
      },
    ],
    ...overrides,
  };
}

function fixture({ rules = [unifiedRule()], tags = ["Delivery"] } = {}) {
  const executions = [];
  const envelopes = [];
  return {
    executions,
    envelopes,
    repository: {
      async loadEnabledMqttRules() {
        return rules;
      },
      async recordExecutions(value) {
        executions.push(value);
      },
    },
    mqttRepository: {
      async discoverCamera() {
        return { id: 11, cameraName: "Entry LPR 1", cameraKey: "entry-lpr-1", topicOverride: "" };
      },
      async loadRuntimeContext() {
        return {
          settings: {
            enabled: true,
            baseTopic: "Blue Iris/ALPR",
            cameraTopicTemplate: "{base_topic}/{camera_key}",
            defaultQos: 1,
            retainMessages: false,
            localTimezone: "America/Denver",
            hourFormat: 12,
          },
          knownPlates: [{ plateNumber: "069YQZ", name: "Test car", tags, flagged: false }],
        };
      },
      async enqueueDelivery(envelope) {
        envelopes.push(envelope);
        return { id: 90, inserted: true };
      },
    },
  };
}

test("an enabled unified MQTT rule records its decision and queues the durable MQTT outbox", async () => {
  const state = fixture();
  const service = new NotificationAcceptedReadService({
    repository: state.repository,
    mqttRepository: state.mqttRepository,
    now: () => new Date("2026-07-22T20:00:00.000Z"),
  });
  const result = await service.processAcceptedRead({
    id: 36458,
    plate_number: "069YQZ",
    observed_plate: "069YQZ",
    camera_name: "Entry LPR 1",
    timestamp: "2026-07-22T20:00:00.000Z",
    confidence: 0.96,
  });

  assert.equal(result.status, "queued");
  assert.equal(result.queued, 1);
  assert.equal(state.executions.length, 1);
  assert.equal(state.executions[0].decisions[0].outcome, "matched");
  assert.equal(state.envelopes.length, 1);
  assert.equal(state.envelopes[0].brokerId, 2);
  assert.equal(state.envelopes[0].topic, "Blue Iris/ALPR/entry-lpr-1");
  assert.equal(state.envelopes[0].payload.notification_runtime, "unified-v1");
  assert.equal(state.envelopes[0].payload.notification_rule_ids, "51");
  assert.equal(state.envelopes[0].payload.message, "Delivery arrived");
  assert.equal(state.envelopes[0].payload.timestamp_source, "blue_iris");
});

test("unified tag rules do not queue for a known plate without the current tag", async () => {
  const state = fixture({ tags: ["Family"] });
  const service = new NotificationAcceptedReadService({
    repository: state.repository,
    mqttRepository: state.mqttRepository,
  });
  const result = await service.processAcceptedRead({
    id: 36458,
    plate_number: "069YQZ",
    camera_name: "Entry LPR 1",
    timestamp: "2026-07-22T20:00:00.000Z",
  });

  assert.equal(result.status, "no-match");
  assert.equal(result.planned, 0);
  assert.equal(state.executions[0].decisions[0].outcome, "not_matched");
  assert.equal(state.envelopes.length, 0);
});

test("the unified runtime remains inert when no unified rules are enabled", async () => {
  const state = fixture({ rules: [] });
  const service = new NotificationAcceptedReadService({
    repository: state.repository,
    mqttRepository: state.mqttRepository,
  });
  const result = await service.processAcceptedRead({
    id: 36458,
    plate_number: "069YQZ",
    camera_name: "Entry LPR 1",
  });
  assert.equal(result.status, "disabled");
  assert.equal(state.envelopes.length, 0);
  assert.equal(state.executions.length, 0);
});

test("unified Pushover actions are planned for post-commit delivery and honor cooldown history", async () => {
  const state = fixture({
    rules: [unifiedRule({
      cooldownSeconds: 900,
      actions: [{ id: 72, enabled: true, channelType: "pushover", configuration: { priority: 1, message: "Delivery arrived" } }],
    })],
  });
  state.repository.loadEnabledRules = state.repository.loadEnabledMqttRules;
  state.repository.loadLastMatchedAt = async () => ({ 51: "2026-07-22T19:00:00.000Z" });
  const service = new NotificationAcceptedReadService({
    repository: state.repository,
    mqttRepository: state.mqttRepository,
    now: () => new Date("2026-07-22T20:00:00.000Z"),
  });
  const result = await service.processAcceptedRead({
    id: 36459,
    plate_number: "069YQZ",
    camera_name: "Entry LPR 1",
    timestamp: "2026-07-22T20:00:00.000Z",
  });

  assert.equal(result.status, "planned");
  assert.equal(result.pushoverPlans.length, 1);
  assert.equal(result.pushoverPlans[0].ruleId, 51);
  assert.equal(result.pushoverPlans[0].message, "Delivery arrived");
  assert.equal(state.envelopes.length, 0);

  state.repository.loadLastMatchedAt = async () => ({ 51: "2026-07-22T19:55:00.000Z" });
  const suppressed = await service.processAcceptedRead({
    id: 36460,
    plate_number: "069YQZ",
    camera_name: "Entry LPR 1",
    timestamp: "2026-07-22T20:00:00.000Z",
  });
  assert.equal(suppressed.status, "no-match");
  assert.equal(suppressed.pushoverPlans.length, 0);
});

test("accepted-read evaluation supplies repository count metrics", async () => {
  const state = fixture({ rules: [unifiedRule({
    conditionTree: { kind: "group", combinator: "all", children: [{ kind: "condition", conditionType: "read_count", operator: "at_least", value: { scope: "plate", count: 3, windowSeconds: 600 } }] },
  })] });
  state.repository.loadReadCountMetrics = async () => ({ readCounts: [{ scope: "plate", windowSeconds: 600, count: 3 }] });
  const service = new NotificationAcceptedReadService({ repository: state.repository, mqttRepository: state.mqttRepository });
  const result = await service.processAcceptedRead({ id: 36500, plate_number: "069YQZ", camera_name: "Entry LPR 1", timestamp: "2026-07-22T20:00:00.000Z" });
  assert.equal(result.status, "queued");
  assert.equal(state.executions[0].decisions[0].trace.children[0].actual, 3);
});
