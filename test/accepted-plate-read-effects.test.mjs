import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  acceptedPlateReadEffectsInternals,
  processAcceptedPlateReadEffects,
} from "../lib/accepted-plate-read-effects.mjs";

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

function makeRead(overrides = {}) {
  return {
    id: 87321,
    plate_number: "DP0M90",
    camera_name: "Entry LPR 1",
    timestamp: "2026-07-17T03:03:37.800Z",
    confidence: 0.94,
    ...overrides,
  };
}

test("accepted-read effects require a durable read identity and callable dependencies", async () => {
  await assert.rejects(
    () =>
      processAcceptedPlateReadEffects({
        read: { id: 0, plate_number: "ABC123" },
        shouldSendPushover() {},
        sendPushover() {},
        processMqtt() {},
      }),
    /positive integer/
  );

  await assert.rejects(
    () =>
      processAcceptedPlateReadEffects({
        read: makeRead(),
        shouldSendPushover: null,
        sendPushover() {},
        processMqtt() {},
      }),
    /match checker must be a function/
  );
});

test("persisted reads run Pushover and MQTT independently with the same read identity", async () => {
  const calls = [];
  const read = makeRead();
  const imageData = "data:image/jpeg;base64,AAAA";

  const result = await processAcceptedPlateReadEffects({
    read,
    imageData,
    async shouldSendPushover(plateNumber) {
      calls.push(["match", plateNumber]);
      return true;
    },
    async sendPushover(plateNumber, message, image) {
      calls.push(["pushover", plateNumber, message, image]);
      return { success: true, request: "pushover-1" };
    },
    async processMqtt(receivedRead) {
      calls.push(["mqtt", receivedRead]);
      return {
        status: "queued",
        readId: receivedRead.id,
        queued: 1,
      };
    },
  });

  assert.equal(result.readId, 87321);
  assert.equal(result.plateNumber, "DP0M90");
  assert.equal(result.pushover.status, "sent");
  assert.equal(result.mqtt.status, "queued");
  assert.equal(result.mqtt.readId, 87321);
  assert.deepEqual(calls.find((call) => call[0] === "pushover"), [
    "pushover",
    "DP0M90",
    null,
    imageData,
  ]);
  assert.equal(calls.find((call) => call[0] === "mqtt")[1], read);
});

test("a nonmatching Pushover rule does not suppress MQTT queueing", async () => {
  let pushoverCalls = 0;
  let mqttCalls = 0;

  const result = await processAcceptedPlateReadEffects({
    read: makeRead(),
    async shouldSendPushover() {
      return false;
    },
    async sendPushover() {
      pushoverCalls += 1;
      return { success: true };
    },
    async processMqtt() {
      mqttCalls += 1;
      return { status: "no-match", queued: 0 };
    },
  });

  assert.equal(result.pushover.status, "not-matched");
  assert.equal(pushoverCalls, 0);
  assert.equal(mqttCalls, 1);
  assert.equal(result.mqtt.status, "no-match");
});

test("Pushover failures are logged and cannot block MQTT", async () => {
  const { logger, entries } = makeLogger();

  const result = await processAcceptedPlateReadEffects({
    read: makeRead(),
    logger,
    async shouldSendPushover() {
      throw new Error("Pushover rule lookup failed");
    },
    async sendPushover() {
      throw new Error("must not run");
    },
    async processMqtt() {
      return { status: "queued", queued: 1 };
    },
  });

  assert.equal(result.pushover.status, "error");
  assert.equal(result.mqtt.status, "queued");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].level, "error");
  assert.match(entries[0].message, /Pushover processing failed/);
});

test("unexpected MQTT failures are returned and cannot block Pushover", async () => {
  const { logger, entries } = makeLogger();

  const result = await processAcceptedPlateReadEffects({
    read: makeRead(),
    logger,
    async shouldSendPushover() {
      return true;
    },
    async sendPushover() {
      return { success: true };
    },
    async processMqtt() {
      throw new Error("MQTT runtime unavailable");
    },
  });

  assert.equal(result.pushover.status, "sent");
  assert.equal(result.mqtt.status, "error");
  assert.equal(result.mqtt.readId, 87321);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].level, "error");
  assert.match(entries[0].message, /MQTT processing failed/);
});

test("the plate route commits each read and MQTT outbox handoff atomically", async () => {
  const [source, migrations] = await Promise.all([
    readFile(new URL("../app/api/plate-reads/route.js", import.meta.url), "utf8"),
    readFile(new URL("../migrations.sql", import.meta.url), "utf8"),
  ]);

  assert.equal(source.includes("checkPlateForMqttNotification"), false);
  assert.equal(source.includes("sendMqttNotificationByPlate"), false);
  assert.equal(source.includes("processAcceptedMqttRead"), false);
  assert.match(source, /new MqttRepository\(\{\s*pool,\s*executor: dbClient/);
  assert.match(source, /await dbClient\.query\("BEGIN"\)/);
  assert.match(source, /await dbClient\.query\("COMMIT"\)/);
  assert.match(source, /await dbClient\.query\("ROLLBACK"\)/);
  assert.match(
    source,
    /const shouldDeleteTransactionImages = transactionOpen;[\s\S]*if \(shouldDeleteTransactionImages\)/
  );
  assert.match(source, /await mqttService\.processAcceptedRead\(acceptedRead\)/);
  assert.match(source, /mqttResult\.status === "error"/);
  assert.match(source, /mqttResult\.status === "partial"/);
  assert.equal(source.includes("processAcceptedPlateReadEffects"), true);
  assert.match(
    source,
    /SELECT \$1, \$2::varchar, \$3,[\s\S]*\$8::varchar,[\s\S]*\$14/
  );
  assert.match(
    source,
    /observed_plate = \$2::varchar AND timestamp = \$7\s+AND camera_name IS NOT DISTINCT FROM \$8::varchar/
  );
  assert.match(
    migrations,
    /CREATE INDEX IF NOT EXISTS idx_plate_reads_event_identity\s+ON public\.plate_reads \(plate_number, timestamp, camera_name\);/
  );
  assert.match(
    migrations,
    /CREATE UNIQUE INDEX IF NOT EXISTS uq_plate_reads_event_identity\s+ON public\.plate_reads \(event_identity\)\s+WHERE event_identity IS NOT NULL;/
  );
  assert.match(source, /event_identity/);
  assert.match(source, /ON CONFLICT DO NOTHING\s+RETURNING id/);

  const ignoreCheck = source.indexOf("await isPlateIgnored");
  const insertRead = source.indexOf("INSERT INTO plate_reads");
  const duplicateBranch = source.indexOf("if (result.rows.length === 0)");
  const trackImage = source.indexOf("transactionImages.push(imagePaths)");
  const begin = source.indexOf('await dbClient.query("BEGIN")');
  const mqttHandoff = source.indexOf(
    "await mqttService.processAcceptedRead(acceptedRead)"
  );
  const commit = source.indexOf('await dbClient.query("COMMIT")');
  const acceptedEffects = source.indexOf("await processAcceptedPlateReadEffects");

  assert.ok(ignoreCheck >= 0);
  assert.ok(begin >= 0);
  assert.ok(trackImage > ignoreCheck);
  assert.ok(trackImage < insertRead);
  assert.ok(insertRead > ignoreCheck);
  assert.ok(duplicateBranch > insertRead);
  assert.match(source, /transactionImages\.indexOf\(imagePaths\)/);
  assert.match(source, /transactionImages\.splice\(trackedImageIndex, 1\)/);
  assert.ok(mqttHandoff > duplicateBranch);
  assert.ok(commit > mqttHandoff);
  assert.ok(acceptedEffects > commit);
  assert.equal(source.includes("timestamp: data.timestamp || null"), true);

  assert.deepEqual(
    acceptedPlateReadEffectsInternals.safeError(new Error("test")),
    { name: "Error", code: "", message: "test" }
  );
});
