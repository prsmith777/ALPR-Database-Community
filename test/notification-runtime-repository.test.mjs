import assert from "node:assert/strict";
import test from "node:test";

import { NotificationRuntimeRepository } from "../lib/notification-runtime-repository.mjs";

test("the unified runtime loads enabled MQTT and Pushover actions without credentials", async () => {
  const queries = [];
  const executor = {
    async query(sql, values = []) {
      const compact = sql.replace(/\s+/g, " ").trim();
      queries.push({ sql: compact, values });
      if (compact.includes("SELECT r.id, r.name")) return { rows: [{ id: 4, name: "Monitored", description: "", event_type: "plate_read.accepted", cooldown_seconds: 300, version: 2 }] };
      if (compact.includes("SELECT g.id, g.rule_id")) return { rows: [{ id: 8, rule_id: 4, parent_group_id: null, combinator: "all", negated: false, position: 0 }] };
      if (compact.includes("SELECT c.id, c.group_id")) return { rows: [{ id: 9, group_id: 8, condition_type: "watchlist", operator: "is_true", operand: { expected: true }, position: 0 }] };
      if (compact.includes("SELECT a.id, a.rule_id")) return { rows: [{ id: 12, rule_id: 4, position: 0, configuration: { priority: 1 }, channel_id: 11, channel_type: "pushover", credential_reference: "settings:notifications.pushover", channel_configuration: {} }] };
      throw new Error(`Unexpected query: ${compact}`);
    },
  };
  const repository = new NotificationRuntimeRepository({ executor });
  const rules = await repository.loadEnabledRules();
  assert.equal(rules[0].conditionTree.children[0].conditionType, "watchlist");
  assert.equal(rules[0].actions[0].channelType, "pushover");
  assert.equal(rules[0].actions[0].configuration.priority, 1);
  assert.equal(queries.every((query) => !query.sql.includes("app_token") && !query.sql.includes("user_key")), true);
  assert.match(queries[0].sql, /channel_type IN \('mqtt', 'pushover'\)/);
});

test("cooldown history is loaded only for explicit enabled rule IDs", async () => {
  const executor = {
    async query(sql, values) {
      assert.match(sql, /outcome = 'matched'/);
      assert.deepEqual(values, [[4, 8]]);
      return { rows: [{ rule_id: 4, last_matched_at: "2026-07-24T12:00:00.000Z" }] };
    },
  };
  const repository = new NotificationRuntimeRepository({ executor });
  assert.deepEqual(await repository.loadLastMatchedAt([4, 8, 4, "bad"]), {
    4: "2026-07-24T12:00:00.000Z",
  });
});

test("read-count metrics are deduplicated and scoped to the event at evaluation time", async () => {
  const calls = [];
  const repository = new NotificationRuntimeRepository({ executor: {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [{ count: values[2] === "plate" ? 4 : 9 }] };
    },
  } });
  const count = (scope, windowSeconds) => ({ kind: "condition", conditionType: "read_count", value: { scope, windowSeconds } });
  const rules = [{ conditionTree: { kind: "group", children: [count("plate", 600), count("plate", 600), count("global", 0)] } }];
  const metrics = await repository.loadReadCountMetrics({ rules, event: { plateNumber: "ABC123", cameraName: "Gate", timestamp: "2026-07-24T12:00:00Z" } });
  assert.equal(calls.length, 2);
  assert.deepEqual(metrics.readCounts.map((metric) => metric.count), [4, 9]);
  assert.match(calls[0].sql, /pr\.timestamp <= \$1::timestamptz/);
});
