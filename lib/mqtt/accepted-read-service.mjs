import { buildMqttPlateReadPayload } from "./payload.mjs";
import { planMqttPublications } from "./rule-engine.mjs";

function requireMethod(value, methodName, ownerName) {
  if (!value || typeof value[methodName] !== "function") {
    throw new Error(`${ownerName} must provide ${methodName}()`);
  }
}

function requireText(value, name, maximumLength = 255) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} cannot be empty`);
  if (text.length > maximumLength) {
    throw new Error(`${name} cannot exceed ${maximumLength} characters`);
  }
  return text;
}

function normalizeReadId(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("MQTT accepted read ID must be a positive integer");
  }
  return parsed;
}

function normalizeDate(value, name) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${name} must be a valid date`);
  return date;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function getReadId(read) {
  return normalizeReadId(firstDefined(read?.id, read?.readId, read?.read_id));
}

function getObservedPlate(read) {
  return requireText(
    firstDefined(read?.plateNumber, read?.plate_number, read?.plate),
    "MQTT accepted plate number",
    255
  );
}

function getCameraName(read) {
  return requireText(
    firstDefined(read?.cameraName, read?.camera_name, read?.camera),
    "MQTT accepted camera name",
    255
  );
}

function safeError(error) {
  return {
    name: String(error?.name ?? "Error"),
    code: String(error?.code ?? ""),
    message: String(error?.message ?? error ?? "Unknown MQTT accepted-read error")
      .trim()
      .slice(0, 4000),
  };
}

function safelyLog(logger, level, message, details) {
  const method = logger?.[level];
  if (typeof method !== "function") return;
  if (details === undefined) method.call(logger, message);
  else method.call(logger, message, details);
}

/**
 * Best-effort MQTT orchestration for one plate read that has already been
 * accepted and persisted by the ingestion route.
 *
 * This service never publishes directly. It discovers the camera, evaluates
 * rules, creates the stable payload, and places delivery rows in the durable
 * outbox. Callers receive a result object instead of an exception so an MQTT
 * configuration or database problem cannot reverse an accepted plate read.
 */
export class MqttAcceptedReadService {
  constructor({
    repository,
    logger = console,
    now = () => new Date(),
    maxAttempts = 5,
    matchingSettings = {},
  } = {}) {
    for (const methodName of [
      "discoverCamera",
      "loadRuntimeContext",
      "enqueueDelivery",
    ]) {
      requireMethod(repository, methodName, "MQTT repository");
    }

    if (typeof now !== "function") {
      throw new Error("MQTT accepted-read clock must be a function");
    }

    const parsedMaxAttempts = Number(maxAttempts);
    if (
      !Number.isInteger(parsedMaxAttempts) ||
      parsedMaxAttempts < 1 ||
      parsedMaxAttempts > 20
    ) {
      throw new Error("MQTT accepted-read maximum attempts must be an integer from 1 to 20");
    }

    this.repository = repository;
    this.logger = logger;
    this.now = now;
    this.maxAttempts = parsedMaxAttempts;
    this.matchingSettings = matchingSettings;
  }

  async processAcceptedRead(read = {}) {
    let readId;
    let cameraName;

    try {
      readId = getReadId(read);
      cameraName = getCameraName(read);
      const observedPlate = getObservedPlate(read);
      const receiptTime = normalizeDate(this.now(), "MQTT accepted-read receipt time");
      const eventId = `read-${readId}`;

      const camera = await this.repository.discoverCamera({
        cameraName,
        seenAt: receiptTime,
      });

      const context = await this.repository.loadRuntimeContext();
      const settings = context?.settings ?? {};
      const knownPlates = context?.knownPlates ?? [];
      const rules = context?.rules ?? [];

      if (!settings.enabled) {
        return {
          status: "disabled",
          readId,
          eventId,
          camera,
          decisions: [],
          planned: 0,
          queued: 0,
          duplicates: 0,
          failed: [],
          deliveries: [],
        };
      }

      const plan = planMqttPublications({
        rules,
        observedPlate,
        camera,
        knownPlates,
        settings,
        matchingSettings: this.matchingSettings,
      });

      if (plan.publications.length === 0) {
        return {
          status: "no-match",
          readId,
          eventId,
          camera,
          decisions: plan.decisions,
          planned: 0,
          queued: 0,
          duplicates: 0,
          failed: [],
          deliveries: [],
        };
      }

      const qos = firstDefined(settings.defaultQos, settings.default_qos, 1);
      const retain = Boolean(
        firstDefined(settings.retainMessages, settings.retain_messages, false)
      );

      const outcomes = await Promise.all(
        plan.publications.map(async (publication) => {
          const payload = buildMqttPlateReadPayload({
            read: {
              ...read,
              id: readId,
              plateNumber: observedPlate,
              cameraName,
            },
            camera,
            publication,
            settings,
            eventId,
            now: () => new Date(receiptTime.getTime()),
          });

          // This service processes reads received from the Blue Iris
          // ingestion endpoint. Preserve explicit fallback labeling, but
          // identify valid supplied event timestamps by their real source.
          if (payload.timestamp_source === "provided") {
            payload.timestamp_source = "blue_iris";
          }

          try {
            const delivery = await this.repository.enqueueDelivery({
              eventId,
              readId,
              cameraId: camera.id,
              cameraKey: camera.cameraKey,
              cameraName: camera.cameraName,
              brokerId: publication.brokerId,
              topic: publication.topic,
              payload,
              qos,
              retain,
              maxAttempts: this.maxAttempts,
            });

            return {
              ok: true,
              publication,
              payload,
              delivery,
            };
          } catch (error) {
            return {
              ok: false,
              publication,
              payload,
              error: safeError(error),
            };
          }
        })
      );

      const accepted = outcomes.filter((outcome) => outcome.ok);
      const failures = outcomes
        .filter((outcome) => !outcome.ok)
        .map((outcome) => ({
          brokerId: outcome.publication.brokerId,
          topic: outcome.publication.topic,
          error: outcome.error,
        }));
      const queued = accepted.filter((outcome) => outcome.delivery.inserted).length;
      const duplicates = accepted.length - queued;
      const status =
        failures.length === 0
          ? "queued"
          : accepted.length > 0
            ? "partial"
            : "error";

      if (failures.length > 0) {
        safelyLog(this.logger, status === "error" ? "error" : "warn", "MQTT accepted read could not queue every publication", {
          readId,
          eventId,
          cameraName,
          planned: plan.publications.length,
          queued,
          duplicates,
          failed: failures,
        });
      }

      return {
        status,
        readId,
        eventId,
        camera,
        decisions: plan.decisions,
        planned: plan.publications.length,
        queued,
        duplicates,
        failed: failures,
        deliveries: accepted.map((outcome) => outcome.delivery),
      };
    } catch (error) {
      const normalized = safeError(error);
      safelyLog(this.logger, "error", "MQTT accepted read processing failed", {
        readId: readId ?? null,
        cameraName: cameraName ?? "",
        error: normalized,
      });

      return {
        status: "error",
        readId: readId ?? null,
        eventId: readId ? `read-${readId}` : "",
        camera: null,
        decisions: [],
        planned: 0,
        queued: 0,
        duplicates: 0,
        failed: [{ brokerId: null, topic: "", error: normalized }],
        deliveries: [],
      };
    }
  }
}

export const mqttAcceptedReadServiceInternals = Object.freeze({
  getReadId,
  getObservedPlate,
  getCameraName,
  safeError,
});
