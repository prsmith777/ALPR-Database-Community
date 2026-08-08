import assert from "node:assert/strict";
import test from "node:test";

import {
  associationMinimumAgeMs,
  chooseOverviewAssociation,
  OVERVIEW_ASSOCIATION_ALGORITHM,
} from "../lib/vehicle-overview-association.mjs";

const candidate = {
  id: 11,
  source_camera_name: "Street Overview",
  event_timestamp: "2026-08-08T18:00:05.000Z",
};

const profiles = [
  {
    id: 1,
    source_camera_name: "Street Overview",
    plate_camera_name: "Street LPR 1",
    direction_label: "Eastbound",
    source_role: "primary",
    expected_delta_ms: 1_000,
    tolerance_ms: 1_500,
    priority: 0,
    enabled: true,
  },
  {
    id: 2,
    source_camera_name: "Street Overview",
    plate_camera_name: "Street LPR 2",
    direction_label: "Eastbound",
    source_role: "primary",
    expected_delta_ms: 5_000,
    tolerance_ms: 1_500,
    priority: 0,
    enabled: true,
  },
];

test("overview association joins paired LPR reads for the same vehicle", () => {
  const result = chooseOverviewAssociation({
    candidate,
    profiles,
    reads: [
      {
        id: 101,
        camera_name: "Street LPR 1",
        timestamp: "2026-08-08T18:00:04.000Z",
        observed_plate: "ABC123",
        plate_number: "ABC123",
        bi_trigger_direction_label: "Eastbound",
      },
      {
        id: 102,
        camera_name: "Street LPR 2",
        timestamp: "2026-08-08T18:00:00.000Z",
        observed_plate: "ABC123",
        plate_number: "ABC123",
        bi_trigger_direction_label: "Eastbound",
      },
    ],
  });

  assert.equal(result.status, "matched");
  assert.deepEqual(result.reads.map((read) => read.id).sort(), [101, 102]);
  assert.equal(result.bestScore, 0);
  assert.equal(OVERVIEW_ASSOCIATION_ALGORITHM, "blue-iris-overview-association-v1");
});

test("close competing vehicles remain ambiguous instead of receiving the wrong image", () => {
  const result = chooseOverviewAssociation({
    candidate,
    profiles,
    reads: [
      {
        id: 201,
        camera_name: "Street LPR 1",
        timestamp: "2026-08-08T18:00:04.000Z",
        observed_plate: "CAR111",
        bi_trigger_direction_label: "Eastbound",
      },
      {
        id: 202,
        camera_name: "Street LPR 1",
        timestamp: "2026-08-08T18:00:04.200Z",
        observed_plate: "CAR999",
        bi_trigger_direction_label: "Eastbound",
      },
    ],
  });

  assert.equal(result.status, "ambiguous");
  assert.equal(result.reason, "MULTIPLE_VEHICLES_MATCH");
  assert.deepEqual(result.reads, []);
});

test("one-character OCR neighbors are not merged into one vehicle event", () => {
  const result = chooseOverviewAssociation({
    candidate,
    profiles,
    reads: [
      {
        id: 211,
        camera_name: "Street LPR 1",
        timestamp: "2026-08-08T18:00:04.000Z",
        observed_plate: "ABC123",
        plate_number: "ABC123",
        bi_trigger_direction_label: "Eastbound",
      },
      {
        id: 212,
        camera_name: "Street LPR 2",
        timestamp: "2026-08-08T18:00:00.000Z",
        observed_plate: "ABC12B",
        plate_number: "ABC12B",
        bi_trigger_direction_label: "Eastbound",
      },
    ],
  });

  assert.equal(result.status, "ambiguous");
  assert.equal(result.reason, "MULTIPLE_VEHICLES_MATCH");
});

test("wrong-direction and unconfigured camera reads do not match", () => {
  const result = chooseOverviewAssociation({
    candidate,
    profiles,
    reads: [
      {
        id: 301,
        camera_name: "Street LPR 1",
        timestamp: "2026-08-08T18:00:04.000Z",
        observed_plate: "WEST77",
        bi_trigger_direction_label: "Westbound",
      },
      {
        id: 302,
        camera_name: "Entry LPR 1",
        timestamp: "2026-08-08T18:00:04.000Z",
        observed_plate: "ENTRY1",
        bi_trigger_direction_label: "Eastbound",
      },
    ],
  });

  assert.equal(result.status, "unmatched");
  assert.equal(result.reason, "NO_MATCHING_PLATE_READ");
});

test("fallback-only sources wait longer for late driveway reads", () => {
  assert.equal(associationMinimumAgeMs(profiles), 12_000);
  assert.equal(associationMinimumAgeMs([
    { source_role: "fallback" },
    { source_role: "fallback" },
  ]), 30_000);
});
