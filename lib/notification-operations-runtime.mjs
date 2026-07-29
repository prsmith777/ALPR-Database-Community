import { getPool } from "./db.js";
import { MqttRepository } from "./mqtt/repository.mjs";
import { NotificationOperationsWorker } from "./notification-operations-worker.mjs";
import { NotificationRuntimeRepository } from "./notification-runtime-repository.mjs";
import { MaintenanceAlertRepository } from "./maintenance-alert-repository.mjs";
import { MaintenanceAlertWorker } from "./maintenance-alert-worker.mjs";

const RUNTIME_STATE = Symbol.for("alpr.notification.operations.runtime.v1");

function state(host = globalThis) {
  if (!host[RUNTIME_STATE]) host[RUNTIME_STATE] = { runtimePromise: null, loopPromise: null };
  return host[RUNTIME_STATE];
}

export async function getNotificationOperationsRuntime({ stateHost = globalThis, logger = console } = {}) {
  const current = state(stateHost);
  if (!current.runtimePromise) {
    current.runtimePromise = (async () => {
      const pool = await getPool();
      const repository = new NotificationRuntimeRepository({ executor: pool });
      const mqttRepository = new MqttRepository({ pool });
      const maintenanceAlertRepository = new MaintenanceAlertRepository({ pool });
      const maintenanceAlertWorker = new MaintenanceAlertWorker({
        repository: maintenanceAlertRepository,
        logger,
      });
      const worker = new NotificationOperationsWorker({
        repository,
        mqttRepository,
        maintenanceAlertWorker,
        logger,
      });
      return { repository, mqttRepository, maintenanceAlertRepository, maintenanceAlertWorker, worker };
    })().catch((error) => {
      current.runtimePromise = null;
      throw error;
    });
  }
  return current.runtimePromise;
}

export async function startNotificationOperationsRuntime(options = {}) {
  const current = state(options.stateHost ?? globalThis);
  const logger = options.logger ?? console;
  const runtime = await getNotificationOperationsRuntime(options);
  if (!current.loopPromise && !runtime.worker.running) {
    const loop = runtime.worker.start();
    current.loopPromise = loop;
    loop
      .catch((error) => {
        logger?.error?.("Notification operations worker stopped unexpectedly", {
          error: String(error?.message ?? error).slice(0, 1000),
        });
      })
      .finally(() => { if (current.loopPromise === loop) current.loopPromise = null; });
  }
  return runtime;
}

export async function stopNotificationOperationsRuntime({ stateHost = globalThis } = {}) {
  const current = state(stateHost);
  const runtime = current.runtimePromise ? await current.runtimePromise.catch(() => null) : null;
  if (runtime) await runtime.worker.stop();
  current.runtimePromise = null;
  current.loopPromise = null;
}

export const notificationOperationsRuntimeInternals = Object.freeze({ RUNTIME_STATE, state });
