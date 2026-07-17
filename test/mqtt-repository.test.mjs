import assert from "node:assert/strict";
import test from "node:test";

import { MqttRepository } from "../lib/mqtt/repository.mjs";

function makeClient(handler) {
  const calls = [];
  let released = false;

  return {
    calls,
    get released() {
      return released;
    },
    async query(text, params = []) {
      const sql = String(text).trim();
      calls.push({ sql, params });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [] };
      }
      return handler(sql, params, calls);
    },
    release() {
      released = true;
    },
  };
}

function makePool({ query, client }) {
  return {
    queryCalls: [],
    async query(text, params = []) {
      const sql = String(text).trim();
      this.queryCalls.push({ sql, params });
      return query(sql, params, this.queryCalls);
    },
    async connect() {
      return client;
    },
  };
}

const deliveryRow = {
  id: "41",
  dedupe_key: `mqtt-v2:${"a".repeat(64)}`,
  event_id: "read-41-entry-lpr-1",
  read_id: 41,
  camera_id: 7,
  camera_key: "entry-lpr-1",
  camera_name: "Entry LPR 1",
  broker_id: 3,
  topic: "Blue Iris/ALPR/entry-lpr-1",
  payload: { plate_number: "ABC123" },
  qos: 1,
  retain: false,
  status: "pending",
  attempt_count: 0,
  max_attempts: 5,
  next_attempt_at: "2026-07-17T03:03:37.000Z",
  locked_at: null,
  locked_by: null,
  last_error: null,
  published_at: null,
  created_at: "2026-07-17T03:03:37.000Z",
  updated_at: "2026-07-17T03:03:37.000Z",
};

test("repository requires a PostgreSQL-compatible pool", () => {
  assert.throws(() => new MqttRepository(), /PostgreSQL-compatible pool/);
  assert.throws(
    () => new MqttRepository({ pool: { query() {} } }),
    /PostgreSQL-compatible pool/
  );
});

test("runtime context maps settings, known plates, rules, cameras, and broker fields", async () => {
  const client = makeClient(() => ({ rows: [] }));
  const pool = makePool({
    client,
    query(sql) {
      if (sql.includes("FROM public.mqtt_settings")) {
        return {
          rows: [
            {
              id: 1,
              enabled: true,
              base_topic: "Blue Iris/ALPR",
              camera_topic_template: "{base_topic}/{camera_key}",
              default_qos: 1,
              retain_messages: false,
              payload_profile: "generic_json",
              local_timezone: "America/Denver",
              hour_format: 12,
              created_at: "created",
              updated_at: "updated",
            },
          ],
        };
      }
      if (sql.includes("FROM public.known_plates")) {
        return {
          rows: [
            {
              plate_number: "DPOM90",
              name: "Liz's Lexus",
              notes: null,
              ignore: false,
              tags: ["Family", "Resident"],
              flagged: false,
            },
          ],
        };
      }
      if (sql.includes("FROM public.mqtt_rules")) {
        return {
          rows: [
            {
              id: 9,
              name: "Family Vehicles",
              enabled: true,
              match_type: "tag",
              match_value: "Family",
              fuzzy_enabled: true,
              fuzzy_max_distance: 1,
              fuzzy_min_length: 5,
              fuzzy_require_unique: true,
              fuzzy_ocr_aware: true,
              broker_id: 3,
              destination_mode: "per_camera",
              fixed_topic: null,
              message: null,
              camera_ids: [7, 8],
              broker_name: "Home MQTT",
              broker_host: "192.168.0.10",
              broker_port: 1883,
              broker_username: "mqtt-user",
              broker_password: "mqtt-password",
              broker_use_tls: false,
              broker_client_id: "alpr",
              broker_enabled: true,
            },
          ],
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  });

  const repository = new MqttRepository({ pool });
  const context = await repository.loadRuntimeContext();

  assert.equal(context.settings.localTimezone, "America/Denver");
  assert.deepEqual(context.knownPlates[0].tags, ["Family", "Resident"]);
  assert.deepEqual(context.rules[0].cameraIds, [7, 8]);
  assert.equal(context.rules[0].broker.broker, "192.168.0.10");
  assert.equal(context.rules[0].broker.password, "mqtt-password");
});

test("camera discovery updates the existing case-insensitive camera identity", async () => {
  const seenAt = new Date("2026-07-17T03:03:37.800Z");
  const client = makeClient((sql, params) => {
    if (sql.startsWith("SELECT * FROM public.mqtt_cameras")) {
      return {
        rows: [
          {
            id: 7,
            camera_name: "Entry LPR 1",
            camera_key: "entry-lpr-1",
            enabled: true,
            topic_override: null,
          },
        ],
      };
    }
    if (sql.startsWith("UPDATE public.mqtt_cameras")) {
      assert.equal(params[0], 7);
      assert.equal(params[1].getTime(), seenAt.getTime());
      return {
        rows: [
          {
            id: 7,
            camera_name: "Entry LPR 1",
            camera_key: "entry-lpr-1",
            enabled: true,
            topic_override: null,
            last_seen_at: seenAt,
          },
        ],
      };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const pool = makePool({ query: () => ({ rows: [] }), client });
  const repository = new MqttRepository({ pool });

  const camera = await repository.discoverCamera({
    cameraName: "entry lpr 1",
    seenAt,
  });

  assert.equal(camera.id, 7);
  assert.equal(camera.cameraKey, "entry-lpr-1");
  assert.equal(client.released, true);
  assert.equal(client.calls.at(-1).sql, "COMMIT");
});

test("camera discovery resolves stable-key collisions without changing display names", async () => {
  const seenAt = new Date("2026-07-17T03:03:37.800Z");
  let selectCount = 0;
  let insertCount = 0;
  const client = makeClient((sql, params) => {
    if (sql.startsWith("SELECT * FROM public.mqtt_cameras")) {
      selectCount += 1;
      return { rows: [] };
    }
    if (sql.startsWith("INSERT INTO public.mqtt_cameras")) {
      insertCount += 1;
      if (insertCount === 1) {
        assert.equal(params[1], "entry-lpr-1");
        return { rows: [] };
      }
      assert.equal(params[1], "entry-lpr-1-2");
      return {
        rows: [
          {
            id: 8,
            camera_name: "Entry LPR 1",
            camera_key: "entry-lpr-1-2",
            enabled: true,
            first_seen_at: seenAt,
            last_seen_at: seenAt,
          },
        ],
      };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const pool = makePool({ query: () => ({ rows: [] }), client });
  const repository = new MqttRepository({ pool });

  const camera = await repository.discoverCamera({
    cameraName: "Entry LPR 1",
    seenAt,
  });

  assert.equal(selectCount, 2);
  assert.equal(insertCount, 2);
  assert.equal(camera.cameraKey, "entry-lpr-1-2");
});

test("delivery enqueue is parameterized and returns the pre-existing row on exact resubmission", async () => {
  let capturedParams;
  const client = makeClient(() => ({ rows: [] }));
  const pool = makePool({
    client,
    query(sql, params) {
      assert.match(sql, /ON CONFLICT \(dedupe_key\) DO NOTHING/);
      capturedParams = params;
      return { rows: [{ ...deliveryRow, inserted: false }] };
    },
  });
  const repository = new MqttRepository({ pool });

  const delivery = await repository.enqueueDelivery({
    eventId: deliveryRow.event_id,
    readId: 41,
    cameraId: 7,
    cameraKey: deliveryRow.camera_key,
    cameraName: deliveryRow.camera_name,
    brokerId: 3,
    topic: deliveryRow.topic,
    payload: deliveryRow.payload,
    qos: 1,
    retain: false,
    maxAttempts: 5,
  });

  assert.equal(delivery.inserted, false);
  assert.equal(delivery.id, 41);
  assert.equal(capturedParams[8], JSON.stringify(deliveryRow.payload));
  assert.match(capturedParams[0], /^mqtt-v2:[a-f0-9]{64}$/);
});

test("due-delivery claims use a transaction and FOR UPDATE SKIP LOCKED", async () => {
  const claimedAt = new Date("2026-07-17T03:04:00.000Z");
  const client = makeClient((sql, params) => {
    assert.match(sql, /FOR UPDATE SKIP LOCKED/);
    assert.deepEqual(params, ["worker-one", claimedAt, 5]);
    return {
      rows: [
        {
          ...deliveryRow,
          status: "processing",
          locked_at: claimedAt,
          locked_by: "worker-one",
          broker_name: "Home MQTT",
          broker_host: "192.168.0.10",
          broker_port: 1883,
          broker_username: "mqtt-user",
          broker_password: "mqtt-password",
          broker_use_tls: false,
          broker_client_id: "alpr",
          broker_enabled: true,
        },
      ],
    };
  });
  const pool = makePool({ query: () => ({ rows: [] }), client });
  const repository = new MqttRepository({ pool });

  const claims = await repository.claimDueDeliveries({
    workerId: "worker-one",
    limit: 5,
    now: claimedAt,
  });

  assert.equal(claims.length, 1);
  assert.equal(claims[0].lockedBy, "worker-one");
  assert.equal(claims[0].broker.clientId, "alpr");
  assert.equal(client.calls.at(-1).sql, "COMMIT");
});

test("expired processing leases return to retry without incrementing attempts", async () => {
  const now = new Date("2026-07-17T03:05:00.000Z");
  let capturedParams;
  const client = makeClient(() => ({ rows: [] }));
  const pool = makePool({
    client,
    query(sql, params) {
      assert.match(sql, /status = 'retry'/);
      capturedParams = params;
      return { rows: [{ id: "41" }, { id: "42" }] };
    },
  });
  const repository = new MqttRepository({ pool });

  const released = await repository.releaseExpiredLeases({
    leaseMs: 60_000,
    now,
  });

  assert.deepEqual(released, [41, 42]);
  assert.equal(capturedParams[0].getTime(), now.getTime());
  assert.equal(capturedParams[1].toISOString(), "2026-07-17T03:04:00.000Z");
});

test("successful deliveries atomically update state and add one attempt", async () => {
  const completedAt = new Date("2026-07-17T03:05:00.000Z");
  const client = makeClient((sql, params) => {
    assert.match(sql, /INSERT INTO public\.mqtt_delivery_attempts/);
    assert.deepEqual(params, [41, "worker-one", completedAt]);
    return {
      rows: [
        {
          ...deliveryRow,
          status: "succeeded",
          attempt_count: 1,
          locked_at: null,
          locked_by: null,
          published_at: completedAt,
        },
      ],
    };
  });
  const pool = makePool({ query: () => ({ rows: [] }), client });
  const repository = new MqttRepository({ pool });

  const delivery = await repository.recordDeliverySuccess({
    deliveryId: 41,
    workerId: "worker-one",
    now: completedAt,
  });

  assert.equal(delivery.status, "succeeded");
  assert.equal(delivery.attemptCount, 1);
  assert.equal(client.calls.at(-1).sql, "COMMIT");
});

test("transient delivery failures schedule retry state and record the failed attempt", async () => {
  const completedAt = new Date("2026-07-17T03:05:00.000Z");
  let attemptParams;
  const client = makeClient((sql, params) => {
    if (sql.startsWith("SELECT *")) {
      return {
        rows: [
          {
            ...deliveryRow,
            status: "processing",
            locked_at: "2026-07-17T03:04:59.000Z",
            locked_by: "worker-one",
          },
        ],
      };
    }
    if (sql.startsWith("UPDATE public.mqtt_deliveries")) {
      assert.equal(params[2], "retry");
      assert.equal(params[3], 1);
      return {
        rows: [
          {
            ...deliveryRow,
            status: "retry",
            attempt_count: 1,
            next_attempt_at: params[4],
            last_error: params[5],
          },
        ],
      };
    }
    if (sql.startsWith("INSERT INTO public.mqtt_delivery_attempts")) {
      attemptParams = params;
      return { rows: [] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const pool = makePool({ query: () => ({ rows: [] }), client });
  const repository = new MqttRepository({ pool });

  const delivery = await repository.recordDeliveryFailure({
    deliveryId: 41,
    workerId: "worker-one",
    error: Object.assign(new Error("Connection refused"), {
      code: "ECONNREFUSED",
    }),
    now: completedAt,
    baseDelayMs: 1000,
  });

  assert.equal(delivery.status, "retry");
  assert.equal(delivery.attemptCount, 1);
  assert.equal(attemptParams[2], "retry");
  assert.equal(attemptParams[4], "ECONNREFUSED");
  assert.equal(client.calls.at(-1).sql, "COMMIT");
});

test("a lost worker lease rolls back instead of overwriting another worker", async () => {
  const client = makeClient((sql) => {
    if (sql.startsWith("SELECT *")) return { rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const pool = makePool({ query: () => ({ rows: [] }), client });
  const repository = new MqttRepository({ pool });

  await assert.rejects(
    repository.recordDeliveryFailure({
      deliveryId: 41,
      workerId: "stale-worker",
      error: new Error("late failure"),
    }),
    /worker lease was lost/
  );

  assert.equal(client.calls.at(-1).sql, "ROLLBACK");
  assert.equal(client.released, true);
});

test("activity queries validate filters and return broker-safe recent attempt history", async () => {
  const client = makeClient(() => ({ rows: [] }));
  const pool = makePool({
    client,
    query(sql, params) {
      assert.match(sql, /jsonb_agg/);
      assert.deepEqual(params, [25, "dead"]);
      return {
        rows: [
          {
            ...deliveryRow,
            status: "dead",
            broker_name: "Home MQTT",
            broker_host: "192.168.0.10",
            broker_port: 1883,
            broker_use_tls: false,
            broker_enabled: true,
            attempts: [
              {
                attempt_number: 1,
                outcome: "dead",
                error_code: "ERR_MQTT_AUTH",
              },
            ],
          },
        ],
      };
    },
  });
  const repository = new MqttRepository({ pool });

  await assert.rejects(
    repository.listActivity({ status: "unknown-status" }),
    /Invalid MQTT activity status/
  );

  const activity = await repository.listActivity({ limit: 25, status: "dead" });
  assert.equal(activity[0].broker.password, "");
  assert.equal(activity[0].attempts[0].error_code, "ERR_MQTT_AUTH");
});
