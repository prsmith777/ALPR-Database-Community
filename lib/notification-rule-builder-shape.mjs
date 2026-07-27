const CONDITION_TYPES = new Set([
  "always",
  "plate_match",
  "known_plate",
  "known_name",
  "tag",
  "watchlist",
  "camera",
  "direction",
  "confidence",
  "read_count",
  "local_time_window",
]);
const GROUP_COMBINATORS = new Set(["all", "any", "not"]);
const ACTION_TYPES = new Set(["mqtt", "pushover", "email", "webhook"]);
const EVENT_TYPES = new Set(["plate_read.accepted", "vehicle.direction_classified", "camera.activity_check"]);
const MAX_DEPTH = 6;
const MAX_NODES = 100;

function text(value, { label = "Value", maximum = 255, required = true } = {}) {
  const normalized = String(value ?? "").trim();
  if (required && !normalized) throw new Error(`${label} is required`);
  if (normalized.length > maximum) throw new Error(`${label} is too long`);
  return normalized;
}

function list(value, label, maximum = 20) {
  const values = [...new Set((Array.isArray(value) ? value : []).map((item) => String(item ?? "").trim()).filter(Boolean))];
  if (values.length === 0) throw new Error(`Select at least one ${label}`);
  if (values.length > maximum || values.some((item) => item.length > 100)) {
    throw new Error(`Select valid ${label}`);
  }
  return values;
}

function integer(value, { label, minimum, maximum }) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function timeZone(value, label = "Rule time zone") {
  const normalized = text(value || "UTC", { label, maximum: 100 });
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date());
  } catch {
    throw new Error(`Select a valid ${label.toLowerCase()}`);
  }
  return normalized;
}

function clock(value, label) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value ?? ""));
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw new Error(`${label} is required`);
  }
  return String(value);
}

function normalizeQuietHours(value, ruleTimeZone) {
  if (!value?.enabled) return { enabled: false };
  const weekdays = [...new Set((Array.isArray(value.weekdays) ? value.weekdays : []).map(Number))];
  if (weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
    throw new Error("Select valid quiet-hour weekdays");
  }
  return {
    enabled: true,
    start: clock(value.start, "Quiet-hours start"),
    end: clock(value.end, "Quiet-hours end"),
    weekdays,
    timeZone: timeZone(value.timeZone || ruleTimeZone, "Quiet-hours time zone"),
  };
}

function normalizeCondition(condition) {
  const conditionType = text(condition?.conditionType, { label: "Condition type", maximum: 50 });
  if (!CONDITION_TYPES.has(conditionType)) throw new Error("Select a supported condition type");
  const value = condition?.value && typeof condition.value === "object" ? condition.value : {};

  if (conditionType === "always") {
    return { kind: "condition", conditionType, operator: "always", value: {} };
  }
  if (conditionType === "plate_match") {
    const strategy = ["profile", "exact", "contains", "wildcard", "ocr_confusion", "edit_distance"]
      .includes(value.strategy) ? value.strategy : "profile";
    const maximumDistance = integer(value.maximumDistance ?? 1, {
      label: "Maximum edit distance",
      minimum: 0,
      maximum: 3,
    });
    return {
      kind: "condition",
      conditionType,
      operator: "matches",
      value: {
        plate: text(value.plate, { label: "Plate number", maximum: 20 }).toUpperCase(),
        mode: ["off", "strict", "balanced", "broad"].includes(value.mode) ? value.mode : "off",
        strategy,
        maximumDistance,
      },
    };
  }
  if (conditionType === "known_plate" || conditionType === "watchlist") {
    return { kind: "condition", conditionType, operator: "is_true", value: { expected: true } };
  }
  if (conditionType === "known_name") {
    return { kind: "condition", conditionType, operator: "in", value: { names: list(value.names, "known-plate name") } };
  }
  if (conditionType === "tag") {
    return { kind: "condition", conditionType, operator: "any", value: { tags: list(value.tags, "tag") } };
  }
  if (conditionType === "camera") {
    return { kind: "condition", conditionType, operator: "in", value: { names: list(value.names, "camera") } };
  }
  if (conditionType === "direction") {
    return { kind: "condition", conditionType, operator: "in", value: { labels: list(value.labels, "direction") } };
  }
  if (conditionType === "confidence") {
    const threshold = Number(value.threshold);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
      throw new Error("Confidence must be between 0 and 100");
    }
    return {
      kind: "condition",
      conditionType,
      operator: ["at_least", "at_most"].includes(condition.operator) ? condition.operator : "at_least",
      value: { threshold },
    };
  }
  if (conditionType === "read_count") {
    return {
      kind: "condition",
      conditionType,
      operator: ["at_least", "at_most", "equals"].includes(condition.operator) ? condition.operator : "at_least",
      value: {
        scope: ["plate", "camera", "global"].includes(value.scope) ? value.scope : "plate",
        count: integer(value.count ?? 1, { label: "Read count", minimum: 0, maximum: 1000000000 }),
        windowSeconds: integer(value.windowSeconds ?? 0, { label: "Count period", minimum: 0, maximum: 3155760000 }),
      },
    };
  }

  const start = clock(value.start, "Schedule start");
  const end = clock(value.end, "Schedule end");
  const weekdays = [...new Set((Array.isArray(value.weekdays) ? value.weekdays : []).map(Number))];
  if (weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
    throw new Error("Select valid schedule weekdays");
  }
  const scheduleTimeZone = timeZone(value.timeZone || "UTC", "Schedule time zone");
  return {
    kind: "condition",
    conditionType,
    operator: "within",
    value: {
      start,
      end,
      weekdays,
      timeZone: scheduleTimeZone,
    },
  };
}

function normalizeGroup(group, state, depth = 1) {
  state.nodes += 1;
  if (depth > MAX_DEPTH || state.nodes > MAX_NODES) throw new Error("The condition tree is too complex");
  const combinator = String(group?.combinator ?? "all").trim().toLowerCase();
  if (!GROUP_COMBINATORS.has(combinator)) throw new Error("Select All or Any for each condition group");
  const children = Array.isArray(group?.children) ? group.children : [];
  if (children.length === 0) throw new Error("Add at least one condition");
  if (combinator === "not" && children.length !== 1) throw new Error("Not groups must contain exactly one condition or group");
  return {
    kind: "group",
    combinator,
    children: children.map((child) => {
      state.nodes += 1;
      if (state.nodes > MAX_NODES) throw new Error("The condition tree is too complex");
      if (child?.kind === "group") return normalizeGroup(child, state, depth + 1);
      return normalizeCondition(child);
    }),
  };
}

function normalizeAction(action) {
  const channelType = String(action?.channelType ?? "").trim().toLowerCase();
  if (!ACTION_TYPES.has(channelType)) throw new Error("Select MQTT, Pushover, Email, or Webhook for each action");
  const configuration = action?.configuration && typeof action.configuration === "object"
    ? action.configuration
    : {};
  if (channelType === "pushover") {
    return {
      channelType,
      credentialReference: "settings:notifications.pushover",
      configuration: {
        priority: integer(configuration.priority ?? 1, { label: "Pushover priority", minimum: -2, maximum: 2 }),
        message: text(configuration.message, { label: "Pushover message", maximum: 500, required: false }),
      },
    };
  }
  if (channelType === "email") {
    const recipients = [...new Set((Array.isArray(configuration.recipients)
      ? configuration.recipients
      : String(configuration.recipients ?? "").split(/[;,\n]/))
      .map((entry) => String(entry).trim().toLowerCase())
      .filter(Boolean))];
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (recipients.length === 0 || recipients.length > 10 || recipients.some((entry) => entry.length > 254 || !emailPattern.test(entry))) {
      throw new Error("Enter no more than 10 valid email recipients");
    }
    return {
      channelType,
      credentialReference: "settings:notifications.email",
      configuration: {
        recipients,
        subject: text(configuration.subject, { label: "Email subject", maximum: 200, required: false }),
        message: text(configuration.message, { label: "Email message", maximum: 5000, required: false }),
        attachImage: configuration.attachImage !== false,
      },
    };
  }
  if (channelType === "webhook") {
    const rawUrl = text(configuration.url, { label: "Webhook URL", maximum: 2048 });
    let url;
    try { url = new URL(rawUrl); }
    catch { throw new Error("Enter a valid webhook URL"); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash) {
      throw new Error("Webhook URLs must use HTTP(S), cannot contain credentials, and cannot contain a fragment");
    }
    return {
      channelType,
      credentialReference: "settings:notifications.webhook",
      configuration: {
        url: url.toString(),
        message: text(configuration.message, { label: "Webhook message", maximum: 5000, required: false }),
      },
    };
  }
  const brokerId = integer(configuration.brokerId, { label: "MQTT broker", minimum: 1, maximum: 2147483647 });
  const destinationMode = configuration.destinationMode === "fixed_topic" ? "fixed_topic" : "per_camera";
  const fixedTopic = text(configuration.fixedTopic, {
    label: "MQTT fixed topic",
    maximum: 500,
    required: destinationMode === "fixed_topic",
  });
  if (fixedTopic.includes("#") || fixedTopic.includes("+")) {
    throw new Error("MQTT publish topics cannot contain wildcard characters");
  }
  return {
    channelType,
    credentialReference: `mqtt-broker:${brokerId}`,
    configuration: {
      brokerId,
      destinationMode,
      fixedTopic,
      message: text(configuration.message, { label: "MQTT message", maximum: 500, required: false }),
    },
  };
}

export function normalizeNotificationRuleDraft(input = {}) {
  const actions = (Array.isArray(input.actions) ? input.actions : []).map(normalizeAction);
  if (actions.length === 0) throw new Error("Add at least one notification action");
  if (actions.length > 4) throw new Error("A rule can have at most four actions");
  const eventType = EVENT_TYPES.has(String(input.eventType))
    ? String(input.eventType)
    : "plate_read.accepted";
  const ruleTimeZone = timeZone(input.timeZone || "UTC");
  const conditionTree = normalizeGroup(input.conditionTree, { nodes: 0 });
  if (eventType === "camera.activity_check") {
    const conditions = [];
    const visit = (node) => {
      if (node?.kind === "condition") conditions.push(node);
      else for (const child of node?.children || []) visit(child);
    };
    visit(conditionTree);
    if (!conditions.some((condition) => condition.conditionType === "camera")) {
      throw new Error("Camera activity rules must select at least one camera");
    }
    if (!conditions.some((condition) => condition.conditionType === "read_count" && condition.value.scope === "camera" && condition.value.windowSeconds > 0)) {
      throw new Error("Camera activity rules need a camera read-count condition with a time period");
    }
  }
  return {
    name: text(input.name, { label: "Rule name", maximum: 255 }),
    description: text(input.description, { label: "Description", maximum: 1000, required: false }),
    eventType,
    timeZone: ruleTimeZone,
    quietHours: normalizeQuietHours(input.quietHours, ruleTimeZone),
    evaluationIntervalSeconds: eventType === "camera.activity_check"
      ? integer(input.evaluationIntervalSeconds ?? 300, {
          label: "Evaluation interval",
          minimum: 60,
          maximum: 86400,
        })
      : null,
    cooldownSeconds: integer(input.cooldownSeconds ?? 0, {
      label: "Cooldown",
      minimum: 0,
      maximum: 2678400,
    }),
    conditionTree,
    actions,
  };
}

export function parseNotificationRuleDraft(value) {
  if (typeof value !== "string" || value.length > 50000) throw new Error("Rule draft payload is invalid");
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Rule draft payload is invalid");
  }
  return normalizeNotificationRuleDraft(parsed);
}

export const notificationRuleBuilderShapeInternals = Object.freeze({
  ACTION_TYPES,
  EVENT_TYPES,
  CONDITION_TYPES,
  GROUP_COMBINATORS,
  MAX_DEPTH,
  MAX_NODES,
  normalizeAction,
  normalizeCondition,
  normalizeGroup,
  normalizeQuietHours,
});
