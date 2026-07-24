const CONDITION_TYPES = new Set([
  "always",
  "plate_match",
  "known_plate",
  "tag",
  "watchlist",
  "camera",
  "confidence",
  "local_time_window",
]);
const GROUP_COMBINATORS = new Set(["all", "any"]);
const ACTION_TYPES = new Set(["mqtt", "pushover"]);
const MAX_DEPTH = 3;
const MAX_NODES = 30;

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

function normalizeCondition(condition) {
  const conditionType = text(condition?.conditionType, { label: "Condition type", maximum: 50 });
  if (!CONDITION_TYPES.has(conditionType)) throw new Error("Select a supported condition type");
  const value = condition?.value && typeof condition.value === "object" ? condition.value : {};

  if (conditionType === "always") {
    return { kind: "condition", conditionType, operator: "always", value: {} };
  }
  if (conditionType === "plate_match") {
    return {
      kind: "condition",
      conditionType,
      operator: "matches",
      value: {
        plate: text(value.plate, { label: "Plate number", maximum: 20 }).toUpperCase(),
        mode: ["off", "strict", "balanced", "broad"].includes(value.mode) ? value.mode : "off",
      },
    };
  }
  if (conditionType === "known_plate" || conditionType === "watchlist") {
    return { kind: "condition", conditionType, operator: "is_true", value: { expected: true } };
  }
  if (conditionType === "tag") {
    return { kind: "condition", conditionType, operator: "any", value: { tags: list(value.tags, "tag") } };
  }
  if (conditionType === "camera") {
    return { kind: "condition", conditionType, operator: "in", value: { names: list(value.names, "camera") } };
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

  const validClock = (candidate) => {
    const match = /^(\d{2}):(\d{2})$/.exec(String(candidate ?? ""));
    return match && Number(match[1]) < 24 && Number(match[2]) < 60 ? String(candidate) : null;
  };
  const start = validClock(value.start);
  const end = validClock(value.end);
  if (!start || !end) throw new Error("Schedule start and end times are required");
  const weekdays = [...new Set((Array.isArray(value.weekdays) ? value.weekdays : []).map(Number))];
  if (weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
    throw new Error("Select valid schedule weekdays");
  }
  const timeZone = text(value.timeZone || "UTC", { label: "Schedule time zone", maximum: 100 });
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    throw new Error("Select a valid schedule time zone");
  }
  return {
    kind: "condition",
    conditionType,
    operator: "within",
    value: {
      start,
      end,
      weekdays,
      timeZone,
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
  if (!ACTION_TYPES.has(channelType)) throw new Error("Select MQTT or Pushover for each action");
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
  return {
    name: text(input.name, { label: "Rule name", maximum: 255 }),
    description: text(input.description, { label: "Description", maximum: 1000, required: false }),
    eventType: "plate_read.accepted",
    cooldownSeconds: integer(input.cooldownSeconds ?? 0, {
      label: "Cooldown",
      minimum: 0,
      maximum: 2678400,
    }),
    conditionTree: normalizeGroup(input.conditionTree, { nodes: 0 }),
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
  CONDITION_TYPES,
  GROUP_COMBINATORS,
  MAX_DEPTH,
  MAX_NODES,
  normalizeAction,
  normalizeCondition,
  normalizeGroup,
});
