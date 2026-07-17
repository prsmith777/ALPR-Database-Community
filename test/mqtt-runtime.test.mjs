import assert from "node:assert/strict";
import test from "node:test";

import {
  createMqttRuntime,
  getMqttRuntime,
  mqttRuntimeInternals,
  processAcceptedMqttRead,
  startMqttRuntime,
  stopMqttRuntime,
} from "../lib/mqtt/runtime.mjs";

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

function makeRuntime({ acceptedResult } = {}) {
  let startCalls = 0;
  let stopCalls = 0;
  const processedReads = [];
  const loopPromise = new Promise(() => {});

  const worker = {
    running: false,
    stopped: false,
    start() {
      startCalls += 1;
      this.running = true;
      return loopPromise;
    },
    async stop() {
      stopCalls += 1;
      this.running = false;
      this.stopped = true;
    },
  };

  return {
    worker,
    acceptedReadService: {
      async processAcceptedRead(read) {
        processedReads.push(read);
        return (
          acceptedResult ?? {
            status: "queued",
            readId: read.id,
            queued: 1,
          }
        );
      },
    },
    get startCalls() {
      return startCalls;
    },
    get stopCalls() {
      return stopCalls;
    },
    processedReads,
  };
}

test("runtime factory wires the repository, accepted-read service, client manager, and worker", () => {
  const poolClient = {
    async query() {
      return { rows: [] };
    },
    release() {},
  };

  const pool = {
    async query() {
      return { rows: [] };
    },
    async connect() {
      return poolClient;
    },
  };

  const runtime = createMqttRuntime({
    pool,
    mqttConnect() {
      throw new Error("connect should not run during construction");
    },
    logger: {},
  });

  assert.ok(runtime.repository);
  assert.ok(runtime.acceptedReadService);
  assert.ok(runtime.clientManager);
  assert.ok(runtime.worker);
  assert.equal(runtime.worker.repository, runtime.repository);
  assert.equal(runtime.worker.clientManager, runtime.clientManager);
});

test("concurrent runtime requests share one initialization", async () => {
  const stateHost = {};
  const runtime = makeRuntime();
  let dependencyLoads = 0;
  let factoryCalls = 0;

  const options = {
    stateHost,
    async loadDependencies() {
      dependencyLoads += 1;
      await Promise.resolve();
      return { pool: {}, mqttConnect() {} };
    },
    runtimeFactory(dependencies) {
      factoryCalls += 1;
      assert.ok(dependencies.pool);
      assert.equal(typeof dependencies.mqttConnect, "function");
      return runtime;
    },
  };

  const [first, second, third] = await Promise.all([
    getMqttRuntime(options),
    getMqttRuntime(options),
    getMqttRuntime(options),
  ]);

  assert.equal(first, runtime);
  assert.equal(second, runtime);
  assert.equal(third, runtime);
  assert.equal(dependencyLoads, 1);
  assert.equal(factoryCalls, 1);
});

test("runtime initialization failures reset so a later request can retry", async () => {
  const stateHost = {};
  const runtime = makeRuntime();
  let attempts = 0;

  const options = {
    stateHost,
    async loadDependencies() {
      attempts += 1;
      if (attempts === 1) throw new Error("Temporary database outage");
      return {};
    },
    runtimeFactory() {
      return runtime;
    },
  };

  await assert.rejects(getMqttRuntime(options), /Temporary database outage/);
  assert.equal(
    mqttRuntimeInternals.getRuntimeState(stateHost).runtimePromise,
    null
  );

  const recovered = await getMqttRuntime(options);
  assert.equal(recovered, runtime);
  assert.equal(attempts, 2);
});

test("starting the runtime is idempotent within one Node process", async () => {
  const stateHost = {};
  const runtime = makeRuntime();
  const options = {
    stateHost,
    async loadDependencies() {
      return {};
    },
    runtimeFactory() {
      return runtime;
    },
  };

  const [first, second] = await Promise.all([
    startMqttRuntime(options),
    startMqttRuntime(options),
  ]);

  assert.equal(first, runtime);
  assert.equal(second, runtime);
  assert.equal(runtime.startCalls, 1);
  assert.equal(runtime.worker.running, true);
});

test("accepted reads start the worker and delegate to the best-effort service", async () => {
  const stateHost = {};
  const runtime = makeRuntime();
  const read = {
    id: 41,
    plateNumber: "DPOM90",
    cameraName: "Entry LPR 1",
  };

  const result = await processAcceptedMqttRead(read, {
    stateHost,
    async loadDependencies() {
      return {};
    },
    runtimeFactory() {
      return runtime;
    },
  });

  assert.equal(result.status, "queued");
  assert.equal(result.readId, 41);
  assert.equal(runtime.startCalls, 1);
  assert.deepEqual(runtime.processedReads, [read]);
});

test("runtime startup errors are returned without escaping to plate ingestion", async () => {
  const stateHost = {};
  const { logger, entries } = makeLogger();

  const result = await processAcceptedMqttRead(
    {
      id: 99,
      cameraName: "Road Entrance LPR",
    },
    {
      stateHost,
      logger,
      async loadDependencies() {
        const error = new Error("MQTT tables are temporarily unavailable");
        error.code = "42P01";
        throw error;
      },
    }
  );

  assert.equal(result.status, "error");
  assert.equal(result.readId, 99);
  assert.equal(result.queued, 0);
  assert.equal(result.failed[0].error.code, "42P01");
  assert.match(JSON.stringify(entries), /temporarily unavailable/);
});

test("stopping the runtime closes the worker and clears the process singleton", async () => {
  const stateHost = {};
  const runtime = makeRuntime();
  const options = {
    stateHost,
    async loadDependencies() {
      return {};
    },
    runtimeFactory() {
      return runtime;
    },
  };

  await startMqttRuntime(options);
  await stopMqttRuntime({ stateHost });

  const state = mqttRuntimeInternals.getRuntimeState(stateHost);
  assert.equal(runtime.stopCalls, 1);
  assert.equal(state.runtimePromise, null);
  assert.equal(state.loopPromise, null);
});
