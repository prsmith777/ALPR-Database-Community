import fileStorage from "./fileStorage.js";
import { sendPushoverNotification } from "./notifications.js";
import { evaluateNotificationRules } from "./notification-rule-engine.mjs";
import { renderCameraTopic, validatePublishTopic } from "./mqtt/topic-template.mjs";

function sleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      const error = new Error("Notification operations wait aborted");
      error.name = "AbortError";
      reject(error);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function safeError(error) {
  return String(error?.message ?? error ?? "Notification operation failed").trim().slice(0, 4000);
}

function cameraNames(rule) {
  const names = new Set();
  const visit = (node) => {
    if (node?.kind === "condition" && node.conditionType === "camera") {
      for (const name of node.value?.names || []) if (String(name).trim()) names.add(String(name).trim());
    } else for (const child of node?.children || []) visit(child);
  };
  visit(rule?.conditionTree);
  return [...names];
}

function activityMessage(rule, cameraName, metrics) {
  const counts = metrics?.readCounts || [];
  const metric = counts.find((candidate) => candidate.scope === "camera") || counts[0];
  const minutes = metric?.windowSeconds ? Math.round(metric.windowSeconds / 60) : null;
  return `${rule.name}: ${cameraName} recorded ${metric?.count ?? 0} reads${minutes ? ` in the last ${minutes} minutes` : ""}.`;
}

function mqttTopic(action, camera, settings) {
  if (action.configuration?.destinationMode === "fixed_topic") {
    return validatePublishTopic(action.configuration.fixedTopic);
  }
  return renderCameraTopic({
    baseTopic: settings.baseTopic ?? settings.base_topic ?? "alpr",
    template: settings.cameraTopicTemplate ?? settings.camera_topic_template ?? "{base_topic}/{camera_key}",
    cameraName: camera.cameraName,
    cameraKey: camera.cameraKey,
    topicOverride: camera.topicOverride || "",
  });
}

export class NotificationOperationsWorker {
  constructor({
    repository,
    mqttRepository,
    sendPushover = sendPushoverNotification,
    storage = fileStorage,
    workerId = `alpr-notification-worker-${process.pid}`,
    pollIntervalMs = 5_000,
    now = () => new Date(),
    logger = console,
  } = {}) {
    this.repository = repository;
    this.mqttRepository = mqttRepository;
    this.sendPushover = sendPushover;
    this.storage = storage;
    this.workerId = workerId;
    this.pollIntervalMs = pollIntervalMs;
    this.now = now;
    this.logger = logger;
    this.stopped = false;
    this.loopPromise = null;
    this.currentRun = null;
    this.waitController = null;
  }

  get running() { return Boolean(this.loopPromise); }

  async processScheduledRules(now) {
    const ids = await this.repository.claimDueActivityRuleIds({ workerId: this.workerId, now });
    if (ids.length === 0) return { claimed: 0, evaluated: 0, queued: 0 };
    const rules = (await this.repository.loadEnabledRules()).filter((rule) => ids.includes(rule.id));
    const runtime = await this.mqttRepository.loadRuntimeContext();
    let evaluated = 0;
    let queued = 0;
    for (const rule of rules) {
      for (const cameraName of cameraNames(rule)) {
        evaluated += 1;
        const camera = await this.mqttRepository.discoverCamera({ cameraName, seenAt: now });
        const interval = Math.max(60, Number(rule.evaluationIntervalSeconds) || 300);
        const bucket = Math.floor(now.getTime() / (interval * 1000));
        const eventId = `camera-activity:${camera.cameraKey}:${bucket}`;
        const event = { id: eventId, type: "camera.activity_check", timestamp: now, cameraName };
        const metrics = await this.repository.loadReadCountMetrics({ rules: [rule], event });
        const lastMatched = typeof this.repository.loadLastMatchedAtForActivity === "function"
          ? await this.repository.loadLastMatchedAtForActivity({ ruleId: rule.id, cameraKey: camera.cameraKey })
          : null;
        const plan = evaluateNotificationRules([rule], {
          event,
          now,
          metrics,
          lastMatchedAt: lastMatched ? { [rule.id]: lastMatched } : {},
        });
        const recorded = await this.repository.recordExecutions({
          readId: null,
          eventId,
          eventType: event.type,
          decisions: plan.decisions,
        });
        const executionId = recorded[0]?.executionId;
        for (const decision of plan.deliverable) {
          for (const action of decision.actions || []) {
            const message = String(action.configuration?.message || "").trim()
              || activityMessage(rule, cameraName, metrics);
            if (action.channelType === "pushover") {
              const result = await this.repository.enqueueDelivery({
                executionId,
                action,
                payload: {
                  plateNumber: `CAMERA-${camera.cameraKey}`,
                  title: `Camera activity alert: ${cameraName}`,
                  priority: Number(action.configuration?.priority ?? 1),
                  message,
                },
              });
              if (result.inserted) queued += 1;
            } else if (action.channelType === "mqtt" && runtime.settings?.enabled) {
              const topic = mqttTopic(action, camera, runtime.settings);
              const result = await this.mqttRepository.enqueueDelivery({
                eventId,
                readId: null,
                cameraId: camera.id,
                cameraKey: camera.cameraKey,
                cameraName,
                brokerId: Number(action.configuration.brokerId),
                topic,
                payload: {
                  schema_version: 1,
                  event_id: eventId,
                  event_type: event.type,
                  camera_name: cameraName,
                  camera_key: camera.cameraKey,
                  timestamp: now.toISOString(),
                  message,
                  notification_rule_id: rule.id,
                },
                qos: runtime.settings.defaultQos ?? runtime.settings.default_qos ?? 1,
                retain: Boolean(runtime.settings.retainMessages ?? runtime.settings.retain_messages),
                maxAttempts: 5,
              });
              if (result.inserted) queued += 1;
            }
          }
        }
      }
    }
    return { claimed: ids.length, evaluated, queued };
  }

  async processPushoverDelivery(delivery) {
    const payload = delivery.payload || {};
    let imageData = null;
    if (payload.imagePath) {
      const image = await this.storage.getImage(payload.imagePath);
      if (image) imageData = `data:image/jpeg;base64,${image.toString("base64")}`;
    }
    const result = await this.sendPushover(
      payload.plateNumber,
      payload.message || null,
      imageData,
      { title: payload.title, priority: payload.priority }
    );
    if (!result?.success) throw new Error(result?.error || "Pushover rejected the notification");
    return this.repository.recordPushoverSuccess({
      deliveryId: delivery.id,
      workerId: this.workerId,
      response: result.data || {},
      now: this.now(),
    });
  }

  async runBatch() {
    const now = this.now();
    await this.repository.releaseExpiredPushoverLeases({ now });
    const schedule = await this.processScheduledRules(now);
    const deliveries = await this.repository.claimDuePushoverDeliveries({
      workerId: this.workerId,
      limit: 10,
      now,
    });
    const results = await Promise.all(deliveries.map(async (delivery) => {
      try {
        await this.processPushoverDelivery(delivery);
        return "succeeded";
      } catch (error) {
        const failed = await this.repository.recordPushoverFailure({
          deliveryId: delivery.id,
          workerId: this.workerId,
          error,
          now: this.now(),
        });
        this.logger?.[failed.status === "dead" ? "error" : "warn"]?.("Pushover delivery failed", {
          deliveryId: delivery.id,
          status: failed.status,
          error: safeError(error),
        });
        return failed.status;
      }
    }));
    return {
      schedule,
      claimed: deliveries.length,
      succeeded: results.filter((status) => status === "succeeded").length,
      retry: results.filter((status) => status === "retry").length,
      dead: results.filter((status) => status === "dead").length,
    };
  }

  runOnce() {
    if (this.currentRun) return this.currentRun;
    const run = this.runBatch().finally(() => { if (this.currentRun === run) this.currentRun = null; });
    this.currentRun = run;
    return run;
  }

  start() {
    if (this.loopPromise) return this.loopPromise;
    const loop = (async () => {
      while (!this.stopped) {
        try { await this.runOnce(); }
        catch (error) { this.logger?.error?.("Notification operations batch failed", { error: safeError(error) }); }
        if (this.stopped) break;
        this.waitController = new AbortController();
        try { await sleep(this.pollIntervalMs, this.waitController.signal); }
        catch (error) { if (error?.name !== "AbortError") throw error; }
        finally { this.waitController = null; }
      }
    })().finally(() => { if (this.loopPromise === loop) this.loopPromise = null; });
    this.loopPromise = loop;
    return loop;
  }

  async stop() {
    this.stopped = true;
    this.waitController?.abort();
    await Promise.allSettled([this.currentRun, this.loopPromise].filter(Boolean));
  }
}

export const notificationOperationsWorkerInternals = Object.freeze({
  activityMessage,
  cameraNames,
  mqttTopic,
  safeError,
});
