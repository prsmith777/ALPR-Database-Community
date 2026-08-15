import crypto from "node:crypto";

const REPAIRABLE_SOURCE_KINDS = new Set([
  "overview_primary",
  "entry_overview_primary",
]);

function canonicalJson(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function jsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function finiteInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function profileSnapshot(read) {
  const metadata = jsonObject(read.vehicle_image_selection_metadata);
  const sourceKind = String(read.vehicle_image_source_kind || "").trim();
  const context = String(metadata.overviewContext || "").trim().toLowerCase();
  const profileId = positiveInteger(metadata.profileId);
  const profileRevision = positiveInteger(metadata.profileRevision);
  const expectedDeltaMs = finiteInteger(metadata.expectedDeltaMs);
  const toleranceMs = finiteInteger(metadata.toleranceMs);
  const sourceCameraName = String(metadata.sourceCameraName || "").trim();
  const sourceCameraShortName = String(
    metadata.sourceCameraShortName || metadata.sourceCameraId || ""
  ).trim() || null;
  if (!REPAIRABLE_SOURCE_KINDS.has(sourceKind)
    || !profileId || !profileRevision
    || !["street", "entry"].includes(context)
    || !sourceCameraName
    || expectedDeltaMs == null || Math.abs(expectedDeltaMs) > 30_000
    || toleranceMs == null || toleranceMs < 250 || toleranceMs > 3_000
    || (context === "entry" && !sourceCameraShortName)) return null;
  if ((sourceKind === "entry_overview_primary") !== (context === "entry")) return null;
  return {
    profileId,
    profileRevision,
    overviewContext: context,
    sourceCameraName,
    sourceCameraShortName,
    expectedDeltaMs,
    toleranceMs,
  };
}

function normalizedReadIds(values) {
  const input = Array.isArray(values) ? values : [];
  const readIds = [...new Set(input.map(Number).filter((value) => (
    Number.isSafeInteger(value) && value > 0
  )))];
  if (!readIds.length || readIds.length !== input.length) {
    throw new Error("Choose one or more exact framing-repair candidates.");
  }
  if (readIds.length > 25) throw new Error("A framing repair preview is limited to 25 reads.");
  return readIds.sort((left, right) => left - right);
}

export class VehicleOverviewFramingRepairService {
  constructor({ repository, auditService } = {}) {
    if (!repository || !auditService) {
      throw new Error("Overview framing repair dependencies are required.");
    }
    this.repository = repository;
    this.auditService = auditService;
  }

  async preview({ readIds, actor = null } = {}) {
    const requestedReadIds = normalizedReadIds(readIds);
    const reads = await this.repository.getOverviewFramingRepairCandidates(requestedReadIds);
    const byId = new Map((reads || []).map((read) => [Number(read.id), read]));
    const items = [];
    const rejected = [];
    for (const readId of requestedReadIds) {
      const read = byId.get(readId);
      if (!read) {
        rejected.push({ readId, reason: "SOURCE_CHANGED" });
        continue;
      }
      const audit = await this.auditService.auditRead(read);
      const profile = profileSnapshot(read);
      if (audit.repairEligible !== true || !profile || !audit.actualBox) {
        rejected.push({
          readId,
          reason: audit.repairEligible !== true
            ? "NOT_EDGE_OR_TIGHT_FRAMING"
            : "ACQUISITION_PROFILE_UNAVAILABLE",
        });
        continue;
      }
      items.push({
        read,
        audit,
        profile,
      });
    }
    if (!items.length) {
      throw new Error("None of the selected reads is still an eligible direct edge/tight repair candidate.");
    }
    const previewFingerprint = fingerprint(items.map(({ read, audit, profile }) => ({
      readId: Number(read.id),
      imagePath: read.vehicle_image_path,
      imageUpdatedAt: read.vehicle_image_updated_at_text,
      sourceKind: read.vehicle_image_source_kind,
      actualBox: audit.actualBox,
      completenessTier: audit.completenessTier,
      edgeMargin: audit.edgeMargin,
      edgeContacts: audit.edgeContacts,
      repairReason: audit.repairReason,
      profile,
    })));
    const run = await this.repository.createOverviewFramingRepairPreview({
      previewFingerprint,
      items,
      actor,
    });
    return { run, rejected };
  }
}

export function overviewFramingRepairProfileFromClaim(read) {
  const profileId = positiveInteger(read?.framing_repair_profile_id);
  const revision = positiveInteger(read?.framing_repair_profile_revision);
  const jobId = positiveInteger(read?.framing_repair_job_id);
  if (!profileId || !revision || !jobId) return null;
  return {
    id: profileId,
    revision,
    profile_kind: "framing_repair",
    profile_identity: fingerprint({ kind: "overview_framing_repair", jobId }),
    source_kind: String(read.framing_repair_source_kind || "overview_primary"),
    source_camera_name: String(read.framing_repair_source_camera_name || ""),
    source_camera_short_name: String(
      read.framing_repair_source_camera_short_name || ""
    ).trim() || null,
    plate_camera_name: String(read.camera_name || ""),
    direction_label: String(read.bi_trigger_direction_label || "").trim() || null,
    source_role: "primary",
    overview_context: String(read.framing_repair_overview_context || "street"),
    expected_delta_ms: Number(read.framing_repair_expected_delta_ms),
    tolerance_ms: Number(read.framing_repair_tolerance_ms),
    enabled: true,
  };
}

export function overviewFramingRepairLifecycle(repository, read) {
  const jobId = positiveInteger(read?.framing_repair_job_id);
  const claimToken = String(read?.vehicle_image_claim_token || "").trim();
  if (!jobId || !claimToken) throw new Error("A claimed Overview framing repair job is required.");
  return {
    kind: "overview_framing_repair",
    heartbeat: () => repository.heartbeatOverviewFramingRepairJob(jobId, claimToken),
    markReady: ({ repository: writerRepository, frame, options }) => (
      writerRepository.markOverviewFramingRepairReady(jobId, frame, {
        claimToken,
        exportToken: options?.exportToken || null,
      })
    ),
    markFailed: ({ failure }) => repository.markOverviewFramingRepairFailed(jobId, {
      claimToken,
      errorCode: failure?.errorCode || "OVERVIEW_FRAMING_REPAIR_FAILED",
      errorDetails: {
        selectionMetadata: failure?.selectionMetadata || null,
        status: failure?.status || null,
      },
      retryable: failure?.retryable === true,
      nextAttemptAt: failure?.nextAttemptAt || null,
      unavailable: failure?.status === "unavailable",
    }),
  };
}

export const vehicleOverviewFramingRepairInternals = Object.freeze({
  canonicalJson,
  fingerprint,
  normalizedReadIds,
  profileSnapshot,
});
