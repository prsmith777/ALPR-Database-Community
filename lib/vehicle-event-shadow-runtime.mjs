import { VehicleEventShadowRepository } from "./vehicle-event-shadow-repository.mjs";
import { VehicleEventShadowService } from "./vehicle-event-shadow.mjs";
import { VehicleEventShadowWorker } from "./vehicle-event-shadow-worker.mjs";

const RUNTIME_STATE = Symbol.for("alpr.vehicle-event-shadow.runtime.v1");

function stateFor(host = globalThis) {
  if (!host[RUNTIME_STATE]) {
    host[RUNTIME_STATE] = { runtimePromise: null, worker: null, loopPromise: null };
  }
  return host[RUNTIME_STATE];
}

async function loadDependencies() {
  const { getPool } = await import("./db.js");
  return { pool: await getPool() };
}

export async function getVehicleEventShadowRuntime({
  stateHost = globalThis,
  logger = console,
  dependencyLoader = loadDependencies,
} = {}) {
  const state = stateFor(stateHost);
  if (!state.runtimePromise) {
    state.runtimePromise = (async () => {
      const dependencies = await dependencyLoader();
      const repository = new VehicleEventShadowRepository(dependencies.pool);
      const service = new VehicleEventShadowService({ repository, logger });
      const worker = new VehicleEventShadowWorker({ service, logger });
      state.worker = worker;
      return { repository, service, worker };
    })().catch((error) => {
      state.runtimePromise = null;
      state.worker = null;
      throw error;
    });
  }
  return state.runtimePromise;
}

export async function startVehicleEventShadowRuntime(options = {}) {
  const stateHost = options.stateHost || globalThis;
  const state = stateFor(stateHost);
  const runtime = await getVehicleEventShadowRuntime(options);
  if (!state.loopPromise && !runtime.worker.running && !runtime.worker.stopped) {
    const loopPromise = runtime.worker.start();
    state.loopPromise = loopPromise;
    loopPromise.finally(() => {
      if (state.loopPromise === loopPromise) state.loopPromise = null;
    });
  }
  return runtime;
}

export function wakeVehicleEventShadowWorker({ stateHost = globalThis } = {}) {
  const worker = stateFor(stateHost).worker;
  worker?.wake?.();
  return Boolean(worker);
}

export function getVehicleEventShadowWorkerStatus({ stateHost = globalThis } = {}) {
  return stateFor(stateHost).worker?.snapshot?.() || {
    running: false,
    startedAt: null,
    lastBatch: null,
    lastError: null,
  };
}

export async function stopVehicleEventShadowRuntime({ stateHost = globalThis } = {}) {
  const state = stateFor(stateHost);
  const runtime = state.runtimePromise ? await state.runtimePromise.catch(() => null) : null;
  if (runtime?.worker) await runtime.worker.stop();
  state.runtimePromise = null;
  state.loopPromise = null;
  state.worker = null;
}

export const vehicleEventShadowRuntimeInternals = Object.freeze({ RUNTIME_STATE, stateFor });
