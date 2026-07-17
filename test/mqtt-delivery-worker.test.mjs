import assert from "node:assert/strict";
import test from "node:test";

import { MqttDeliveryWorker } from "../lib/mqtt/delivery-worker.mjs";

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

function makeDelivery(overrides = {}) {
  return {
    id: 41,
    eventId: "read-41-entry-lpr-1",
    cameraKey: "entry-lpr-1",
    cameraName: "Entry LPR 1",
    brokerId: 3,
    topic: "Blue Iris/ALPR/entry-lpr-1",
    payload: {
      event_id: "read-41-entry-lpr-1",
      plate_number: "DP0M90",
      matched_plate_number: "DPOM90",
      camera_key: "entry-lpr-1",
    },
    qos: 1,
    retain: false,
    status: "processing",
    attemptCount: 0,
    maxAttempts: 5,
    broker: {
      id: 3,
      name: "Home MQTT",
      broker: "192.168.0.10",
      port: 1883,
      username: "mqtt-user",
      password: "super-secret-password",
      useTls: false,
      enabled: true,
    },
    ...overrides,
  };
}

function makeRepository(overrides = {}) {
  return {
    async releaseExpiredLeases() {
      return [];
    },
    async claimDueDeliveries() {
      return [];
    },
    async recordDeliverySuccess({ deliveryId }) {
      return {
        ...makeDelivery({ id: deliveryId }),
        status: "succeeded",
        attemptCount: 1,
        publishedAt: "2030-01-01T00:00:01.000Z",
      };
    },
    async recordDeliveryFailure({ deliveryId }) {
      return {
        ...makeDelivery({ id: deliveryId }),
        status: "retry",
        attemptCount: 1,
        nextAttemptAt: "2030-01-01T00:00:02.000Z",
      };
    },
    ...overrides,
  };
}

function makeClientManager(overrides = {}) {
  return {
    async publish({ topic, qos, retain, payload }) {
      return {
        topic,
        qos,
        retain,
        bytes: Buffer.byteLength(JSON.stringify(payload)),
      };
    },
    async shutdown() {},
    ...overrides,
  };
}

async function waitFor(predicate, { timeoutMs = 1000 } = {}) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for worker test condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("worker validates repository, client manager, and numeric configuration", () => {
  assert.throws(
    () => new MqttDeliveryWorker(),
    /MQTT repository must provide releaseExpiredLeases/
  );

  const repository = makeRepository();
  assert.throws(
    () => new MqttDeliveryWorker({ repository, clientManager: {} }),
    /MQTT client manager must provide publish/
  );

  assert.throws(
    () =>
      new MqttDeliveryWorker({
        repository,
        clientManager: makeClientManager(),
        batchSize: 0,
      }),
    /batch size/
  );
});

test("one worker batch releases stale leases, publishes, and records success", async () => {
  const calls = [];
  const delivery = makeDelivery();
  const repository = makeRepository({
    async releaseExpiredLeases(options) {
      calls.push({ type: "release", options });
      return [11, 12];
    },
    async claimDueDeliveries(options) {
      calls.push({ type: "claim", options });
      return [delivery];
    },
    async recordDeliverySuccess(options) {
      calls.push({ type: "success", options });
      return {
        ...delivery,
        status: "succeeded",
        attemptCount: 1,
        publishedAt: "2030-01-01T00:00:01.000Z",
      };
    },
  });
  const clientManager = makeClientManager({
    async publish(options) {
      calls.push({ type: "publish", options });
      return { topic: options.topic, qos: 1, retain: false, bytes: 240 };
    },
  });
  const now = new Date("2030-01-01T00:00:00.000Z");
  const worker = new MqttDeliveryWorker({
    repository,
    clientManager,
    workerId: "worker-success",
    now: () => now,
  });

  const summary = await worker.runOnce();

  assert.deepEqual(calls.map((call) => call.type), [
    "release",
    "claim",
    "publish",
    "success",
  ]);
  assert.equal(calls[2].options.broker.password, "super-secret-password");
  assert.equal(calls[2].options.topic, delivery.topic);
  assert.deepEqual(calls[2].options.payload, delivery.payload);
  assert.equal(summary.releasedLeases, 2);
  assert.equal(summary.claimed, 1);
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.retry, 0);
  assert.equal(summary.dead, 0);
  assert.equal(summary.unrecorded, 0);
});

test("transient publish failures are delegated to repository retry planning without credential logs", async () => {
  const { logger, entries } = makeLogger();
  const delivery = makeDelivery();
  let capturedFailure;
  const repository = makeRepository({
    async claimDueDeliveries() {
      return [delivery];
    },
    async recordDeliveryFailure(options) {
      capturedFailure = options;
      return {
        ...delivery,
        status: "retry",
        attemptCount: 1,
        nextAttemptAt: "2030-01-01T00:00:02.000Z",
      };
    },
  });
  const refused = new Error("Temporary connection refused");
  refused.code = "ECONNREFUSED";
  const worker = new MqttDeliveryWorker({
    repository,
    clientManager: makeClientManager({
      async publish() {
        throw refused;
      },
    }),
    workerId: "worker-retry",
    logger,
    now: () => new Date("2030-01-01T00:00:01.000Z"),
  });

  const summary = await worker.runOnce();

  assert.equal(capturedFailure.deliveryId, delivery.id);
  assert.equal(capturedFailure.workerId, "worker-retry");
  assert.equal(capturedFailure.error, refused);
  assert.equal(summary.retry, 1);
  assert.equal(summary.unrecorded, 0);
  assert.doesNotMatch(JSON.stringify(entries), /super-secret-password/);
  assert.match(JSON.stringify(entries), /ECONNREFUSED/);
});


test("different camera deliveries publish without waiting for one another", async () => {
  const first = makeDelivery({
    id: 41,
    cameraKey: "entry-lpr-1",
    cameraName: "Entry LPR 1",
    topic: "Blue Iris/ALPR/entry-lpr-1",
  });
  const second = makeDelivery({
    id: 42,
    eventId: "read-42-entry-lpr-2",
    cameraKey: "entry-lpr-2",
    cameraName: "Entry LPR 2",
    topic: "Blue Iris/ALPR/entry-lpr-2",
  });

  let releaseFirstPublish;
  const firstPublishGate = new Promise((resolve) => {
    releaseFirstPublish = resolve;
  });

  let reportSecondPublish;
  const secondPublishStarted = new Promise((resolve) => {
    reportSecondPublish = resolve;
  });

  const completedDeliveryIds = [];
  const startedTopics = [];

  const repository = makeRepository({
    async claimDueDeliveries() {
      return [first, second];
    },
    async recordDeliverySuccess({ deliveryId }) {
      completedDeliveryIds.push(deliveryId);
      const source = deliveryId === first.id ? first : second;

      return {
        ...source,
        status: "succeeded",
        attemptCount: 1,
      };
    },
  });

  const clientManager = makeClientManager({
    async publish(options) {
      startedTopics.push(options.topic);

      if (options.topic === first.topic) {
        await firstPublishGate;
      } else {
        reportSecondPublish();
      }

      return {
        topic: options.topic,
        qos: options.qos,
        retain: options.retain,
        bytes: 100,
      };
    },
  });

  const worker = new MqttDeliveryWorker({
    repository,
    clientManager,
    workerId: "worker-independent-cameras",
  });

  const batchPromise = worker.runOnce();

  await secondPublishStarted;
  await waitFor(() => completedDeliveryIds.includes(second.id));

  assert.deepEqual(startedTopics, [first.topic, second.topic]);
  assert.equal(completedDeliveryIds.includes(second.id), true);
  assert.equal(completedDeliveryIds.includes(first.id), false);

  releaseFirstPublish();

  const summary = await batchPromise;

  assert.equal(summary.claimed, 2);
  assert.equal(summary.succeeded, 2);
  assert.equal(summary.retry, 0);
  assert.equal(summary.dead, 0);
  assert.equal(summary.unrecorded, 0);
  assert.deepEqual(
    summary.results.map((result) => result.deliveryId),
    [first.id, second.id]
  );
});

test("a dead delivery does not block a later successful delivery in the same batch", async () => {
  const deadDelivery = makeDelivery({ id: 41 });
  const goodDelivery = makeDelivery({
    id: 42,
    eventId: "read-42-entry-lpr-2",
    cameraKey: "entry-lpr-2",
    cameraName: "Entry LPR 2",
    topic: "Blue Iris/ALPR/entry-lpr-2",
  });
  const repository = makeRepository({
    async claimDueDeliveries() {
      return [deadDelivery, goodDelivery];
    },
    async recordDeliveryFailure({ deliveryId }) {
      return {
        ...deadDelivery,
        id: deliveryId,
        status: "dead",
        attemptCount: 1,
      };
    },
    async recordDeliverySuccess({ deliveryId }) {
      return {
        ...goodDelivery,
        id: deliveryId,
        status: "succeeded",
        attemptCount: 1,
      };
    },
  });
  const clientManager = makeClientManager({
    async publish({ topic }) {
      if (topic === deadDelivery.topic) {
        const error = new Error("Not authorized");
        error.code = "CONNACK_REFUSED_NOT_AUTHORIZED";
        throw error;
      }
      return { topic, qos: 1, retain: false, bytes: 100 };
    },
  });
  const worker = new MqttDeliveryWorker({
    repository,
    clientManager,
    workerId: "worker-mixed",
  });

  const summary = await worker.runOnce();

  assert.equal(summary.claimed, 2);
  assert.equal(summary.dead, 1);
  assert.equal(summary.succeeded, 1);
  assert.deepEqual(
    summary.results.map((result) => result.status),
    ["dead", "succeeded"]
  );
});

test("a publish that cannot be marked successful is not incorrectly recorded as a publish failure", async () => {
  let failureRecordCalls = 0;
  const repository = makeRepository({
    async claimDueDeliveries() {
      return [makeDelivery()];
    },
    async recordDeliverySuccess() {
      throw new Error("Worker lease was lost after publish");
    },
    async recordDeliveryFailure() {
      failureRecordCalls += 1;
      throw new Error("recordDeliveryFailure must not be called");
    },
  });
  const worker = new MqttDeliveryWorker({
    repository,
    clientManager: makeClientManager(),
    workerId: "worker-published-unrecorded",
  });

  const summary = await worker.runOnce();

  assert.equal(failureRecordCalls, 0);
  assert.equal(summary.succeeded, 0);
  assert.equal(summary.unrecorded, 1);
  assert.equal(summary.results[0].status, "published-unrecorded");
  assert.equal(summary.results[0].published, true);
});

test("an unrecorded publish failure does not stop later deliveries", async () => {
  const first = makeDelivery({ id: 41 });
  const second = makeDelivery({
    id: 42,
    cameraKey: "entry-lpr-2",
    cameraName: "Entry LPR 2",
    topic: "Blue Iris/ALPR/entry-lpr-2",
  });
  const repository = makeRepository({
    async claimDueDeliveries() {
      return [first, second];
    },
    async recordDeliveryFailure() {
      throw new Error("Worker lease was lost");
    },
    async recordDeliverySuccess({ deliveryId }) {
      return {
        ...second,
        id: deliveryId,
        status: "succeeded",
        attemptCount: 1,
      };
    },
  });
  const clientManager = makeClientManager({
    async publish({ topic }) {
      if (topic === first.topic) throw new Error("Temporary outage");
      return { topic, qos: 1, retain: false, bytes: 100 };
    },
  });
  const worker = new MqttDeliveryWorker({
    repository,
    clientManager,
    workerId: "worker-unrecorded-failure",
  });

  const summary = await worker.runOnce();

  assert.equal(summary.unrecorded, 1);
  assert.equal(summary.succeeded, 1);
  assert.deepEqual(
    summary.results.map((result) => result.status),
    ["failure-unrecorded", "succeeded"]
  );
});

test("overlapping runOnce calls share one lease-release and claim operation", async () => {
  const { logger, entries } = makeLogger();
  let releaseCalls = 0;
  let claimCalls = 0;
  let resolveClaim;
  const claimPromise = new Promise((resolve) => {
    resolveClaim = resolve;
  });
  const repository = makeRepository({
    async releaseExpiredLeases() {
      releaseCalls += 1;
      return [];
    },
    async claimDueDeliveries() {
      claimCalls += 1;
      return claimPromise;
    },
  });
  const worker = new MqttDeliveryWorker({
    repository,
    clientManager: makeClientManager(),
    workerId: "worker-overlap",
    logger,
  });

  const firstRun = worker.runOnce();
  const secondRun = worker.runOnce();

  assert.equal(firstRun, secondRun);
  await waitFor(() => claimCalls === 1);
  resolveClaim([]);

  const [firstSummary, secondSummary] = await Promise.all([firstRun, secondRun]);
  assert.equal(firstSummary, secondSummary);
  assert.equal(releaseCalls, 1);
  assert.equal(claimCalls, 1);
  assert.equal(
    entries.some((entry) => entry.message === "MQTT delivery worker batch complete"),
    false
  );
});

test("polling continues after a batch error and stop aborts the wait and closes connections", async () => {
  const { logger, entries } = makeLogger();
  let releaseCalls = 0;
  let claimCalls = 0;
  let sleepCalls = 0;
  let shutdownCalls = 0;
  let secondSleepSignal;

  const repository = makeRepository({
    async releaseExpiredLeases() {
      releaseCalls += 1;
      if (releaseCalls === 1) throw new Error("Temporary database outage");
      return [];
    },
    async claimDueDeliveries() {
      claimCalls += 1;
      return [];
    },
  });
  const clientManager = makeClientManager({
    async shutdown() {
      shutdownCalls += 1;
    },
  });
  const sleep = async (_milliseconds, signal) => {
    sleepCalls += 1;
    if (sleepCalls === 1) return;
    secondSleepSignal = signal;
    await new Promise((resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        },
        { once: true }
      );
    });
  };
  const worker = new MqttDeliveryWorker({
    repository,
    clientManager,
    workerId: "worker-loop",
    pollIntervalMs: 10,
    logger,
    sleep,
  });

  const loopPromise = worker.start();
  await waitFor(() => releaseCalls >= 2 && secondSleepSignal);
  await worker.stop();
  await loopPromise;

  assert.equal(releaseCalls, 2);
  assert.equal(claimCalls, 1);
  assert.equal(secondSleepSignal.aborted, true);
  assert.equal(shutdownCalls, 1);
  assert.match(JSON.stringify(entries), /Temporary database outage/);
  assert.equal(worker.running, false);
});

test("stop is idempotent and permanently rejects new work", async () => {
  let shutdownCalls = 0;
  const worker = new MqttDeliveryWorker({
    repository: makeRepository(),
    clientManager: makeClientManager({
      async shutdown({ force }) {
        shutdownCalls += 1;
        assert.equal(force, true);
      },
    }),
    workerId: "worker-stop",
  });

  await worker.stop({ forceConnections: true });
  await worker.stop({ forceConnections: true });

  assert.equal(shutdownCalls, 1);
  await assert.rejects(worker.runOnce(), /has been stopped/);
  await assert.rejects(worker.start(), /has been stopped/);
});
