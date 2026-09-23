import { VehicleAssetEmbeddingCampaignService } from "./vehicle-asset-embedding-campaign.mjs";
import { VehicleAssetEmbeddingRepository } from "./vehicle-asset-embedding-repository.mjs";
import { VehicleAssetEmbeddingService } from "./vehicle-asset-embedding.mjs";
import { VehicleAssetEmbeddingWorker } from "./vehicle-asset-embedding-worker.mjs";

const RUNTIME_STATE = Symbol.for("alpr.vehicle-asset-embedding.runtime.v1");

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

export async function getVehicleAssetEmbeddingRuntime({
  stateHost = globalThis,
  logger = console,
  dependencyLoader = loadDependencies,
} = {}) {
  const state = stateFor(stateHost);
  if (!state.runtimePromise) {
    state.runtimePromise = (async () => {
      const dependencies = await dependencyLoader();
      const repository = new VehicleAssetEmbeddingRepository({ pool: dependencies.pool });
      const embeddingService = new VehicleAssetEmbeddingService({
        repository,
        fileStorage: dependencies.fileStorage,
      });
      const service = new VehicleAssetEmbeddingCampaignService({
        repository,
        embeddingService,
        logger,
      });
      const worker = new VehicleAssetEmbeddingWorker({ service, logger });
      state.worker = worker;
      return { repository, embeddingService, service, worker };
    })().catch((error) => {
      state.runtimePromise = null;
      state.worker = null;
      throw error;
    });
  }
  return state.runtimePromise;
}

export async function startVehicleAssetEmbeddingRuntime(options = {}) {
  const stateHost = options.stateHost || globalThis;
  const state = stateFor(stateHost);
  const runtime = await getVehicleAssetEmbeddingRuntime(options);
  if (!state.loop && !runtime.worker.running && !runtime.worker.stopped) {
    state.loop = runtime.worker.start();
    state.loop.finally(() => { state.loop = null; });
  }
  return runtime;
}

export function wakeVehicleAssetEmbeddingWorker({ stateHost = globalThis } = {}) {
  const worker = stateFor(stateHost).worker;
  worker?.wake?.();
  return Boolean(worker);
}

export function getVehicleAssetEmbeddingWorkerStatus({ stateHost = globalThis } = {}) {
  return stateFor(stateHost).worker?.snapshot?.() || {
    running: false,
    phase: "starting",
    startedAt: null,
    lastBatch: null,
    lastError: null,
  };
}

export async function stopVehicleAssetEmbeddingRuntime({ stateHost = globalThis } = {}) {
  const state = stateFor(stateHost);
  const runtime = state.runtimePromise ? await state.runtimePromise.catch(() => null) : null;
  if (runtime?.worker) await runtime.worker.stop();
  state.runtimePromise = null;
  state.worker = null;
  state.loop = null;
}

export const vehicleAssetEmbeddingRuntimeInternals = Object.freeze({ RUNTIME_STATE, stateFor });
