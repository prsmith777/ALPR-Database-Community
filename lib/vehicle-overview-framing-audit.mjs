import fs from "node:fs/promises";

import sharp from "sharp";

import { analyzeVehicleFrameQuality } from "./blue-iris-vehicle-frame.mjs";
import { vehicleReidEngine } from "./vehicle-reid.mjs";

function clamp(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function normalizedBox(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const box = {
    left: Number(value.left),
    top: Number(value.top),
    right: Number(value.right),
    bottom: Number(value.bottom),
  };
  if (!Object.values(box).every(Number.isFinite)
    || box.left < 0 || box.top < 0 || box.right > 1 || box.bottom > 1
    || box.right <= box.left || box.bottom <= box.top) return null;
  return box;
}

function area(box) {
  return box ? Math.max(0, box.right - box.left) * Math.max(0, box.bottom - box.top) : 0;
}

function overlap(left, right) {
  if (!left || !right) return 0;
  const intersection = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left))
    * Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
  const union = area(left) + area(right) - intersection;
  return union > 0 ? intersection / union : 0;
}

function edgeMargin(box) {
  return box ? Math.min(box.left, box.top, 1 - box.right, 1 - box.bottom) : 0;
}

function edgeContacts(box, threshold = 0.005) {
  if (!box) return 4;
  return [box.left, box.top, 1 - box.right, 1 - box.bottom]
    .filter((margin) => margin < threshold).length;
}

function completenessTier(box) {
  const margin = edgeMargin(box);
  if (margin >= 0.04) return 3;
  if (margin >= 0.015) return 2;
  if (margin >= 0.005) return 1;
  return 0;
}

function auditError(error) {
  return {
    code: String(error?.code || "OVERVIEW_AUDIT_FAILED").slice(0, 80),
    message: String(error?.message || "Unable to inspect the saved Overview image.").slice(0, 300),
  };
}

function preferredDetection(detections, storedBox) {
  const candidates = detections.map((detection) => ({
    detection,
    box: normalizedBox(detection),
    confidence: clamp(detection?.confidence),
  })).filter((candidate) => candidate.box);
  if (!candidates.length) return { selected: null, candidates: [] };
  const ordered = [...candidates].sort((left, right) => {
    const leftOverlap = storedBox ? overlap(storedBox, left.box) : 0;
    const rightOverlap = storedBox ? overlap(storedBox, right.box) : 0;
    return rightOverlap - leftOverlap
      || right.confidence - left.confidence
      || area(right.box) - area(left.box);
  });
  return { selected: ordered[0], candidates };
}

export class VehicleOverviewFramingAuditService {
  constructor({
    repository,
    fileStorage,
    detector = vehicleReidEngine,
    imageProcessor = sharp,
    qualityAnalyzer = analyzeVehicleFrameQuality,
    loadImage = null,
  } = {}) {
    if (!repository || !fileStorage || !detector) {
      throw new Error("Overview framing audit dependencies are required");
    }
    this.repository = repository;
    this.fileStorage = fileStorage;
    this.detector = detector;
    this.imageProcessor = imageProcessor;
    this.qualityAnalyzer = qualityAnalyzer;
    this.loadImage = loadImage || (async (imagePath) => {
      const fullPath = await this.fileStorage.resolveExistingImagePath(imagePath);
      return fs.readFile(fullPath);
    });
  }

  async auditRead(read) {
    try {
      const buffer = await this.loadImage(read.vehicle_image_path);
      const metadata = await this.imageProcessor(buffer).metadata();
      const width = Number(metadata?.width);
      const height = Number(metadata?.height);
      if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
        const error = new Error("Saved Overview dimensions are unavailable");
        error.code = "OVERVIEW_AUDIT_IMAGE_INVALID";
        throw error;
      }
      const dimensions = { imageWidth: width, imageHeight: height, plateBox: null };
      const detections = typeof this.detector.detectAll === "function"
        ? await this.detector.detectAll(buffer, dimensions)
        : [await this.detector.detect(buffer, dimensions)].filter(Boolean);
      const storedBox = normalizedBox(read.vehicle_image_detection_box);
      const { selected, candidates } = preferredDetection(detections || [], storedBox);
      if (!selected) {
        return this.result(read, {
          width,
          height,
          classification: "no_vehicle_detected",
          needsReview: true,
          reasons: ["NO_VEHICLE_DETECTED"],
          actualBox: null,
          storedBox,
        });
      }
      const margin = edgeMargin(selected.box);
      const contacts = edgeContacts(selected.box);
      const tier = completenessTier(selected.box);
      const geometryOverlap = storedBox ? overlap(storedBox, selected.box) : null;
      const quality = await this.qualityAnalyzer({
        imageProcessor: this.imageProcessor,
        buffer,
        detection: selected.detection,
        width,
        height,
      });
      const plausibleDetections = candidates.filter((candidate) => (
        candidate.confidence >= 0.55 && area(candidate.box) >= 0.01
      )).length;
      const reasons = [];
      if (contacts > 0 || tier === 0) reasons.push("VEHICLE_TOUCHES_IMAGE_EDGE");
      else if (tier === 1) reasons.push("VEHICLE_FRAMING_TOO_TIGHT");
      else if (tier === 2) reasons.push("VEHICLE_FRAMING_REVIEW");
      if (storedBox && geometryOverlap < 0.4) reasons.push("STORED_GEOMETRY_MISMATCH");
      if (plausibleDetections > 1) reasons.push("MULTIPLE_VEHICLES_DETECTED");
      if (Number(quality?.sharpnessScore || 0) < 0.25) reasons.push("LOW_SHARPNESS");
      if (Number(quality?.exposureScore || 0) < 0.2) reasons.push("POOR_EXPOSURE");
      const unacceptable = reasons.some((reason) => [
        "VEHICLE_TOUCHES_IMAGE_EDGE",
        "VEHICLE_FRAMING_TOO_TIGHT",
        "STORED_GEOMETRY_MISMATCH",
        "LOW_SHARPNESS",
        "POOR_EXPOSURE",
      ].includes(reason));
      return this.result(read, {
        width,
        height,
        classification: unacceptable ? "unacceptable" : reasons.length ? "review" : "acceptable",
        needsReview: reasons.length > 0,
        reasons,
        actualBox: selected.box,
        storedBox,
        detectionConfidence: selected.confidence,
        completenessTier: tier,
        edgeMargin: Number(margin.toFixed(6)),
        edgeContacts: contacts,
        geometryOverlap: geometryOverlap == null ? null : Number(geometryOverlap.toFixed(6)),
        plausibleDetections,
        quality,
      });
    } catch (error) {
      return this.result(read, {
        classification: "audit_failed",
        needsReview: true,
        reasons: ["AUDIT_FAILED"],
        error: auditError(error),
      });
    }
  }

  result(read, details) {
    return {
      readId: Number(read.id),
      plateNumber: read.plate_number || "",
      cameraName: read.camera_name || "",
      timestamp: read.timestamp || null,
      sourceKind: read.vehicle_image_source_kind || null,
      imageUrl: `/images/${String(read.vehicle_image_path || "").replaceAll("\\", "/")}`,
      readUrl: `/live_feed?readId=${encodeURIComponent(read.id)}`,
      ...details,
    };
  }

  async auditBatch({ afterReadId = 0, maxReadId = null, limit = 10 } = {}) {
    const candidates = await this.repository.listOverviewFramingAuditCandidates({
      afterReadId,
      maxReadId,
      limit,
    });
    const items = [];
    for (const read of candidates.reads || []) items.push(await this.auditRead(read));
    return {
      maxReadId: Number(candidates.maxReadId || 0),
      total: Number(candidates.total || 0),
      remaining: Number(candidates.remaining || 0),
      nextCursor: items.length ? items.at(-1).readId : Number(afterReadId || 0),
      inspected: items.length,
      flagged: items.filter((item) => item.needsReview).length,
      unacceptable: items.filter((item) => item.classification === "unacceptable").length,
      failures: items.filter((item) => item.classification === "audit_failed").length,
      items,
    };
  }
}

export const vehicleOverviewFramingAuditInternals = Object.freeze({
  completenessTier,
  edgeContacts,
  edgeMargin,
  normalizedBox,
  overlap,
  preferredDetection,
});
