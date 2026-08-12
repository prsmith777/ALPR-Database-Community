import crypto from "node:crypto";
import path from "node:path";

const SAFE_TARGET_ERRORS = new Set([
  "RECORDING_UNAVAILABLE",
  "VEHICLE_NOT_VISIBLE",
]);

const ENTRY_FALLBACK_ALGORITHM = "entry-lpr-route-fallback-v3-guarded-entry-overview";
const ENTRY_FALLBACK_MARGIN = 0.3;
const ENTRY_FALLBACK_GRACE_MS = 5_000;
const MINIMUM_FUZZY_PLATE_LENGTH = 5;

function text(value) {
  return String(value || "").trim();
}

function key(value) {
  return text(value).toLowerCase();
}

function integer(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) && Number.isInteger(number) ? number : fallback;
}

function positiveInteger(value, fallback = null) {
  const number = integer(value);
  return number !== null && number > 0 ? number : fallback;
}

function dateMs(value) {
  const result = new Date(value).getTime();
  return Number.isFinite(result) ? result : null;
}

function normalizedPlate(value) {
  return text(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function confusionPlate(value) {
  const groups = new Map([
    ["0", "O"], ["O", "O"], ["Q", "O"],
    ["1", "I"], ["I", "I"], ["L", "I"],
    ["2", "Z"], ["Z", "Z"],
    ["5", "S"], ["S", "S"],
    ["6", "G"], ["G", "G"],
    ["8", "B"], ["B", "B"],
  ]);
  return [...normalizedPlate(value)].map((character) => groups.get(character) || character).join("");
}

function editDistanceAtMostOne(leftValue, rightValue) {
  const left = confusionPlate(leftValue);
  const right = confusionPlate(rightValue);
  if (!left || !right) return false;
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;
  if (left.length === right.length) {
    let differences = 0;
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index] && ++differences > 1) return false;
    }
    return differences === 1;
  }
  const shorter = left.length < right.length ? left : right;
  const longer = left.length < right.length ? right : left;
  let shortIndex = 0;
  let longIndex = 0;
  let skipped = false;
  while (shortIndex < shorter.length && longIndex < longer.length) {
    if (shorter[shortIndex] === longer[longIndex]) {
      shortIndex += 1;
      longIndex += 1;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    longIndex += 1;
  }
  return true;
}

function sourceCameraNames(route) {
  const value = route?.route_source_camera_names
    ?? route?.source_camera_names
    ?? route?.sourceCameraNames;
  return Array.isArray(value)
    ? [...new Set(value.map(text).filter(Boolean))]
    : [];
}

function routeSnapshot(target) {
  const sourceCameras = sourceCameraNames(target);
  const snapshot = {
    id: positiveInteger(target?.route_profile_id ?? target?.routeProfileId),
    name: text(target?.route_name ?? target?.routeName),
    revision: positiveInteger(target?.route_revision ?? target?.routeRevision, 1),
    targetCameraName: text(target?.route_target_camera_name ?? target?.target_camera_name),
    targetDirectionLabel: text(target?.route_target_direction_label ?? target?.target_direction_label),
    sourceDirectionLabel: text(target?.route_source_direction_label ?? target?.source_direction_label),
    sourceCameraNames: sourceCameras,
    expectedDeltaMs: integer(target?.route_expected_delta_ms ?? target?.expected_delta_ms, 0),
    toleranceMs: positiveInteger(target?.route_tolerance_ms ?? target?.tolerance_ms, 3_000),
    eventWindowMs: positiveInteger(target?.route_event_window_ms ?? target?.event_window_ms, 3_000),
    minimumSourceCount: positiveInteger(target?.route_minimum_source_count ?? target?.minimum_source_count, 2),
    priority: integer(target?.route_priority ?? target?.priority, 0),
  };
  if (
    !snapshot.id
    || !snapshot.name
    || !snapshot.targetCameraName
    || !snapshot.targetDirectionLabel
    || !snapshot.sourceDirectionLabel
    || snapshot.sourceCameraNames.length < snapshot.minimumSourceCount
  ) return null;
  return snapshot;
}

function isEligibleTarget(target, route, nowMs = Date.now()) {
  const targetAt = dateMs(target?.timestamp);
  if (
    !positiveInteger(target?.id)
    || !targetAt
    || !normalizedPlate(target?.plate_number)
    || !route
    || key(target?.camera_name) !== key(route.targetCameraName)
    || target?.bi_trigger_direction_status !== "ready"
    || key(target?.bi_trigger_direction_label) !== key(route.targetDirectionLabel)
    || text(target?.vehicle_image_path)
    || !["failed", "unavailable"].includes(target?.vehicle_image_status)
    || target?.vehicle_image_retryable !== false
    || target?.vehicle_image_queue_kind !== "overview"
    || target?.vehicle_image_claim_token
    || !SAFE_TARGET_ERRORS.has(text(target?.vehicle_image_error_code))
  ) return false;
  const horizonMs = targetAt
    + Math.max(0, route.expectedDeltaMs)
    + route.toleranceMs
    + route.eventWindowMs
    + ENTRY_FALLBACK_GRACE_MS;
  return nowMs >= horizonMs;
}

function cropMetrics(source) {
  const crop = source?.crop_box && typeof source.crop_box === "object"
    ? source.crop_box
    : null;
  const width = positiveInteger(source?.image_width);
  const height = positiveInteger(source?.image_height);
  const left = Number(crop?.left);
  const top = Number(crop?.top);
  const cropWidth = Number(crop?.width);
  const cropHeight = Number(crop?.height);
  if (
    !width || !height
    || !Number.isFinite(left) || !Number.isFinite(top)
    || !Number.isFinite(cropWidth) || !Number.isFinite(cropHeight)
    || cropWidth <= 0 || cropHeight <= 0
    || left < 0 || top < 0
    || left + cropWidth > width + 1 || top + cropHeight > height + 1
  ) return null;
  const edgeX = Math.max(1, width * 0.005);
  const edgeY = Math.max(1, height * 0.005);
  const right = left + cropWidth;
  const bottom = top + cropHeight;
  const edgeContacts = [
    left <= edgeX,
    top <= edgeY,
    right >= width - edgeX,
    bottom >= height - edgeY,
  ].filter(Boolean).length;
  const areaRatio = (cropWidth * cropHeight) / (width * height);
  if (edgeContacts > 1 || areaRatio < 0.05) return null;
  return {
    width,
    height,
    edgeContacts,
    areaRatio,
    box: {
      left: Number((left / width).toFixed(6)),
      top: Number((top / height).toFixed(6)),
      right: Number((right / width).toFixed(6)),
      bottom: Number((bottom / height).toFixed(6)),
    },
  };
}

function usableSource(source, route) {
  if (
    !positiveInteger(source?.id)
    || !text(source?.image_path)
    || !normalizedPlate(source?.plate_number)
    || !route.sourceCameraNames.some((camera) => key(camera) === key(source?.camera_name))
    || source?.color_evaluated !== true
    || text(source?.color_reason) === "monochrome_capture"
  ) return null;
  const metrics = cropMetrics(source);
  if (!metrics) return null;
  return {
    ...source,
    ...metrics,
    detectionConfidence: Number.isFinite(Number(source?.detection_confidence))
      ? Number(source.detection_confidence)
      : null,
  };
}

function sourceDirectionState(source, route) {
  if (source?.bi_trigger_direction_status !== "ready") return "unavailable";
  return key(source?.bi_trigger_direction_label) === key(route.sourceDirectionLabel)
    ? "matching"
    : "conflicting";
}

function entryOverviewPayload(source) {
  const metadata = source?.overview_selection_metadata
    && typeof source.overview_selection_metadata === "object"
    ? source.overview_selection_metadata
    : null;
  const box = source?.overview_detection_box
    && typeof source.overview_detection_box === "object"
    ? source.overview_detection_box
    : null;
  const left = Number(box?.left);
  const top = Number(box?.top);
  const right = Number(box?.right);
  const bottom = Number(box?.bottom);
  const width = positiveInteger(source?.overview_image_width);
  const height = positiveInteger(source?.overview_image_height);
  const timestampMs = dateMs(source?.overview_timestamp);
  if (
    source?.overview_status !== "ready"
    || text(source?.overview_source_kind) !== "entry_overview_primary"
    || !text(source?.overview_image_path)
    || !timestampMs
    || !width || !height
    || !Number.isFinite(left) || !Number.isFinite(top)
    || !Number.isFinite(right) || !Number.isFinite(bottom)
    || left < 0 || top < 0 || right > 1 || bottom > 1
    || right <= left || bottom <= top
    || key(metadata?.overviewContext) !== "entry"
    || key(metadata?.sourceCameraName) !== "entry overview"
    || key(metadata?.sourceCameraShortName ?? metadata?.sourceCameraId) !== "cam143"
  ) return null;
  return {
    readId: Number(source.id),
    imagePath: text(source.overview_image_path),
    sourceKind: "entry_overview_primary",
    timestamp: new Date(timestampMs).toISOString(),
    detectionConfidence: Number.isFinite(Number(source?.overview_detection_confidence))
      ? Number(source.overview_detection_confidence)
      : null,
    detectionBox: { left, top, right, bottom },
    imageWidth: width,
    imageHeight: height,
    score: Number.isFinite(Number(source?.overview_score)) ? Number(source.overview_score) : null,
    sampledCount: positiveInteger(source?.overview_sampled_count, 1),
    selectionMetadata: metadata,
  };
}

function identityEvidence(target, sources) {
  const targetPlate = normalizedPlate(target?.plate_number);
  const sourcePlates = sources.map((source) => normalizedPlate(source.plate_number));
  const exactCount = sourcePlates.filter((plate) => plate === targetPlate).length;
  if (
    exactCount > 0
    && sourcePlates.every((plate) => plate === targetPlate || editDistanceAtMostOne(plate, targetPlate))
  ) {
    return {
      class: exactCount === sourcePlates.length
        ? (sources.length === 1 ? "single_camera_exact" : "exact")
        : "exact_with_dual_camera_fuzzy_corroboration",
      penalty: exactCount === sourcePlates.length
        ? (sources.length === 1 ? 0.12 : 0)
        : 0.08,
      targetPlate,
      sourcePlates,
    };
  }
  const consensus = sourcePlates[0];
  if (
    sources.length >= 2
    && sourcePlates.every((plate) => plate === consensus)
    && editDistanceAtMostOne(consensus, targetPlate)
  ) {
    return {
      class: "dual_camera_fuzzy",
      penalty: 0.18,
      targetPlate,
      sourcePlates,
    };
  }
  if (
    sources.length === 1
    && targetPlate.length >= MINIMUM_FUZZY_PLATE_LENGTH
    && sourcePlates[0]?.length >= MINIMUM_FUZZY_PLATE_LENGTH
    && editDistanceAtMostOne(sourcePlates[0], targetPlate)
  ) {
    return {
      class: "single_camera_fuzzy",
      penalty: 0.26,
      targetPlate,
      sourcePlates,
    };
  }
  return null;
}

function sourceRank(source, targetPlate) {
  return [
    source.edgeContacts === 0 ? 1 : 0,
    source.detectionConfidence ?? -1,
    source.areaRatio,
    positiveInteger(source.image_width, 0) * positiveInteger(source.image_height, 0),
    normalizedPlate(source.plate_number) === targetPlate ? 1 : 0,
  ];
}

function compareRank(left, right, targetPlate) {
  const leftRank = sourceRank(left, targetPlate);
  const rightRank = sourceRank(right, targetPlate);
  for (let index = 0; index < leftRank.length; index += 1) {
    if (leftRank[index] !== rightRank[index]) return rightRank[index] - leftRank[index];
  }
  return Number(left.id) - Number(right.id);
}

function comparePayload(left, right) {
  const leftBox = left.payload.detectionBox;
  const rightBox = right.payload.detectionBox;
  const leftArea = (leftBox.right - leftBox.left) * (leftBox.bottom - leftBox.top);
  const rightArea = (rightBox.right - rightBox.left) * (rightBox.bottom - rightBox.top);
  const leftRank = [
    left.payload.detectionConfidence ?? -1,
    leftArea,
    left.payload.imageWidth * left.payload.imageHeight,
    left.payload.score ?? -1,
  ];
  const rightRank = [
    right.payload.detectionConfidence ?? -1,
    rightArea,
    right.payload.imageWidth * right.payload.imageHeight,
    right.payload.score ?? -1,
  ];
  for (let index = 0; index < leftRank.length; index += 1) {
    if (leftRank[index] !== rightRank[index]) return rightRank[index] - leftRank[index];
  }
  return Number(left.payload.readId) - Number(right.payload.readId);
}

function candidateEvents(target, route, sourceReads) {
  const targetAt = dateMs(target.timestamp);
  const candidates = sourceReads
    .map((source) => usableSource(source, route))
    .filter(Boolean)
    .filter((source) => {
      const sourceAt = dateMs(source.timestamp);
      return sourceAt !== null
        && Math.abs((sourceAt - targetAt) - route.expectedDeltaMs)
          <= route.toleranceMs + route.eventWindowMs;
    });
  const signatures = new Set();
  const events = [];
  for (const anchor of candidates) {
    const anchorAt = dateMs(anchor.timestamp);
    const selected = [];
    for (const cameraName of route.sourceCameraNames) {
      const cameraCandidates = candidates
        .filter((source) => key(source.camera_name) === key(cameraName))
        .filter((source) => Math.abs(dateMs(source.timestamp) - anchorAt) <= route.eventWindowMs)
        .sort((left, right) => (
          Math.abs(dateMs(left.timestamp) - anchorAt) - Math.abs(dateMs(right.timestamp) - anchorAt)
          || Number(left.id) - Number(right.id)
        ));
      if (cameraCandidates[0]) selected.push(cameraCandidates[0]);
    }
    if (selected.some((source) => sourceDirectionState(source, route) === "conflicting")) continue;
    const signature = selected.map((source) => Number(source.id)).sort((a, b) => a - b).join(":");
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    const evidence = identityEvidence(target, selected);
    if (!evidence) continue;
    const timestamps = selected.map((source) => dateMs(source.timestamp));
    const eventAt = Math.round(timestamps.reduce((sum, value) => sum + value, 0) / timestamps.length);
    const actualDeltaMs = eventAt - targetAt;
    const timingErrorMs = Math.abs(actualDeltaMs - route.expectedDeltaMs);
    if (timingErrorMs > route.toleranceMs) continue;
    const rankedPayloads = selected
      .filter((source) => sourceDirectionState(source, route) === "matching")
      .map((source) => ({ source, payload: entryOverviewPayload(source) }))
      .filter((item) => item.payload)
      .sort(comparePayload);
    const rankedSources = [...selected].sort((left, right) => compareRank(left, right, evidence.targetPlate));
    const chosen = rankedPayloads[0] || null;
    events.push({
      route,
      target,
      sources: selected,
      chosenSource: chosen?.source || rankedSources[0],
      chosenPayload: chosen?.payload || null,
      evidence,
      eventAt,
      actualDeltaMs,
      timingErrorMs,
      score: Number((timingErrorMs / route.toleranceMs + evidence.penalty).toFixed(6)),
    });
  }
  return events.sort((left, right) => (
    right.sources.length - left.sources.length
    || left.score - right.score
    || left.eventAt - right.eventAt
  ));
}

function decisionIdentity({ targetReadId, route, reason, sourceReadIds = [] }) {
  return crypto.createHash("sha256").update(JSON.stringify({
    algorithm: ENTRY_FALLBACK_ALGORITHM,
    targetReadId,
    routeProfileId: route?.id || null,
    routeRevision: route?.revision || null,
    reason,
    sourceReadIds: [...sourceReadIds].sort((a, b) => a - b),
  })).digest("hex");
}

function sourceEventKey(route, sourceReadIds = []) {
  if (!route?.id || sourceReadIds.length === 0) return null;
  return crypto.createHash("sha256").update(JSON.stringify({
    algorithm: ENTRY_FALLBACK_ALGORITHM,
    routeProfileId: route.id,
    sourceDirectionLabel: route.sourceDirectionLabel,
    sourceReadIds: [...sourceReadIds].sort((a, b) => a - b),
  })).digest("hex");
}

function eventMetadata(event, runnerUp = null) {
  const sourceReadIds = event.sources.map((source) => Number(source.id));
  const chosen = event.chosenSource;
  const payload = event.chosenPayload;
  return {
    algorithm: ENTRY_FALLBACK_ALGORITHM,
    routeProfileId: event.route.id,
    routeName: event.route.name,
    routeRevision: event.route.revision,
    targetReadId: Number(event.target.id),
    targetCameraName: text(event.target.camera_name),
    targetDirectionLabel: text(event.target.bi_trigger_direction_label),
    targetPlate: event.evidence.targetPlate,
    sourceDirectionLabel: event.route.sourceDirectionLabel,
    sourceReadIds,
    corroboratingReadIds: sourceReadIds.filter((id) => id !== Number(chosen.id)),
    sourceCameraNames: event.sources.map((source) => text(source.camera_name)),
    sourcePlates: event.evidence.sourcePlates,
    identityReads: event.sources.map((source) => ({
      readId: Number(source.id),
      cameraName: text(source.camera_name),
      timestamp: new Date(dateMs(source.timestamp)).toISOString(),
      plate: normalizedPlate(source.plate_number),
      directionStatus: text(source.bi_trigger_direction_status),
      directionLabel: text(source.bi_trigger_direction_label),
      imagePath: text(source.image_path),
    })),
    chosenSourceReadId: Number(chosen.id),
    chosenSourceImagePath: text(chosen.image_path),
    chosenSourceTimestamp: new Date(dateMs(chosen.timestamp)).toISOString(),
    chosenDetectionConfidence: chosen.detectionConfidence,
    chosenDetectionBox: chosen.box,
    chosenImageWidth: chosen.width,
    chosenImageHeight: chosen.height,
    chosenEdgeContacts: chosen.edgeContacts,
    payloadReadId: payload.readId,
    payloadImagePath: payload.imagePath,
    payloadSourceKind: payload.sourceKind,
    payloadTimestamp: payload.timestamp,
    payloadDetectionConfidence: payload.detectionConfidence,
    payloadDetectionBox: payload.detectionBox,
    payloadImageWidth: payload.imageWidth,
    payloadImageHeight: payload.imageHeight,
    payloadScore: payload.score,
    payloadSampledCount: payload.sampledCount,
    payloadSelectionMetadata: payload.selectionMetadata,
    plateEvidenceClass: event.evidence.class,
    directionAuthorityReadId: Number(chosen.id),
    directionEvidenceCount: event.sources.filter(
      (source) => sourceDirectionState(source, event.route) === "matching",
    ).length,
    sourceEvidenceCount: event.sources.length,
    expectedDeltaMs: event.route.expectedDeltaMs,
    actualDeltaMs: event.actualDeltaMs,
    timingErrorMs: event.timingErrorMs,
    score: event.score,
    runnerUpScore: runnerUp?.score ?? null,
    scoreMargin: runnerUp ? Number((runnerUp.score - event.score).toFixed(6)) : null,
  };
}

export function buildEntryLprFallbackDecisions({ targets = [], sourcesByTarget = new Map(), now = Date.now() } = {}) {
  const decisions = [];
  for (const target of targets) {
    const route = routeSnapshot(target);
    if (!isEligibleTarget(target, route, dateMs(now) ?? Number(now))) continue;
    const sourceReads = sourcesByTarget instanceof Map
      ? (sourcesByTarget.get(Number(target.id)) || [])
      : (sourcesByTarget?.[Number(target.id)] || []);
    const events = candidateEvents(target, route, sourceReads);
    const best = events[0] || null;
    const runnerUp = events[1] || null;
    let status = "proposed";
    let reason = "UNIQUE_ENTRY_ROUTE_EVENT";
    let selected = best;
    if (!best) {
      status = "rejected";
      reason = "NO_CORROBORATED_ENTRY_EVENT";
      selected = null;
    } else if (
      runnerUp
      && runnerUp.sources.length === best.sources.length
      && runnerUp.score - best.score < ENTRY_FALLBACK_MARGIN
    ) {
      status = "rejected";
      reason = "ENTRY_FALLBACK_AMBIGUOUS";
      selected = null;
    } else if (!best.chosenPayload) {
      // Identity/timing evidence may arrive before its direction-authoritative Cam143
      // payload. Do not freeze a permanent rejection while that payload is processing.
      continue;
    }
    const metadata = selected
      ? eventMetadata(selected, runnerUp)
      : {
          algorithm: ENTRY_FALLBACK_ALGORITHM,
          routeProfileId: route.id,
          routeName: route.name,
          routeRevision: route.revision,
          targetReadId: Number(target.id),
          targetCameraName: text(target.camera_name),
          targetDirectionLabel: text(target.bi_trigger_direction_label),
          targetPlate: normalizedPlate(target.plate_number),
          candidateEventCount: events.length,
          candidateSourceReadIds: [...new Set(events.flatMap((event) => event.sources.map((source) => Number(source.id))))],
        };
    decisions.push({
      decisionIdentity: decisionIdentity({
        targetReadId: Number(target.id),
        route,
        reason,
        sourceReadIds: selected?.sources.map((source) => Number(source.id)) || [],
      }),
      routeProfileId: route.id,
      routeRevision: route.revision,
      targetReadId: Number(target.id),
      sourceEventKey: selected
        ? sourceEventKey(route, selected.sources.map((source) => Number(source.id)))
        : null,
      sourceReadId: selected ? Number(selected.chosenSource.id) : null,
      payloadReadId: selected ? Number(selected.chosenPayload.readId) : null,
      corroboratingReadIds: selected
        ? selected.sources.map((source) => Number(source.id)).filter((id) => id !== Number(selected.chosenSource.id))
        : [],
      status,
      reason,
      metadata,
    });
  }

  const proposedBySource = new Map();
  for (const decision of decisions.filter((item) => item.status === "proposed")) {
    for (const readId of [decision.sourceReadId, ...decision.corroboratingReadIds]) {
      const owners = proposedBySource.get(readId) || [];
      owners.push(decision);
      proposedBySource.set(readId, owners);
    }
  }
  for (const owners of proposedBySource.values()) {
    if (owners.length < 2) continue;
    for (const decision of owners) {
      decision.status = "rejected";
      decision.reason = "ENTRY_EVENT_COMPETES_FOR_MULTIPLE_STREET_READS";
      decision.sourceReadId = null;
      decision.corroboratingReadIds = [];
      decision.sourceEventKey = null;
      decision.decisionIdentity = decisionIdentity({
        targetReadId: decision.targetReadId,
        route: { id: decision.routeProfileId, revision: decision.routeRevision },
        reason: decision.reason,
      });
    }
  }
  return decisions.sort((left, right) => left.targetReadId - right.targetReadId);
}

function fallbackDerivedPath(claim) {
  const timestamp = new Date(claim.target_read_timestamp || Date.now());
  const year = String(timestamp.getUTCFullYear());
  const month = String(timestamp.getUTCMonth() + 1).padStart(2, "0");
  const day = String(timestamp.getUTCDate()).padStart(2, "0");
  const token = text(claim.claim_token).replaceAll("-", "");
  return path.posix.join(
    "derived",
    year,
    month,
    day,
    `entry_lpr_vehicle_${Number(claim.target_read_id)}_${token}.jpg`
  );
}

export class EntryLprRouteFallbackService {
  constructor({ repository, fileStorage, logger = console } = {}) {
    this.repository = repository;
    this.fileStorage = fileStorage;
    this.logger = logger;
  }

  async discover() {
    if (
      typeof this.repository?.getEntryFallbackSettings !== "function"
      || typeof this.repository?.listEntryFallbackTargets !== "function"
      || typeof this.repository?.listEntryFallbackSourceReads !== "function"
      || typeof this.repository?.recordEntryFallbackDecisions !== "function"
    ) return { mode: "off", recorded: 0 };
    const settings = await this.repository.getEntryFallbackSettings();
    if (!settings || settings.mode === "off") return { mode: settings?.mode || "off", recorded: 0 };
    const targets = await this.repository.listEntryFallbackTargets({
      startedAt: settings.observation_started_at,
    });
    const sourceRows = targets.length
      ? await this.repository.listEntryFallbackSourceReads(targets)
      : [];
    const sourcesByTarget = new Map();
    for (const row of sourceRows) {
      const targetReadId = Number(row.target_read_id);
      const rows = sourcesByTarget.get(targetReadId) || [];
      rows.push(row);
      sourcesByTarget.set(targetReadId, rows);
    }
    const decisions = buildEntryLprFallbackDecisions({ targets, sourcesByTarget });
    const recorded = await this.repository.recordEntryFallbackDecisions(decisions);
    return {
      mode: settings.mode,
      overviewPayloadMode: settings.overview_payload_mode || "shadow",
      recorded: Number(recorded || 0),
      decisions: decisions.length,
    };
  }

  async processNext() {
    const discovery = await this.discover();
    if (
      discovery.mode !== "active"
      || discovery.overviewPayloadMode !== "active"
      || typeof this.repository?.claimNextEntryFallback !== "function"
    ) {
      return null;
    }
    const claim = await this.repository.claimNextEntryFallback();
    if (!claim) return null;
    let targetPath = null;
    try {
      const sourceBuffer = await this.fileStorage.getImage(claim.payload_image_path_snapshot);
      if (!sourceBuffer) {
        await this.repository.markEntryFallbackFailed(claim.id, claim.claim_token, {
          errorCode: "ENTRY_OVERVIEW_PAYLOAD_MISSING",
        });
        return {
          kind: "entry_overview_route_fallback",
          status: "failed",
          targetReadId: Number(claim.target_read_id),
          errorCode: "ENTRY_OVERVIEW_PAYLOAD_MISSING",
        };
      }
      targetPath = fallbackDerivedPath(claim);
      const apply = async (writerRepository) => {
        await this.fileStorage.saveDerivedImageAtomic(targetPath, sourceBuffer);
        const applied = await writerRepository.applyEntryFallback(
          claim.id,
          claim.claim_token,
          targetPath
        );
        if (!applied) await this.fileStorage.deleteImage(targetPath);
        return applied;
      };
      const applied = typeof this.repository.withDerivedStorageWriterLock === "function"
        ? await this.repository.withDerivedStorageWriterLock(apply)
        : await apply(this.repository);
      if (!applied) {
        await this.repository.markEntryFallbackFailed(claim.id, claim.claim_token, {
          errorCode: "ENTRY_FALLBACK_SUPERSEDED",
          errorDetails: {
            reason: "The immutable payload, identity evidence, or target state changed before commit.",
          },
        }).catch(() => {});
        return {
          kind: "entry_overview_route_fallback",
          status: "superseded",
          targetReadId: Number(claim.target_read_id),
        };
      }
      return {
        kind: "entry_overview_route_fallback",
        status: "shared",
        sourceReadId: Number(claim.payload_read_id),
        targetReadId: Number(claim.target_read_id),
        framePath: targetPath,
      };
    } catch (error) {
      if (targetPath) await this.fileStorage.deleteImage(targetPath).catch(() => {});
      await this.repository.markEntryFallbackFailed(claim.id, claim.claim_token, {
        errorCode: "ENTRY_FALLBACK_COPY_FAILED",
        errorDetails: { message: String(error?.message || error).slice(0, 500) },
      }).catch(() => {});
      this.logger?.error?.("Entry LPR fallback failed", {
        sourceReadId: Number(claim.payload_read_id),
        targetReadId: Number(claim.target_read_id),
        message: String(error?.message || error),
      });
      return {
        kind: "entry_overview_route_fallback",
        status: "failed",
        targetReadId: Number(claim.target_read_id),
        errorCode: "ENTRY_FALLBACK_COPY_FAILED",
      };
    }
  }
}

export const entryLprRouteFallbackInternals = Object.freeze({
  SAFE_TARGET_ERRORS,
  ENTRY_FALLBACK_ALGORITHM,
  ENTRY_FALLBACK_MARGIN,
  ENTRY_FALLBACK_GRACE_MS,
  MINIMUM_FUZZY_PLATE_LENGTH,
  candidateEvents,
  comparePayload,
  confusionPlate,
  cropMetrics,
  editDistanceAtMostOne,
  fallbackDerivedPath,
  identityEvidence,
  isEligibleTarget,
  routeSnapshot,
  sourceEventKey,
  sourceDirectionState,
  entryOverviewPayload,
  usableSource,
});
