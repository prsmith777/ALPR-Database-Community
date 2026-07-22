import { evaluatePlateIdentityMatch } from "./plate-matching.mjs";

export const NOTIFICATION_EVENT_TYPES = Object.freeze([
  "plate_read.accepted",
  "camera.activity_check",
]);

export const NOTIFICATION_CONDITION_TYPES = Object.freeze([
  "always",
  "event_type",
  "plate_match",
  "camera",
  "known_plate",
  "tag",
  "watchlist",
  "confidence",
  "read_count",
  "local_time_window",
]);

const GROUP_COMBINATORS = new Set(["all", "any", "not"]);
const NUMERIC_OPERATORS = new Set([
  "equals",
  "not_equals",
  "at_least",
  "at_most",
  "greater_than",
  "less_than",
  "between",
]);
const MAX_TREE_DEPTH = 8;
const MAX_TREE_NODES = 100;
const WEEKDAY_INDEX = Object.freeze({
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
});

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function normalizeText(value) {
  return String(value ?? "").trim().toLocaleLowerCase("en-US");
}

function normalizeStringList(value) {
  return [...new Set(asArray(value).map(normalizeText).filter(Boolean))];
}

function safeDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function conditionResult(condition, matched, reason, details = {}) {
  return {
    kind: "condition",
    id: firstDefined(condition?.id, condition?.conditionId, condition?.condition_id, null),
    conditionType: normalizeText(
      firstDefined(condition?.conditionType, condition?.condition_type, condition?.type)
    ),
    operator: normalizeText(condition?.operator),
    matched: Boolean(matched),
    reason,
    ...details,
  };
}

function invalidCondition(condition, reason) {
  return conditionResult(condition, false, reason, { invalid: true });
}

function compareNumber(actualValue, operator, expectedValue) {
  const actual = Number(actualValue);
  if (!Number.isFinite(actual) || !NUMERIC_OPERATORS.has(operator)) return null;

  if (operator === "between") {
    const bounds = asArray(expectedValue).map(Number);
    if (bounds.length !== 2 || bounds.some((value) => !Number.isFinite(value))) {
      return null;
    }
    const [minimum, maximum] = bounds;
    return minimum <= actual && actual <= maximum;
  }

  const expected = Number(expectedValue);
  if (!Number.isFinite(expected)) return null;
  if (operator === "equals") return actual === expected;
  if (operator === "not_equals") return actual !== expected;
  if (operator === "at_least") return actual >= expected;
  if (operator === "at_most") return actual <= expected;
  if (operator === "greater_than") return actual > expected;
  if (operator === "less_than") return actual < expected;
  return null;
}

function compareText(actualValue, operator, expectedValue) {
  const actual = normalizeText(actualValue);
  const expected = normalizeStringList(expectedValue);
  if (!actual || expected.length === 0) return null;
  if (["equals", "in"].includes(operator)) return expected.includes(actual);
  if (["not_equals", "not_in"].includes(operator)) return !expected.includes(actual);
  return null;
}

function eventFromContext(context) {
  return context?.event ?? context?.read ?? {};
}

function eventPlate(event) {
  return firstDefined(
    event?.effectivePlate,
    event?.effective_plate,
    event?.plateNumber,
    event?.plate_number,
    event?.plate,
    ""
  );
}

function eventTimestamp(event, context) {
  return firstDefined(
    event?.timestamp,
    event?.persistedTimestamp,
    event?.persisted_timestamp,
    context?.now
  );
}

function parseClock(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value ?? ""));
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function localClock(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    weekday: WEEKDAY_INDEX[values.weekday],
    minute: Number(values.hour) * 60 + Number(values.minute),
  };
}

function evaluateTimeWindow(condition, context, value) {
  const event = eventFromContext(context);
  const date = safeDate(eventTimestamp(event, context));
  if (!date) return invalidCondition(condition, "invalid-event-timestamp");

  const timeZone = String(value?.timeZone ?? value?.time_zone ?? "UTC").trim();
  const start = parseClock(value?.start);
  const end = parseClock(value?.end);
  if (start === null || end === null) {
    return invalidCondition(condition, "invalid-time-window");
  }

  let local;
  try {
    local = localClock(date, timeZone);
  } catch {
    return invalidCondition(condition, "invalid-time-zone");
  }

  const configuredWeekdays = asArray(value?.weekdays).map(Number);
  if (
    configuredWeekdays.length > 0 &&
    configuredWeekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)
  ) {
    return invalidCondition(condition, "invalid-weekdays");
  }

  let timeMatches;
  let scheduleWeekday = local.weekday;
  if (start === end) {
    timeMatches = true;
  } else if (start < end) {
    timeMatches = local.minute >= start && local.minute < end;
  } else {
    timeMatches = local.minute >= start || local.minute < end;
    if (local.minute < end) scheduleWeekday = local.weekday === 1 ? 7 : local.weekday - 1;
  }

  const weekdayMatches =
    configuredWeekdays.length === 0 || configuredWeekdays.includes(scheduleWeekday);
  const matched = timeMatches && weekdayMatches;
  return conditionResult(condition, matched, matched ? "within-local-time-window" : "outside-local-time-window", {
    actual: { weekday: local.weekday, minute: local.minute, timeZone },
    expected: { start: value.start, end: value.end, weekdays: configuredWeekdays, timeZone },
  });
}

function findReadCountMetric(context, value) {
  const scope = normalizeText(value?.scope || "plate");
  const windowSeconds = Number(value?.windowSeconds ?? value?.window_seconds);
  const metricKey = String(value?.metricKey ?? value?.metric_key ?? "").trim();
  const metrics = context?.metrics?.readCounts ?? context?.metrics?.read_counts ?? [];

  if (metricKey && metrics && !Array.isArray(metrics)) {
    const count = Number(metrics[metricKey]);
    return Number.isFinite(count) ? { count, scope, windowSeconds, metricKey } : null;
  }

  const metric = asArray(metrics).find((candidate) => {
    const candidateScope = normalizeText(candidate?.scope);
    const candidateWindow = Number(candidate?.windowSeconds ?? candidate?.window_seconds);
    const candidateKey = String(candidate?.metricKey ?? candidate?.metric_key ?? "").trim();
    if (metricKey) return candidateKey === metricKey;
    return candidateScope === scope && candidateWindow === windowSeconds;
  });
  if (!metric || !Number.isFinite(Number(metric.count))) return null;
  return { count: Number(metric.count), scope, windowSeconds, metricKey };
}

export function evaluateNotificationCondition(condition = {}, context = {}) {
  const conditionType = normalizeText(
    firstDefined(condition.conditionType, condition.condition_type, condition.type)
  );
  const operator = normalizeText(condition.operator);
  const value = firstDefined(condition.value, condition.operand, condition.configuration, {});
  const event = eventFromContext(context);

  if (!NOTIFICATION_CONDITION_TYPES.includes(conditionType)) {
    return invalidCondition(condition, "unsupported-condition-type");
  }
  if (conditionType === "always") {
    return conditionResult(condition, true, "always");
  }
  if (conditionType === "event_type") {
    const matched = compareText(event.type, operator || "in", value?.values ?? value);
    if (matched === null) return invalidCondition(condition, "invalid-event-type-condition");
    return conditionResult(condition, matched, matched ? "event-type-matched" : "event-type-mismatch", {
      actual: event.type ?? null,
      expected: value?.values ?? value,
    });
  }
  if (conditionType === "plate_match") {
    const candidate = String(value?.plate ?? value?.candidate ?? "").trim();
    if (!candidate) return invalidCondition(condition, "missing-plate-candidate");
    const evaluation = evaluatePlateIdentityMatch(
      eventPlate(event),
      candidate,
      value?.mode ?? "off",
      context?.matchingSettings ?? context?.matching_settings ?? {}
    );
    return conditionResult(
      condition,
      evaluation.matched,
      evaluation.matched ? "plate-matched" : "plate-mismatch",
      { actual: eventPlate(event), expected: candidate, evidence: evaluation }
    );
  }
  if (conditionType === "camera") {
    const actual = firstDefined(event.cameraName, event.camera_name, event.camera, "");
    const matched = compareText(actual, operator || "in", value?.names ?? value);
    if (matched === null) return invalidCondition(condition, "invalid-camera-condition");
    return conditionResult(condition, matched, matched ? "camera-matched" : "camera-mismatch", {
      actual,
      expected: value?.names ?? value,
    });
  }
  if (conditionType === "known_plate" || conditionType === "watchlist") {
    const actual =
      conditionType === "known_plate"
        ? Boolean(firstDefined(event.knownPlate, event.known_plate, event.knownName, event.known_name, false))
        : Boolean(firstDefined(event.watchlisted, event.watchlist, event.flagged, false));
    const expected = operator === "is_false" ? false : Boolean(value?.expected ?? value ?? true);
    const matched = actual === expected;
    return conditionResult(condition, matched, matched ? `${conditionType}-matched` : `${conditionType}-mismatch`, {
      actual,
      expected,
    });
  }
  if (conditionType === "tag") {
    const actual = normalizeStringList(firstDefined(event.tags, event.tagNames, event.tag_names, []));
    const expected = normalizeStringList(value?.tags ?? value);
    if (expected.length === 0) return invalidCondition(condition, "missing-tag-values");
    const mode = operator || "any";
    let matched;
    if (mode === "any") matched = expected.some((tag) => actual.includes(tag));
    else if (mode === "all") matched = expected.every((tag) => actual.includes(tag));
    else if (mode === "none") matched = expected.every((tag) => !actual.includes(tag));
    else return invalidCondition(condition, "invalid-tag-operator");
    return conditionResult(condition, matched, matched ? "tag-matched" : "tag-mismatch", {
      actual,
      expected,
    });
  }
  if (conditionType === "confidence") {
    const actual = firstDefined(event.confidence, event.plateConfidence, event.plate_confidence);
    const expected = value?.threshold ?? value?.value ?? value;
    const matched = compareNumber(actual, operator, expected);
    if (matched === null) return invalidCondition(condition, "invalid-confidence-condition");
    return conditionResult(condition, matched, matched ? "confidence-matched" : "confidence-mismatch", {
      actual: Number(actual),
      expected,
    });
  }
  if (conditionType === "read_count") {
    const metric = findReadCountMetric(context, value);
    if (!metric) return invalidCondition(condition, "missing-read-count-metric");
    const expected = value?.count;
    const matched = compareNumber(metric.count, operator, expected);
    if (matched === null) return invalidCondition(condition, "invalid-read-count-condition");
    return conditionResult(condition, matched, matched ? "read-count-matched" : "read-count-mismatch", {
      actual: metric.count,
      expected,
      metric: {
        scope: metric.scope,
        windowSeconds: metric.windowSeconds,
        metricKey: metric.metricKey || null,
      },
    });
  }
  if (conditionType === "local_time_window") {
    return evaluateTimeWindow(condition, context, value);
  }

  return invalidCondition(condition, "unsupported-condition-type");
}

function evaluateGroup(group, context, state, depth = 1) {
  state.nodes += 1;
  if (state.nodes > MAX_TREE_NODES) {
    return { kind: "group", matched: false, invalid: true, reason: "condition-tree-too-large", children: [] };
  }
  if (depth > MAX_TREE_DEPTH) {
    return { kind: "group", matched: false, invalid: true, reason: "condition-tree-too-deep", children: [] };
  }

  const combinator = normalizeText(firstDefined(group?.combinator, group?.operator, group?.type));
  const children = asArray(firstDefined(group?.children, group?.conditions, []));
  if (!GROUP_COMBINATORS.has(combinator)) {
    return { kind: "group", matched: false, invalid: true, reason: "invalid-group-combinator", combinator, children: [] };
  }
  if (children.length === 0 || (combinator === "not" && children.length !== 1)) {
    return { kind: "group", matched: false, invalid: true, reason: "invalid-group-size", combinator, children: [] };
  }

  const traces = children.map((child) => {
    const isGroup =
      child?.kind === "group" ||
      GROUP_COMBINATORS.has(normalizeText(firstDefined(child?.combinator, child?.type)));
    return isGroup
      ? evaluateGroup(child, context, state, depth + 1)
      : (state.nodes += 1) > MAX_TREE_NODES
        ? invalidCondition(child, "condition-tree-too-large")
        : evaluateNotificationCondition(child, context);
  });
  const invalid = traces.some((trace) => trace.invalid);
  let matched = false;
  if (!invalid && combinator === "all") matched = traces.every((trace) => trace.matched);
  if (!invalid && combinator === "any") matched = traces.some((trace) => trace.matched);
  if (!invalid && combinator === "not") matched = !traces[0].matched;
  if (group?.negated === true && !invalid) matched = !matched;

  return {
    kind: "group",
    id: firstDefined(group?.id, group?.groupId, group?.group_id, null),
    combinator,
    negated: group?.negated === true,
    matched,
    invalid,
    reason: invalid ? "invalid-child-condition" : matched ? "group-matched" : "group-not-matched",
    children: traces,
  };
}

function ruleValue(rule, camelName, snakeName, fallback) {
  return firstDefined(rule?.[camelName], rule?.[snakeName], fallback);
}

function normalizedRuleId(rule) {
  return ruleValue(rule, "id", "id", null);
}

function lastMatchedAtForRule(context, ruleId) {
  const supplied = firstDefined(context?.lastMatchedAt, context?.last_matched_at);
  if (supplied && typeof supplied === "object" && !(supplied instanceof Date)) {
    return firstDefined(supplied[ruleId], supplied[String(ruleId)]);
  }
  return supplied;
}

export function evaluateNotificationRule(rule = {}, context = {}) {
  const ruleId = normalizedRuleId(rule);
  const ruleName = String(ruleValue(rule, "name", "name", "Unnamed notification rule")).trim();
  const version = Number(ruleValue(rule, "version", "version", 1));
  const base = { ruleId, ruleName, version };

  if (rule?.enabled === false) {
    return { ...base, outcome: "disabled", matched: false, shouldDeliver: false, reason: "rule-disabled", trace: null };
  }

  const event = eventFromContext(context);
  const eventTypes = normalizeStringList(ruleValue(rule, "eventTypes", "event_types", []));
  if (eventTypes.length > 0 && !eventTypes.includes(normalizeText(event.type))) {
    return { ...base, outcome: "event_filtered", matched: false, shouldDeliver: false, reason: "event-type-mismatch", trace: null };
  }

  const root = ruleValue(rule, "conditionTree", "condition_tree", rule?.condition);
  if (!root) {
    return { ...base, outcome: "invalid", matched: false, shouldDeliver: false, reason: "missing-condition-tree", trace: null };
  }

  const trace = evaluateGroup(root, context, { nodes: 0 });
  if (trace.invalid) {
    return { ...base, outcome: "invalid", matched: false, shouldDeliver: false, reason: trace.reason, trace };
  }
  if (!trace.matched) {
    return { ...base, outcome: "not_matched", matched: false, shouldDeliver: false, reason: "conditions-not-matched", trace };
  }

  const cooldownSeconds = Number(ruleValue(rule, "cooldownSeconds", "cooldown_seconds", 0));
  const now = safeDate(firstDefined(context?.now, eventTimestamp(event, context)));
  const lastMatchedAt = safeDate(lastMatchedAtForRule(context, ruleId));
  if (cooldownSeconds > 0 && now && lastMatchedAt) {
    const retryAt = new Date(lastMatchedAt.getTime() + cooldownSeconds * 1000);
    if (now < retryAt) {
      return {
        ...base,
        outcome: "suppressed",
        matched: true,
        shouldDeliver: false,
        reason: "cooldown-active",
        retryAt: retryAt.toISOString(),
        trace,
      };
    }
  }

  const actions = asArray(rule.actions).filter((action) => action?.enabled !== false);
  return {
    ...base,
    outcome: "matched",
    matched: true,
    shouldDeliver: actions.length > 0,
    reason: actions.length > 0 ? "eligible-for-delivery" : "no-enabled-actions",
    actions,
    trace,
  };
}

export function evaluateNotificationRules(rules = [], context = {}) {
  const decisions = asArray(rules).map((rule) => evaluateNotificationRule(rule, context));
  return {
    decisions,
    matched: decisions.filter((decision) => decision.matched),
    deliverable: decisions.filter((decision) => decision.shouldDeliver),
  };
}

export const notificationRuleEngineInternals = Object.freeze({
  MAX_TREE_DEPTH,
  MAX_TREE_NODES,
  compareNumber,
  compareText,
  localClock,
  parseClock,
});
