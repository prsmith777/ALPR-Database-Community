import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import sharp from "sharp";

import {
  analyzeDayDetectionMotion,
  analyzeVehicleMotionDirection,
  classifyMotionCaptureMode,
  VEHICLE_MOTION_DIRECTION_ALGORITHM,
} from "../lib/vehicle-motion-direction.mjs";

function trackCandidate(offsetMs, centerX, {
  containsPlate = false,
  continuity = 0.96,
  motionAnchor = false,
  motionAnchorSource = null,
} = {}) {
  return {
    offsetMs,
    motionAnchor,
    motionAnchorSource,
    detection: {
      left: centerX - 0.1,
      right: centerX + 0.1,
      top: 0.35,
      bottom: 0.65,
      containsPlate,
    },
    continuityScore: continuity,
    trackSimilarity: 0.9,
  };
}

async function solidFrame({ red, green, blue }) {
  return sharp({
    create: { width: 320, height: 180, channels: 3, background: { r: red, g: green, b: blue } },
  }).jpeg().toBuffer();
}

test("capture mode separates color daytime pixels from monochrome night pixels", () => {
  assert.deepEqual(classifyMotionCaptureMode(Buffer.from([220, 20, 20, 30, 200, 30])), {
    captureMode: "day_color",
    monochromeRatio: 0,
  });
  assert.deepEqual(classifyMotionCaptureMode(Buffer.from([20, 20, 20, 240, 240, 240])), {
    captureMode: "night_monochrome",
    monochromeRatio: 1,
  });
});

test("daytime plate-anchored motion resolves a consistent camera-plane direction", () => {
  const result = analyzeDayDetectionMotion({
    sampleCount: 7,
    monochromeRatio: 0.12,
    track: [
      trackCandidate(-1_000, 0.28),
      trackCandidate(-500, 0.33),
      trackCandidate(0, 0.38, { containsPlate: true }),
      trackCandidate(500, 0.43),
      trackCandidate(1_000, 0.48),
    ],
  });
  assert.equal(result.status, "ready");
  assert.equal(result.captureMode, "day_color");
  assert.equal(result.imageDirection, "right");
  assert.ok(result.confidence >= 0.64);
  assert.equal(result.vector.dominantAxis, "horizontal");
  assert.equal(result.trackedCount, 5);
  assert.equal(result.diagnostics.anchorDistance, null);
});

test("daytime motion fails closed without a plate-anchored vehicle", () => {
  const result = analyzeDayDetectionMotion({
    track: [trackCandidate(-500, 0.3), trackCandidate(0, 0.4), trackCandidate(500, 0.5)],
  });
  assert.equal(result.status, "unknown");
  assert.equal(result.imageDirection, "unknown");
  assert.equal(result.errorCode, "PLATE_ANCHOR_NOT_DETECTED");
});

test("stationary daytime tracks remain unknown", () => {
  const result = analyzeDayDetectionMotion({
    track: [
      trackCandidate(-300, 0.4),
      trackCandidate(-100, 0.403),
      trackCandidate(100, 0.407, { containsPlate: true }),
      trackCandidate(300, 0.41),
    ],
  });
  assert.equal(result.status, "unknown");
  assert.equal(result.errorCode, "INSUFFICIENT_MOTION");
});

test("a sub-second edge-clipped vehicle track can resolve direction", () => {
  const clippedAnchor = trackCandidate(0, 0.1, { motionAnchor: true });
  clippedAnchor.detection.left = 0;
  const result = analyzeDayDetectionMotion({
    sampleCount: 4,
    track: [
      clippedAnchor,
      trackCandidate(100, 0.25),
      trackCandidate(200, 0.4),
      trackCandidate(300, 0.55),
    ],
    samplingDiagnostics: {
      source: "blue_iris_alert",
      intervalMs: 100,
      requestedCount: 31,
      uniqueFrameCount: 28,
      duplicateCount: 3,
    },
  });
  assert.equal(result.status, "ready");
  assert.equal(result.imageDirection, "right");
  assert.equal(result.vector.spanMs, 300);
  assert.equal(result.diagnostics.edgeClippedCount, 1);
  assert.equal(result.diagnostics.sampling.intervalMs, 100);
});

test("monochrome night reads are recorded as disabled rather than guessed", async () => {
  const buffer = await solidFrame({ red: 40, green: 40, blue: 40 });
  const result = await analyzeVehicleMotionDirection({
    frames: [{ buffer, offsetMs: 0, width: 320, height: 180 }],
    track: [trackCandidate(0, 0.4, { containsPlate: true })],
  });
  assert.equal(result.status, "unknown");
  assert.equal(result.captureMode, "night_monochrome");
  assert.equal(result.imageDirection, "unknown");
  assert.equal(result.errorCode, "NIGHT_DIRECTION_DISABLED");
});

test("daytime motion uses a bounded nearby LPR anchor when the exact frame is unavailable", async () => {
  const buffer = await solidFrame({ red: 220, green: 80, blue: 30 });
  const result = await analyzeVehicleMotionDirection({
    frames: [-500, 500, 1_000, 1_500, 2_000].map((offsetMs) => ({
      buffer,
      offsetMs,
      width: 320,
      height: 180,
    })),
    track: [
      trackCandidate(-500, 0.28, {
        motionAnchor: true,
        motionAnchorSource: "scaled_stored_plate_proximity",
      }),
      trackCandidate(500, 0.36),
      trackCandidate(1_000, 0.4),
      trackCandidate(1_500, 0.44),
      trackCandidate(2_000, 0.48),
    ],
    anchorOffsetMs: -500,
    anchorSource: "scaled_stored_plate_proximity",
    anchorDistance: 0.02,
  });
  assert.equal(result.status, "ready");
  assert.equal(result.imageDirection, "right");
  assert.equal(result.diagnostics.anchorOffsetMs, -500);
  assert.equal(result.diagnostics.anchorSource, "scaled_stored_plate_proximity");
  assert.equal(result.diagnostics.anchorDistance, 0.02);
});

test("motion reports an unavailable anchor only when the bounded dense window has no frames", async () => {
  const result = await analyzeVehicleMotionDirection({
    frames: [],
    track: [trackCandidate(1_000, 0.4, { motionAnchor: true })],
    anchorOffsetMs: 0,
  });
  assert.equal(result.status, "unknown");
  assert.equal(result.errorCode, "ANCHOR_FRAME_UNAVAILABLE");
  assert.equal(result.diagnostics.nearestFrameOffsetMs, null);
});

test("the shadow algorithm remains explicitly versioned", () => {
  assert.equal(VEHICLE_MOTION_DIRECTION_ALGORITHM, "plate-anchored-motion-v3-dense-shadow");
});

test("motion shadow schema cannot overwrite the displayed ReID direction", async () => {
  const [migration, analyzer] = await Promise.all([
    readFile(new URL("../migrations.sql", import.meta.url), "utf8"),
    readFile(new URL("../lib/vehicle-motion-direction.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.vehicle_motion_direction_observations/);
  assert.match(analyzer, /NIGHT_DIRECTION_DISABLED/);
  assert.match(migration, /2026080701_vehicle_motion_direction_shadow/);
  const shadowSection = migration.slice(migration.indexOf("-- Phase 2A records"));
  assert.doesNotMatch(shadowSection, /UPDATE public\.vehicle_direction_observations/);
});
