import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLateDuplicateReconciliationPlan,
  reconcileLateDuplicateRead,
} from "../lib/late-duplicate-reconciliation.mjs";

function emptyRead(overrides = {}) {
  return {
    id: 40811,
    plate_number: "ABC123",
    observed_plate: "ABC123",
    camera_name: "Street LPR 1",
    timestamp: "2026-08-13T22:44:00.000Z",
    image_path: null,
    thumbnail_path: null,
    bi_path: null,
    bi_alert_clip: null,
    bi_alert_path: null,
    bi_alert_offset_ms: null,
    confidence: null,
    crop_coordinates: null,
    ocr_annotation: null,
    plate_annotation: null,
    bi_trigger_type: null,
    bi_trigger_direction_status: null,
    bi_trigger_direction_label: null,
    bi_trigger_direction_profile_version: null,
    bi_trigger_direction_algorithm: null,
    bi_trigger_direction_error_code: null,
    vehicle_image_status: "unavailable",
    vehicle_image_path: null,
    vehicle_image_queue_kind: null,
    vehicle_image_attempt_count: 0,
    vehicle_image_retryable: false,
    vehicle_image_error_code: "OVERVIEW_DIRECTION_UNAVAILABLE",
    vehicle_image_claim_token: null,
    vehicle_image_next_attempt_at: null,
    vehicle_image_heartbeat_at: null,
    vehicle_image_processing_deadline_at: null,
    vehicle_image_hard_deadline_at: null,
    vehicle_image_backfill_job_id: null,
    vehicle_image_updated_at: null,
    ...overrides,
  };
}

function readyDirection(overrides = {}) {
  return {
    bi_trigger_type: "MOTION_A>B",
    bi_trigger_direction_status: "ready",
    bi_trigger_direction_label: "Eastbound",
    bi_trigger_direction_profile_version: 2,
    bi_trigger_direction_algorithm: "blue-iris-zone-crossing-v2-primary",
    bi_trigger_direction_error_code: null,
    ...overrides,
  };
}

function completeIncoming(overrides = {}) {
  return {
    imagePath: "images/late.jpg",
    thumbnailPath: "thumbnails/late.jpg",
    alert: {
      bi_path: "ui3.htm?rec=late-12&cam=Street%20LPR%201",
      bi_alert_clip: "@late",
      bi_alert_path: "Street.1.12",
      bi_alert_offset_ms: 12,
    },
    recognition: {
      confidence: 0.92,
      crop_coordinates: [1, 2, 3, 4],
      ocr_annotation: { source: "ai" },
      plate_annotation: "plate-region",
    },
    direction: readyDirection(),
    vehicleOverview: {
      status: "pending",
      queueKind: "overview",
      retryable: true,
      errorCode: "WAITING_FOR_DAYTIME_OVERVIEW",
    },
    ...overrides,
  };
}

test("late duplicates fill only missing evidence and queue one never-started overview", () => {
  const plan = buildLateDuplicateReconciliationPlan(emptyRead(), completeIncoming());

  assert.equal(plan.changed, true);
  assert.equal(plan.imageAttached, true);
  assert.equal(plan.alertPointerAttached, true);
  assert.equal(plan.directionAttached, true);
  assert.equal(plan.recognitionAttached, true);
  assert.equal(plan.overviewQueued, true);
  assert.equal(plan.next.image_path, "images/late.jpg");
  assert.equal(plan.next.bi_alert_clip, "@late");
  assert.equal(plan.next.bi_trigger_direction_label, "Eastbound");
  assert.equal(plan.next.confidence, 0.92);
  assert.equal(plan.next.vehicle_image_status, "pending");
  assert.equal(plan.next.vehicle_image_queue_kind, "overview");
});

test("established or conflicting evidence and successful work are immutable", () => {
  const current = emptyRead({
    image_path: "images/original.jpg",
    thumbnail_path: "thumbnails/original.jpg",
    bi_path: "ui3.htm?rec=original-9&cam=Street%20LPR%201",
    bi_alert_clip: "@original",
    bi_alert_path: "Street.1.9",
    bi_alert_offset_ms: 9,
    confidence: 0.99,
    crop_coordinates: [9, 9, 9, 9],
    ocr_annotation: { source: "original" },
    plate_annotation: "original-region",
    ...readyDirection(),
    vehicle_image_status: "ready",
    vehicle_image_path: "derived/original.webp",
    vehicle_image_queue_kind: "overview",
    vehicle_image_retryable: false,
    vehicle_image_error_code: null,
  });
  const plan = buildLateDuplicateReconciliationPlan(current, completeIncoming());

  assert.equal(plan.changed, false);
  assert.equal(plan.imageAttached, false);
  assert.equal(plan.alertPointerAttached, false);
  assert.equal(plan.directionAttached, false);
  assert.equal(plan.recognitionAttached, false);
  assert.equal(plan.overviewQueued, false);
  assert.equal(plan.next.image_path, "images/original.jpg");
  assert.equal(plan.next.bi_alert_clip, "@original");
  assert.equal(plan.next.bi_trigger_direction_label, "Eastbound");
  assert.equal(plan.next.vehicle_image_path, "derived/original.webp");
});

test("pointer completion requires every established pointer field to match", () => {
  const current = emptyRead({ bi_alert_clip: "@same" });
  const underdetermined = buildLateDuplicateReconciliationPlan(current, completeIncoming({
    imagePath: null,
    thumbnailPath: null,
    recognition: {},
    direction: {},
    vehicleOverview: {},
    alert: {
      bi_path: "ui3.htm?rec=other-12&cam=Street%20LPR%201",
      bi_alert_clip: null,
      bi_alert_path: "Street.1.12",
      bi_alert_offset_ms: 12,
    },
  }));
  assert.equal(underdetermined.alertPointerAttached, false);

  const matching = buildLateDuplicateReconciliationPlan(current, completeIncoming({
    imagePath: null,
    thumbnailPath: null,
    recognition: {},
    direction: {},
    vehicleOverview: {},
    alert: {
      bi_path: "ui3.htm?rec=same-12&cam=Street%20LPR%201",
      bi_alert_clip: "@same",
      bi_alert_path: "Street.1.12",
      bi_alert_offset_ms: 12,
    },
  }));
  assert.equal(matching.alertPointerAttached, true);
  assert.equal(matching.next.bi_alert_clip, "@same");
  assert.equal(matching.next.bi_alert_path, "Street.1.12");
});

test("an established unknown direction is not replaced by a later ready direction", () => {
  const current = emptyRead({
    bi_trigger_type: "MOTION",
    bi_trigger_direction_status: "unknown",
    bi_trigger_direction_algorithm: "blue-iris-zone-crossing-v2-primary",
    bi_trigger_direction_error_code: "TRIGGER_TYPE_UNMAPPED",
  });
  const plan = buildLateDuplicateReconciliationPlan(current, completeIncoming({
    imagePath: null,
    thumbnailPath: null,
    alert: {},
    recognition: {},
  }));

  assert.equal(plan.directionAttached, false);
  assert.equal(plan.overviewQueued, false);
  assert.equal(plan.next.bi_trigger_direction_status, "unknown");
  assert.equal(plan.next.bi_trigger_direction_error_code, "TRIGGER_TYPE_UNMAPPED");
});

test("only never-started missing-evidence overview states can be queued", () => {
  for (const protectedState of [
    { vehicle_image_status: "unavailable", vehicle_image_error_code: "NIGHTTIME_UNAVAILABLE" },
    { vehicle_image_status: "failed", vehicle_image_retryable: true },
    { vehicle_image_status: "processing", vehicle_image_claim_token: "claim" },
    { vehicle_image_status: "ready", vehicle_image_path: "derived/ready.webp" },
    { vehicle_image_status: null, vehicle_image_queue_kind: "overview" },
    { vehicle_image_status: null, vehicle_image_error_code: "UNEXPECTED_STATE" },
  ]) {
    const plan = buildLateDuplicateReconciliationPlan(
      emptyRead(protectedState),
      completeIncoming({ alert: {}, recognition: {} }),
    );
    assert.equal(plan.overviewQueued, false, JSON.stringify(protectedState));
  }
});

test("repository reconciliation locks the target and uses one parameterized fill-only update", async () => {
  const current = emptyRead();
  const statements = [];
  const query = async (text, values) => {
    statements.push([text, values]);
    if (statements.length === 1) return { rows: [current] };
    return { rows: [{ ...current, ...buildLateDuplicateReconciliationPlan(current, completeIncoming()).next }] };
  };

  const result = await reconcileLateDuplicateRead(query, {
    readId: current.id,
    ...completeIncoming(),
  });

  assert.equal(result.changed, true);
  assert.equal(result.read.id, current.id);
  assert.equal(statements.length, 2);
  assert.match(statements[0][0], /WHERE id = \$1::integer\s+FOR UPDATE/);
  assert.deepEqual(statements[0][1], [current.id]);
  assert.match(statements[1][0], /CASE WHEN \$2::boolean THEN \$3::text ELSE image_path END/);
  assert.match(statements[1][0], /CASE WHEN \$12::boolean THEN \$13::integer\[\]/);
  assert.match(statements[1][0], /CASE WHEN \$16::boolean THEN \$17::varchar/);
  assert.match(statements[1][0], /CASE WHEN \$25::boolean THEN 'pending'/);
  assert.equal(statements[1][1][0], current.id);
  assert.equal(statements[1][1][24], true);
});

test("an unchanged duplicate performs no update", async () => {
  const current = emptyRead({
    image_path: "images/original.jpg",
    thumbnail_path: "thumbnails/original.jpg",
    bi_path: "ui3.htm?rec=original-9&cam=Street%20LPR%201",
    bi_alert_clip: "@original",
    bi_alert_path: "Street.1.9",
    bi_alert_offset_ms: 9,
    confidence: 0.99,
    crop_coordinates: [9, 9, 9, 9],
    ocr_annotation: { source: "original" },
    plate_annotation: "original-region",
    ...readyDirection(),
    vehicle_image_status: "ready",
    vehicle_image_path: "derived/original.webp",
  });
  let calls = 0;
  const result = await reconcileLateDuplicateRead(async () => {
    calls += 1;
    return { rows: [current] };
  }, { readId: current.id, ...completeIncoming() });

  assert.equal(result.changed, false);
  assert.equal(calls, 1);
});
