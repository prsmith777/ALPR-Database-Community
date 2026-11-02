import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import net from "node:net";
import mqtt from "mqtt";
import mqttPacket from "mqtt-packet";
import {
  normalizeAxisEvent,
  InputError,
  readAxisRequest,
  topicMatches,
  validateTopicFilter,
} from "../lib/camera-inputs/axis.mjs";
import {
  hashCredential,
  validateInput,
  verifySourceCredential,
} from "../lib/camera-inputs/config.mjs";
import { createAxisReceiver } from "../lib/camera-inputs/http.mjs";
import {
  CameraInputRuntime,
  buildSubscriberOptions,
} from "../lib/camera-inputs/runtime.mjs";
import { testMqttConnection } from "../lib/camera-inputs/connection-test.mjs";
import { axisDirection } from "../lib/camera-inputs/processor.mjs";
import { startCameraInputsWithRetry } from "../lib/camera-inputs/startup.mjs";
import { createMiddlewareHandler } from "../lib/middleware-auth.mjs";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1kAAAAASUVORK5CYII=";
const input = {
  id: "b41494f6-eec2-454e-9fcb-c2fc39b967f1",
  source: "axis",
  transport: "both",
  enabled: true,
  camera_name: "Test Gate",
  device_id: "AABBCCDDEEFF",
  store_images: true,
  direction_in: "Entering",
  direction_out: "Exiting",
  credential_hash: hashCredential("test-only-source-secret"),
};
function mqttEvent(overrides = {}) {
  return {
    topic: "axis:CameraApplicationPlatform/ALPV.AllPlates",
    timestamp: 1793286884875,
    message: {
      source: {},
      key: {},
      data: {
        text: "ABC123",
        carID: "42",
        carState: "update",
        capture_timestamp: "1793286884875",
        frame_timestamp: "1793286884",
        MACAddress: "AA:BB:CC:DD:EE:FF",
        lpConfidence: "0.000000",
        vehicleConfidence: "47.3",
        carMoveDirection: "in",
        roiID: "0",
        lpImage: png,
        action: "Denied",
        country: "USA",
        region: "Example",
        regionCode: "EX",
        vehicleType: "TRUCK",
        view: "front",
        ...overrides,
      },
    },
  };
}
function httpEvent(overrides = {}) {
  return {
    plateText: "ABC123",
    carID: "42",
    carState: "update",
    capture_timestamp: "1793286884875",
    camera_info: { SerialNumber: input.device_id },
    plateConfidence: "0.000000",
    carMoveDirection: "in",
    roiID: "0",
    imageType: "plate",
    ImageArray: [{ BinaryImage: png }],
    vehicle_info: { view: "front" },
    ...overrides,
  };
}

test("Axis MQTT imports the existing nested payload, cropped image, zero confidence and denied access result", () => {
  const event = normalizeAxisEvent(mqttEvent(), input);
  assert.equal(event.plate, "ABC123");
  assert.equal(event.image, png);
  assert.equal(event.confidence, 0);
  assert.equal(event.timestamp, "2026-10-29T15:14:44.875Z");
  assert.equal(event.metadata.action, "Denied");
  assert.equal(axisDirection(input, event).directionLabel, "Entering");
});
test("HTTP and MQTT normalize the same physical event to the same idempotency identity", () => {
  assert.equal(
    normalizeAxisEvent(httpEvent(), input).fingerprint,
    normalizeAxisEvent(mqttEvent(), input).fingerprint,
  );
  assert.notEqual(
    normalizeAxisEvent(mqttEvent({ text: "ABC128" }), input).fingerprint,
    normalizeAxisEvent(mqttEvent(), input).fingerprint,
  );
});
test("camera identity, plate length, state, confidence, timestamp units and images are validated", () => {
  for (const values of [
    { MACAddress: "112233445566" },
    { text: "A".repeat(11) },
    { text: "../oops" },
    { carState: "test" },
    { carID: "" },
    { capture_timestamp: "1793286884" },
    { capture_timestamp: "bad" },
    { lpConfidence: "NaN" },
    { lpImage: "not image data" },
  ])
    assert.throws(() => normalizeAxisEvent(mqttEvent(values), input));
});
test("disabled image storage discards received image data without requiring a separate image topic", () => {
  const event = normalizeAxisEvent(mqttEvent(), {
    ...input,
    store_images: false,
  });
  assert.equal(event.image, null);
  assert.equal(event.sceneImage, null);
});
test("malformed scalar and image fields are permanent input errors", () => {
  for (const event of [
    null, [], "bad", mqttEvent({ text: { toString: "bad" } }),
    mqttEvent({ capture_timestamp: { toString: "bad" } }),
    mqttEvent({ lpConfidence: {} }), mqttEvent({ lpImage: {} }),
    httpEvent({ ImageArray: [null] }),
    httpEvent({ ImageArray: [{ ImageType: {} }] }),
  ]) assert.throws(() => normalizeAxisEvent(event, input), InputError);
});
test("direction labels remain independent of vehicle view", () => {
  const event = normalizeAxisEvent(
    mqttEvent({ view: "", carMoveDirection: "out" }),
    input,
  );
  assert.equal(axisDirection(input, event).orientation, "unknown");
  assert.equal(axisDirection(input, event).directionLabel, "Exiting");
  assert.equal(axisDirection(input, { ...event, direction: "unknown" }), null);
});
test("configuration defaults are portable, reject invalid topics, and preserve existing camera names", () => {
  assert.equal(
    validateInput({ camera_name: "Existing", source: "blue_iris" }).transport,
    "http",
  );
  assert.throws(
    () => validateInput({ camera_name: "Gate", source: "axis" }),
    /serial|MAC/,
  );
  for (const filter of [
    "",
    "axis/#/plates",
    "axis/a+",
    "axis/a#",
    "$share/group/axis/#",
  ])
    assert.throws(() => validateTopicFilter(filter));
  for (const filter of ["axis/+/event/#", "axis/camera/ALPV.AllPlates"])
    assert.equal(validateTopicFilter(filter), filter);
  assert.equal(topicMatches("axis/+/event/#", "axis/gate/event/a"), true);
  assert.equal(topicMatches("axis/+/event", "axis/gate/event/a"), false);
  assert.equal(topicMatches("#", "$SYS/status"), false);
});
test("scoped receiver accepts Basic, Bearer and x-api-key, while rejecting URL credentials and disabled inputs", () => {
  const url = `http://localhost/api/camera-inputs/axis/${input.id}`;
  for (const headers of [
    { "x-api-key": "test-only-source-secret" },
    { authorization: "Bearer test-only-source-secret" },
    {
      authorization: `Basic ${Buffer.from(`${input.id}:test-only-source-secret`).toString("base64")}`,
    },
  ])
    assert.equal(
      verifySourceCredential(new Request(url, { headers }), input),
      true,
    );
  assert.equal(
    verifySourceCredential(
      new Request(url, { headers: { authorization: "Bearer wrong" } }),
      input,
    ),
    false,
  );
  assert.equal(
    verifySourceCredential(
      new Request(url + "?api_key=test-only-source-secret"),
      input,
    ),
    false,
  );
  assert.equal(
    verifySourceCredential(
      new Request(url, { headers: { "x-api-key": "test-only-source-secret" } }),
      { ...input, enabled: false },
    ),
    false,
  );
});
test("HTTP authentication occurs before body consumption and durable receipt precedes success", async () => {
  let received = 0;
  let bodyRead = false;
  const receiver = createAxisReceiver({
    repository: {
      get: async () => input,
      receive: async () => {
        received++;
        return { duplicate: false };
      },
    },
    logger: {},
  });
  const unauthorized = {
    url: "http://localhost/event",
    headers: new Headers(),
    get body() {
      bodyRead = true;
      throw new Error("Body must stay unread");
    },
  };
  assert.equal((await receiver(unauthorized, input.id)).status, 401);
  assert.equal(bodyRead, false);
  assert.equal(received, 0);
  const request = new Request("http://localhost/event", {
    method: "POST",
    headers: {
      "x-api-key": "test-only-source-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify(httpEvent()),
  });
  assert.equal((await receiver(request, input.id)).status, 200);
  assert.equal(received, 1);
  const broken = createAxisReceiver({
    repository: {
      get: async () => input,
      receive: async () => {
        throw new Error("Database unavailable");
      },
    },
    logger: {},
  });
  assert.equal(
    (
      await broken(
        new Request(request.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(httpEvent()),
        }),
        input.id,
      )
    ).status,
    503,
  );
});
test("HTTP multipart preserves separate plate and scene images and enforces streamed size limits", async () => {
  const form = new FormData();
  form.set(
    "event",
    new Blob(
      [JSON.stringify(httpEvent({ ImageArray: [], imageType: "vehicle" }))],
      { type: "application/json" },
    ),
    "event.json",
  );
  form.set(
    "image",
    new Blob([Buffer.from(png, "base64")], { type: "image/png" }),
    "scene.png",
  );
  form.set(
    "image2",
    new Blob([Buffer.from(png, "base64")], { type: "image/png" }),
    "plate.png",
  );
  const payload = await readAxisRequest(
    new Request("http://localhost/event", { method: "POST", body: form }),
  );
  const event = normalizeAxisEvent(payload, input);
  assert.equal(event.image, png);
  assert.equal(event.sceneImage, png);
  await assert.rejects(
    () =>
      readAxisRequest(
        new Request("http://localhost/event", {
          method: "POST",
          body: "x".repeat(100),
        }),
        20,
      ),
    /too large/,
  );
  await assert.rejects(
    () =>
      readAxisRequest(
        new Request("http://localhost/event", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "{}",
        }),
      ),
    /JSON or multipart/,
  );
});
test("only exact Axis receiver routes bypass browser authentication; administration remains protected", async () => {
  const handler = createMiddlewareHandler({
    next: () => ({ status: 200 }),
    json: (body, init) => ({ body, ...init }),
    redirect: () => ({ status: 302 }),
    fetchImpl: async () => {
      throw new Error("Unexpected request");
    },
  });
  const request = (path) => ({
    nextUrl: { pathname: path },
    url: `http://localhost${path}`,
    headers: new Headers(),
    cookies: { get: () => null },
  });
  assert.equal(
    (await handler(request(`/api/camera-inputs/axis/${input.id}`))).status,
    200,
  );
  for (const path of [
    "/api/camera-inputs",
    `/api/camera-inputs/${input.id}/events`,
    `/api/camera-inputs/axis/${input.id}/extra`,
    "/api/camera-inputs/axis/not-a-uuid",
  ])
    assert.equal((await handler(request(path))).status, 401);
});
test("incoming subscribers use a stable dedicated client ID, persistent sessions and verified TLS", () => {
  const options = buildSubscriberOptions(input);
  assert.equal(options.clientId, `alpr-axis-${input.id}`);
  assert.equal(options.clean, false);
  assert.equal(options.rejectUnauthorized, true);
});

test("a wildcard subscription silently filters other cameras and physical camera identity binds event identity", async () => {
  const runtime = new CameraInputRuntime({
    pool: {},
    mqttConnect() {},
    ingest() {},
    storage: {},
    logger: {},
  });
  let imported = 0;
  runtime.repository = {
    get: async () => input,
    receive: async () => {
      imported++;
    },
  };
  await runtime.handlePacket(
    { ...input, topic_filter: "axis/#" },
    {
      topic: "axis/other/event",
      payload: Buffer.from(
        JSON.stringify(mqttEvent({ MACAddress: "112233445566" })),
      ),
    },
  );
  assert.equal(imported, 0);
  const first = normalizeAxisEvent(mqttEvent(), input);
  const second = normalizeAxisEvent(mqttEvent({ MACAddress: "112233445566" }), {
    ...input,
    device_id: "112233445566",
  });
  assert.notEqual(first.fingerprint, second.fingerprint);
});
test("startup retries are isolated and concurrent initialization is shared", async () => {
  const stateHost = {};
  const timers = [];
  let calls = 0;
  const options = {
    stateHost,
    logger: {},
    schedule: (callback) => {
      timers.push(callback);
      return {};
    },
    startRuntime: async () => {
      calls++;
      if (calls === 1) throw new Error("Database not ready");
    },
  };
  const [a, b] = await Promise.all([
    startCameraInputsWithRetry(options),
    startCameraInputsWithRetry(options),
  ]);
  assert.equal(a.status, "retry-scheduled");
  assert.equal(b.status, "retry-scheduled");
  assert.equal(calls, 1);
  await startCameraInputsWithRetry(options);
  assert.equal(calls, 2);
});
test("MQTT connection test uses an independent session and reports subscription rejection", async () => {
  let options;
  const connect = (_url, value) => {
    options = value;
    const client = new EventEmitter();
    client.end = () => {};
    client.subscribe = (_topic, _options, callback) =>
      callback(null, [{ qos: 128 }]);
    queueMicrotask(() => client.emit("connect"));
    return client;
  };
  const result = await testMqttConnection(
    {
      ...input,
      broker: "localhost",
      port: 1883,
      topic_filter: "axis/#",
      qos: 1,
    },
    connect,
  );
  assert.equal(result.ok, false);
  assert.equal(options.clean, true);
  assert.notEqual(options.clientId, buildSubscriberOptions(input).clientId);
});

test("real MQTT QoS 1 acknowledges poison input and persists valid input before PUBACK", async () => {
  const sockets = new Set();
  let socket;
  const acked = new Set();
  let persist;
  let received;
  const receivedGate = new Promise((resolve) => {
    received = resolve;
  });
  const persistGate = new Promise((resolve) => {
    persist = resolve;
  });
  let testServer;
  const subscribed = new Promise((resolve) => {
    const server = net.createServer((connection) => {
      socket = connection;
      sockets.add(connection);
      const parser = mqttPacket.parser();
      connection.on("data", (chunk) => parser.parse(chunk));
      parser.on("packet", (packet) => {
        if (packet.cmd === "connect")
          connection.write(
            mqttPacket.generate({
              cmd: "connack",
              returnCode: 0,
              sessionPresent: false,
            }),
          );
        if (packet.cmd === "subscribe") {
          connection.write(
            mqttPacket.generate({
              cmd: "suback",
              messageId: packet.messageId,
              granted: [1],
            }),
          );
          resolve();
        }
        if (packet.cmd === "puback") acked.add(packet.messageId);
      });
    });
    server.listen(0, "127.0.0.1");
    testServer = server;
  });
  // A real wire broker exercises MQTT.js's handleMessage/PUBACK ordering.
  await once(testServer, "listening");
  const runtime = new CameraInputRuntime({
    pool: {},
    mqttConnect: mqtt.connect,
    ingest: async () => {},
    storage: {},
    logger: {},
  });
  const configured = {
    ...input,
    broker: "127.0.0.1",
    port: testServer.address().port,
    broker_enabled: true,
    topic_filter: "axis/test/event",
    qos: 1,
  };
  runtime.repository = {
    mqttInputs: async () => [configured],
    get: async () => configured,
    status: async () => {},
    receive: async (_input, event) => {
      normalizeAxisEvent(event, configured);
      received();
      await persistGate;
      return {};
    },
  };
  try {
    await runtime.sync();
    await subscribed;
    for (const [index, event] of [null, mqttEvent({ lpImage: {} })].entries()) {
      const messageId = index + 1;
      socket.write(mqttPacket.generate({cmd: "publish", topic: configured.topic_filter,
        payload: Buffer.from(JSON.stringify(event)), qos: 1, messageId, retain: false, dup: false}));
      const until = Date.now() + 2000;
      while (!acked.has(messageId) && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(acked.has(messageId), "Permanent malformed input must not block the subscription");
    }
    socket.write(
      mqttPacket.generate({
        cmd: "publish",
        topic: configured.topic_filter,
        payload: Buffer.from(JSON.stringify(mqttEvent())),
        qos: 1,
        messageId: 7,
        retain: false,
        dup: false,
      }),
    );
    await receivedGate;
    assert.equal(acked.has(7), false);
    persist();
    const until = Date.now() + 2000;
    while (!acked.has(7) && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(acked.has(7), true);
  } finally {
    persist();
    await runtime.stop();
    for (const connection of sockets) connection.destroy();
    await new Promise((resolve) => testServer.close(resolve));
  }
});

test("a database failure withholds MQTT acknowledgment and redelivery succeeds after reconnect", async () => {
  const sockets = new Set();
  const identities = [];
  let attempts = 0;
  let persisted = 0;
  let connections = 0;
  let acknowledge;
  const acknowledged = new Promise((resolve) => {
    acknowledge = resolve;
  });
  const server = net.createServer((connection) => {
    sockets.add(connection);
    const number = ++connections;
    const parser = mqttPacket.parser();
    connection.on("data", (chunk) => parser.parse(chunk));
    parser.on("packet", (packet) => {
      if (packet.cmd === "connect") {
        identities.push({ id: packet.clientId, clean: packet.clean });
        connection.write(
          mqttPacket.generate({
            cmd: "connack",
            returnCode: 0,
            sessionPresent: number > 1,
          }),
        );
      }
      if (packet.cmd === "subscribe") {
        connection.write(
          mqttPacket.generate({
            cmd: "suback",
            messageId: packet.messageId,
            granted: [1],
          }),
        );
        connection.write(
          mqttPacket.generate({
            cmd: "publish",
            topic: "axis/test/event",
            payload: Buffer.from(JSON.stringify(mqttEvent())),
            qos: 1,
            messageId: 15,
            retain: false,
            dup: number > 1,
          }),
        );
      }
      if (packet.cmd === "puback") acknowledge(number);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const runtime = new CameraInputRuntime({
    pool: {},
    mqttConnect: (url, options) =>
      mqtt.connect(url, { ...options, reconnectPeriod: 20 }),
    ingest: async () => {},
    storage: {},
    logger: {},
  });
  const configured = {
    ...input,
    broker: "127.0.0.1",
    port: server.address().port,
    broker_enabled: true,
    topic_filter: "axis/test/event",
    qos: 1,
  };
  runtime.repository = {
    mqttInputs: async () => [configured],
    get: async () => configured,
    status: async () => {},
    receive: async () => {
      attempts++;
      if (attempts === 1)
        throw Object.assign(new Error("Temporary test database failure"), {
          code: "ECONNREFUSED",
        });
      persisted++;
      return {};
    },
  };
  let timeout;
  try {
    await runtime.sync();
    const connectionNumber = await Promise.race([
      acknowledged,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Reconnect timed out")),
          4000,
        );
      }),
    ]);
    assert.equal(connectionNumber, 2);
    assert.equal(attempts, 2);
    assert.equal(persisted, 1);
    assert.equal(identities[0].id, identities[1].id);
    assert.equal(identities[0].clean, false);
    assert.equal(identities[1].clean, false);
  } finally {
    clearTimeout(timeout);
    await runtime.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
