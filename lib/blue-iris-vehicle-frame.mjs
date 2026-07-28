import path from "node:path";

import sharp from "sharp";

import { BlueIrisError } from "./blue-iris.mjs";
import { vehicleReidEngine } from "./vehicle-reid.mjs";

export const VEHICLE_FRAME_SAMPLE_OFFSETS_MS = Object.freeze([
  -2_000, -1_500, -1_000, -500, 0, 500, 1_000, 1_500, 2_000,
  2_500, 3_000, 3_500, 4_000, 4_500, 5_000, 5_500, 6_000,
]);

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function scoreVehicleFrame(detection) {
  if (!detection) return null;
  const confidence = clamp(Number(detection.confidence) || 0, 0, 1);
  const area = clamp(Number(detection.area) || 0, 0, 1);
  const edgeMargin = Math.min(
    clamp(Number(detection.left) || 0, 0, 1),
    clamp(Number(detection.top) || 0, 0, 1),
    clamp(1 - Number(detection.right), 0, 1),
    clamp(1 - Number(detection.bottom), 0, 1)
  );
  const completeness = clamp(edgeMargin / 0.04, 0, 1);
  return Number((confidence * 0.35 + Math.sqrt(area) * 0.45 + completeness * 0.2).toFixed(6));
}

function detectionBox(detection) {
  return {
    left: Number(detection.left.toFixed(6)),
    top: Number(detection.top.toFixed(6)),
    right: Number(detection.right.toFixed(6)),
    bottom: Number(detection.bottom.toFixed(6)),
  };
}

export function isLikelyBlueIrisPlaceholder(stats) {
  const entropy = Number(stats?.entropy);
  const deviations = Array.isArray(stats?.channels)
    ? stats.channels.slice(0, 3).map((channel) => Number(channel?.stdev)).filter(Number.isFinite)
    : [];
  if (!Number.isFinite(entropy) || deviations.length < 3) return false;

  const averageDeviation = deviations.reduce((sum, value) => sum + value, 0) / deviations.length;
  // Blue Iris returns a valid JPEG containing a nearly-flat gray "No video"
  // card when a requested timeline position cannot be decoded. Reject that
  // placeholder before object detection so it cannot win as a false vehicle.
  return entropy < 1 && averageDeviation < 12;
}

function derivedPath(read, frameTimestamp) {
  const date = new Date(frameTimestamp);
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return path.posix.join("derived", year, month, day, `blue_iris_vehicle_read_${read.id}.jpg`);
}

export class BlueIrisVehicleFrameService {
  constructor({
    client,
    repository,
    fileStorage,
    detector = vehicleReidEngine,
    imageProcessor = sharp,
    sampleOffsetsMs = VEHICLE_FRAME_SAMPLE_OFFSETS_MS,
  }) {
    this.client = client;
    this.repository = repository;
    this.fileStorage = fileStorage;
    this.detector = detector;
    this.imageProcessor = imageProcessor;
    this.sampleOffsetsMs = [...sampleOffsetsMs];
  }

  async selectBestFrame({ camera, timestamp }) {
    const baseMs = new Date(timestamp).getTime();
    if (!Number.isFinite(baseMs)) throw new Error("A valid plate-read timestamp is required.");
    const candidates = [];
    const failures = [];

    for (const offsetMs of this.sampleOffsetsMs) {
      try {
        const frame = await this.client.fetchTimelineJpeg({
          camera,
          timestamp: new Date(baseMs + offsetMs),
        });
        const oriented = await this.imageProcessor(frame.buffer).rotate().jpeg({ quality: 88 }).toBuffer();
        const metadata = await this.imageProcessor(oriented).metadata();
        if (!metadata.width || !metadata.height) throw new Error("Blue Iris frame dimensions are unavailable.");
        const stats = await this.imageProcessor(oriented).stats();
        if (isLikelyBlueIrisPlaceholder(stats)) {
          throw new BlueIrisError(
            "RECORDING_UNAVAILABLE",
            "Blue Iris returned a no-video placeholder for this sample."
          );
        }
        const detection = await this.detector.detect(oriented, {
          imageWidth: metadata.width,
          imageHeight: metadata.height,
        });
        const score = scoreVehicleFrame(detection);
        if (score !== null) {
          candidates.push({
            buffer: oriented,
            timestamp: frame.timestamp,
            offsetMs,
            width: metadata.width,
            height: metadata.height,
            detection,
            score,
          });
        }
      } catch (error) {
        failures.push(error);
      }
    }

    candidates.sort((left, right) => right.score - left.score || left.offsetMs - right.offsetMs);
    if (candidates[0]) {
      return { best: candidates[0], sampledCount: this.sampleOffsetsMs.length, detectedCount: candidates.length };
    }
    const unavailable = failures.length === this.sampleOffsetsMs.length
      && failures.every((error) => error?.code === "RECORDING_UNAVAILABLE");
    if (unavailable) {
      throw new BlueIrisError(
        "RECORDING_UNAVAILABLE",
        "Blue Iris no longer has viewable recording data around this plate read."
      );
    }
    if (failures.length === this.sampleOffsetsMs.length) throw failures[0];
    throw new BlueIrisError(
      "VEHICLE_NOT_VISIBLE",
      "No complete vehicle was detected in the bounded Blue Iris sample window."
    );
  }

  async processNearestRead({ camera, cameraName, timestamp, toleranceSeconds = 3 }) {
    const read = await this.repository.findNearestRead({
      cameraName,
      timestamp,
      toleranceSeconds,
    });
    if (!read) {
      return {
        status: "read_not_found",
        errorCode: "READ_NOT_FOUND",
        message: "No ALPR read from this camera matched the selected time closely enough to own the vehicle image.",
      };
    }

    return this.processRead({ read, camera });
  }

  async processRead({ read, camera, alreadyClaimed = false }) {
    if (!read?.id || !read?.timestamp) {
      throw new Error("A persisted plate read is required for vehicle-frame processing.");
    }

    if (!alreadyClaimed) await this.repository.markPending(read.id);
    try {
      const selected = await this.selectBestFrame({ camera, timestamp: read.timestamp });
      const framePath = derivedPath(read, selected.best.timestamp);
      await this.fileStorage.saveDerivedImage(framePath, selected.best.buffer);
      const previousPath = read.vehicle_image_path;
      try {
        await this.repository.markReady(read.id, {
          framePath,
          frameTimestamp: selected.best.timestamp,
          frameScore: selected.best.score,
          detectionConfidence: selected.best.detection.confidence,
          detectionBox: detectionBox(selected.best.detection),
          imageWidth: selected.best.width,
          imageHeight: selected.best.height,
          sampledCount: selected.sampledCount,
        });
      } catch (error) {
        await this.fileStorage.deleteImage(framePath, null);
        throw error;
      }
      if (previousPath && previousPath !== framePath) {
        await this.fileStorage.deleteImage(previousPath, null);
      }
      return {
        status: "ready",
        readId: Number(read.id),
        plateNumber: read.plate_number,
        cameraName: read.camera_name,
        readTimestamp: new Date(read.timestamp).toISOString(),
        imageUrl: `/images/${framePath.replaceAll("\\", "/")}`,
        frameTimestamp: selected.best.timestamp,
        frameScore: selected.best.score,
        sampledCount: selected.sampledCount,
        detectedCount: selected.detectedCount,
      };
    } catch (error) {
      const terminal = ["RECORDING_UNAVAILABLE", "VEHICLE_NOT_VISIBLE"].includes(error?.code);
      await this.repository.markFailed(read.id, {
        status: terminal ? "unavailable" : "failed",
        errorCode: error?.code || "FRAME_SELECTION_FAILED",
        retryable: !terminal,
      });
      return {
        status: terminal ? "unavailable" : "failed",
        readId: Number(read.id),
        errorCode: error?.code || "FRAME_SELECTION_FAILED",
        message: error instanceof BlueIrisError
          ? error.message
          : "Unable to analyze the sampled Blue Iris frames.",
      };
    }
  }
}

export const blueIrisVehicleFrameInternals = Object.freeze({ derivedPath, detectionBox });
