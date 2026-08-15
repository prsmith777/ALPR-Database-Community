import crypto from "node:crypto";

export const VEHICLE_EVENT_SHADOW_ALGORITHM = "vehicle-event-shadow-v1";
export const VEHICLE_EVENT_SHADOW_REVISION = 1;
export const VEHICLE_EVENT_SHADOW_SETTLE_SECONDS = 20;
export const VEHICLE_EVENT_SHADOW_BATCH_SIZE = 25;

const READ_GAP_MS = Object.freeze({ street: 12_000, entry: 5_000 });
const MAX_CAPTURE_GAP_MS = 1_500;
const IDENTITY_SOURCE_KINDS = new Set([
  "overview_primary",
  "entry_overview_primary",
  "overview_fallback",
  "overview_pair_share",
  "entry_overview_history",
]);

function text(value) {
  return String(value ?? "").trim();
}

function key(value) {
  return text(value).toLocaleLowerCase("en-US");
}

function integer(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function timestampMs(value) {
  const milliseconds = new Date(value).getTime();
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function sha256(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function isCurrentIdentityObservation(row) {
  return Boolean(
    integer(row?.read_id) > 0
    && integer(row?.asset_id) > 0
    && (row?.overview_context === "street" || row?.overview_context === "entry")
    && row?.identity_eligible !== false
    && text(row?.effective_plate)
    && text(row?.read_camera_name)
    && timestampMs(row?.read_timestamp) != null
    && text(row?.source_kind)
    && IDENTITY_SOURCE_KINDS.has(text(row?.source_kind))
    && text(row?.source_path_snapshot)
  );
}

function directionEvidence(row) {
  const ready = row?.direction_status === "ready" && Boolean(text(row?.direction_label));
  return { ready, label: ready ? text(row.direction_label) : null };
}

function comparablePair(anchor, companion) {
  if (!isCurrentIdentityObservation(anchor) || !isCurrentIdentityObservation(companion)) {
    return null;
  }
  if (integer(anchor.read_id) === integer(companion.read_id)) return null;
  if (anchor.overview_context !== companion.overview_context) return null;
  if (key(anchor.effective_plate) !== key(companion.effective_plate)) return null;
  if (key(anchor.read_camera_name) === key(companion.read_camera_name)) return null;

  const anchorReadMs = timestampMs(anchor.read_timestamp);
  const companionReadMs = timestampMs(companion.read_timestamp);
  const readGapMs = Math.abs(companionReadMs - anchorReadMs);
  if (readGapMs > READ_GAP_MS[anchor.overview_context]) return null;

  const anchorDirection = directionEvidence(anchor);
  const companionDirection = directionEvidence(companion);
  if (anchorDirection.ready && companionDirection.ready
      && key(anchorDirection.label) !== key(companionDirection.label)) {
    return { rejected: "CONFLICTING_DIRECTION", readGapMs };
  }

  const sharedAsset = integer(anchor.asset_id) === integer(companion.asset_id);
  if (sharedAsset) {
    return {
      correlationClass: "shared_asset",
      readGapMs,
      captureGapMs: 0,
      directionLabel: anchorDirection.label || companionDirection.label,
      rank: [0, readGapMs],
    };
  }

  if (!anchorDirection.ready || !companionDirection.ready) {
    return { rejected: "DIRECTION_NOT_CORROBORATED", readGapMs };
  }
  const anchorCaptureMs = timestampMs(anchor.captured_at);
  const companionCaptureMs = timestampMs(companion.captured_at);
  if (anchorCaptureMs == null || companionCaptureMs == null) {
    return { rejected: "CAPTURE_TIME_UNAVAILABLE", readGapMs };
  }
  const captureGapMs = Math.abs(companionCaptureMs - anchorCaptureMs);
  if (captureGapMs > MAX_CAPTURE_GAP_MS) {
    return { rejected: "CAPTURE_TIME_OUTSIDE_WINDOW", readGapMs, captureGapMs };
  }
  return {
    correlationClass: "timed_pair",
    readGapMs,
    captureGapMs,
    directionLabel: anchorDirection.label,
    rank: [1, captureGapMs, readGapMs],
  };
}

function decisionSnapshot(row) {
  return {
    readId: integer(row.read_id),
    assetId: integer(row.asset_id),
    sourceKind: text(row.source_kind),
    sourceReadId: integer(row.source_read_id),
    sourcePath: text(row.source_path_snapshot),
    sourceUpdatedAt: row.source_updated_at ?? null,
    capturedAt: row.captured_at ?? null,
    plate: text(row.effective_plate),
    directionStatus: text(row.direction_status) || null,
    directionLabel: text(row.direction_label) || null,
  };
}

export function evaluateShadowPair(anchor, companions = []) {
  if (!isCurrentIdentityObservation(anchor)) {
    return { outcome: "rejected", reason: "ANCHOR_NOT_ELIGIBLE", candidateCount: 0 };
  }
  const evaluated = companions
    .map((companion) => ({ companion, evidence: comparablePair(anchor, companion) }))
    .filter((item) => item.evidence);
  const eligible = evaluated.filter((item) => !item.evidence.rejected);
  if (eligible.length === 0) {
    const rejection = evaluated.find((item) => item.evidence.rejected)?.evidence;
    return {
      outcome: "rejected",
      reason: rejection?.rejected || "NO_CONFIDENT_COMPANION",
      candidateCount: evaluated.length,
      metadata: rejection ? {
        readGapMs: rejection.readGapMs ?? null,
        captureGapMs: rejection.captureGapMs ?? null,
      } : {},
    };
  }

  const sharedAssetCandidates = eligible.filter(
    (item) => item.evidence.correlationClass === "shared_asset"
  );
  const preferred = sharedAssetCandidates.length > 0 ? sharedAssetCandidates : eligible;
  if (preferred.length !== 1) {
    return {
      outcome: "rejected",
      reason: "AMBIGUOUS_COMPANIONS",
      candidateCount: eligible.length,
    };
  }

  const best = preferred[0];
  const companion = best.companion;
  const ordered = [anchor, companion].sort(
    (left, right) => integer(left.read_id) - integer(right.read_id)
  );
  const firstReadMs = Math.min(...ordered.map((row) => timestampMs(row.read_timestamp)));
  const lastReadMs = Math.max(...ordered.map((row) => timestampMs(row.read_timestamp)));
  const identityPayload = {
    algorithm: VEHICLE_EVENT_SHADOW_ALGORITHM,
    revision: VEHICLE_EVENT_SHADOW_REVISION,
    overviewContext: anchor.overview_context,
    reads: ordered.map(decisionSnapshot),
  };
  return {
    outcome: "proposed",
    reason: best.evidence.correlationClass === "shared_asset"
      ? "EXACT_SHARED_ASSET"
      : "CORROBORATED_TIMED_PAIR",
    candidateCount: eligible.length,
    companion,
    event: {
      eventIdentity: sha256(identityPayload),
      overviewContext: anchor.overview_context,
      correlationClass: best.evidence.correlationClass,
      eventTimestamp: new Date(Math.round((firstReadMs + lastReadMs) / 2)).toISOString(),
      firstReadAt: new Date(firstReadMs).toISOString(),
      lastReadAt: new Date(lastReadMs).toISOString(),
      effectivePlateSnapshot: text(anchor.effective_plate),
      directionLabelSnapshot: best.evidence.directionLabel || null,
      correlationAlgorithm: VEHICLE_EVENT_SHADOW_ALGORITHM,
      correlationRevision: VEHICLE_EVENT_SHADOW_REVISION,
      metadata: {
        readGapMs: best.evidence.readGapMs,
        captureGapMs: best.evidence.captureGapMs,
        candidateCount: eligible.length,
        externalProviderContacted: false,
      },
    },
  };
}

export function shadowDecisionIdentity(anchor, evaluation) {
  return sha256({
    algorithm: VEHICLE_EVENT_SHADOW_ALGORITHM,
    revision: VEHICLE_EVENT_SHADOW_REVISION,
    anchor: decisionSnapshot(anchor),
    companion: evaluation?.companion ? decisionSnapshot(evaluation.companion) : null,
    outcome: evaluation?.outcome || "rejected",
    reason: evaluation?.reason || "UNKNOWN",
  });
}

export const vehicleEventShadowModelInternals = Object.freeze({
  READ_GAP_MS,
  MAX_CAPTURE_GAP_MS,
  IDENTITY_SOURCE_KINDS,
  comparablePair,
  decisionSnapshot,
  timestampMs,
});
