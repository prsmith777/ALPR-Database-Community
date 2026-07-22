import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateNotificationCondition,
  evaluateNotificationRule,
  evaluateNotificationRules,
} from "../lib/notification-rule-engine.mjs";

function condition(conditionType, operator, value, id = null) {
  return { kind: "condition", id, conditionType, operator, value };
}

function all(...children) {
  return { kind: "group", combinator: "all", children };
}

function any(...children) {
  return { kind: "group", combinator: "any", children };
}

function baseRule(overrides = {}) {
  return {
    id: 7,
    name: "Family arrival",
    version: 1,
    enabled: true,
    eventTypes: ["plate_read.accepted"],
    cooldownSeconds: 0,
    conditionTree: all(condition("always")),
    actions: [{ id: 12, enabled: true, channelType: "pushover" }],
    ...overrides,
  };
}

const acceptedRead = {
  type: "plate_read.accepted",
  plateNumber: "DP0M90",
  cameraName: "Driveway",
  timestamp: "2026-07-18T05:30:00.000Z",
  confidence: 0.91,
  knownPlate: true,
  watchlisted: false,
  tags: ["Family", "Resident"],
};

test("nested condition groups produce an explainable matching decision", () => {
  const rule = baseRule({
    conditionTree: all(
      any(
        condition("tag", "any", { tags: ["Family"] }, 1),
        condition("watchlist", "is_true", true, 2)
      ),
      condition("camera", "in", { names: ["Driveway", "Gate"] }, 3)
    ),
  });

  const decision = evaluateNotificationRule(rule, { event: acceptedRead });
  assert.equal(decision.outcome, "matched");
  assert.equal(decision.matched, true);
  assert.equal(decision.shouldDeliver, true);
  assert.equal(decision.trace.children[0].combinator, "any");
  assert.equal(decision.trace.children[0].children[0].reason, "tag-matched");
  assert.equal(decision.trace.children[0].children[1].reason, "watchlist-mismatch");
});

test("plate conditions reuse the shared exact and fuzzy matching profiles", () => {
  const exact = evaluateNotificationCondition(
    condition("plate_match", "matches", { plate: "DPOM90", mode: "off" }),
    { event: acceptedRead }
  );
  const strict = evaluateNotificationCondition(
    condition("plate_match", "matches", { plate: "DPOM90", mode: "strict" }),
    { event: acceptedRead }
  );

  assert.equal(exact.matched, false);
  assert.equal(exact.evidence.mode, "off");
  assert.equal(strict.matched, true);
  assert.equal(strict.evidence.method, "ocr");
});

test("known-name conditions preserve legacy MQTT name matching", () => {
  const matching = evaluateNotificationCondition(
    condition("known_name", "equals", { names: ["Liz's Lexus"] }),
    { event: { ...acceptedRead, knownName: "Liz's Lexus" } }
  );
  const mismatch = evaluateNotificationCondition(
    condition("known_name", "in", { names: ["Delivery Van"] }),
    { event: { ...acceptedRead, known_name: "Liz's Lexus" } }
  );

  assert.equal(matching.matched, true);
  assert.equal(matching.reason, "known-name-matched");
  assert.equal(mismatch.matched, false);
  assert.equal(mismatch.reason, "known-name-mismatch");
});

test("count conditions consume explicit precomputed metrics without database side effects", () => {
  const readCount = condition("read_count", "at_least", {
    scope: "plate",
    windowSeconds: 600,
    count: 3,
  });
  const context = {
    event: acceptedRead,
    metrics: {
      readCounts: [{ scope: "plate", windowSeconds: 600, count: 4 }],
    },
  };

  assert.equal(evaluateNotificationCondition(readCount, context).matched, true);
  assert.equal(
    evaluateNotificationCondition(readCount, { event: acceptedRead }).reason,
    "missing-read-count-metric"
  );
});

test("local schedules support weekdays, time zones, and overnight windows", () => {
  const fridayOvernight = condition("local_time_window", "within", {
    timeZone: "America/Denver",
    weekdays: [5],
    start: "22:00",
    end: "06:00",
  });

  const result = evaluateNotificationCondition(fridayOvernight, {
    event: { ...acceptedRead, timestamp: "2026-07-18T07:30:00.000Z" },
  });
  assert.equal(result.matched, true);
  assert.equal(result.actual.weekday, 6);
  assert.equal(result.reason, "within-local-time-window");
});

test("cooldowns preserve the match trace while suppressing delivery", () => {
  const decision = evaluateNotificationRule(
    baseRule({ cooldownSeconds: 900 }),
    {
      event: acceptedRead,
      now: "2026-07-18T05:30:00.000Z",
      lastMatchedAt: { 7: "2026-07-18T05:20:00.000Z" },
    }
  );

  assert.equal(decision.outcome, "suppressed");
  assert.equal(decision.matched, true);
  assert.equal(decision.shouldDeliver, false);
  assert.equal(decision.retryAt, "2026-07-18T05:35:00.000Z");
  assert.equal(decision.trace.matched, true);
});

test("disabled, event-filtered, malformed, and actionless rules fail closed", () => {
  assert.equal(
    evaluateNotificationRule(baseRule({ enabled: false }), { event: acceptedRead }).outcome,
    "disabled"
  );
  assert.equal(
    evaluateNotificationRule(baseRule({ eventTypes: ["camera.activity_check"] }), {
      event: acceptedRead,
    }).outcome,
    "event_filtered"
  );
  assert.equal(
    evaluateNotificationRule(baseRule({ conditionTree: { combinator: "all", children: [] } }), {
      event: acceptedRead,
    }).outcome,
    "invalid"
  );
  const actionless = evaluateNotificationRule(baseRule({ actions: [] }), { event: acceptedRead });
  assert.equal(actionless.outcome, "matched");
  assert.equal(actionless.shouldDeliver, false);
  assert.equal(actionless.reason, "no-enabled-actions");
});

test("batch evaluation separates matched rules from rules eligible for delivery", () => {
  const result = evaluateNotificationRules(
    [
      baseRule({ id: 1 }),
      baseRule({ id: 2, actions: [] }),
      baseRule({ id: 3, enabled: false }),
    ],
    { event: acceptedRead }
  );

  assert.equal(result.decisions.length, 3);
  assert.deepEqual(result.matched.map((decision) => decision.ruleId), [1, 2]);
  assert.deepEqual(result.deliverable.map((decision) => decision.ruleId), [1]);
});
