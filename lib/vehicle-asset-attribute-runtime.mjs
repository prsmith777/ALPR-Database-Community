import { VehicleAssetAttributeCampaignService } from "./vehicle-asset-attribute-campaign.mjs";
import { VehicleAssetAttributeRepository } from "./vehicle-asset-attribute-repository.mjs";
import { VehicleAssetAttributeService } from "./vehicle-asset-attribute.mjs";
import { VehicleAssetAttributeWorker } from "./vehicle-asset-attribute-worker.mjs";

const RUNTIME_STATE = Symbol.for("alpr.vehicle-asset-attribute.runtime.v1");

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

export async function getVehicleAssetAttributeRuntime({
  stateHost = globalThis,
  logger = console,
  dependencyLoader = loadDependencies,
} = {}) {
  const state = stateFor(stateHost);
  if (!state.runtimePromise) {
    state.runtimePromise = (async () => {
      const dependencies = await dependencyLoader();
      const repository = new VehicleAssetAttributeRepository({ pool: dependencies.pool });
      const attributeService = new VehicleAssetAttributeService({
        repository,
        fileStorage: dependencies.fileStorage,
      });
      const service = new VehicleAssetAttributeCampaignService({
        repository,
        attributeService,
        logger,
      });
      const worker = new VehicleAssetAttributeWorker({ service, logger });
      state.worker = worker;
      return { repository, attributeService, service, worker };
    })().catch((error) => {
      state.runtimePromise = null;
      state.worker = null;
      throw error;
    });
  }
  return state.runtimePromise;
}

export async function startVehicleAssetAttributeRuntime(options = {}) {
  const stateHost = options.stateHost || globalThis;
  const state = stateFor(stateHost);
  const runtime = await getVehicleAssetAttributeRuntime(options);
  if (!state.loop && !runtime.worker.running && !runtime.worker.stopped) {
    state.loop = runtime.worker.start();
    state.loop.finally(() => { state.loop = null; });
  }
  return runtime;
}

export function wakeVehicleAssetAttributeWorker({ stateHost = globalThis } = {}) {
  const worker = stateFor(stateHost).worker;
  worker?.wake?.();
  return Boolean(worker);
}

export function getVehicleAssetAttributeWorkerStatus({ stateHost = globalThis } = {}) {
  return stateFor(stateHost).worker?.snapshot?.() || {
    running: false,
    phase: "starting",
    startedAt: null,
    lastBatch: null,
    lastError: null,
  };
}

export async function stopVehicleAssetAttributeRuntime({ stateHost = globalThis } = {}) {
  const state = stateFor(stateHost);
  const runtime = state.runtimePromise ? await state.runtimePromise.catch(() => null) : null;
  if (runtime?.worker) await runtime.worker.stop();
  state.runtimePromise = null;
  state.worker = null;
  state.loop = null;
}

export const vehicleAssetAttributeRuntimeInternals = Object.freeze({ RUNTIME_STATE, stateFor });


