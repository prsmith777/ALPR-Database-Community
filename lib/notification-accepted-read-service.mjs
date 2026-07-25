import { evaluateNotificationRules } from "./notification-rule-engine.mjs";
import { buildMqttPlateReadPayload } from "./mqtt/payload.mjs";
import { normalizePlate } from "./mqtt/plate-normalize.mjs";
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

function matchingKnownPlate(plateNumber, knownPlates) {
  const normalized = normalizePlate(plateNumber);
  return (knownPlates || []).find(
    (candidate) => normalizePlate(candidate?.plateNumber ?? candidate?.plate_number) === normalized
  ) || null;
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

function publicationFor(group, candidate) {
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
    evidenceMatches,
    matches: evidenceMatches,
  };
}

function durableActionPayload({ action, decision, event, eventId, read, candidate }) {
  const message = String(action.configuration?.message ?? "").trim();
  const common = {
    eventId,
    eventType: event.type,
    readId: Number(event.id),
    timestamp: new Date(event.timestamp).toISOString(),
    plateNumber: event.plateNumber,
    observedPlate: event.observedPlate,
    cameraName: event.cameraName,
    confidence: event.confidence == null ? null : Number(event.confidence),
    knownName: candidate?.name || "",
    tags: candidate?.tags || [],
    ruleId: Number(decision.ruleId),
    ruleName: decision.ruleName,
    title: `${event.plateNumber} Detected`,
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
    let readId = null;
    try {
      readId = positiveInteger(firstDefined(read.id, read.readId, read.read_id), "Accepted read ID");
      const plateNumber = requiredText(
        firstDefined(read.plateNumber, read.plate_number, read.plate),
        "Accepted plate number"
      );
      const cameraName = requiredText(
        firstDefined(read.cameraName, read.camera_name, read.camera),
        "Accepted camera name"
      );
      const eventId = `read-${readId}`;
      const camera = await this.mqttRepository.discoverCamera({ cameraName, seenAt: this.now() });
      const [{ settings, knownPlates }, rules] = await Promise.all([
        this.mqttRepository.loadRuntimeContext(),
        typeof this.repository.loadEnabledRules === "function"
          ? this.repository.loadEnabledRules()
          : this.repository.loadEnabledMqttRules(),
      ]);

      if (rules.length === 0) {
        return { status: "disabled", readId, eventId, planned: 0, queued: 0, duplicates: 0, failed: [] };
      }
      const candidate = matchingKnownPlate(plateNumber, knownPlates);
      const event = {
        id: readId,
        type: "plate_read.accepted",
        plateNumber,
        effectivePlate: plateNumber,
        observedPlate: read.observed_plate || plateNumber,
        timestamp: read.timestamp || read.persisted_timestamp || this.now(),
        cameraName,
        confidence: read.confidence,
        knownPlate: Boolean(candidate),
        knownName: candidate?.name || "",
        tags: candidate?.tags || [],
        watchlisted: Boolean(candidate?.flagged),
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
                payload: durableActionPayload({ action, decision, event, eventId, read, candidate }),
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
        const publication = publicationFor(group, candidate);
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
      safelyLog(this.logger, "error", "Unified notification accepted-read processing failed", {
        readId,
        error: normalized,
      });
      return {
        status: "error",
        readId,
        eventId: readId ? `read-${readId}` : "",
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
  matchingKnownPlate,
  publicationFor,
  safeError,
  topicForAction,
});
