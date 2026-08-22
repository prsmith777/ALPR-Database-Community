import { BlueIrisVehicleFrameQueue } from "./blue-iris-vehicle-frame-queue.mjs";
import { BlueIrisVehicleFrameRepository } from "./blue-iris-vehicle-frame-repository.mjs";
import { BlueIrisVehicleFrameWorker } from "./blue-iris-vehicle-frame-worker.mjs";

const RUNTIME_STATE = Symbol.for("alpr.blue-iris-vehicle-frame.runtime.v1");

function stateFor(host = globalThis) {
  if (!host[RUNTIME_STATE]) host[RUNTIME_STATE] = { runtimePromise: null, worker: null, loopPromise: null };
  return host[RUNTIME_STATE];
}

async function loadDependencies() {
  const [{ getPool }, { getConfig }, { default: fileStorage }] = await Promise.all([
    import("./db.js"),
    import("./settings.js"),
    import("./fileStorage.js"),
  ]);
  return { pool: await getPool(), loadConfig: getConfig, fileStorage };
}

export async function getBlueIrisVehicleFrameRuntime({
  stateHost = globalThis,
  logger = console,
  dependencyLoader = loadDependencies,
} = {}) {
  const state = stateFor(stateHost);
  if (!state.runtimePromise) {
    state.runtimePromise = (async () => {
      const dependencies = await dependencyLoader();
      const repository = new BlueIrisVehicleFrameRepository(dependencies.pool);
      const queue = new BlueIrisVehicleFrameQueue({
        repository,
        fileStorage: dependencies.fileStorage,
        loadConfig: dependencies.loadConfig,
        logger,
      });
      void queue.refreshCameraInventory({ force: true }).catch((error) => {
        logger?.warn?.("blue_iris_camera_inventory_startup_refresh_failed", {
          code: String(error?.code || ""),
          message: String(error?.message || error).slice(0, 300),
        });
      });
      const worker = new BlueIrisVehicleFrameWorker({ queue, logger });
      state.worker = worker;
      return { repository, queue, worker };
    })().catch((error) => {
      state.runtimePromise = null;
      state.worker = null;
      throw error;
    });
  }
  return state.runtimePromise;
}

export async function startBlueIrisVehicleFrameRuntime(options = {}) {
  const stateHost = options.stateHost || globalThis;
  const state = stateFor(stateHost);
  const runtime = await getBlueIrisVehicleFrameRuntime(options);
  if (!state.loopPromise && !runtime.worker.running) {
    state.loopPromise = runtime.worker.start().finally(() => { state.loopPromise = null; });
  }
  return runtime;
}

export function wakeBlueIrisVehicleFrameWorker({ stateHost = globalThis } = {}) {
  const worker = stateFor(stateHost).worker;
  worker?.wake?.();
  return Boolean(worker);
}

export const blueIrisVehicleFrameRuntimeInternals = Object.freeze({ RUNTIME_STATE, stateFor });
