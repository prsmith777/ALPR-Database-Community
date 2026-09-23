import { evaluateNotificationRules } from "./notification-rule-engine.mjs";
import { buildMqttPlateReadPayload } from "./mqtt/payload.mjs";
import { renderCameraTopic, validatePublishTopic } from "./mqtt/topic-template.mjs";

function requireMethod(value, methodName, ownerName) {
  if (!value || typeof value[methodName] !== "function") {
    throw new Error(`${ownerName} must provide ${methodName}()`);
  }
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function requiredText(value, name) {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`${name} cannot be empty`);
  return result;
}

function safeError(error) {
  return {
    name: String(error?.name ?? "Error"),
    code: String(error?.code ?? ""),
    message: String(error?.message ?? error ?? "Unknown unified notification error")
      .trim()
      .slice(0, 4000),
  };
}

function safelyLog(logger, level, message, details) {
  const method = logger?.[level];
  if (typeof method === "function") method.call(logger, message, details);
}

function topicForAction(action, camera, settings) {
  const configuration = action?.configuration || {};
  if (configuration.destinationMode === "fixed_topic") {
    return validatePublishTopic(configuration.fixedTopic);
  }
  return renderCameraTopic({
    baseTopic: firstDefined(settings?.baseTopic, settings?.base_topic, "alpr"),
    template: firstDefined(
      settings?.cameraTopicTemplate,
      settings?.camera_topic_template,
      "{base_topic}/{camera_key}"
    ),
    cameraName: camera.cameraName,
    cameraKey: camera.cameraKey,
    topicOverride: camera.topicOverride || "",
  });
}

function publicationFor(group, candidate, tags = []) {
  const evidenceMatches = group.rules.map(({ decision, action }) => ({
    ruleId: decision.ruleId,
    ruleName: decision.ruleName,
    message: String(action?.configuration?.message ?? "").trim(),
    matchType: "unified_rule",
    matchMethod: candidate ? "exact" : "rule",
    matchDistance: candidate ? 0 : null,
    matchQuality: candidate ? "exact" : "rule",
    matchedPlateNumber: candidate?.plateNumber ?? candidate?.plate_number ?? "",
    candidate,
  }));
  return {
    brokerId: group.brokerId,
    topic: group.topic,
    ruleIds: group.rules.map(({ decision }) => decision.ruleId),
    ruleNames: group.rules.map(({ decision }) => decision.ruleName),
    matchedBy: ["unified_rule"],
    matchMethods: candidate ? ["exact"] : ["rule"],
    matchedPlateNumber: candidate?.plateNumber ?? candidate?.plate_number ?? "",
    matchDistance: candidate ? 0 : null,
    identityConflict: false,
    candidate,
    tags,
    evidenceMatches,
    matches: evidenceMatches,
  };
}

function durableActionPayload({ action, decision, event, eventId, read }) {
  const configuredMessage = String(action.configuration?.message ?? "").trim();
  const message = configuredMessage || (event.type === "vehicle.direction_classified"
    ? `Plate ${event.plateNumber || "Unknown"} was classified as ${event.directionLabel} by ${event.cameraName || "an ALPR camera"}.`
    : "");
  const common = {
    eventId,
    eventType: event.type,
    readId: Number(event.id),
    timestamp: new Date(event.timestamp).toISOString(),
    plateNumber: event.plateNumber,
    observedPlate: event.observedPlate,
    cameraName: event.cameraName,
    confidence: event.confidence == null ? null : Number(event.confidence),
    knownName: event.knownName || "",
    tags: event.tags || [],
    directionLabel: event.directionLabel || "",
    vehicleOrientation: event.vehicleOrientation || "unknown",
    directionConfidence: event.directionConfidence == null ? null : Number(event.directionConfidence),
    ruleId: Number(decision.ruleId),
    ruleName: decision.ruleName,
    title: event.type === "vehicle.direction_classified"
      ? `${event.plateNumber} ${event.directionLabel}`
      : `${event.plateNumber} Detected`,
    message,
  };
  if (action.channelType === "email") {
    return {
      ...common,
      recipients: action.configuration?.recipients || [],
      subject: String(action.configuration?.subject || "").trim(),
      attachImage: action.configuration?.attachImage !== false,
      imagePath: read.image_path || null,
    };
  }
  if (action.channelType === "webhook") {
    return {
      ...common,
      url: action.configuration?.url,
      body: {
        schema_version: 1,
        event_id: eventId,
        event_type: event.type,
        read_id: Number(event.id),
        timestamp: common.timestamp,
        plate_number: event.plateNumber,
        observed_plate: event.observedPlate,
        camera_name: event.cameraName,
        confidence: common.confidence,
        known_plate_name: common.knownName || null,
        tags: common.tags,
        direction_label: common.directionLabel || null,
        vehicle_orientation: common.vehicleOrientation,
        direction_confidence: common.directionConfidence,
        rule_id: common.ruleId,
        rule_name: common.ruleName,
        message,
      },
    };
  }
  return {
    ...common,
    priority: Number(action.configuration?.priority ?? 1),
    imagePath: read.image_path || null,
  };
}

export class NotificationAcceptedReadService {
  constructor({
    repository,
    mqttRepository,
    logger = console,
    now = () => new Date(),
    matchingSettings = {},
  } = {}) {
    if (!repository || (
      typeof repository.loadEnabledRules !== "function" &&
      typeof repository.loadEnabledMqttRules !== "function"
    )) {
      throw new Error("Notification runtime repository must provide loadEnabledRules()");
    }
    requireMethod(repository, "recordExecutions", "Notification runtime repository");
    requireMethod(repository, "loadPlateContext", "Notification runtime repository");
    for (const method of ["discoverCamera", "loadRuntimeContext", "enqueueDelivery"]) {
      requireMethod(mqttRepository, method, "MQTT repository");
    }
    this.repository = repository;
    this.mqttRepository = mqttRepository;
    this.logger = logger;
    this.now = now;
    this.matchingSettings = matchingSettings;
  }

  async processAcceptedRead(read = {}) {
    return this.processReadEvent(read, { eventType: "plate_read.accepted", eventIdPrefix: "read" });
  }

  async processVehicleDirection(read = {}, observation = {}) {
    if (observation?.status !== "ready" || !String(observation?.directionLabel || "").trim()) {
      return { status: "ignored", readId: Number(read?.id || 0) || null, planned: 0, queued: 0, duplicates: 0, failed: [] };
    }
    return this.processReadEvent(read, {
      eventType: "vehicle.direction_classified",
      eventIdPrefix: "direction-read",
      observation,
    });
  }

  async processReadEvent(read = {}, { eventType, eventIdPrefix, observation = null } = {}) {
    let readId = null;
    try {
      readId = positiveInteger(firstDefined(read.id, read.readId, read.read_id), "Read ID");
      const plateNumber = requiredText(
        firstDefined(read.plateNumber, read.plate_number, read.plate),
        "Accepted plate number"
      );
      const cameraName = requiredText(
        firstDefined(read.cameraName, read.camera_name, read.camera),
        "Accepted camera name"
      );
      const eventId = `${eventIdPrefix}-${readId}`;
      const camera = await this.mqttRepository.discoverCamera({ cameraName, seenAt: this.now() });
      const [{ settings }, rules] = await Promise.all([
        this.mqttRepository.loadRuntimeContext(),
        typeof this.repository.loadEnabledRules === "function"
          ? this.repository.loadEnabledRules()
          : this.repository.loadEnabledMqttRules(),
      ]);

      if (rules.length === 0) {
        return { status: "disabled", readId, eventId, planned: 0, queued: 0, duplicates: 0, failed: [] };
      }
      const plateContext = await this.repository.loadPlateContext({ plateNumber });
      const candidate = plateContext.knownPlate
        ? {
            plateNumber: plateContext.plateNumber,
            name: plateContext.knownName,
            tags: plateContext.tags,
            flagged: plateContext.watchlisted,
          }
        : null;
      const event = {
        id: readId,
        type: eventType,
        plateNumber,
        effectivePlate: plateNumber,
        observedPlate: read.observed_plate || plateNumber,
        timestamp: read.timestamp || read.persisted_timestamp || this.now(),
        cameraName,
        confidence: read.confidence,
        knownPlate: plateContext.knownPlate,
        knownName: plateContext.knownName,
        tags: plateContext.tags,
        watchlisted: plateContext.watchlisted,
        directionLabel: observation?.directionLabel || "",
        vehicleOrientation: observation?.orientation || "unknown",
        directionConfidence: observation?.confidence ?? null,
      };
      const lastMatchedAt = typeof this.repository.loadLastMatchedAt === "function"
        ? await this.repository.loadLastMatchedAt(rules.map((rule) => rule.id))
        : {};
      const metrics = typeof this.repository.loadReadCountMetrics === "function"
        ? await this.repository.loadReadCountMetrics({ rules, event })
        : {};
      const plan = evaluateNotificationRules(rules, {
        event,
        now: event.timestamp,
        matchingSettings: this.matchingSettings,
        lastMatchedAt,
        metrics,
      });
      const recordedResult = await this.repository.recordExecutions({
        readId,
        eventId,
        eventType: event.type,
        decisions: plan.decisions,
      });
      const recordedDecisions = Array.isArray(recordedResult) ? recordedResult : plan.decisions;
      const executionIds = new Map(recordedDecisions.map((decision) => [
        `${decision.ruleId}:${decision.version}`,
        decision.executionId,
      ]));

      const groups = new Map();
      const pushoverOutcomes = [];
      const pushoverPlans = [];
      for (const decision of plan.deliverable) {
        for (const action of decision.actions || []) {
          if (["pushover", "email", "webhook"].includes(action.channelType)) {
            if (typeof this.repository.enqueueDelivery !== "function") {
              if (action.channelType === "pushover") {
                pushoverPlans.push({
                  actionId: Number(action.id),
                  ruleId: Number(decision.ruleId),
                  ruleName: decision.ruleName,
                  plateNumber,
                  priority: Number(action.configuration?.priority ?? 1),
                  message: String(action.configuration?.message ?? "").trim(),
                });
              } else {
                pushoverOutcomes.push({ ok: false, error: safeError("Durable notification delivery is unavailable"), channelType: action.channelType });
              }
              continue;
            }
            try {
              const delivery = await this.repository.enqueueDelivery({
                executionId: executionIds.get(`${decision.ruleId}:${decision.version}`),
                action,
                payload: durableActionPayload({ action, decision, event, eventId, read }),
                maxAttempts: 5,
              });
              pushoverOutcomes.push({ ok: true, delivery });
            } catch (error) {
              pushoverOutcomes.push({ ok: false, error: safeError(error), channelType: action.channelType });
            }
            continue;
          }
          if (action.channelType !== "mqtt" || !settings?.enabled) continue;
          const brokerId = positiveInteger(action.configuration?.brokerId, "Unified MQTT broker ID");
          const topic = topicForAction(action, camera, settings);
          const key = `${brokerId}\u0000${topic}`;
          const group = groups.get(key) || { brokerId, topic, rules: [] };
          group.rules.push({ decision, action });
          groups.set(key, group);
        }
      }

      if (groups.size === 0 && pushoverOutcomes.length === 0 && pushoverPlans.length === 0) {
        return {
          status: "no-match",
          readId,
          eventId,
          planned: 0,
          queued: 0,
          duplicates: 0,
          failed: [],
          pushoverPlans: [],
        };
      }

      const outcomes = [];
      for (const group of groups.values()) {
        const publication = publicationFor(group, candidate, event.tags);
        const payload = buildMqttPlateReadPayload({
          read: { ...read, id: readId, plateNumber, cameraName },
          camera,
          publication,
          settings,
          eventId,
          now: () => new Date(this.now()),
        });
        if (payload.timestamp_source === "provided") {
          payload.timestamp_source = "blue_iris";
        }
        payload.notification_runtime = "unified-v1";
        payload.notification_rule_ids = group.rules.map(({ decision }) => decision.ruleId).join(",");
        if (event.type === "vehicle.direction_classified") {
          payload.direction_label = event.directionLabel;
          payload.vehicle_orientation = event.vehicleOrientation;
          payload.direction_confidence = event.directionConfidence;
          payload.message = payload.message || `Plate ${plateNumber} was classified as ${event.directionLabel} by ${cameraName}.`;
        }
        try {
          const delivery = await this.mqttRepository.enqueueDelivery({
            eventId,
            readId,
            cameraId: camera.id,
            cameraKey: camera.cameraKey,
            cameraName: camera.cameraName,
            brokerId: group.brokerId,
            topic: group.topic,
            payload,
            qos: firstDefined(settings.defaultQos, settings.default_qos, 1),
            retain: Boolean(firstDefined(settings.retainMessages, settings.retain_messages, false)),
            maxAttempts: 5,
          });
          outcomes.push({ ok: true, delivery });
        } catch (error) {
          outcomes.push({ ok: false, error: safeError(error), brokerId: group.brokerId, topic: group.topic });
        }
      }

      const allOutcomes = [...outcomes, ...pushoverOutcomes];
      const accepted = allOutcomes.filter((outcome) => outcome.ok);
      const failures = allOutcomes.filter((outcome) => !outcome.ok);
      const queued = accepted.filter((outcome) => outcome.delivery.inserted).length;
      const status = failures.length === 0
        ? allOutcomes.length > 0 ? "queued" : pushoverPlans.length > 0 ? "planned" : "no-match"
        : accepted.length ? "partial" : "error";
      if (failures.length) {
        safelyLog(this.logger, status === "error" ? "error" : "warn", "Unified notification outbox handoff failed", {
          readId,
          failures,
        });
      }
      return {
        status,
        readId,
        eventId,
        planned: allOutcomes.length + pushoverPlans.length,
        queued,
        duplicates: accepted.length - queued,
        failed: failures,
        pushoverPlans,
      };
    } catch (error) {
      const normalized = safeError(error);
      safelyLog(this.logger, "error", "Unified notification event processing failed", {
        readId,
        error: normalized,
      });
      return {
        status: "error",
        readId,
        eventId: readId ? `${eventIdPrefix || "read"}-${readId}` : "",
        planned: 0,
        queued: 0,
        duplicates: 0,
        failed: [normalized],
        pushoverPlans: [],
      };
    }
  }
}

export const notificationAcceptedReadServiceInternals = Object.freeze({
  durableActionPayload,
  publicationFor,
  safeError,
  topicForAction,
});
