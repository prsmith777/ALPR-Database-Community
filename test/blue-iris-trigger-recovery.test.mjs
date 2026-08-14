import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { BlueIrisVehicleFrameRepository } from "../lib/blue-iris-vehicle-frame-repository.mjs";

const START_AT = "2026-08-13T14:00:00.000Z";
const END_AT = "2026-08-13T18:00:00.000Z";

function candidate(overrides = {}) {
  return {
    read_id: 40791,
    camera_name: "Street LPR 1",
    read_timestamp: "2026-08-13T16:01:12.000Z",
    bi_trigger_direction_profile_version: 2,
    bi_trigger_direction_algorithm: "blue-iris-zone-crossing-v2-primary",
    receipt_id: 901,
    receipt_match_count: "1",
    request_id: "trigger-recovery-request",
    trigger_type: "Motion_A>B,Zone A,Zone B,Zone C",
    enabled: true,
    front_direction_label: "Eastbound",
    rear_direction_label: "Westbound",
    blue_iris_motion_enabled: true,
    blue_iris_front_trigger_type: "MOTION_A>B",
    blue_iris_rear_trigger_type: "MOTION_B>A",
    blue_iris_motion_profile_version: 2,
    ...overrides,
  };
}

test("composite trigger recovery preview returns an exact bounded read manifest", async () => {
  const calls = [];
  const repository = new BlueIrisVehicleFrameRepository({
    query: async (text, values) => {
      calls.push({ text, values });
      return {
        rows: [
          candidate(),
          candidate({
            read_id: 40792,
            receipt_id: 902,
            read_timestamp: "2026-08-13T16:02:12.000Z",
            trigger_type: "MOTION_A>B,MOTION_B>A",
          }),
        ],
      };
    },
  });

  const preview = await repository.previewBlueIrisCompositeTriggerRecovery({
    startAt: START_AT,
    endAt: END_AT,
  });
  assert.deepEqual(preview.readIds, [40791]);
  assert.equal(preview.eligible, 1);
  assert.equal(preview.moreAvailable, false);
  assert.equal(preview.startAt, START_AT);
  assert.equal(preview.endAt, END_AT);
  assert.match(calls[0].text, /integration_ingress_receipts/);
  assert.match(calls[0].text, /receipt_match_count = 1/);
  assert.match(calls[0].text, /vehicle_image_error_code = 'OVERVIEW_DIRECTION_UNAVAILABLE'/);
  assert.match(calls[0].text, /COALESCE\(reads\.vehicle_image_attempt_count, 0\) = 0/);
  assert.equal(calls[0].values[2], null);
});

test("composite trigger recovery revalidates exact reads, records evidence, and does not replay notifications", async () => {
  const calls = [];
  const pool = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (/WITH linked AS MATERIALIZED/.test(text)) {
        return { rows: [candidate()] };
      }
      if (/UPDATE public\.plate_reads/.test(text)) {
        return { rowCount: 1, rows: [{ id: 40791 }] };
      }
      return { rowCount: 1, rows: [] };
    },
  };
  const repository = new BlueIrisVehicleFrameRepository(pool);
  const result = await repository.recoverBlueIrisCompositeTriggers({
    startAt: START_AT,
    endAt: END_AT,
    readIds: [40791],
    actor: { id: 7 },
  });

  assert.deepEqual(result.readIds, [40791]);
  assert.equal(result.queued, 1);
  assert.equal(result.stale, 0);
  assert.equal(calls[0].text, "BEGIN");
  assert.equal(calls.at(-1).text, "COMMIT");
  const candidateCall = calls.find(({ text }) => /WITH linked AS MATERIALIZED/.test(text));
  assert.deepEqual(candidateCall.values[2], [40791]);
  const update = calls.find(({ text }) => /UPDATE public\.plate_reads/.test(text));
  assert.match(update.text, /bi_trigger_direction_status = 'ready'/);
  assert.match(update.text, /vehicle_image_queue_kind = 'overview'/);
  assert.match(update.text, /WAITING_FOR_DAYTIME_OVERVIEW/);
  assert.match(update.text, /vehicle_image_attempt_count, 0\) = 0/);
  assert.equal(update.values[1], "MOTION_A>B");
  assert.equal(update.values[2], "Eastbound");
  assert.ok(calls.some(({ text }) => /INSERT INTO public\.vehicle_direction_observations/.test(text)));
  assert.ok(calls.some(({ text }) => /direction\.composite-trigger-recovered/.test(text)));
  const audit = calls.find(({ text }) => /vehicle\.blue_iris_composite_trigger_recovery/.test(text));
  assert.equal(audit.values[0], 7);
  assert.equal(JSON.parse(audit.values[1]).notificationsReplayed, false);
  assert.equal(calls.some(({ text }) => /notification_outbox|mqtt_outbox|pushover/i.test(text)), false);
});

test("composite trigger recovery preserves stale reads and rejects altered manifests", async () => {
  const calls = [];
  const repository = new BlueIrisVehicleFrameRepository({
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (/WITH linked AS MATERIALIZED/.test(text)) return { rows: [] };
      return { rowCount: 1, rows: [] };
    },
  });
  const result = await repository.recoverBlueIrisCompositeTriggers({
    startAt: START_AT,
    endAt: END_AT,
    readIds: [40791],
    actor: { id: 7 },
  });
  assert.equal(result.queued, 0);
  assert.equal(result.stale, 1);
  assert.equal(calls.some(({ text }) => /UPDATE public\.plate_reads/.test(text)), false);

  await assert.rejects(
    () => repository.recoverBlueIrisCompositeTriggers({
      startAt: START_AT,
      endAt: END_AT,
      readIds: [40791, 40791],
    }),
    /exact previewed read IDs/i,
  );
  await assert.rejects(
    () => repository.previewBlueIrisCompositeTriggerRecovery({
      startAt: "2026-07-01T00:00:00.000Z",
      endAt: END_AT,
    }),
    /14-day window/i,
  );
});

test("Vehicle Views exposes a separate preview-first composite trigger repair", async () => {
  const [actions, settings] = await Promise.all([
    readFile(new URL("../app/actions.js", import.meta.url), "utf8"),
    readFile(new URL("../components/settings/VehicleIntelligenceSettings.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(actions, /export async function recoverBlueIrisCompositeTriggerReads/);
  assert.match(actions, /requirePermission\("maintenance\.manage"\)/);
  assert.match(actions, /previewBlueIrisCompositeTriggerRecovery/);
  assert.match(actions, /recoverBlueIrisCompositeTriggers/);
  assert.match(settings, /Repair missed Blue Iris 6 composite triggers/);
  assert.match(settings, /Preview trigger repair/);
  assert.match(settings, /triggerRecoveryPreview\.readIds/);
  assert.match(settings, /Historical notifications were not replayed/);
});
