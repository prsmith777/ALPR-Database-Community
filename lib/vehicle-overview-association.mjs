export const OVERVIEW_ASSOCIATION_ALGORITHM = "blue-iris-overview-association-v1";
export const OVERVIEW_ASSOCIATION_AMBIGUITY_MARGIN = 0.3;
export const OVERVIEW_SAME_EVENT_WINDOW_MS = 12_000;

export function overviewSourceTimestamp(readTimestamp, expectedDeltaMs = 0) {
  const readMs = new Date(readTimestamp).getTime();
  const deltaMs = Number(expectedDeltaMs);
  if (!Number.isFinite(readMs) || !Number.isFinite(deltaMs)) {
    throw new Error("A valid plate-read timestamp and overview timing delta are required.");
  }
  return new Date(readMs + deltaMs).toISOString();
}

export function overviewReadQueueState({ eligibility, directionStatus, directionLabel } = {}) {
  if (eligibility?.monochrome === true) {
    return {
      status: "unavailable",
      queueKind: null,
      retryable: false,
      errorCode: "NIGHTTIME_UNAVAILABLE",
    };
  }
  if (eligibility?.evaluated !== true) {
    return {
      status: "unavailable",
      queueKind: null,
      retryable: false,
      errorCode: "DAYLIGHT_UNVERIFIED",
    };
  }
  if (directionStatus !== "ready" || !String(directionLabel || "").trim()) {
    return {
      status: "unavailable",
      queueKind: null,
      retryable: false,
      errorCode: "OVERVIEW_DIRECTION_UNAVAILABLE",
    };
  }
  return {
    status: "pending",
    queueKind: "overview",
    retryable: true,
    errorCode: "WAITING_FOR_DAYTIME_OVERVIEW",
  };
}

function normalizedText(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizedPlate(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function samePlateEvidence(left, right) {
  const leftEffective = normalizedPlate(left.plate_number);
  const rightEffective = normalizedPlate(right.plate_number);
  if (leftEffective && rightEffective && leftEffective === rightEffective) return true;
  const leftObserved = normalizedPlate(left.observed_plate);
  const rightObserved = normalizedPlate(right.observed_plate);
  return Boolean(leftObserved && rightObserved && leftObserved === rightObserved);
}

function profileForRead(read, profiles) {
  return profiles.find((profile) => (
    normalizedText(profile.plate_camera_name ?? profile.plateCameraName)
      === normalizedText(read.camera_name ?? read.cameraName)
    && normalizedText(profile.direction_label ?? profile.directionLabel)
      === normalizedText(read.bi_trigger_direction_label ?? read.directionLabel)
    && (profile.enabled ?? true) === true
  )) || null;
}

function scoredRead(candidate, read, profile) {
  const eventMs = new Date(candidate.event_timestamp ?? candidate.eventTimestamp).getTime();
  const readMs = new Date(read.timestamp).getTime();
  const expectedDeltaMs = Number(profile.expected_delta_ms ?? profile.expectedDeltaMs ?? 0);
  const toleranceMs = Math.max(250, Number(profile.tolerance_ms ?? profile.toleranceMs ?? 1_500));
  const actualDeltaMs = eventMs - readMs;
  const timingErrorMs = Math.abs(actualDeltaMs - expectedDeltaMs);
  if (!Number.isFinite(eventMs) || !Number.isFinite(readMs) || timingErrorMs > toleranceMs) return null;
  const role = String((profile.source_role ?? profile.sourceRole) || "primary").toLowerCase();
  const priority = Number(profile.priority ?? 0);
  const normalizedTimingError = timingErrorMs / toleranceMs;
  const score = normalizedTimingError + (role === "fallback" ? 0.12 : 0) + Math.max(0, priority) * 0.01;
  return {
    ...read,
    profile,
    actualDeltaMs,
    timingErrorMs,
    normalizedTimingError,
    associationScore: Number(score.toFixed(6)),
  };
}

function compatibleEvent(left, right) {
  if (normalizedText(left.bi_trigger_direction_label ?? left.directionLabel)
      !== normalizedText(right.bi_trigger_direction_label ?? right.directionLabel)) return false;
  const timeGap = Math.abs(new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime());
  return timeGap <= OVERVIEW_SAME_EVENT_WINDOW_MS
    && samePlateEvidence(left, right);
}

function groupScoredReads(reads) {
  const groups = [];
  for (const read of [...reads].sort((left, right) => left.associationScore - right.associationScore)) {
    const group = groups.find((candidate) => candidate.reads.some((existing) => compatibleEvent(existing, read)));
    if (group) {
      group.reads.push(read);
      group.score = Math.min(group.score, read.associationScore);
    } else {
      groups.push({ score: read.associationScore, reads: [read] });
    }
  }
  return groups.sort((left, right) => left.score - right.score);
}

export function chooseOverviewAssociation({
  candidate,
  reads = [],
  profiles = [],
  ambiguityMargin = OVERVIEW_ASSOCIATION_AMBIGUITY_MARGIN,
} = {}) {
  const scored = reads
    .map((read) => {
      const profile = profileForRead(read, profiles);
      return profile ? scoredRead(candidate, read, profile) : null;
    })
    .filter(Boolean);
  const groups = groupScoredReads(scored);
  if (!groups.length) {
    return { status: "unmatched", reads: [], scored, groups, reason: "NO_MATCHING_PLATE_READ" };
  }
  const best = groups[0];
  const runnerUp = groups[1] || null;
  if (runnerUp && runnerUp.score - best.score < ambiguityMargin) {
    return {
      status: "ambiguous",
      reads: [],
      scored,
      groups,
      reason: "MULTIPLE_VEHICLES_MATCH",
      bestScore: best.score,
      runnerUpScore: runnerUp.score,
    };
  }
  return {
    status: "matched",
    reads: best.reads,
    scored,
    groups,
    reason: null,
    bestScore: best.score,
    runnerUpScore: runnerUp?.score ?? null,
  };
}

export function associationMinimumAgeMs(profiles = []) {
  return profiles.length && profiles.every((profile) => (
    String((profile.source_role ?? profile.sourceRole) || "primary").toLowerCase() === "fallback"
  )) ? 30_000 : 12_000;
}

export const vehicleOverviewAssociationInternals = Object.freeze({
  groupScoredReads,
  normalizedPlate,
  normalizedText,
  profileForRead,
  samePlateEvidence,
  scoredRead,
});
