import { statfs } from "node:fs/promises";
import os from "node:os";

import { VisualIndexWorker } from "./visual-index-worker.mjs";
import { normalizeVisualIndexSettings } from "./visual-index-settings.mjs";

const RUNTIME_STATE = Symbol.for("alpr.visual-index.runtime.state.v1");

function getRuntimeState(stateHost = globalThis) {
  if (!stateHost[RUNTIME_STATE]) {
    stateHost[RUNTIME_STATE] = {
      runtimePromise: null,
      loopPromise: null,
      worker: null,
    };
  }
  return stateHost[RUNTIME_STATE];
}

export async function probeVisualIndexSafety({
  minimumFreeDiskGb,
  maximumLoadPercent,
  storagePath,
  statfsFn = statfs,
  loadAverage = os.loadavg,
  cpuCount = () => os.cpus().length,
} = {}) {
  const settings = normalizeVisualIndexSettings({ minimumFreeDiskGb, maximumLoadPercent });
  const filesystem = await statfsFn(storagePath);
  const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  const availableDiskGb = availableBytes / 1024 ** 3;
  if (availableDiskGb < settings.minimumFreeDiskGb) {
    return {
      safe: false,
      reason: `Only ${availableDiskGb.toFixed(1)} GB of free storage remains`,
      availableDiskGb: Number(availableDiskGb.toFixed(1)),
      loadPercent: null,
    };
  }

  const cores = Math.max(1, Number(cpuCount()) || 1);
  const oneMinuteLoad = Math.max(0, Number(loadAverage()?.[0]) || 0);
  const loadPercent = oneMinuteLoad / cores * 100;
  if (loadPercent > settings.maximumLoadPercent) {
    return {
      safe: false,
      reason: `System load is ${loadPercent.toFixed(0)}% of available CPU capacity`,
      availableDiskGb: Number(availableDiskGb.toFixed(1)),
      loadPercent: Number(loadPercent.toFixed(1)),
    };
  }

  return {
    safe: true,
    reason: "",
    availableDiskGb: Number(availableDiskGb.toFixed(1)),
    loadPercent: Number(loadPercent.toFixed(1)),
  };
}

export async function loadDefaultVisualIndexDependencies() {
  const [{ getCaptureAssetService }, { getConfig }, { default: fileStorage }] = await Promise.all([
    import("./capture-asset-runtime.mjs"),
    import("./settings.js"),
    import("./fileStorage.js"),
  ]);
  return {
    service: await getCaptureAssetService(),
    loadSettings: getConfig,
    safetyProbe: (settings) => probeVisualIndexSafety({
      ...settings,
      storagePath: fileStorage.baseDir,
    }),
  };
}

export async function getVisualIndexRuntime({
  stateHost = globalThis,
  logger = console,
  loadDependencies = loadDefaultVisualIndexDependencies,
  workerFactory = (options) => new VisualIndexWorker(options),
} = {}) {
  const state = getRuntimeState(stateHost);
  if (!state.runtimePromise) {
    state.runtimePromise = (async () => {
      const dependencies = await loadDependencies();
      const worker = workerFactory({ ...dependencies, logger });
      state.worker = worker;
      return { worker };
    })().catch((error) => {
      state.runtimePromise = null;
      state.worker = null;
      throw error;
    });
  }
  return state.runtimePromise;
}

export async function startVisualIndexRuntime(options = {}) {
  const stateHost = options.stateHost ?? globalThis;
  const logger = options.logger ?? console;
  const state = getRuntimeState(stateHost);
  const runtime = await getVisualIndexRuntime(options);

  if (!state.loopPromise && !runtime.worker.running && !runtime.worker.stopped) {
    const loopPromise = runtime.worker.start();
    state.loopPromise = loopPromise;
    loopPromise
      .catch((error) => logger?.error?.("Visual index worker stopped unexpectedly", {
        message: String(error?.message || error),
      }))
      .finally(() => {
        if (state.loopPromise === loopPromise) state.loopPromise = null;
      });
  }
  return runtime;
}

export function getVisualIndexRuntimeStatus({ stateHost = globalThis } = {}) {
  const worker = getRuntimeState(stateHost).worker;
  return worker?.snapshot?.() || {
    running: false,
    phase: "starting",
    settings: normalizeVisualIndexSettings(),
    startedAt: null,
    nextRunAt: null,
    lastBatch: null,
    lastError: null,
    safetyReason: "",
    itemsPerMinute: null,
    estimatedSecondsRemaining: null,
  };
}

export function wakeVisualIndexWorker({ stateHost = globalThis } = {}) {
  const worker = getRuntimeState(stateHost).worker;
  worker?.wake?.();
  return Boolean(worker);
}

export async function stopVisualIndexRuntime({ stateHost = globalThis } = {}) {
  const state = getRuntimeState(stateHost);
  const runtime = state.runtimePromise ? await state.runtimePromise.catch(() => null) : null;
  if (runtime?.worker) await runtime.worker.stop();
  state.runtimePromise = null;
  state.loopPromise = null;
  state.worker = null;
}

export const visualIndexRuntimeInternals = Object.freeze({
  RUNTIME_STATE,
  getRuntimeState,
});
