const SUPPORTED_MQTT_MATCH_TYPES = new Set([
  "any_plate",
  "exact_plate",
  "any_known_plate",
  "known_name",
  "tag",
]);
const MQTT_MATCH_TYPES_REQUIRING_VALUE = new Set(["exact_plate", "known_name", "tag"]);

function text(value) {
  return String(value ?? "").trim();
}

function integer(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function stringList(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(text).filter(Boolean))];
}

function rootGroup(children) {
  return { kind: "group", combinator: "all", children };
}

function plateCondition(plate, mode = "off") {
  return {
    kind: "condition",
    conditionType: "plate_match",
    operator: "matches",
    value: { plate, mode: text(mode) || "off" },
  };
}

function mqttSourceCondition(row) {
  const matchType = text(row.match_type);
  const matchValue = text(row.match_value);
  if (!SUPPORTED_MQTT_MATCH_TYPES.has(matchType)) return null;
  if (matchType === "any_plate") {
    return { kind: "condition", conditionType: "always", operator: "always", value: {} };
  }
  if (matchType === "exact_plate") {
    return plateCondition(matchValue, row.plate_match_mode);
  }
  if (matchType === "any_known_plate") {
    return {
      kind: "condition",
      conditionType: "known_plate",
      operator: "is_true",
      value: { expected: true },
    };
  }
  if (matchType === "known_name") {
    return {
      kind: "condition",
      conditionType: "known_name",
      operator: "equals",
      value: { names: [matchValue] },
    };
  }
  return {
    kind: "group",
    combinator: "all",
    children: [
      {
        kind: "condition",
        conditionType: "known_plate",
        operator: "is_true",
        value: { expected: true },
      },
      {
        kind: "condition",
        conditionType: "tag",
        operator: "any",
        value: { tags: [matchValue] },
      },
    ],
  };
}

function previewResult({ source, proposed, blockers = [], notes = [] }) {
  return {
    source,
    proposed,
    ready: blockers.length === 0,
    blockers,
    notes,
  };
}

export function previewLegacyPushoverRule(row = {}, pushover = {}) {
  const plate = text(row.plate_number);
  const blockers = [];
  if (!plate) blockers.push("The source rule has no plate number.");
  if (!pushover.configured) blockers.push("Pushover credentials are incomplete.");
  if (!pushover.enabled) blockers.push("Pushover is globally disabled.");

  return previewResult({
    source: {
      type: "pushover",
      id: integer(row.id),
      name: plate || "Unnamed plate notification",
      enabled: Boolean(row.enabled),
    },
    proposed: {
      name: `Plate ${plate || "(missing)"} to Pushover`,
      description: "Previewed from the existing exact-plate Pushover notification.",
      enabled: false,
      eventType: "plate_read.accepted",
      cooldownSeconds: 0,
      conditionTree: rootGroup([plateCondition(plate)]),
      actions: [
        {
          channelType: "pushover",
          enabled: false,
          credentialReference: "settings:notifications.pushover",
          configuration: { priority: integer(row.priority, 1) },
        },
      ],
    },
    blockers,
    notes: ["The preview remains disabled and does not replace the current Pushover path."],
  });
}

export function previewLegacyMqttRule(row = {}) {
  const matchType = text(row.match_type);
  const sourceCondition = mqttSourceCondition(row);
  const cameraNames = stringList(row.camera_names);
  const blockers = [];
  if (!sourceCondition) blockers.push(`Unsupported MQTT match type: ${matchType || "missing"}.`);
  if (MQTT_MATCH_TYPES_REQUIRING_VALUE.has(matchType) && !text(row.match_value)) {
    blockers.push(`MQTT match type ${matchType} requires a match value.`);
  }
  if (!integer(row.broker_id)) blockers.push("The MQTT rule has no broker.");
  if (!row.broker_enabled) blockers.push(`MQTT broker ${text(row.broker_name) || "(unnamed)"} is disabled.`);

  const conditions = sourceCondition ? [sourceCondition] : [];
  if (cameraNames.length > 0) {
    conditions.push({
      kind: "condition",
      conditionType: "camera",
      operator: "in",
      value: { names: cameraNames },
    });
  }

  return previewResult({
    source: {
      type: "mqtt",
      id: integer(row.id),
      name: text(row.name) || `MQTT rule ${integer(row.id)}`,
      enabled: Boolean(row.enabled),
      matchType,
    },
    proposed: {
      name: text(row.name) || `MQTT rule ${integer(row.id)}`,
      description: "Previewed from the existing durable MQTT rule.",
      enabled: false,
      eventType: "plate_read.accepted",
      cooldownSeconds: 0,
      conditionTree: rootGroup(conditions),
      actions: [
        {
          channelType: "mqtt",
          enabled: false,
          credentialReference: `mqtt-broker:${integer(row.broker_id)}`,
          configuration: {
            brokerId: integer(row.broker_id),
            brokerName: text(row.broker_name),
            destinationMode: text(row.destination_mode) || "per_camera",
            fixedTopic: text(row.fixed_topic),
            message: text(row.message),
          },
        },
      ],
    },
    blockers,
    notes: ["The preview remains disabled and does not replace the durable MQTT outbox."],
  });
}

export function buildNotificationMigrationPreview({
  pushoverRules = [],
  mqttRules = [],
  pushover = {},
  migrationMappings = [],
} = {}) {
  const normalizedPushover = {
    enabled: Boolean(pushover.enabled),
    configured: Boolean(pushover.configured),
  };
  const mappingBySource = new Map(
    migrationMappings.map((mapping) => [
      `${text(mapping.source_type)}:${integer(mapping.source_id)}`,
      mapping,
    ])
  );
  const rules = [
    ...pushoverRules.map((row) => previewLegacyPushoverRule(row, normalizedPushover)),
    ...mqttRules.map(previewLegacyMqttRule),
  ].map((rule) => {
    const mapping = mappingBySource.get(`${rule.source.type}:${rule.source.id}`);
    const needsReconciliation = Boolean(
      mapping &&
        rule.source.type === "mqtt" &&
        rule.source.matchType === "tag" &&
        !mapping.target_has_known_plate_guard
    );
    return {
      ...rule,
      migration: mapping
        ? {
            status: "created_disabled",
            targetRuleId: integer(mapping.target_rule_id),
            createdAt: mapping.created_at ?? null,
            ...(needsReconciliation
              ? {
                  needsReconciliation: true,
                  reconciliationSafe: Boolean(mapping.target_all_disabled),
                }
              : {}),
          }
        : { status: "pending", targetRuleId: null, createdAt: null },
    };
  });
  const readyRules = rules.filter((rule) => rule.ready);
  const migratedRules = rules.filter(
    (rule) => rule.migration.status === "created_disabled"
  );
  const reconciliationRules = migratedRules.filter(
    (rule) => rule.migration.needsReconciliation
  );

  return {
    mode: "read_only",
    writesPerformed: 0,
    sourceCounts: {
      pushover: pushoverRules.length,
      mqtt: mqttRules.length,
      total: rules.length,
    },
    readyCount: readyRules.length,
    attentionCount: rules.filter((rule) => !rule.ready).length,
    migratedCount: migratedRules.length,
    reconcileReadyCount: reconciliationRules.filter(
      (rule) => rule.migration.reconciliationSafe
    ).length,
    reconcileBlockedCount: reconciliationRules.filter(
      (rule) => !rule.migration.reconciliationSafe
    ).length,
    pendingReadyCount: readyRules.filter(
      (rule) => rule.migration.status === "pending"
    ).length,
    rules,
  };
}

export const notificationMigrationPreviewInternals = Object.freeze({
  MQTT_MATCH_TYPES_REQUIRING_VALUE,
  mqttSourceCondition,
  rootGroup,
  stringList,
});
