import assert from "node:assert/strict";
import test from "node:test";

import { MqttAcceptedReadService } from "../lib/mqtt/accepted-read-service.mjs";

const baseSettings = {
  enabled: true,
  baseTopic: "Blue Iris/ALPR",
  cameraTopicTemplate: "{base_topic}/{camera_key}",
  defaultQos: 1,
  retainMessages: false,
  localTimezone: "America/Denver",
  hourFormat: 12,
};

const knownPlates = [
  {
    plateNumber: "DPOM90",
    name: "Liz's Lexus",
    tags: ["Family", "Resident"],
  },
];

function anyPlateRule(overrides = {}) {
  return {
    id: 10,
    name: "All Plate Reads",
    enabled: true,
    matchType: "any_plate",
    matchValue: "",
    fuzzyEnabled: false,
    fuzzyMaxDistance: 1,
    fuzzyMinLength: 5,
    fuzzyRequireUnique: true,
    fuzzyOcrAware: true,
    brokerId: 3,
    destinationMode: "per_camera",
    fixedTopic: "",
    message: "",
    cameraIds: [],
    ...overrides,
  };
}

function makeRead(overrides = {}) {
  return {
    id: 41,
    plateNumber: "DPOM90",
    cameraName: "Entry LPR 1",
    timestamp: "2026-07-17T03:03:37.800Z",
    confidence: 0.94,
    ...overrides,
  };
}

function cameraForName(cameraName) {
  const cameraKey = cameraName
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return {
    id: cameraName === "Entry LPR 2" ? 8 : 7,
    cameraName,
    cameraKey,
    enabled: true,
    topicOverride: "",
  };
}

function makeRepository({
  settings = baseSettings,
  plates = knownPlates,
  rules = [anyPlateRule()],
  enqueue,
  discover,
  load,
} = {}) {
  const calls = [];
  let nextDeliveryId = 100;

  return {
    calls,
    async discoverCamera(options) {
      calls.push({ type: "discover", options });
      if (discover) return discover(options);
      return cameraForName(options.cameraName);
    },
    async loadRuntimeContext() {
      calls.push({ type: "load" });
      if (load) return load();
      return {
        settings,
        knownPlates: plates,
        rules,
      };
    },
    async enqueueDelivery(envelope) {
      calls.push({ type: "enqueue", envelope });
      if (enqueue) return enqueue(envelope, calls);
      nextDeliveryId += 1;
      return {
        id: nextDeliveryId,
        inserted: true,
        ...envelope,
      };
    },
  };
}

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

test("accepted-read service validates its repository and retry limit", () => {
  assert.throws(
    () => new MqttAcceptedReadService(),
    /must provide discoverCamera/
  );

  const repository = makeRepository();
  assert.throws(
    () => new MqttAcceptedReadService({ repository, maxAttempts: 21 }),
    /maximum attempts/
  );
});

test("disabled MQTT still discovers the camera but never queues delivery", async () => {
  const repository = makeRepository({
    settings: { ...baseSettings, enabled: false },
  });
  const service = new MqttAcceptedReadService({
    repository,
    now: () => new Date("2026-07-17T03:03:38.000Z"),
  });

  const result = await service.processAcceptedRead(makeRead());

  assert.equal(result.status, "disabled");
  assert.equal(result.camera.cameraKey, "entry-lpr-1");
  assert.equal(result.queued, 0);
  assert.deepEqual(
    repository.calls.map((call) => call.type),
    ["discover", "load"]
  );
});

test("enabled MQTT with no matching rules returns a harmless no-match result", async () => {
  const repository = makeRepository({
    rules: [
      anyPlateRule({
        matchType: "exact_plate",
        matchValue: "ABC123",
      }),
    ],
  });
  const service = new MqttAcceptedReadService({ repository });

  const result = await service.processAcceptedRead(makeRead());

  assert.equal(result.status, "no-match");
  assert.equal(result.planned, 0);
  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].matched, false);
  assert.equal(
    repository.calls.some((call) => call.type === "enqueue"),
    false
  );
});

test("an accepted persisted read builds the stable payload and queues one delivery", async () => {
  const repository = makeRepository();
  const service = new MqttAcceptedReadService({
    repository,
    now: () => new Date("2026-07-17T03:03:38.000Z"),
  });

  const result = await service.processAcceptedRead(makeRead());
  const enqueueCall = repository.calls.find((call) => call.type === "enqueue");

  assert.equal(result.status, "queued");
  assert.equal(result.readId, 41);
  assert.equal(result.eventId, "read-41");
  assert.equal(result.planned, 1);
  assert.equal(result.queued, 1);
  assert.equal(result.duplicates, 0);
  assert.equal(enqueueCall.envelope.readId, 41);
  assert.equal(enqueueCall.envelope.cameraId, 7);
  assert.equal(enqueueCall.envelope.cameraKey, "entry-lpr-1");
  assert.equal(enqueueCall.envelope.topic, "Blue Iris/ALPR/entry-lpr-1");
  assert.equal(enqueueCall.envelope.qos, 1);
  assert.equal(enqueueCall.envelope.retain, false);
  assert.equal(enqueueCall.envelope.payload.event_id, "read-41");
  assert.equal(enqueueCall.envelope.payload.read_id, 41);
  assert.equal(enqueueCall.envelope.payload.plate_number, "DPOM90");
  assert.equal(enqueueCall.envelope.payload.matched_plate_number, "DPOM90");
  assert.equal(enqueueCall.envelope.payload.plate_name, "Liz's Lexus");
  assert.equal(enqueueCall.envelope.payload.tags, "Family, Resident");
  assert.equal(enqueueCall.envelope.payload.camera_key, "entry-lpr-1");
  assert.equal(enqueueCall.envelope.payload.timestamp_source, "blue_iris");
});

test("an exact ingestion resubmission is reported as a duplicate instead of a new queue row", async () => {
  const repository = makeRepository({
    enqueue: async (envelope) => ({
      id: 101,
      inserted: false,
      ...envelope,
    }),
  });
  const service = new MqttAcceptedReadService({ repository });

  const result = await service.processAcceptedRead(makeRead());

  assert.equal(result.status, "queued");
  assert.equal(result.queued, 0);
  assert.equal(result.duplicates, 1);
  assert.equal(result.deliveries[0].id, 101);
});

test("one enqueue failure does not block another broker or topic", async () => {
  const { logger, entries } = makeLogger();
  const rules = [
    anyPlateRule({
      id: 10,
      brokerId: 3,
      destinationMode: "fixed_topic",
      fixedTopic: "Blue Iris/ALPR/accepted",
    }),
    anyPlateRule({
      id: 11,
      name: "Audit Copy",
      brokerId: 4,
      destinationMode: "fixed_topic",
      fixedTopic: "Blue Iris/ALPR/audit",
    }),
  ];
  const repository = makeRepository({
    rules,
    enqueue: async (envelope) => {
      if (envelope.brokerId === 4) {
        const error = new Error("Temporary database write failure");
        error.code = "40001";
        throw error;
      }
      return { id: 101, inserted: true, ...envelope };
    },
  });
  const service = new MqttAcceptedReadService({ repository, logger });

  const result = await service.processAcceptedRead(makeRead());

  assert.equal(result.status, "partial");
  assert.equal(result.planned, 2);
  assert.equal(result.queued, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].brokerId, 4);
  assert.equal(result.failed[0].topic, "Blue Iris/ALPR/audit");
  assert.equal(entries[0].level, "warn");
  assert.doesNotMatch(JSON.stringify(entries), /password/i);
});

test("repository failures are returned and logged without escaping to plate ingestion", async () => {
  const { logger, entries } = makeLogger();
  const repository = makeRepository({
    load: async () => {
      throw new Error("MQTT settings table unavailable");
    },
  });
  const service = new MqttAcceptedReadService({ repository, logger });

  const result = await service.processAcceptedRead(makeRead());

  assert.equal(result.status, "error");
  assert.equal(result.readId, 41);
  assert.equal(result.queued, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error.message, /settings table unavailable/);
  assert.equal(entries[0].level, "error");
  assert.match(JSON.stringify(entries), /settings table unavailable/);
});

test("same-second observations from different cameras retain independent read event IDs", async () => {
  const envelopes = [];
  const repository = makeRepository({
    enqueue: async (envelope) => {
      envelopes.push(envelope);
      return {
        id: 100 + envelopes.length,
        inserted: true,
        ...envelope,
      };
    },
  });
  const service = new MqttAcceptedReadService({ repository });

  const first = await service.processAcceptedRead(
    makeRead({
      id: 41,
      cameraName: "Entry LPR 1",
      timestamp: "2026-07-17T03:03:37.100Z",
    })
  );
  const second = await service.processAcceptedRead(
    makeRead({
      id: 42,
      cameraName: "Entry LPR 2",
      timestamp: "2026-07-17T03:03:37.800Z",
    })
  );

  assert.equal(first.status, "queued");
  assert.equal(second.status, "queued");
  assert.deepEqual(
    envelopes.map((envelope) => envelope.eventId),
    ["read-41", "read-42"]
  );
  assert.deepEqual(
    envelopes.map((envelope) => envelope.cameraKey),
    ["entry-lpr-1", "entry-lpr-2"]
  );
  assert.notEqual(
    envelopes[0].payload.timestamp_epoch,
    envelopes[1].payload.timestamp_epoch
  );
});
