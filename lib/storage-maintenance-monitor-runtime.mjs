import { getPool } from "./db.js";
import { StorageMaintenanceMonitor } from "./storage-maintenance-monitor.mjs";

const RUNTIME_STATE = Symbol.for("alpr.storage.maintenance.monitor.runtime.v1");

function state(host = globalThis) {
  if (!host[RUNTIME_STATE]) host[RUNTIME_STATE] = { runtimePromise: null, loopPromise: null };
  return host[RUNTIME_STATE];
}

export async function startStorageMaintenanceMonitor({ stateHost = globalThis, logger = console } = {}) {
  const current = state(stateHost);
  if (!current.runtimePromise) {
    current.runtimePromise = (async () => {
      const pool = await getPool();
      const worker = new StorageMaintenanceMonitor({ pool, logger });
      return { worker };
    })().catch((error) => { current.runtimePromise = null; throw error; });
  }
  const runtime = await current.runtimePromise;
  let reused = true;
  if (!current.loopPromise && !runtime.worker.loopPromise) {
    reused = false;
    current.loopPromise = runtime.worker.start();
    current.loopPromise.catch((error) => {
      logger?.error?.("Storage maintenance monitor stopped unexpectedly", { error: String(error?.message || error).slice(0, 1000) });
    }).finally(() => { current.loopPromise = null; });
  }
  return { status: "started", reused, worker: runtime.worker };
}

export const storageMaintenanceMonitorRuntimeInternals = Object.freeze({ RUNTIME_STATE, state });
