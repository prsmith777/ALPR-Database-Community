function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new Error(`${name} must be a function`);
  }
  return value;
}

function normalizeReadId(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("Accepted plate read ID must be a positive integer");
  }
  return parsed;
}

function normalizePlateNumber(value) {
  const plateNumber = String(value ?? "").trim();
  if (!plateNumber) {
    throw new Error("Accepted plate number cannot be empty");
  }
  return plateNumber;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function safeError(error) {
  return {
    name: String(error?.name ?? "Error"),
    code: String(error?.code ?? ""),
    message: String(error?.message ?? error ?? "Unknown accepted-read effect error")
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
 * Run human and machine notifications only for a plate read that already has a
 * durable database ID. Each effect is best-effort and independent so a remote
 * notification failure cannot reverse or hide the accepted plate read.
 */
export async function processAcceptedPlateReadEffects({
  read = {},
  imageData = null,
  shouldSendPushover,
  sendPushover,
  processMqtt,
  logger = console,
} = {}) {
  requireFunction(shouldSendPushover, "Pushover match checker");
  requireFunction(sendPushover, "Pushover sender");
  requireFunction(processMqtt, "MQTT accepted-read processor");

  const readId = normalizeReadId(
    firstDefined(read.id, read.readId, read.read_id)
  );
  const plateNumber = normalizePlateNumber(
    firstDefined(read.plateNumber, read.plate_number, read.plate)
  );

  const pushoverPromise = (async () => {
    try {
      const matched = Boolean(await shouldSendPushover(plateNumber));
      if (!matched) {
        return {
          status: "not-matched",
          matched: false,
          sent: false,
        };
      }

      const result = await sendPushover(plateNumber, null, imageData);
      if (result?.success === false) {
        const error = safeError(result.error ?? "Pushover notification failed");
        safelyLog(logger, "warn", "Accepted plate Pushover notification failed", {
          readId,
          plateNumber,
          error,
        });
        return {
          status: "failed",
          matched: true,
          sent: false,
          error,
          result,
        };
      }

      return {
        status: "sent",
        matched: true,
        sent: true,
        result,
      };
    } catch (error) {
      const normalized = safeError(error);
      safelyLog(logger, "error", "Accepted plate Pushover processing failed", {
        readId,
        plateNumber,
        error: normalized,
      });
      return {
        status: "error",
        matched: false,
        sent: false,
        error: normalized,
      };
    }
  })();

  const mqttPromise = (async () => {
    try {
      return await processMqtt(read);
    } catch (error) {
      const normalized = safeError(error);
      safelyLog(logger, "error", "Accepted plate MQTT processing failed", {
        readId,
        plateNumber,
        error: normalized,
      });
      return {
        status: "error",
        readId,
        eventId: `read-${readId}`,
        planned: 0,
        queued: 0,
        duplicates: 0,
        failed: [{ brokerId: null, topic: "", error: normalized }],
        deliveries: [],
      };
    }
  })();

  const [pushover, mqtt] = await Promise.all([pushoverPromise, mqttPromise]);

  return {
    readId,
    plateNumber,
    pushover,
    mqtt,
  };
}

export const acceptedPlateReadEffectsInternals = Object.freeze({
  normalizeReadId,
  normalizePlateNumber,
  safeError,
});
