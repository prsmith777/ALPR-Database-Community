function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

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

function normalizeInteger(value, {
  name,
  minimum,
  maximum,
  fallback,
}) {
  const source = firstDefined(value, fallback);
  const parsed = Number(source);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function safelyLog(logger, level, message, details) {
  const method = logger?.[level];
  if (typeof method !== "function") return;
  if (details === undefined) method.call(logger, message);
  else method.call(logger, message, details);
}

function defaultSleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error("MQTT worker sleep aborted");
      error.name = "AbortError";
      reject(error);
      return;
    }

    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);

    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      const error = new Error("MQTT worker sleep aborted");
      error.name = "AbortError";
      reject(error);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizeError(error) {
  return {
    name: String(error?.name ?? "Error"),
    code: String(error?.code ?? ""),
    message: String(error?.message ?? error ?? "Unknown MQTT worker error")
      .trim()
      .slice(0, 4000),
  };
}

function deliveryLogDetails(delivery) {
  return {
    deliveryId: delivery?.id ?? null,
    eventId: delivery?.eventId ?? delivery?.event_id ?? "",
    cameraKey: delivery?.cameraKey ?? delivery?.camera_key ?? "",
    topic: delivery?.topic ?? "",
    brokerName:
      delivery?.broker?.name ?? delivery?.brokerName ?? delivery?.broker_name ?? "",
  };
}

export class MqttDeliveryWorker {
  constructor({
    repository,
    clientManager,
    workerId = `alpr-mqtt-worker-${process.pid}`,
    batchSize = 10,
    leaseMs = 60_000,
    pollIntervalMs = 1_000,
    baseRetryDelayMs = 1_000,
    maximumRetryDelayMs = 300_000,
    logger = console,
    now = () => new Date(),
    sleep = defaultSleep,
  } = {}) {
    for (const methodName of [
      "releaseExpiredLeases",
      "claimDueDeliveries",
      "recordDeliverySuccess",
      "recordDeliveryFailure",
    ]) {
      requireMethod(repository, methodName, "MQTT repository");
    }
    requireMethod(clientManager, "publish", "MQTT client manager");

    if (typeof now !== "function") {
      throw new Error("MQTT worker clock must be a function");
    }
    if (typeof sleep !== "function") {
      throw new Error("MQTT worker sleep function must be a function");
    }

    this.repository = repository;
    this.clientManager = clientManager;
    this.workerId = requireText(workerId, "MQTT worker ID", 255);
    this.batchSize = normalizeInteger(batchSize, {
      name: "MQTT worker batch size",
      minimum: 1,
      maximum: 100,
      fallback: 10,
    });
    this.leaseMs = normalizeInteger(leaseMs, {
      name: "MQTT worker lease",
      minimum: 1_000,
      maximum: 86_400_000,
      fallback: 60_000,
    });
    this.pollIntervalMs = normalizeInteger(pollIntervalMs, {
      name: "MQTT worker poll interval",
      minimum: 10,
      maximum: 3_600_000,
      fallback: 1_000,
    });
    this.baseRetryDelayMs = normalizeInteger(baseRetryDelayMs, {
      name: "MQTT base retry delay",
      minimum: 1,
      maximum: 3_600_000,
      fallback: 1_000,
    });
    this.maximumRetryDelayMs = normalizeInteger(maximumRetryDelayMs, {
      name: "MQTT maximum retry delay",
      minimum: this.baseRetryDelayMs,
      maximum: 86_400_000,
      fallback: 300_000,
    });
    this.logger = logger;
    this.now = now;
    this.sleep = sleep;

    this.currentRun = null;
    this.loopPromise = null;
    this.waitController = null;
    this.stopped = false;
    this.connectionsClosed = false;
  }

  get running() {
    return Boolean(this.loopPromise);
  }

  get processing() {
    return Boolean(this.currentRun);
  }

  async processDelivery(delivery) {
    const details = deliveryLogDetails(delivery);
    let publishResult;

    try {
      publishResult = await this.clientManager.publish({
        broker: delivery.broker,
        topic: delivery.topic,
        payload: delivery.payload,
        qos: delivery.qos,
        retain: delivery.retain,
      });
    } catch (publishError) {
      const normalizedPublishError = normalizeError(publishError);

      try {
        const failure = await this.repository.recordDeliveryFailure({
          deliveryId: delivery.id,
          workerId: this.workerId,
          error: publishError,
          now: this.now(),
          baseDelayMs: this.baseRetryDelayMs,
          maximumDelayMs: this.maximumRetryDelayMs,
        });

        const level = failure.status === "dead" ? "error" : "warn";
        safelyLog(this.logger, level, "MQTT delivery publish failed", {
          ...details,
          status: failure.status,
          attemptCount: failure.attemptCount,
          error: normalizedPublishError,
        });

        return {
          deliveryId: delivery.id,
          status: failure.status,
          published: false,
          recorded: true,
          error: normalizedPublishError,
          delivery: failure,
        };
      } catch (recordError) {
        const normalizedRecordError = normalizeError(recordError);
        safelyLog(this.logger, "error", "MQTT delivery failure could not be recorded", {
          ...details,
          publishError: normalizedPublishError,
          recordError: normalizedRecordError,
        });

        return {
          deliveryId: delivery.id,
          status: "failure-unrecorded",
          published: false,
          recorded: false,
          error: normalizedPublishError,
          recordError: normalizedRecordError,
        };
      }
    }

    try {
      const success = await this.repository.recordDeliverySuccess({
        deliveryId: delivery.id,
        workerId: this.workerId,
        now: this.now(),
      });

      safelyLog(this.logger, "info", "MQTT delivery published", {
        ...details,
        attemptCount: success.attemptCount,
        bytes: publishResult?.bytes ?? null,
        qos: publishResult?.qos ?? delivery.qos,
        retain: publishResult?.retain ?? Boolean(delivery.retain),
      });

      return {
        deliveryId: delivery.id,
        status: "succeeded",
        published: true,
        recorded: true,
        publishResult,
        delivery: success,
      };
    } catch (recordError) {
      const normalizedRecordError = normalizeError(recordError);
      safelyLog(this.logger, "error", "Published MQTT delivery could not be marked successful", {
        ...details,
        recordError: normalizedRecordError,
      });

      return {
        deliveryId: delivery.id,
        status: "published-unrecorded",
        published: true,
        recorded: false,
        publishResult,
        recordError: normalizedRecordError,
      };
    }
  }

  runOnce() {
    if (this.stopped) {
      return Promise.reject(new Error("MQTT delivery worker has been stopped"));
    }
    if (this.currentRun) return this.currentRun;

    const runPromise = this.runBatch().finally(() => {
      if (this.currentRun === runPromise) this.currentRun = null;
    });
    this.currentRun = runPromise;
    return runPromise;
  }

  async runBatch() {
    const runStartedAt = this.now();
    const releasedLeaseIds = await this.repository.releaseExpiredLeases({
      leaseMs: this.leaseMs,
      now: runStartedAt,
    });
    const deliveries = await this.repository.claimDueDeliveries({
      workerId: this.workerId,
      limit: this.batchSize,
      now: runStartedAt,
    });

    const results = [];
    for (const delivery of deliveries) {
      results.push(await this.processDelivery(delivery));
    }

    const summary = {
      workerId: this.workerId,
      releasedLeases: releasedLeaseIds.length,
      releasedLeaseIds,
      claimed: deliveries.length,
      succeeded: results.filter((result) => result.status === "succeeded").length,
      retry: results.filter((result) => result.status === "retry").length,
      dead: results.filter((result) => result.status === "dead").length,
      unrecorded: results.filter((result) => !result.recorded).length,
      results,
    };

    safelyLog(this.logger, "info", "MQTT delivery worker batch complete", {
      workerId: summary.workerId,
      releasedLeases: summary.releasedLeases,
      claimed: summary.claimed,
      succeeded: summary.succeeded,
      retry: summary.retry,
      dead: summary.dead,
      unrecorded: summary.unrecorded,
    });

    return summary;
  }

  start() {
    if (this.stopped) {
      return Promise.reject(new Error("MQTT delivery worker has been stopped"));
    }
    if (this.loopPromise) return this.loopPromise;

    const loopPromise = this.runLoop().finally(() => {
      if (this.loopPromise === loopPromise) this.loopPromise = null;
    });
    this.loopPromise = loopPromise;
    return loopPromise;
  }

  async runLoop() {
    safelyLog(this.logger, "info", "MQTT delivery worker started", {
      workerId: this.workerId,
      batchSize: this.batchSize,
      pollIntervalMs: this.pollIntervalMs,
      leaseMs: this.leaseMs,
    });

    while (!this.stopped) {
      try {
        await this.runOnce();
      } catch (error) {
        if (!this.stopped) {
          safelyLog(this.logger, "error", "MQTT delivery worker batch failed", {
            workerId: this.workerId,
            error: normalizeError(error),
          });
        }
      }

      if (this.stopped) break;

      this.waitController = new AbortController();
      try {
        await this.sleep(this.pollIntervalMs, this.waitController.signal);
      } catch (error) {
        if (error?.name !== "AbortError" && !this.stopped) {
          safelyLog(this.logger, "error", "MQTT delivery worker poll wait failed", {
            workerId: this.workerId,
            error: normalizeError(error),
          });
        }
      } finally {
        this.waitController = null;
      }
    }

    safelyLog(this.logger, "info", "MQTT delivery worker stopped", {
      workerId: this.workerId,
    });
  }

  async stop({ shutdownConnections = true, forceConnections = false } = {}) {
    this.stopped = true;
    this.waitController?.abort();

    const pending = [this.currentRun, this.loopPromise].filter(Boolean);
    if (pending.length > 0) await Promise.allSettled(pending);

    if (
      shutdownConnections &&
      !this.connectionsClosed &&
      typeof this.clientManager.shutdown === "function"
    ) {
      this.connectionsClosed = true;
      await this.clientManager.shutdown({ force: Boolean(forceConnections) });
    }
  }
}

export const mqttDeliveryWorkerInternals = Object.freeze({
  defaultSleep,
  normalizeError,
  deliveryLogDetails,
});
