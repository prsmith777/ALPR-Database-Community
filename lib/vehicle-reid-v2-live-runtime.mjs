import { getPool } from "./db.js";
import { VehicleReidV2LiveRepository, VehicleReidV2LiveService } from "./vehicle-reid-v2-live.mjs";
import { VehicleReidV2LiveWorker } from "./vehicle-reid-v2-live-worker.mjs";

const RUNTIME_STATE = Symbol.for("alpr.vehicle-reid-v2-live.runtime.v1");

function stateFor(host = globalThis) {
  if (!host[RUNTIME_STATE]) {
    host[RUNTIME_STATE] = { runtimePromise: null, worker: null, loop: null };
  }
  return host[RUNTIME_STATE];
}

export async function getVehicleReidV2LiveRuntime({
  stateHost = globalThis,
  logger = console,
  poolLoader = getPool,
} = {}) {
  const state = stateFor(stateHost);
  if (!state.runtimePromise) {
    state.runtimePromise = (async () => {
      const pool = await poolLoader();
      const repository = new VehicleReidV2LiveRepository({ pool });
      const service = new VehicleReidV2LiveService({ repository, logger });
      const worker = new VehicleReidV2LiveWorker({ service, logger });
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

export async function startVehicleReidV2LiveRuntime(options = {}) {
  const state = stateFor(options.stateHost || globalThis);
  const runtime = await getVehicleReidV2LiveRuntime(options);
  if (!state.loop && !runtime.worker.running && !runtime.worker.stopped) {
    state.loop = runtime.worker.start();
    state.loop.finally(() => { state.loop = null; });
  }
  return runtime;
}

export function wakeVehicleReidV2LiveWorker({ stateHost = globalThis } = {}) {
  const worker = stateFor(stateHost).worker;
  worker?.wake?.();
  return Boolean(worker);
}

export function getVehicleReidV2LiveWorkerStatus({ stateHost = globalThis } = {}) {
  return stateFor(stateHost).worker?.snapshot?.() || {
    running: false,
    phase: "starting",
    startedAt: null,
    lastBatch: null,
    lastError: null,
  };
}

export async function stopVehicleReidV2LiveRuntime({ stateHost = globalThis } = {}) {
  const state = stateFor(stateHost);
  const runtime = state.runtimePromise ? await state.runtimePromise.catch(() => null) : null;
  if (runtime?.worker) await runtime.worker.stop();
  state.runtimePromise = null;
  state.worker = null;
  state.loop = null;
}

export const vehicleReidV2LiveRuntimeInternals = Object.freeze({ RUNTIME_STATE, stateFor });
