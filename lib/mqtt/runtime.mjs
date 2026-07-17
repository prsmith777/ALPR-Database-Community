import { MqttAcceptedReadService } from "./accepted-read-service.mjs";
import { MqttClientManager } from "./client-manager.mjs";
import { MqttDeliveryWorker } from "./delivery-worker.mjs";
import { MqttRepository } from "./repository.mjs";

const RUNTIME_STATE = Symbol.for("alpr.mqtt.runtime.state.v2");

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function safelyLog(logger, level, message, details) {
  const method = logger?.[level];
  if (typeof method !== "function") return;
  if (details === undefined) method.call(logger, message);
  else method.call(logger, message, details);
}

function safeError(error) {
  return {
    name: String(error?.name ?? "Error"),
    code: String(error?.code ?? ""),
    message: String(error?.message ?? error ?? "Unknown MQTT runtime error")
      .trim()
      .slice(0, 4000),
  };
}

function getRuntimeState(stateHost = globalThis) {
  if (!stateHost[RUNTIME_STATE]) {
    stateHost[RUNTIME_STATE] = {
      runtimePromise: null,
      loopPromise: null,
    };
  }
  return stateHost[RUNTIME_STATE];
}

function resolveMqttConnect(mqttPackage) {
  const connect = firstDefined(
    mqttPackage?.connect,
    mqttPackage?.default?.connect,
    typeof mqttPackage?.default === "function" ? mqttPackage.default : null
  );
  if (typeof connect !== "function") {
    throw new Error("The MQTT package did not expose connect()");
  }
  return connect;
}

export function createMqttRuntime({
  pool,
  mqttConnect,
  logger = console,
  now = () => new Date(),
  workerId,
  workerOptions = {},
  acceptedReadOptions = {},
} = {}) {
  const repository = new MqttRepository({ pool, now });
  const clientManager = new MqttClientManager({ mqttConnect, logger });
  const acceptedReadService = new MqttAcceptedReadService({
    repository,
    logger,
    now,
    ...acceptedReadOptions,
  });
  const worker = new MqttDeliveryWorker({
    repository,
    clientManager,
    logger,
    now,
    ...(workerId ? { workerId } : {}),
    ...workerOptions,
  });

  return {
    repository,
    clientManager,
    acceptedReadService,
    worker,
  };
}

export async function loadDefaultMqttRuntimeDependencies() {
  const [{ getPool }, mqttPackage] = await Promise.all([
    import("../db.js"),
    import("mqtt"),
  ]);
  const pool = await getPool();
  return {
    pool,
    mqttConnect: resolveMqttConnect(mqttPackage),
  };
}

export async function getMqttRuntime({
  stateHost = globalThis,
  logger = console,
  loadDependencies = loadDefaultMqttRuntimeDependencies,
  runtimeFactory = createMqttRuntime,
  runtimeOptions = {},
} = {}) {
  const state = getRuntimeState(stateHost);

  if (!state.runtimePromise) {
    state.runtimePromise = (async () => {
      const dependencies = await loadDependencies();
      return runtimeFactory({
        ...dependencies,
        logger,
        ...runtimeOptions,
      });
    })().catch((error) => {
      state.runtimePromise = null;
      throw error;
    });
  }

  return state.runtimePromise;
}

export async function startMqttRuntime(options = {}) {
  const stateHost = options.stateHost ?? globalThis;
  const logger = options.logger ?? console;
  const state = getRuntimeState(stateHost);
  const runtime = await getMqttRuntime(options);

  if (!state.loopPromise && !runtime.worker.running && !runtime.worker.stopped) {
    const loopPromise = runtime.worker.start();
    state.loopPromise = loopPromise;

    loopPromise
      .catch((error) => {
        safelyLog(logger, "error", "MQTT delivery worker stopped unexpectedly", {
          error: safeError(error),
        });
      })
      .finally(() => {
        if (state.loopPromise === loopPromise) state.loopPromise = null;
      });
  }

  return runtime;
}

export async function processAcceptedMqttRead(read, options = {}) {
  const logger = options.logger ?? console;

  try {
    const runtime = await startMqttRuntime(options);
    return await runtime.acceptedReadService.processAcceptedRead(read);
  } catch (error) {
    const normalized = safeError(error);
    safelyLog(logger, "error", "MQTT runtime could not process accepted read", {
      readId: firstDefined(read?.id, read?.readId, read?.read_id, null),
      cameraName: String(
        firstDefined(read?.cameraName, read?.camera_name, read?.camera, "")
      ).trim(),
      error: normalized,
    });

    return {
      status: "error",
      readId: firstDefined(read?.id, read?.readId, read?.read_id, null),
      eventId: "",
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

export async function stopMqttRuntime({
  stateHost = globalThis,
  shutdownConnections = true,
  forceConnections = false,
} = {}) {
  const state = getRuntimeState(stateHost);
  const runtime = state.runtimePromise ? await state.runtimePromise.catch(() => null) : null;

  if (runtime) {
    await runtime.worker.stop({ shutdownConnections, forceConnections });
  }

  state.runtimePromise = null;
  state.loopPromise = null;
}

export const mqttRuntimeInternals = Object.freeze({
  RUNTIME_STATE,
  getRuntimeState,
  resolveMqttConnect,
  safeError,
});
