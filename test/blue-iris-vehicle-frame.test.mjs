import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

import {
  analyzeVehicleFrameQuality,
  BlueIrisVehicleFrameService,
  OVERVIEW_VEHICLE_FRAME_SAMPLE_OFFSETS_MS,
  overviewVehicleFrameSampleOffsets,
  VEHICLE_FRAME_DEEP_EXTENSION_OFFSETS_MS,
  VEHICLE_FRAME_EXTENSION_OFFSETS_MS,
  VEHICLE_FRAME_SAMPLE_OFFSETS_MS,
  isLikelyBlueIrisPlaceholder,
  productionBaselineVehicleFrameScore,
  scoreVehicleFrame,
  selectAnchoredOverviewVehicleFrame,
  selectGuardedVehicleFrame,
  selectBestTrackedVehicleFrame,
} from "../lib/blue-iris-vehicle-frame.mjs";
import { BlueIrisError } from "../lib/blue-iris.mjs";

test("vehicle-frame scoring favors a complete, larger vehicle over an edge-truncated one", () => {
  const complete = scoreVehicleFrame({ confidence: 0.82, area: 0.35, left: 0.1, top: 0.1, right: 0.8, bottom: 0.8 });
  const truncated = scoreVehicleFrame({ confidence: 0.99, area: 0.12, left: 0, top: 0.2, right: 0.4, bottom: 0.7 });
  assert.ok(complete > truncated);
});

test("a sharp complete vehicle beats a larger blurred edge-truncated detection", () => {
  const complete = scoreVehicleFrame(
    { confidence: 0.82, area: 0.24, left: 0.08, top: 0.08, right: 0.72, bottom: 0.72 },
    { sharpnessScore: 0.9, exposureScore: 0.75, contrastScore: 0.8 }
  );
  const truncated = scoreVehicleFrame(
    { confidence: 0.99, area: 0.62, left: 0, top: 0.03, right: 0.93, bottom: 0.9 },
    { sharpnessScore: 0.3, exposureScore: 0.8, contrastScore: 0.8 }
  );
  assert.ok(complete > truncated);
});

test("default vehicle-frame sampling covers the event densely without retaining extra frames", () => {
  assert.equal(VEHICLE_FRAME_SAMPLE_OFFSETS_MS.length, 17);
  assert.equal(VEHICLE_FRAME_SAMPLE_OFFSETS_MS[0], -2_000);
  assert.equal(VEHICLE_FRAME_SAMPLE_OFFSETS_MS.at(-1), 6_000);
  assert.ok(VEHICLE_FRAME_SAMPLE_OFFSETS_MS.every((offset, index, offsets) => (
    index === 0 || offset - offsets[index - 1] === 500
  )));
  assert.equal(VEHICLE_FRAME_EXTENSION_OFFSETS_MS.at(-1), 10_000);
  assert.equal(VEHICLE_FRAME_DEEP_EXTENSION_OFFSETS_MS[0], -8_000);
  assert.equal(VEHICLE_FRAME_DEEP_EXTENSION_OFFSETS_MS.at(-1), 16_000);
  assert.equal(VEHICLE_FRAME_DEEP_EXTENSION_OFFSETS_MS.length, 10);
});

test("overview sampling derives a six-second 100 ms window from the primary tolerance", () => {
  assert.equal(OVERVIEW_VEHICLE_FRAME_SAMPLE_OFFSETS_MS.length, 61);
  assert.equal(OVERVIEW_VEHICLE_FRAME_SAMPLE_OFFSETS_MS[0], -1_500);
  assert.equal(OVERVIEW_VEHICLE_FRAME_SAMPLE_OFFSETS_MS.at(-1), 4_500);
  assert.ok(OVERVIEW_VEHICLE_FRAME_SAMPLE_OFFSETS_MS.every((offset, index, offsets) => (
    index === 0 || offset - offsets[index - 1] === 100
  )));
  const lpr2 = overviewVehicleFrameSampleOffsets(2_000);
  assert.deepEqual([lpr2.length, lpr2[0], lpr2.at(-1)], [61, -2_000, 4_000]);
  assert.throws(() => overviewVehicleFrameSampleOffsets(3_001), /between 250 and 3000/);
});

test("the guarded selector retains the production winner when v3 would choose the plate-time frame", () => {
  const plateTimePartial = {
    offsetMs: 0,
    primarySample: true,
    frameRank: 0,
    detection: { containsPlate: true, selectionScore: 10 },
    embedding: Float32Array.from([1, 0]),
    quality: { sharpnessScore: 0.9, exposureScore: 0.9, contrastScore: 0.9 },
    baselineScore: 0.7,
    score: 0.95,
    scoreBreakdown: { score: 0.95, completenessTier: 3 },
  };
  const productionWinner = {
    offsetMs: 2_000,
    primarySample: true,
    frameRank: 0,
    detection: { containsPlate: false, selectionScore: 1 },
    // A changing front-to-side view may have low ReID similarity. It must not
    // disqualify the same production-baseline frame that already worked.
    embedding: Float32Array.from([0, 1]),
    quality: { sharpnessScore: 0.75, exposureScore: 0.75, contrastScore: 0.75 },
    baselineScore: 0.84,
    score: 0.78,
    scoreBreakdown: { score: 0.78, completenessTier: 2 },
  };

  const result = selectGuardedVehicleFrame([plateTimePartial, productionWinner]);
  assert.equal(result.best.offsetMs, 2_000);
  assert.equal(result.selectionReason, "production_baseline");
});

test("the baseline score is byte-for-byte compatible with the production formula", () => {
  const detection = { confidence: 0.87, area: 0.31, left: 0.08, top: 0.1, right: 0.77, bottom: 0.78 };
  const expected = Number((0.87 * 0.35 + Math.sqrt(0.31) * 0.45 + 0.2).toFixed(6));
  assert.equal(productionBaselineVehicleFrameScore(detection), expected);
});

test("quality analysis distinguishes a sharp vehicle crop from a flat blurred crop", async () => {
  const width = 160;
  const height = 100;
  const flat = await sharp({
    create: { width, height, channels: 3, background: { r: 128, g: 128, b: 128 } },
  }).jpeg().toBuffer();
  const checkerboard = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? 230 : 25;
      const offset = (y * width + x) * 3;
      checkerboard[offset] = value;
      checkerboard[offset + 1] = value;
      checkerboard[offset + 2] = value;
    }
  }
  const sharpFrame = await sharp(checkerboard, { raw: { width, height, channels: 3 } }).jpeg().toBuffer();
  const detection = { left: 0.05, top: 0.05, right: 0.95, bottom: 0.95 };
  const flatQuality = await analyzeVehicleFrameQuality({ buffer: flat, detection, width, height });
  const sharpQuality = await analyzeVehicleFrameQuality({ buffer: sharpFrame, detection, width, height });
  assert.ok(sharpQuality.sharpnessScore > flatQuality.sharpnessScore);
  assert.ok(sharpQuality.contrastScore > flatQuality.contrastScore);
});

test("plate anchoring and ReID tracking reject a larger unrelated vehicle", () => {
  const scoreBreakdown = (score, completenessTier) => ({ score, completenessTier });
  const anchor = {
    offsetMs: 0,
    detection: { containsPlate: true, selectionScore: 10 },
    embedding: Float32Array.from([1, 0]),
    score: 0.3,
    scoreBreakdown: scoreBreakdown(0.3, 0),
  };
  const tracked = {
    offsetMs: 500,
    detection: { containsPlate: false, selectionScore: 0.8 },
    embedding: Float32Array.from([0.995, 0.1]),
    score: 0.78,
    scoreBreakdown: scoreBreakdown(0.78, 2),
  };
  const unrelated = {
    offsetMs: 500,
    detection: { containsPlate: false, selectionScore: 0.99 },
    embedding: Float32Array.from([0, 1]),
    score: 0.96,
    scoreBreakdown: scoreBreakdown(0.96, 2),
  };
  const result = selectBestTrackedVehicleFrame([anchor, tracked, unrelated]);
  assert.equal(result.best.offsetMs, tracked.offsetMs);
  assert.equal(result.best.score, tracked.score);
  assert.equal(result.trackedCount, 2);
});

test("overview anchoring keeps the timed vehicle track instead of a stronger unrelated production candidate", () => {
  const anchor = {
    offsetMs: 0,
    primarySample: true,
    frameRank: 0,
    detection: { confidence: 0.82, left: 0.1, top: 0.1, right: 0.5, bottom: 0.6, area: 0.2 },
    embedding: Float32Array.from([1, 0]),
    baselineScore: 0.55,
    score: 0.5,
    scoreBreakdown: { completenessTier: 3 },
  };
  const target = {
    offsetMs: 100,
    primarySample: true,
    frameRank: 1,
    detection: { confidence: 0.86, left: 0.14, top: 0.1, right: 0.55, bottom: 0.62, area: 0.21 },
    embedding: Float32Array.from([0.995, 0.1]),
    baselineScore: 0.66,
    score: 0.82,
    scoreBreakdown: { completenessTier: 3 },
  };
  const unrelated = {
    offsetMs: 2_000,
    primarySample: true,
    frameRank: 0,
    detection: { confidence: 0.96, left: 0.65, top: 0.2, right: 0.98, bottom: 0.8, area: 0.3 },
    embedding: Float32Array.from([0, 1]),
    baselineScore: 0.96,
    score: 0.97,
    scoreBreakdown: { completenessTier: 2 },
  };
  const laterUnrelated = {
    ...unrelated,
    offsetMs: 2_100,
    frameRank: 0,
    baselineScore: 0.99,
    score: 0.99,
  };

  const result = selectAnchoredOverviewVehicleFrame([anchor, target, unrelated, laterUnrelated]);
  assert.equal(result.status, "selected");
  assert.equal(result.best.frameRank, target.frameRank);
  assert.equal(result.best.score, target.score);
  assert.equal(result.trackedCount, 2);
  assert.equal(result.selectionReason, "overview_anchor_track");
});

test("overview anchoring fails closed when multiple vehicles occupy the timing anchor", () => {
  const result = selectAnchoredOverviewVehicleFrame([
    {
      offsetMs: 0,
      primarySample: true,
      frameRank: 0,
      detection: { confidence: 0.9, area: 0.245, left: 0.05, top: 0.1, right: 0.4, bottom: 0.8 },
      embedding: Float32Array.from([1, 0]),
      score: 0.9,
    },
    {
      offsetMs: 0,
      primarySample: true,
      frameRank: 1,
      detection: { confidence: 0.88, area: 0.245, left: 0.55, top: 0.1, right: 0.9, bottom: 0.8 },
      embedding: Float32Array.from([0, 1]),
      score: 0.88,
    },
    {
      offsetMs: 100,
      primarySample: true,
      frameRank: 0,
      detection: { confidence: 0.91, area: 0.245, left: 0.08, top: 0.1, right: 0.43, bottom: 0.8 },
      embedding: Float32Array.from([0.99, 0.05]),
      score: 0.91,
    },
    {
      offsetMs: 100,
      primarySample: true,
      frameRank: 1,
      detection: { confidence: 0.89, area: 0.245, left: 0.52, top: 0.1, right: 0.87, bottom: 0.8 },
      embedding: Float32Array.from([0.05, 0.99]),
      score: 0.89,
    },
  ]);
  assert.equal(result.status, "ambiguous");
  assert.equal(result.best, null);
  assert.equal(result.selectionReason, "multiple_vehicles_at_overview_anchor");
});

test("overview anchoring fails closed when a second viable track begins one sample from the anchor", () => {
  const target = [0, 100, 200].map((offsetMs) => ({
    offsetMs,
    frameRank: 0,
    detection: { confidence: 0.9, area: 0.22, left: 0.08, top: 0.1, right: 0.43, bottom: 0.73 },
    embedding: Float32Array.from([1, 0]),
    score: 0.88,
  }));
  const competitor = [100, 200, 300].map((offsetMs) => ({
    offsetMs,
    frameRank: 1,
    detection: { confidence: 0.87, area: 0.2, left: 0.58, top: 0.12, right: 0.91, bottom: 0.72 },
    embedding: Float32Array.from([0, 1]),
    score: 0.86,
  }));
  const result = selectAnchoredOverviewVehicleFrame([...target, ...competitor]);
  assert.equal(result.status, "ambiguous");
  assert.equal(result.viableTrackCount, 2);
});

test("an early nonviable speck cannot suppress a later unique viable track inside tolerance", () => {
  const speck = {
    offsetMs: 0,
    frameRank: 0,
    detection: { confidence: 0.35, area: 0.002, left: 0.02, top: 0.02, right: 0.07, bottom: 0.06 },
    embedding: Float32Array.from([0, 1]),
    score: 0.99,
  };
  const target = [500, 600, 700].map((offsetMs) => ({
    offsetMs,
    frameRank: 0,
    detection: { confidence: 0.9, area: 0.24, left: 0.2, top: 0.12, right: 0.68, bottom: 0.62 },
    embedding: Float32Array.from([1, 0]),
    score: 0.86,
  }));
  const result = selectAnchoredOverviewVehicleFrame([speck, ...target], { toleranceMs: 1_500 });
  assert.equal(result.status, "selected");
  assert.equal(result.viableTrackCount, 1);
  assert.equal(result.best.offsetMs >= 500, true);
});

test("two temporally offset viable tracks inside tolerance remain ambiguous", () => {
  const first = [0, 100, 200].map((offsetMs) => ({
    offsetMs,
    frameRank: 0,
    detection: { confidence: 0.9, area: 0.22, left: 0.05, top: 0.12, right: 0.42, bottom: 0.7 },
    embedding: Float32Array.from([1, 0]),
    score: 0.86,
  }));
  const second = [500, 600, 700].map((offsetMs) => ({
    offsetMs,
    frameRank: 0,
    detection: { confidence: 0.88, area: 0.21, left: 0.58, top: 0.1, right: 0.91, bottom: 0.68 },
    embedding: Float32Array.from([0, 1]),
    score: 0.84,
  }));
  const result = selectAnchoredOverviewVehicleFrame([...first, ...second], { toleranceMs: 1_500 });
  assert.equal(result.status, "ambiguous");
  assert.equal(result.viableTrackCount, 2);
});

test("separate vehicles occupying the same lane box at different times are not deduplicated", () => {
  const laneBox = { confidence: 0.9, area: 0.22, left: 0.18, top: 0.12, right: 0.62, bottom: 0.62 };
  const first = [0, 100, 200].map((offsetMs) => ({
    offsetMs,
    frameRank: 0,
    detection: { ...laneBox },
    embedding: Float32Array.from([1, 0]),
    score: 0.86,
  }));
  const second = [1_000, 1_100, 1_200].map((offsetMs) => ({
    offsetMs,
    frameRank: 0,
    detection: { ...laneBox, confidence: 0.88 },
    embedding: Float32Array.from([0, 1]),
    score: 0.84,
  }));
  const result = selectAnchoredOverviewVehicleFrame([...first, ...second], { toleranceMs: 1_500 });
  assert.equal(result.status, "ambiguous");
  assert.equal(result.viableTrackCount, 2);
});

test("overview anchoring fails closed for competing viable tracks and ignores detections outside profile tolerance", () => {
  const competing = selectAnchoredOverviewVehicleFrame([
    {
      offsetMs: 0,
      frameRank: 0,
      detection: { confidence: 0.9, area: 0.245, left: 0.05, top: 0.1, right: 0.4, bottom: 0.8 },
      embedding: Float32Array.from([1, 0]),
      score: 0.9,
    },
    {
      offsetMs: 0,
      frameRank: 1,
      detection: { confidence: 0.88, area: 0.245, left: 0.55, top: 0.1, right: 0.9, bottom: 0.8 },
      embedding: Float32Array.from([0, 1]),
      score: 0.88,
    },
    {
      offsetMs: -100,
      frameRank: 0,
      detection: { confidence: 0.89, area: 0.245, left: 0.02, top: 0.1, right: 0.37, bottom: 0.8 },
      embedding: Float32Array.from([0.99, 0.05]),
      score: 0.89,
    },
    {
      offsetMs: 100,
      frameRank: 1,
      detection: { confidence: 0.89, area: 0.245, left: 0.58, top: 0.1, right: 0.93, bottom: 0.8 },
      embedding: Float32Array.from([0.05, 0.99]),
      score: 0.89,
    },
  ], { toleranceMs: 1_500 });
  assert.equal(competing.status, "ambiguous");

  const outsideTolerance = selectAnchoredOverviewVehicleFrame([
    {
      offsetMs: 2_000,
      detection: { left: 0.1, top: 0.1, right: 0.8, bottom: 0.8 },
      score: 0.95,
    },
  ], { toleranceMs: 1_500 });
  assert.equal(outsideTolerance.status, "not_visible");
  assert.equal(outsideTolerance.selectionReason, "overview_anchor_outside_tolerance");
});

test("overview anchoring accepts a unique confident continuous one-edge vehicle but rejects unsafe crops", () => {
  const oneEdgeTrack = [-100, 0, 100].map((offsetMs, index) => ({
    offsetMs,
    frameRank: 0,
    detection: {
      confidence: 0.82,
      area: 0.42,
      left: 0,
      top: 0.08,
      right: 0.7 + index * 0.01,
      bottom: 0.68,
    },
    embedding: Float32Array.from([1, 0]),
    baselineScore: 0.7,
    score: 0.72 + index * 0.01,
  }));
  const accepted = selectAnchoredOverviewVehicleFrame(oneEdgeTrack);
  assert.equal(accepted.status, "selected");
  assert.equal(accepted.viableTrackCount, 1);
  assert.equal(accepted.selectionReason, "overview_anchor_track_one_edge");

  const twoEdgeTrack = oneEdgeTrack.map((candidate) => ({
    ...candidate,
    detection: { ...candidate.detection, top: 0 },
  }));
  assert.equal(selectAnchoredOverviewVehicleFrame(twoEdgeTrack).status, "not_visible");
  assert.equal(selectAnchoredOverviewVehicleFrame([{
    ...oneEdgeTrack[1],
    detection: { ...oneEdgeTrack[1].detection, left: 0.1 },
  }]).status, "not_visible");
});

test("a nonviable detector speck does not make a uniquely owned overview track ambiguous", () => {
  const target = [-100, 0, 100].map((offsetMs) => ({
    offsetMs,
    frameRank: 0,
    detection: { confidence: 0.85, area: 0.2, left: 0.2, top: 0.1, right: 0.6, bottom: 0.6 },
    embedding: Float32Array.from([1, 0]),
    score: 0.8,
    baselineScore: 0.78,
  }));
  const speck = {
    offsetMs: 0,
    frameRank: 1,
    detection: { confidence: 0.41, area: 0.003, left: 0.85, top: 0.1, right: 0.91, bottom: 0.15 },
    embedding: Float32Array.from([0, 1]),
    score: 0.95,
  };
  const result = selectAnchoredOverviewVehicleFrame([...target, speck]);
  assert.equal(result.status, "selected");
  assert.equal(result.viableTrackCount, 1);
  assert.equal(result.best.detection.left, 0.2);
});

test("a weak primary selection expands the timeline and selects a complete later view", async () => {
  const frames = new Map([
    [0, { confidence: 0.95, area: 0.4, left: 0, top: 0.1, right: 0.7, bottom: 0.8 }],
    [1_000, { confidence: 0.85, area: 0.25, left: 0.1, top: 0.1, right: 0.75, bottom: 0.75 }],
  ]);
  const base = Date.parse("2026-07-22T17:46:50Z");
  const service = new BlueIrisVehicleFrameService({
    client: {
      async fetchTimelineJpeg({ timestamp }) {
        const offset = new Date(timestamp).getTime() - base;
        return { buffer: Buffer.from(String(offset)), timestamp: new Date(timestamp).toISOString() };
      },
    },
    repository: {},
    fileStorage: {},
    detector: {
      async detect(buffer, dimensions) {
        const detection = frames.get(Number(buffer.toString())) || null;
        return detection ? { ...detection, containsPlate: Boolean(dimensions.plateBox), selectionScore: 1 } : null;
      },
    },
    imageProcessor: (buffer) => ({
      buffer,
      rotate() { return this; },
      jpeg() { return this; },
      async toBuffer() { return this.buffer; },
      async metadata() { return { width: 1280, height: 720 }; },
      async stats() { return { entropy: 3, channels: [{ stdev: 20 }, { stdev: 20 }, { stdev: 20 }] }; },
    }),
    qualityAnalyzer: async () => ({ sharpnessScore: 0.8, exposureScore: 0.8, contrastScore: 0.8 }),
    sampleOffsetsMs: [0],
    extensionOffsetsMs: [1_000],
  });
  const result = await service.selectBestFrame({
    camera: "Cam146",
    timestamp: new Date(base),
    plateBox: [700, 360, 780, 410],
  });
  assert.equal(result.best.offsetMs, 1_000);
  assert.equal(result.sampledCount, 2);
  assert.equal(result.expandedSampling, true);
});

test("a still-weak extended result triggers a sparse deep search for a better production-score view", async () => {
  const frames = new Map([
    [0, { confidence: 0.58, area: 0.06, left: 0, top: 0.1, right: 0.3, bottom: 0.3 }],
    [1_000, { confidence: 0.6, area: 0.07, left: 0.01, top: 0.03, right: 0.36, bottom: 0.35 }],
    [4_000, { confidence: 0.86, area: 0.3, left: 0.08, top: 0.08, right: 0.76, bottom: 0.76 }],
  ]);
  const base = Date.parse("2026-07-22T17:46:50Z");
  const service = new BlueIrisVehicleFrameService({
    client: {
      async fetchTimelineJpeg({ timestamp }) {
        const offset = new Date(timestamp).getTime() - base;
        return { buffer: Buffer.from(String(offset)), timestamp: new Date(timestamp).toISOString() };
      },
    },
    repository: {},
    fileStorage: {},
    detector: {
      async detect(buffer, dimensions) {
        const detection = frames.get(Number(buffer.toString())) || null;
        return detection ? { ...detection, containsPlate: Boolean(dimensions.plateBox), selectionScore: 1 } : null;
      },
    },
    imageProcessor: (buffer) => ({
      buffer,
      rotate() { return this; },
      jpeg() { return this; },
      async toBuffer() { return this.buffer; },
      async metadata() { return { width: 1280, height: 720 }; },
      async stats() { return { entropy: 3, channels: [{ stdev: 20 }, { stdev: 20 }, { stdev: 20 }] }; },
    }),
    qualityAnalyzer: async () => ({ sharpnessScore: 0.8, exposureScore: 0.8, contrastScore: 0.8 }),
    sampleOffsetsMs: [0],
    extensionOffsetsMs: [1_000],
    deepExtensionOffsetsMs: [4_000],
  });

  const result = await service.selectBestFrame({
    camera: "Cam146",
    timestamp: new Date(base),
    plateBox: [700, 360, 780, 410],
  });
  assert.equal(result.best.offsetMs, 4_000);
  assert.equal(result.sampledCount, 3);
  assert.equal(result.deepExpandedSampling, true);
});

test("Blue Iris no-video cards are rejected without rejecting normal frames", () => {
  assert.equal(isLikelyBlueIrisPlaceholder({
    entropy: 0.59,
    channels: [{ stdev: 6.6 }, { stdev: 6.6 }, { stdev: 6.6 }],
  }), true);
  assert.equal(isLikelyBlueIrisPlaceholder({
    entropy: 3.2,
    channels: [{ stdev: 31 }, { stdev: 29 }, { stdev: 28 }],
  }), false);
});

test("bounded selection retains only the highest-scoring vehicle frame", async () => {
  const frames = new Map([
    [-1_000, { confidence: 0.99, area: 0.08, left: 0, top: 0.2, right: 0.3, bottom: 0.6 }],
    [0, { confidence: 0.9, area: 0.3, left: 0.1, top: 0.1, right: 0.8, bottom: 0.8 }],
    [1_000, { confidence: 0.85, area: 0.2, left: 0.1, top: 0.1, right: 0.7, bottom: 0.7 }],
  ]);
  const base = Date.parse("2026-07-22T17:46:50Z");
  const service = new BlueIrisVehicleFrameService({
    client: {
      async fetchTimelineJpeg({ timestamp }) {
        const offset = new Date(timestamp).getTime() - base;
        return { buffer: Buffer.from(String(offset)), timestamp: new Date(timestamp).toISOString() };
      },
    },
    repository: {},
    fileStorage: {},
    detector: {
      async detect(buffer) { return frames.get(Number(buffer.toString())) || null; },
    },
    imageProcessor: () => ({
      rotate() { return this; },
      jpeg() { return this; },
      async toBuffer() { return this.buffer || Buffer.from("normalized"); },
      async metadata() { return { width: 1280, height: 720 }; },
    }),
    sampleOffsetsMs: [-1_000, 0, 1_000],
  });
  // Preserve each fetched marker through the injectable image processor.
  service.imageProcessor = (buffer) => ({
    buffer,
    rotate() { return this; },
    jpeg() { return this; },
    async toBuffer() { return this.buffer; },
    async metadata() { return { width: 1280, height: 720 }; },
    async stats() { return { entropy: 3, channels: [{ stdev: 20 }, { stdev: 20 }, { stdev: 20 }] }; },
  });

  const result = await service.selectBestFrame({ camera: "Cam146", timestamp: new Date(base) });
  assert.equal(result.best.offsetMs, 0);
  assert.equal(result.sampledCount, 3);
  assert.equal(result.detectedCount, 3);
});

test("successful processing saves one frame before replacing the prior derived image", async () => {
  const operations = [];
  let selectionRequest = null;
  const service = new BlueIrisVehicleFrameService({
    client: {},
    repository: {
      async findNearestRead() {
        return {
          id: 42,
          plate_number: "ERGW43",
          camera_name: "Street LPR 2",
          timestamp: "2026-07-22T17:46:50.000Z",
          crop_coordinates: [700, 360, 780, 410],
          vehicle_image_path: "derived/old.jpg",
        };
      },
      async markPending(id) { operations.push(["pending", id]); },
      async markReady(id, frame) { operations.push(["ready", id, frame.framePath]); },
      async markFailed() { assert.fail("successful processing must not mark the read failed"); },
    },
    fileStorage: {
      async saveDerivedImage(framePath) { operations.push(["save", framePath]); },
      async deleteImage(framePath) { operations.push(["delete", framePath]); },
    },
  });
  service.selectBestFrame = async (request) => {
    selectionRequest = request;
    return {
      best: {
        buffer: Buffer.from("jpeg"),
        timestamp: "2026-07-22T17:46:52.000Z",
        offsetMs: 2_000,
        score: 0.91,
        quality: { sharpnessScore: 0.85 },
        scoreBreakdown: { completenessTier: 2 },
        detection: { confidence: 0.88, left: 0.1, top: 0.1, right: 0.9, bottom: 0.9 },
        width: 1280,
        height: 720,
      },
      sampledCount: 8,
      detectedCount: 6,
      trackedCount: 5,
      anchorOffsetMs: 0,
      expandedSampling: false,
    };
  };

  const result = await service.processNearestRead({
    camera: "Cam146",
    cameraName: "Street LPR 2",
    timestamp: "2026-07-22T17:46:50.000Z",
  });

  assert.equal(result.status, "ready");
  assert.equal(result.sampledCount, 8);
  assert.deepEqual(selectionRequest.plateBox, [700, 360, 780, 410]);
  assert.deepEqual(operations.map((operation) => operation[0]), ["pending", "save", "ready", "delete"]);
  assert.equal(operations.at(-1)[1], "derived/old.jpg");
});

test("overview processing retains one plate-independent candidate frame", async () => {
  const operations = [];
  let selectionRequest = null;
  const service = new BlueIrisVehicleFrameService({
    client: {},
    repository: {
      async markOverviewCandidateReady(id, frame) {
        operations.push(["ready", id, frame]);
      },
      async markOverviewCandidateFailed() {
        assert.fail("a successful overview candidate must not fail");
      },
    },
    fileStorage: {
      async saveDerivedImage(framePath) { operations.push(["save", framePath]); },
      async deleteImage() { assert.fail("a retained candidate must not be deleted"); },
    },
  });
  service.selectBestFrame = async (request) => {
    selectionRequest = request;
    return {
      best: {
        buffer: Buffer.from("overview"),
        timestamp: "2026-08-08T18:00:05.500Z",
        offsetMs: 500,
        score: 0.93,
        quality: { sharpnessScore: 0.9 },
        scoreBreakdown: { completenessTier: 3 },
        detection: { confidence: 0.91, left: 0.05, top: 0.05, right: 0.95, bottom: 0.95 },
        width: 1920,
        height: 1080,
      },
      sampledCount: 61,
      detectedCount: 9,
      trackedCount: 0,
      anchorOffsetMs: null,
      selectionReason: "production_baseline",
    };
  };

  const result = await service.processOverviewCandidate({
    candidate: {
      id: 501,
      source_camera_name: "Street Overview",
      event_timestamp: "2026-08-08T18:00:05.000Z",
    },
    camera: "Cam149",
    alreadyClaimed: true,
  });

  assert.equal(result.status, "ready");
  assert.equal(selectionRequest.plateBox, null);
  assert.equal(operations[0][0], "save");
  assert.equal(operations[1][0], "ready");
  assert.equal(operations[1][2].sampledCount, 61);
  assert.match(operations[1][2].selectionMetadata.algorithm, /overview-100ms$/);
});

test("read-owned overview processing applies the signed profile delta and saves directly to the plate read", async () => {
  const operations = [];
  let selectionRequest = null;
  const service = new BlueIrisVehicleFrameService({
    client: {},
    repository: {
      async markReady(id, frame, options) { operations.push(["ready", id, frame, options]); return { id }; },
      async markFailed() { assert.fail("a successful read-owned overview must not fail"); },
    },
    fileStorage: {
      async saveDerivedImageAtomic(framePath) { operations.push(["save", framePath]); },
      async deleteImage() {},
    },
    sampleOffsetsMs: OVERVIEW_VEHICLE_FRAME_SAMPLE_OFFSETS_MS,
    extensionOffsetsMs: [],
    deepExtensionOffsetsMs: [],
  });
  service.selectBestFrame = async (request) => {
    selectionRequest = request;
    return {
      best: {
        buffer: Buffer.from("overview"),
        timestamp: "2026-08-08T18:00:05.000Z",
        offsetMs: 500,
        score: 0.93,
        quality: { sharpnessScore: 0.9 },
        scoreBreakdown: { completenessTier: 3 },
        detection: { confidence: 0.91, left: 0.05, top: 0.05, right: 0.95, bottom: 0.95 },
        width: 1920,
        height: 1080,
      },
      sampledCount: 61,
      detectedCount: 8,
      trackedCount: 5,
      anchorOffsetMs: 0,
      selectionReason: "overview_anchor_track",
      telemetry: { successfulSampleCount: 61 },
    };
  };
  service.refetchOverviewFrame = async ({ camera, selected }) => {
    assert.equal(camera, "Cam149");
    assert.equal(selected.timestamp, "2026-08-08T18:00:05.000Z");
    return {
      buffer: Buffer.from("maximum-resolution-overview"),
      timestamp: selected.timestamp,
      width: 3840,
      height: 2160,
      identitySimilarity: 0.99,
      detectionOverlap: 0.96,
      detectionContinuity: 0.98,
      mode: "maximum_resolution",
    };
  };

  const result = await service.processOverviewRead({
    read: {
      id: 701,
      plate_number: "ABC123",
      camera_name: "Street LPR 2",
      timestamp: "2026-08-08T18:00:00.000Z",
      bi_trigger_direction_label: "Eastbound",
      vehicle_image_claim_token: "11111111-1111-4111-8111-111111111111",
      vehicle_image_attempt_count: 1,
    },
    profile: {
      id: 42,
      source_camera_name: "Street Overview",
      expected_delta_ms: 4_500,
      tolerance_ms: 2_000,
      updated_at: "2026-08-08T17:55:00.000Z",
    },
    camera: "Cam149",
    alreadyClaimed: true,
  });

  assert.equal(result.status, "ready");
  assert.equal(selectionRequest.camera, "Cam149");
  assert.equal(selectionRequest.timestamp, "2026-08-08T18:00:04.500Z");
  assert.equal(selectionRequest.plateBox, null);
  assert.equal(selectionRequest.selectionMode, "overview_anchor");
  assert.equal(selectionRequest.anchorToleranceMs, 2_000);
  assert.deepEqual(
    [selectionRequest.sampleOffsetsMs.length, selectionRequest.sampleOffsetsMs[0], selectionRequest.sampleOffsetsMs.at(-1)],
    [61, -2_000, 4_000]
  );
  assert.equal(selectionRequest.requireColor, true);
  assert.equal(operations[1][0], "ready");
  assert.equal(operations[1][1], 701);
  assert.equal(operations[1][2].sourceKind, "overview_primary");
  assert.equal(operations[1][2].selectionMetadata.sourceCameraName, "Street Overview");
  assert.equal(operations[1][2].selectionMetadata.expectedDeltaMs, 4_500);
  assert.equal(operations[1][2].imageWidth, 3840);
  assert.equal(operations[1][2].selectionMetadata.finalImage.mode, "maximum_resolution");
  assert.equal(operations[1][3].claimToken, "11111111-1111-4111-8111-111111111111");
  assert.deepEqual(operations[1][3].profileSnapshot, {
    id: 42,
    updatedAt: "2026-08-08T17:55:00.000Z",
  });
  assert.match(operations[0][1], /blue_iris_vehicle_read_701_11111111111141118111111111111111\.jpg$/);
});

test("expired recording becomes terminal without writing or deleting an image", async () => {
  const operations = [];
  const service = new BlueIrisVehicleFrameService({
    client: {},
    repository: {
      async findNearestRead() {
        return {
          id: 43,
          plate_number: "DPF020",
          camera_name: "Street LPR 2",
          timestamp: "2026-04-01T17:46:50.000Z",
          vehicle_image_path: null,
        };
      },
      async markPending(id) { operations.push(["pending", id]); },
      async markReady() { assert.fail("expired recording must not become ready"); },
      async markFailed(id, failure) { operations.push(["failed", id, failure]); },
    },
    fileStorage: {
      async saveDerivedImage() { assert.fail("expired recording must not write a frame"); },
      async deleteImage() { assert.fail("expired recording must not delete a frame"); },
    },
  });
  service.selectBestFrame = async () => {
    throw new BlueIrisError("RECORDING_UNAVAILABLE", "Recording has expired.");
  };

  const result = await service.processNearestRead({
    camera: "Cam146",
    cameraName: "Street LPR 2",
    timestamp: "2026-04-01T17:46:50.000Z",
  });

  assert.equal(result.status, "unavailable");
  assert.deepEqual(operations, [
    ["pending", 43],
    ["failed", 43, { status: "unavailable", errorCode: "RECORDING_UNAVAILABLE", retryable: false }],
  ]);
});
