import assert from "node:assert/strict";
import test from "node:test";

import {
  mqttInstrumentationInternals,
  register,
} from "../instrumentation.js";
import {
  registerMqttNodeInstrumentation,
  registerNodeInstrumentation,
} from "../instrumentation.node.js";
import {
  mqttStartupInternals,
  startMqttRuntimeWithRetry,
} from "../lib/mqtt/startup.mjs";

function makeLogger() {
  const entries = [];
  const logger = {};
  for (const level of ["info", "warn", "error"]) {
    logger[level] = (message, details) => {
      entries.push({ level, message, details });
    };
  }
  return { logger, entries };
}

test("MQTT startup validates injected runtime and timer functions", async () => {
  await assert.rejects(
    () => startMqttRuntimeWithRetry({ startRuntime: "invalid" }),
    /startRuntime must be a function/
  );
  await assert.rejects(
    () => startMqttRuntimeWithRetry({ loadStartRuntime: null }),
    /startup loader must be a function/
  );
  await assert.rejects(
    () => startMqttRuntimeWithRetry({ schedule: null }),
    /timer functions must be functions/
  );
});

test("concurrent server startup calls share one runtime initialization", async () => {
  const stateHost = {};
  let startCalls = 0;
  let releaseStart;
  const startGate = new Promise((resolve) => {
    releaseStart = resolve;
  });

  const options = {
    stateHost,
    logger: {},
    async startRuntime() {
      startCalls += 1;
      await startGate;
    },
  };

  const firstPromise = startMqttRuntimeWithRetry(options);
  const secondPromise = startMqttRuntimeWithRetry(options);

  await Promise.resolve();
  assert.equal(startCalls, 1);

  releaseStart();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  assert.equal(first.status, "started");
  assert.equal(second.status, "started");
  assert.equal(startCalls, 1);

  const reused = await startMqttRuntimeWithRetry(options);
  assert.equal(reused.status, "started");
  assert.equal(reused.reused, true);
  assert.equal(startCalls, 1);
});

test("temporary startup failures schedule a retry that can later succeed", async () => {
  const stateHost = {};
  const { logger, entries } = makeLogger();
  const scheduled = [];
  let startCalls = 0;

  const schedule = (callback, delay) => {
    const timer = {
      callback,
      delay,
      unrefCalled: false,
      unref() {
        this.unrefCalled = true;
      },
    };
    scheduled.push(timer);
    return timer;
  };

  const result = await startMqttRuntimeWithRetry({
    stateHost,
    logger,
    retryDelayMs: 12_345,
    schedule,
    cancel() {},
    async startRuntime() {
      startCalls += 1;
      if (startCalls === 1) {
        const error = new Error("PostgreSQL is still starting");
        error.code = "ECONNREFUSED";
        throw error;
      }
    },
  });

  assert.equal(result.status, "retry-scheduled");
  assert.equal(result.retryDelayMs, 12_345);
  assert.equal(result.error.code, "ECONNREFUSED");
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 12_345);
  assert.equal(scheduled[0].unrefCalled, true);
  assert.equal(entries.at(-1).level, "error");
  assert.match(entries.at(-1).message, /retry scheduled/);

  const retryResult = await scheduled[0].callback();
  assert.equal(retryResult.status, "started");
  assert.equal(startCalls, 2);

  const state = mqttStartupInternals.getStartupState(stateHost);
  assert.equal(state.started, true);
  assert.equal(state.retryTimer, null);
  assert.equal(state.lastError, null);
});

test("Next.js instrumentation skips Edge without loading Node-only MQTT code", async () => {
  let loadCalls = 0;

  const result = await mqttInstrumentationInternals.registerForRuntime({
    runtime: "edge",
    async loadNodeInstrumentation() {
      loadCalls += 1;
      throw new Error("Edge must not import Node MQTT instrumentation");
    },
  });

  assert.equal(result.status, "skipped");
  assert.equal(result.runtime, "edge");
  assert.equal(loadCalls, 0);
});

test("Next.js Node instrumentation delegates through the Node-only adapter", async () => {
  const { logger } = makeLogger();
  let receivedLogger;

  const result = await mqttInstrumentationInternals.registerForRuntime({
    runtime: "nodejs",
    logger,
    async loadNodeInstrumentation() {
      return {
        async registerNodeInstrumentation(options) {
          receivedLogger = options.logger;
          return {
            status: "started",
            reused: false,
          };
        },
      };
    },
  });

  assert.equal(result.status, "started");
  assert.equal(receivedLogger, logger);
});

test("Node instrumentation starts MQTT and automatic visual indexing together", async () => {
  const { logger } = makeLogger();
  let mqttCalls = 0;
  let visualCalls = 0;
  let vehicleFrameCalls = 0;
  let notificationCalls = 0;
  let maintenanceCalls = 0;
  let storageMonitorCalls = 0;
  let vehicleAssetCatalogCalls = 0;
  let vehicleEventShadowCalls = 0;
  let vehicleImageCropCalls = 0;
  let vehicleAssetEmbeddingCalls = 0;
  const result = await registerNodeInstrumentation({
    logger,
    async startMqtt(options) {
      mqttCalls += 1;
      assert.equal(options.logger, logger);
      return { status: "started" };
    },
    async loadVisualStartup() {
      return {
        async startVisualIndexRuntimeWithRetry(options) {
          visualCalls += 1;
          assert.equal(options.logger, logger);
          return { status: "started" };
        },
      };
    },
    async loadVehicleFrameStartup() {
      return {
        async startBlueIrisVehicleFrameRuntimeWithRetry(options) {
          vehicleFrameCalls += 1;
          assert.equal(options.logger, logger);
          return { status: "started" };
        },
      };
    },
    async loadNotificationStartup() {
      return {
        async startNotificationOperationsRuntimeWithRetry(options) {
          notificationCalls += 1;
          assert.equal(options.logger, logger);
          return { status: "started" };
        },
      };
    },
    async loadMaintenanceStartup() {
      return {
        async startMaintenanceRuntimeWithRetry(options) {
          maintenanceCalls += 1;
          assert.equal(options.logger, logger);
          return { status: "started" };
        },
      };
    },
    async loadStorageMonitorStartup() {
      return {
        async startStorageMaintenanceMonitorWithRetry(options) {
          storageMonitorCalls += 1;
          assert.equal(options.logger, logger);
          return { status: "started" };
        },
      };
    },
    async loadVehicleAssetCatalogStartup() {
      return {
        async startVehicleImageAssetCatalogRuntimeWithRetry(options) {
          vehicleAssetCatalogCalls += 1;
          assert.equal(options.logger, logger);
          return { status: "started" };
        },
      };
    },
    async loadVehicleEventShadowStartup() {
      return {
        async startVehicleEventShadowRuntimeWithRetry(options) {
          vehicleEventShadowCalls += 1;
          assert.equal(options.logger, logger);
          return { status: "started" };
        },
      };
    },
    async loadVehicleImageCropStartup() {
      return {
        async startVehicleImageCropRuntimeWithRetry(options) {
          vehicleImageCropCalls += 1;
          assert.equal(options.logger, logger);
          return { status: "started" };
        },
      };
    },
    async loadVehicleAssetEmbeddingStartup() {
      return {
        async startVehicleAssetEmbeddingRuntimeWithRetry(options) {
          vehicleAssetEmbeddingCalls += 1;
          assert.equal(options.logger, logger);
          return { status: "started" };
        },
      };
    },
  });
  assert.equal(result.status, "started");
  assert.equal(result.mqtt.status, "started");
  assert.equal(result.visualIndex.status, "started");
  assert.equal(result.vehicleFrames.status, "started");
  assert.equal(result.notificationOperations.status, "started");
  assert.equal(result.maintenance.status, "started");
  assert.equal(result.storageMonitor.status, "started");
  assert.equal(result.vehicleAssetCatalog.status, "started");
  assert.equal(result.vehicleEventShadow.status, "started");
  assert.equal(result.vehicleImageCrops.status, "started");
  assert.equal(result.vehicleAssetEmbeddings.status, "started");
  assert.equal(mqttCalls, 1);
  assert.equal(visualCalls, 1);
  assert.equal(vehicleFrameCalls, 1);
  assert.equal(notificationCalls, 1);
  assert.equal(maintenanceCalls, 1);
  assert.equal(storageMonitorCalls, 1);
  assert.equal(vehicleAssetCatalogCalls, 1);
  assert.equal(vehicleEventShadowCalls, 1);
  assert.equal(vehicleImageCropCalls, 1);
  assert.equal(vehicleAssetEmbeddingCalls, 1);
});

test("a visual-index instrumentation import failure cannot prevent MQTT startup", async () => {
  const { logger, entries } = makeLogger();
  let mqttCalls = 0;
  const result = await registerNodeInstrumentation({
    logger,
    async startMqtt() {
      mqttCalls += 1;
      return { status: "started" };
    },
    async loadVisualStartup() {
      throw new Error("OpenVINO module is temporarily unavailable");
    },
    async loadVehicleFrameStartup() {
      return { async startBlueIrisVehicleFrameRuntimeWithRetry() { return { status: "started" }; } };
    },
    async loadNotificationStartup() {
      return { async startNotificationOperationsRuntimeWithRetry() { return { status: "started" }; } };
    },
    async loadMaintenanceStartup() {
      return { async startMaintenanceRuntimeWithRetry() { return { status: "started" }; } };
    },
    async loadStorageMonitorStartup() {
      return { async startStorageMaintenanceMonitorWithRetry() { return { status: "started" }; } };
    },
    async loadVehicleAssetCatalogStartup() {
      return { async startVehicleImageAssetCatalogRuntimeWithRetry() { return { status: "started" }; } };
    },
    async loadVehicleEventShadowStartup() {
      return { async startVehicleEventShadowRuntimeWithRetry() { return { status: "started" }; } };
    },
    async loadVehicleImageCropStartup() {
      return { async startVehicleImageCropRuntimeWithRetry() { return { status: "started" }; } };
    },
    async loadVehicleAssetEmbeddingStartup() {
      return { async startVehicleAssetEmbeddingRuntimeWithRetry() { return { status: "started" }; } };
    },
  });
  assert.equal(mqttCalls, 1);
  assert.equal(result.status, "partial");
  assert.equal(result.mqtt.status, "started");
  assert.equal(result.visualIndex.status, "error");
  assert.match(result.visualIndex.error.message, /OpenVINO/);
  assert.match(entries.at(-1).message, /Visual index instrumentation startup failed/);
});

test("Node-only instrumentation loads the resilient MQTT startup wrapper", async () => {
  const { logger } = makeLogger();
  let receivedLogger;

  const result = await registerMqttNodeInstrumentation({
    logger,
    async loadStartup() {
      return {
        async startMqttRuntimeWithRetry(options) {
          receivedLogger = options.logger;
          return {
            status: "started",
            reused: false,
          };
        },
      };
    },
  });

  assert.equal(result.status, "started");
  assert.equal(receivedLogger, logger);
});

test("instrumentation import failures are logged without blocking the server", async () => {
  const { logger, entries } = makeLogger();

  const result = await mqttInstrumentationInternals.registerForRuntime({
    runtime: "nodejs",
    logger,
    async loadNodeInstrumentation() {
      throw new Error("Unable to load Node MQTT instrumentation");
    },
  });

  assert.equal(result.status, "error");
  assert.equal(result.runtime, "nodejs");
  assert.match(result.error.message, /Unable to load Node MQTT instrumentation/);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].level, "error");
  assert.match(entries[0].message, /instrumentation registration failed/);
  assert.deepEqual(
    mqttInstrumentationInternals.safeError(new Error("test")),
    { name: "Error", code: "", message: "test" }
  );
});

test("the production register function skips non-Node runtimes", async () => {
  const previousRuntime = process.env.NEXT_RUNTIME;
  process.env.NEXT_RUNTIME = "edge";

  try {
    const result = await register();
    assert.equal(result.status, "skipped");
    assert.equal(result.runtime, "edge");
  } finally {
    if (previousRuntime === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = previousRuntime;
  }
});
