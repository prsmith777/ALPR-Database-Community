import { VehicleImageAssetCatalogService } from "./vehicle-image-asset-catalog.mjs";
import { VehicleImageAssetCatalogCampaignService } from "./vehicle-image-asset-catalog-campaign.mjs";
import { VehicleImageAssetCatalogCampaignRepository } from "./vehicle-image-asset-catalog-campaign-repository.mjs";
import { VehicleImageAssetCatalogWorker } from "./vehicle-image-asset-catalog-worker.mjs";
import { VehicleImageAssetRepository } from "./vehicle-image-asset-repository.mjs";
import { VehicleImageAssetLiveCatalogService } from "./vehicle-image-asset-live-catalog.mjs";
import { VehicleImageAssetLiveCatalogRepository } from "./vehicle-image-asset-live-catalog-repository.mjs";

const RUNTIME_STATE = Symbol.for("alpr.vehicle-image-asset-catalog.runtime.v1");

function stateFor(host = globalThis) {
  if (!host[RUNTIME_STATE]) {
    host[RUNTIME_STATE] = { runtimePromise: null, worker: null, loopPromise: null };
  }
  return host[RUNTIME_STATE];
}

async function loadDependencies() {
  const [{ getPool }, { default: fileStorage }] = await Promise.all([
    import("./db.js"),
    import("./fileStorage.js"),
  ]);
  return { pool: await getPool(), fileStorage };
}

export async function getVehicleImageAssetCatalogRuntime({
  stateHost = globalThis,
  logger = console,
  dependencyLoader = loadDependencies,
} = {}) {
  const state = stateFor(stateHost);
  if (!state.runtimePromise) {
    state.runtimePromise = (async () => {
      const dependencies = await dependencyLoader();
      const assetRepository = new VehicleImageAssetRepository({ pool: dependencies.pool });
      const repository = new VehicleImageAssetCatalogCampaignRepository(dependencies.pool);
      const catalog = new VehicleImageAssetCatalogService({
        repository: assetRepository,
        fileStorage: dependencies.fileStorage,
      });
      const liveRepository = new VehicleImageAssetLiveCatalogRepository(dependencies.pool);
      const liveCatalog = new VehicleImageAssetLiveCatalogService({
        repository: liveRepository,
        catalog,
        logger,
      });
      const service = new VehicleImageAssetCatalogCampaignService({
        repository,
        catalog,
        liveCatalog,
        logger,
      });
      const worker = new VehicleImageAssetCatalogWorker({ service, liveCatalog, logger });
      state.worker = worker;
      return {
        assetRepository,
        repository,
        catalog,
        liveRepository,
        liveCatalog,
        service,
        worker,
      };
    })().catch((error) => {
      state.runtimePromise = null;
      state.worker = null;
      throw error;
    });
  }
  return state.runtimePromise;
}

export async function startVehicleImageAssetCatalogRuntime(options = {}) {
  const stateHost = options.stateHost || globalThis;
  const state = stateFor(stateHost);
  const runtime = await getVehicleImageAssetCatalogRuntime(options);
  if (!state.loopPromise && !runtime.worker.running && !runtime.worker.stopped) {
    const loopPromise = runtime.worker.start();
    state.loopPromise = loopPromise;
    loopPromise.finally(() => {
      if (state.loopPromise === loopPromise) state.loopPromise = null;
    });
  }
  return runtime;
}

export function wakeVehicleImageAssetCatalogWorker({ stateHost = globalThis } = {}) {
  const worker = stateFor(stateHost).worker;
  worker?.wake?.();
  return Boolean(worker);
}

export function getVehicleImageAssetCatalogWorkerStatus({ stateHost = globalThis } = {}) {
  return stateFor(stateHost).worker?.snapshot?.() || {
    running: false,
    phase: "starting",
    startedAt: null,
    lastBatch: null,
    lastError: null,
  };
}

export async function stopVehicleImageAssetCatalogRuntime({ stateHost = globalThis } = {}) {
  const state = stateFor(stateHost);
  const runtime = state.runtimePromise ? await state.runtimePromise.catch(() => null) : null;
  if (runtime?.worker) await runtime.worker.stop();
  state.runtimePromise = null;
  state.loopPromise = null;
  state.worker = null;
}

export const vehicleImageAssetCatalogRuntimeInternals = Object.freeze({
  RUNTIME_STATE,
  stateFor,
});
