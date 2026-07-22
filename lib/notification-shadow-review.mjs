import { createHash } from "node:crypto";

import { evaluateMqttRule } from "./mqtt/rule-engine.mjs";
import { normalizePlate } from "./mqtt/plate-normalize.mjs";
import { evaluateNotificationRule } from "./notification-rule-engine.mjs";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function sourceSemantics(entry, read, knownPlates, matchingSettings) {
  if (entry.sourceType === "pushover") {
    const expected = normalizePlate(entry.sourceRule?.plate_number);
    const actual = normalizePlate(read.plate_number || read.observed_plate);
    const matched = Boolean(expected && actual && expected === actual);
    return {
      matched,
      reason: matched ? "plate-matched" : "plate-mismatch",
      matchedPlateNumber: matched ? actual : "",
    };
  }

  return evaluateMqttRule(
    { ...entry.sourceRule, enabled: true },
    {
      // The live legacy MQTT service receives the effective plate identity
      // after alias resolution, even though the immutable observation is also
      // retained on the read for audit and review.
      observedPlate: read.plate_number || read.observed_plate,
      camera: {
        id: read.mqtt_camera_id,
        cameraName: read.camera_name,
        cameraKey: read.camera_key,
      },
      knownPlates,
      matchingSettings,
    }
  );
}

function unifiedSemantics(entry, read, matchingSettings) {
  const event = {
    id: read.id,
    type: "plate_read.accepted",
    plateNumber: read.plate_number,
    effectivePlate: read.plate_number,
    observedPlate: read.observed_plate,
    timestamp: read.timestamp,
    cameraName: read.camera_name,
    confidence: read.confidence,
    knownPlate: Boolean(read.known_plate),
    knownName: read.known_name || "",
    tags: asArray(read.tags),
    watchlisted: Boolean(read.watchlisted),
  };

  return evaluateNotificationRule(
    {
      ...entry.targetRule,
      enabled: true,
      eventTypes: [entry.targetRule.eventType || "plate_read.accepted"],
      actions: asArray(entry.targetRule.actions).map((action) => ({
        ...action,
        enabled: false,
      })),
    },
    { event, now: event.timestamp, matchingSettings }
  );
}

function relevantReads(entry, reads) {
  if (entry.sourceType !== "mqtt") return reads;
  const cameraIds = asArray(entry.sourceRule?.camera_ids).map(String);
  if (cameraIds.length === 0) return reads;
  return reads.filter(
    (read) => read.mqtt_camera_id != null && cameraIds.includes(String(read.mqtt_camera_id))
  );
}

function fingerprintFor(ruleId, version, decisions) {
  const evidence = decisions.map((decision) => ({
    readId: decision.readId,
    legacyMatched: decision.legacyMatched,
    unifiedMatched: decision.unifiedMatched,
    agreement: decision.agreement,
  }));
  return createHash("sha256")
    .update(JSON.stringify({ ruleId: String(ruleId), version: Number(version), evidence }))
    .digest("hex");
}

function latestReviewByRule(reviews) {
  const result = new Map();
  for (const review of reviews) {
    const key = String(review.rule_id);
    if (!result.has(key)) result.set(key, review);
  }
  return result;
}

export function buildNotificationShadowReview({
  entries = [],
  recentReads = [],
  knownPlates = [],
  matchingSettings = {},
  reviews = [],
} = {}) {
  const latestReviews = latestReviewByRule(reviews);
  const rules = entries.map((entry) => {
    const samples = relevantReads(entry, recentReads);
    const decisions = samples.map((read) => {
      const legacy = sourceSemantics(entry, read, knownPlates, matchingSettings);
      const unified = unifiedSemantics(entry, read, matchingSettings);
      const agreement = Boolean(legacy.matched) === Boolean(unified.matched);
      return {
        readId: read.id,
        timestamp:
          read.timestamp instanceof Date ? read.timestamp.toISOString() : String(read.timestamp),
        plateNumber: read.plate_number || "",
        observedPlate: read.observed_plate || read.plate_number || "",
        cameraName: read.camera_name || "Unknown camera",
        legacyMatched: Boolean(legacy.matched),
        legacyReason: legacy.reason,
        unifiedMatched: Boolean(unified.matched),
        unifiedReason: unified.reason,
        unifiedOutcome: unified.outcome,
        agreement,
        trace: unified.trace,
      };
    });
    const mismatchCount = decisions.filter((decision) => !decision.agreement).length;
    const agreementCount = decisions.length - mismatchCount;
    const positiveMatchCount = decisions.filter(
      (decision) => decision.legacyMatched && decision.unifiedMatched
    ).length;
    const allDisabled =
      entry.targetRule.enabled === false &&
      asArray(entry.targetRule.actions).every(
        (action) => action.enabled === false && action.channelEnabled === false
      );
    const noDeliveries = decisions.every(
      (decision) => decision.unifiedOutcome !== "matched" || decision.unifiedReason === "no-enabled-actions"
    );
    const fingerprint = fingerprintFor(
      entry.targetRule.id,
      entry.targetRule.version,
      decisions
    );
    const latestReview = latestReviews.get(String(entry.targetRule.id)) || null;
    const currentApproval = Boolean(
      latestReview && latestReview.report_fingerprint === fingerprint
    );
    let status = "ready";
    if (!allDisabled || !noDeliveries) status = "unsafe";
    else if (decisions.length === 0) status = "no_samples";
    else if (mismatchCount > 0) status = "needs_review";
    else if (positiveMatchCount === 0) status = "no_positive_matches";
    else if (currentApproval) status = "approved";

    return {
      sourceType: entry.sourceType,
      sourceId: entry.sourceId,
      sourceName: entry.sourceRule?.name || entry.sourceRule?.plate_number || "Legacy rule",
      sourceEnabled: entry.sourceRule?.enabled !== false,
      migratedAt:
        entry.migratedAt instanceof Date
          ? entry.migratedAt.toISOString()
          : String(entry.migratedAt || ""),
      targetRule: entry.targetRule,
      sampleCount: decisions.length,
      agreementCount,
      mismatchCount,
      positiveMatchCount,
      agreementRate: decisions.length
        ? Math.round((agreementCount / decisions.length) * 10000) / 100
        : null,
      allDisabled,
      noDeliveries,
      status,
      reportFingerprint: fingerprint,
      latestReview: latestReview
        ? {
            id: latestReview.id,
            reviewedAt:
              latestReview.reviewed_at instanceof Date
                ? latestReview.reviewed_at.toISOString()
                : String(latestReview.reviewed_at),
            reviewerName: latestReview.reviewer_name || "Administrator",
            sampleCount: Number(latestReview.sample_count),
            reportFingerprint: latestReview.report_fingerprint,
            current: currentApproval,
          }
        : null,
      decisions: [...decisions].sort((left, right) => Number(left.agreement) - Number(right.agreement)),
    };
  });

  return {
    mode: "read_only_shadow",
    evaluatedReadCount: recentReads.length,
    ruleCount: rules.length,
    agreementCount: rules.reduce((sum, rule) => sum + rule.agreementCount, 0),
    mismatchCount: rules.reduce((sum, rule) => sum + rule.mismatchCount, 0),
    deliveryAttempts: 0,
    rules,
  };
}

export const notificationShadowReviewInternals = Object.freeze({
  fingerprintFor,
  relevantReads,
  sourceSemantics,
  unifiedSemantics,
});
