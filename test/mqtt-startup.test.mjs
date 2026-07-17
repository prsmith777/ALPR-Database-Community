import assert from "node:assert/strict";
import test from "node:test";

import {
  mqttInstrumentationInternals,
  register,
} from "../instrumentation.js";
import { registerMqttNodeInstrumentation } from "../instrumentation.node.js";
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
        async registerMqttNodeInstrumentation(options) {
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
