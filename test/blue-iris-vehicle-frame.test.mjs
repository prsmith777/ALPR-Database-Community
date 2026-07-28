import assert from "node:assert/strict";
import test from "node:test";

import {
  BlueIrisVehicleFrameService,
  scoreVehicleFrame,
} from "../lib/blue-iris-vehicle-frame.mjs";
import { BlueIrisError } from "../lib/blue-iris.mjs";

test("vehicle-frame scoring favors a complete, larger vehicle over an edge-truncated one", () => {
  const complete = scoreVehicleFrame({ confidence: 0.82, area: 0.35, left: 0.1, top: 0.1, right: 0.8, bottom: 0.8 });
  const truncated = scoreVehicleFrame({ confidence: 0.99, area: 0.12, left: 0, top: 0.2, right: 0.4, bottom: 0.7 });
  assert.ok(complete > truncated);
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
  });

  const result = await service.selectBestFrame({ camera: "Cam146", timestamp: new Date(base) });
  assert.equal(result.best.offsetMs, 0);
  assert.equal(result.sampledCount, 3);
  assert.equal(result.detectedCount, 3);
});

test("successful processing saves one frame before replacing the prior derived image", async () => {
  const operations = [];
  const service = new BlueIrisVehicleFrameService({
    client: {},
    repository: {
      async findNearestRead() {
        return {
          id: 42,
          plate_number: "ERGW43",
          camera_name: "Street LPR 2",
          timestamp: "2026-07-22T17:46:50.000Z",
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
  service.selectBestFrame = async () => ({
    best: {
      buffer: Buffer.from("jpeg"),
      timestamp: "2026-07-22T17:46:52.000Z",
      score: 0.91,
      detection: { confidence: 0.88, left: 0.1, top: 0.1, right: 0.9, bottom: 0.9 },
      width: 1280,
      height: 720,
    },
    sampledCount: 8,
    detectedCount: 6,
  });

  const result = await service.processNearestRead({
    camera: "Cam146",
    cameraName: "Street LPR 2",
    timestamp: "2026-07-22T17:46:50.000Z",
  });

  assert.equal(result.status, "ready");
  assert.equal(result.sampledCount, 8);
  assert.deepEqual(operations.map((operation) => operation[0]), ["pending", "save", "ready", "delete"]);
  assert.equal(operations.at(-1)[1], "derived/old.jpg");
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
