import crypto from "node:crypto";
import path from "node:path";

const SAFE_TARGET_ERRORS = new Set([
  "RECORDING_UNAVAILABLE",
  "VEHICLE_NOT_VISIBLE",
]);

const STREET_PAIR_MAX_READ_GAP_MS = 12_000;
const STREET_PAIR_MAX_ANCHOR_DELTA_MS = 1_500;

function text(value) {
  return String(value || "").trim();
}

function key(value) {
  return text(value).toLowerCase();
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function finiteInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && Number.isInteger(number) ? number : null;
}

function dateMs(value) {
  const result = new Date(value).getTime();
  return Number.isFinite(result) ? result : null;
}

function selectionMetadata(read) {
  const value = read?.vehicle_image_selection_metadata;
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function profileSnapshot(read) {
  const metadata = selectionMetadata(read);
  if (!metadata) return null;
  const profileId = positiveInteger(metadata.profileId);
  const profileRevision = positiveInteger(metadata.profileRevision);
  const expectedDeltaMs = finiteInteger(metadata.expectedDeltaMs);
  const toleranceMs = positiveInteger(metadata.toleranceMs);
  const sourceCameraName = text(metadata.sourceCameraName);
  const directionLabel = text(metadata.directionLabel || read.bi_trigger_direction_label);
  const overviewContext = key(metadata.overviewContext || "street");
  if (
    !profileId
    || !profileRevision
    || expectedDeltaMs === null
    || !toleranceMs
    || !sourceCameraName
    || !directionLabel
  ) return null;
  return {
    profileId,
    profileRevision,
    expectedDeltaMs,
    toleranceMs,
    sourceCameraName,
    directionLabel,
    overviewContext,
  };
}

function isEligibleSource(read) {
  return Boolean(
    positiveInteger(read?.id)
    && text(read?.plate_number)
    && text(read?.camera_name)
    && dateMs(read?.timestamp) !== null
    && read?.vehicle_image_status === "ready"
    && read?.vehicle_image_source_kind === "overview_primary"
    && text(read?.vehicle_image_path)
    && read?.bi_trigger_direction_status === "ready"
    && text(read?.bi_trigger_direction_label)
    && profileSnapshot(read)?.overviewContext === "street"
  );
}

function isEligibleTarget(read) {
  return Boolean(
    positiveInteger(read?.id)
    && text(read?.plate_number)
    && text(read?.camera_name)
    && dateMs(read?.timestamp) !== null
    && !text(read?.vehicle_image_path)
    && ["failed", "unavailable"].includes(read?.vehicle_image_status)
    && SAFE_TARGET_ERRORS.has(text(read?.vehicle_image_error_code))
    && read?.vehicle_image_retryable === false
    && read?.vehicle_image_queue_kind === "overview"
    && !read?.vehicle_image_claim_token
    && read?.bi_trigger_direction_status === "ready"
    && text(read?.bi_trigger_direction_label)
    && profileSnapshot(read)?.overviewContext === "street"
  );
}

function stableDecisionIdentity({ sourceReadId = null, targetReadId, reason, metadata }) {
  return crypto.createHash("sha256").update(JSON.stringify({
    sourceReadId,
    targetReadId,
    reason,
    sourceProfileId: metadata?.sourceProfileId || null,
    sourceProfileRevision: metadata?.sourceProfileRevision || null,
    targetProfileId: metadata?.targetProfileId || null,
    targetProfileRevision: metadata?.targetProfileRevision || null,
  })).digest("hex");
}

function candidateFor(source, target) {
  if (!isEligibleSource(source) || !isEligibleTarget(target)) return null;
  if (Number(source.id) === Number(target.id)) return null;
  if (key(source.camera_name) === key(target.camera_name)) return null;
  if (key(source.plate_number) !== key(target.plate_number)) return null;
  if (key(source.bi_trigger_direction_label) !== key(target.bi_trigger_direction_label)) return null;

  const sourceProfile = profileSnapshot(source);
  const targetProfile = profileSnapshot(target);
  if (key(sourceProfile.directionLabel) !== key(source.bi_trigger_direction_label)) return null;
  if (key(targetProfile.directionLabel) !== key(target.bi_trigger_direction_label)) return null;
  if (key(sourceProfile.sourceCameraName) !== key(targetProfile.sourceCameraName)) return null;

  const sourceReadAt = dateMs(source.timestamp);
  const targetReadAt = dateMs(target.timestamp);
  const actualReadDeltaMs = targetReadAt - sourceReadAt;
  if (Math.abs(actualReadDeltaMs) > STREET_PAIR_MAX_READ_GAP_MS) return null;

  const sourceAnchorAt = sourceReadAt + sourceProfile.expectedDeltaMs;
  const targetAnchorAt = targetReadAt + targetProfile.expectedDeltaMs;
  const anchorDeltaMs = targetAnchorAt - sourceAnchorAt;
  const allowedAnchorDeltaMs = Math.max(250, Math.min(
    STREET_PAIR_MAX_ANCHOR_DELTA_MS,
    sourceProfile.toleranceMs,
    targetProfile.toleranceMs
  ));
  if (Math.abs(anchorDeltaMs) > allowedAnchorDeltaMs) return null;

  return {
    sourceReadId: Number(source.id),
    targetReadId: Number(target.id),
    sourceReadTimestamp: new Date(sourceReadAt).toISOString(),
    targetReadTimestamp: new Date(targetReadAt).toISOString(),
    sourceAnchorAt: new Date(sourceAnchorAt).toISOString(),
    targetAnchorAt: new Date(targetAnchorAt).toISOString(),
    sourceCameraName: text(source.camera_name),
    targetCameraName: text(target.camera_name),
    overviewCameraName: sourceProfile.sourceCameraName,
    directionLabel: text(source.bi_trigger_direction_label),
    plateNumber: text(source.plate_number),
    sourceProfileId: sourceProfile.profileId,
    sourceProfileRevision: sourceProfile.profileRevision,
    targetProfileId: targetProfile.profileId,
    targetProfileRevision: targetProfile.profileRevision,
    sourceImagePath: text(source.vehicle_image_path),
    targetErrorCode: text(target.vehicle_image_error_code),
    actualReadDeltaMs,
    expectedReadDeltaMs: sourceProfile.expectedDeltaMs - targetProfile.expectedDeltaMs,
    anchorDeltaMs,
    allowedAnchorDeltaMs,
    algorithm: "street-overview-pair-sharing-v1",
  };
}

export function buildStreetOverviewPairDecisions(reads = []) {
  const sources = reads.filter(isEligibleSource);
  const targets = reads.filter(isEligibleTarget);
  const candidates = [];
  for (const target of targets) {
    for (const source of sources) {
      const candidate = candidateFor(source, target);
      if (candidate) candidates.push(candidate);
    }
  }

  const byTarget = new Map();
  const bySource = new Map();
  for (const candidate of candidates) {
    const targetMatches = byTarget.get(candidate.targetReadId) || [];
    targetMatches.push(candidate);
    byTarget.set(candidate.targetReadId, targetMatches);
    const sourceMatches = bySource.get(candidate.sourceReadId) || [];
    sourceMatches.push(candidate);
    bySource.set(candidate.sourceReadId, sourceMatches);
  }

  const decisions = [];
  for (const [targetReadId, targetMatches] of byTarget.entries()) {
    const first = targetMatches[0];
    let status = "proposed";
    let reason = "UNIQUE_STREET_PAIR";
    let selected = first;
    if (targetMatches.length !== 1) {
      status = "rejected";
      reason = "MULTIPLE_SOURCE_READS";
      selected = null;
    } else if ((bySource.get(first.sourceReadId) || []).length !== 1) {
      status = "rejected";
      reason = "SOURCE_COMPETES_FOR_MULTIPLE_READS";
      selected = null;
    }
    const metadata = {
      ...(selected || first),
      candidateSourceReadIds: targetMatches.map((item) => item.sourceReadId),
      candidateCount: targetMatches.length,
    };
    decisions.push({
      decisionIdentity: stableDecisionIdentity({
        sourceReadId: selected?.sourceReadId || null,
        targetReadId,
        reason,
        metadata,
      }),
      status,
      reason,
      sourceReadId: selected?.sourceReadId || null,
      targetReadId,
      metadata,
    });
  }
  return decisions.sort((left, right) => left.targetReadId - right.targetReadId);
}

function sharedDerivedPath(claim) {
  const timestamp = new Date(claim.target_read_timestamp || claim.target_timestamp || Date.now());
  const year = String(timestamp.getUTCFullYear());
  const month = String(timestamp.getUTCMonth() + 1).padStart(2, "0");
  const day = String(timestamp.getUTCDate()).padStart(2, "0");
  const token = text(claim.claim_token).replaceAll("-", "");
  return path.posix.join(
    "derived",
    year,
    month,
    day,
    `blue_iris_vehicle_pair_${Number(claim.target_read_id)}_${token}.jpg`
  );
}

export class StreetOverviewPairSharingService {
  constructor({ repository, fileStorage, logger = console } = {}) {
    this.repository = repository;
    this.fileStorage = fileStorage;
    this.logger = logger;
  }

  async discover() {
    if (
      typeof this.repository?.getStreetPairSharingSettings !== "function"
      || typeof this.repository?.listStreetPairSharingReads !== "function"
      || typeof this.repository?.recordStreetPairSharingDecisions !== "function"
    ) return { mode: "off", recorded: 0 };
    const settings = await this.repository.getStreetPairSharingSettings();
    if (!settings || settings.mode === "off") return { mode: settings?.mode || "off", recorded: 0 };
    const reads = await this.repository.listStreetPairSharingReads({
      startedAt: settings.observation_started_at,
    });
    const decisions = buildStreetOverviewPairDecisions(reads);
    const recorded = await this.repository.recordStreetPairSharingDecisions(decisions);
    return { mode: settings.mode, recorded: Number(recorded || 0), decisions: decisions.length };
  }

  async processNext() {
    const discovery = await this.discover();
    if (discovery.mode !== "active" || typeof this.repository?.claimNextStreetPairShare !== "function") {
      return null;
    }
    const claim = await this.repository.claimNextStreetPairShare();
    if (!claim) return null;
    let targetPath = null;
    try {
      const sourceBuffer = await this.fileStorage.getImage(claim.source_image_path_snapshot);
      if (!sourceBuffer) {
        await this.repository.markStreetPairShareFailed(claim.id, claim.claim_token, {
          errorCode: "SOURCE_IMAGE_MISSING",
        });
        return {
          kind: "overview_pair_share",
          status: "failed",
          sourceReadId: Number(claim.source_read_id),
          targetReadId: Number(claim.target_read_id),
          errorCode: "SOURCE_IMAGE_MISSING",
        };
      }
      targetPath = sharedDerivedPath(claim);
      const apply = async (writerRepository) => {
        await this.fileStorage.saveDerivedImageAtomic(targetPath, sourceBuffer);
        const applied = await writerRepository.applyStreetPairShare(
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
        return {
          kind: "overview_pair_share",
          status: "superseded",
          sourceReadId: Number(claim.source_read_id),
          targetReadId: Number(claim.target_read_id),
        };
      }
      return {
        kind: "overview_pair_share",
        status: "shared",
        sourceReadId: Number(claim.source_read_id),
        targetReadId: Number(claim.target_read_id),
        framePath: targetPath,
      };
    } catch (error) {
      if (targetPath) await this.fileStorage.deleteImage(targetPath).catch(() => {});
      await this.repository.markStreetPairShareFailed(claim.id, claim.claim_token, {
        errorCode: "PAIR_SHARE_COPY_FAILED",
        errorDetails: { message: String(error?.message || error).slice(0, 500) },
      }).catch(() => {});
      this.logger?.error?.("Street Overview pair sharing failed", {
        sourceReadId: Number(claim.source_read_id),
        targetReadId: Number(claim.target_read_id),
        message: String(error?.message || error),
      });
      return {
        kind: "overview_pair_share",
        status: "failed",
        sourceReadId: Number(claim.source_read_id),
        targetReadId: Number(claim.target_read_id),
        errorCode: "PAIR_SHARE_COPY_FAILED",
      };
    }
  }
}

export const streetOverviewPairSharingInternals = Object.freeze({
  SAFE_TARGET_ERRORS,
  STREET_PAIR_MAX_READ_GAP_MS,
  STREET_PAIR_MAX_ANCHOR_DELTA_MS,
  profileSnapshot,
  candidateFor,
  sharedDerivedPath,
});
