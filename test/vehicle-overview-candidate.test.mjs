import assert from "node:assert/strict";
import test from "node:test";

import {
  createOverviewCandidateIdentity,
  normalizeOverviewTriggerType,
  overviewNighttimeState,
} from "../lib/vehicle-overview-candidate.mjs";

test("overview event identities are stable and camera scoped", () => {
  const input = {
    sourceCameraName: "Street Overview",
    eventTimestamp: "2026-08-08T18:00:05.000Z",
    alertClip: "@283261194611520.bvr",
    alertPath: "1.0.220354",
  };
  const identity = createOverviewCandidateIdentity(input);
  assert.match(identity, /^[0-9a-f]{64}$/);
  assert.equal(createOverviewCandidateIdentity(input), identity);
  assert.notEqual(createOverviewCandidateIdentity({ ...input, sourceCameraName: "Entry LPR 1" }), identity);
});

test("ordered Blue Iris trigger types are normalized conservatively", () => {
  assert.equal(normalizeOverviewTriggerType(" motion_a>b "), "MOTION_A>B");
  assert.equal(normalizeOverviewTriggerType("bad type with spaces"), null);
});

test("monochrome overview alerts are accepted only as terminal nighttime evidence", () => {
  assert.deepEqual(overviewNighttimeState({
    evaluated: true,
    eligible: false,
    monochrome: true,
  }), {
    accepted: true,
    daylightStatus: "nighttime",
    status: "unavailable",
    retryable: false,
    errorCode: "NIGHTTIME_UNAVAILABLE",
  });
});

test("color alerts queue while missing images cannot bypass daytime enforcement", () => {
  assert.deepEqual(overviewNighttimeState({
    evaluated: true,
    eligible: true,
    monochrome: false,
  }), {
    accepted: true,
    daylightStatus: "daytime",
    status: "pending",
    retryable: true,
    errorCode: null,
  });
  assert.deepEqual(overviewNighttimeState({ evaluated: false }), {
    accepted: false,
    status: "invalid",
    errorCode: "DAYLIGHT_IMAGE_REQUIRED",
  });
});
