import { VehicleImageCropCampaignService } from "./vehicle-image-crop-campaign.mjs";
import { VehicleImageCropRepository } from "./vehicle-image-crop-repository.mjs";
import { VehicleImageCropService } from "./vehicle-image-crop.mjs";
import { VehicleImageCropWorker } from "./vehicle-image-crop-worker.mjs";

const RUNTIME_STATE = Symbol.for("alpr.vehicle-image-crop.runtime.v1");

function stateFor(host = globalThis) {
  if (!host[RUNTIME_STATE]) host[RUNTIME_STATE] = { runtimePromise: null, worker: null, loop: null };
  return host[RUNTIME_STATE];
}

async function loadDependencies() {
  const [{ getPool }, { default: fileStorage }] = await Promise.all([
    import("./db.js"),
    import("./fileStorage.js"),
  ]);
  return { pool: await getPool(), fileStorage };
}

export async function getVehicleImageCropRuntime({
  stateHost = globalThis,
  logger = console,
  dependencyLoader = loadDependencies,
} = {}) {
  const state = stateFor(stateHost);
  if (!state.runtimePromise) {
    state.runtimePromise = (async () => {
      const dependencies = await dependencyLoader();
      const repository = new VehicleImageCropRepository({ pool: dependencies.pool });
      const cropService = new VehicleImageCropService({
        repository,
        fileStorage: dependencies.fileStorage,
      });
      const service = new VehicleImageCropCampaignService({ repository, cropService, logger });
      const worker = new VehicleImageCropWorker({ service, logger });
      state.worker = worker;
      return { repository, cropService, service, worker };
    })().catch((error) => {
      state.runtimePromise = null;
      state.worker = null;
      throw error;
    });
  }
  return state.runtimePromise;
}

export async function startVehicleImageCropRuntime(options = {}) {
  const stateHost = options.stateHost || globalThis;
  const state = stateFor(stateHost);
  const runtime = await getVehicleImageCropRuntime(options);
  if (!state.loop && !runtime.worker.running && !runtime.worker.stopped) {
    state.loop = runtime.worker.start();
    state.loop.finally(() => { state.loop = null; });
  }
  return runtime;
}

export function wakeVehicleImageCropWorker({ stateHost = globalThis } = {}) {
  const worker = stateFor(stateHost).worker;
  worker?.wake?.();
  return Boolean(worker);
}

export function getVehicleImageCropWorkerStatus({ stateHost = globalThis } = {}) {
  return stateFor(stateHost).worker?.snapshot?.() || {
    running: false,
    phase: "starting",
    startedAt: null,
    lastBatch: null,
    lastError: null,
  };
}

export async function stopVehicleImageCropRuntime({ stateHost = globalThis } = {}) {
  const state = stateFor(stateHost);
  const runtime = state.runtimePromise ? await state.runtimePromise.catch(() => null) : null;
  if (runtime?.worker) await runtime.worker.stop();
  state.runtimePromise = null;
  state.worker = null;
  state.loop = null;
}

export const vehicleImageCropRuntimeInternals = Object.freeze({ RUNTIME_STATE, stateFor });
