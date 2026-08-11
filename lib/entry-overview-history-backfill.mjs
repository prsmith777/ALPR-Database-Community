import { assessDirectionImageEligibility } from "./direction-image-eligibility.mjs";

export const ENTRY_OVERVIEW_HISTORY_CAMERA_NAME = "Entry Overview";
export const ENTRY_OVERVIEW_HISTORY_CAMERA_SHORT_NAME = "Cam143";

function decodeStoredImage(value) {
  if (Buffer.isBuffer(value)) return value.length ? value : null;
  const encoded = String(value || "")
    .replace(/^data:image\/[^;]+;base64,/i, "")
    .trim();
  if (!encoded) return null;
  try {
    const buffer = Buffer.from(encoded, "base64");
    return buffer.length ? buffer : null;
  } catch {
    return null;
  }
}

export async function loadEntryOverviewHistoryEvidenceImage(read, fileStorage) {
  const path = String(read?.image_path || "").trim();
  if (path && typeof fileStorage?.getImage === "function") {
    try {
      const stored = await fileStorage.getImage(path);
      if (stored?.length) return { buffer: stored, source: "image_path" };
    } catch {
      // Retained image_data remains a safe local fallback. If neither source can
      // be read, the caller records DAYLIGHT_UNVERIFIED without contacting BI.
    }
  }
  const retained = decodeStoredImage(read?.image_data);
  return retained
    ? { buffer: retained, source: "image_data" }
    : { buffer: null, source: null };
}

export async function assessEntryOverviewHistoryDaylight(read, fileStorage, options = {}) {
  const loaded = await loadEntryOverviewHistoryEvidenceImage(read, fileStorage);
  if (!loaded.buffer) {
    return {
      status: "unverified",
      errorCode: "DAYLIGHT_UNVERIFIED",
      evidence: {
        evaluated: false,
        eligible: false,
        monochrome: false,
        monochromeRatio: null,
        reason: "retained_plate_image_unavailable",
        source: null,
      },
    };
  }
  try {
    const assessment = await assessDirectionImageEligibility(loaded.buffer, options);
    if (assessment.evaluated !== true) {
      return {
        status: "unverified",
        errorCode: "DAYLIGHT_UNVERIFIED",
        evidence: {
          ...assessment,
          eligible: false,
          source: loaded.source,
        },
      };
    }
    if (assessment.eligible !== true || assessment.monochrome === true) {
      return {
        status: "nighttime",
        errorCode: "NIGHTTIME_UNAVAILABLE",
        evidence: { ...assessment, eligible: false, source: loaded.source },
      };
    }
    return {
      status: "eligible",
      errorCode: null,
      evidence: { ...assessment, source: loaded.source },
    };
  } catch (error) {
    return {
      status: "unverified",
      errorCode: "DAYLIGHT_UNVERIFIED",
      evidence: {
        evaluated: false,
        eligible: false,
        monochrome: false,
        monochromeRatio: null,
        reason: "retained_plate_image_unreadable",
        source: loaded.source,
        message: String(error?.message || error).slice(0, 300),
      },
    };
  }
}

export function entryOverviewHistoryProfileFromClaim(read) {
  if (!read?.entry_history_profile_id || !read?.entry_history_profile_key) return null;
  return {
    id: Number(read.entry_history_profile_id),
    profile_key: String(read.entry_history_profile_key),
    profile_kind: String(read.entry_history_profile_kind || "entry_history"),
    source_kind: String(read.entry_overview_source_kind || "entry_overview_history"),
    source_camera_name: String(
      read.overview_source_camera_name || ENTRY_OVERVIEW_HISTORY_CAMERA_NAME
    ),
    source_camera_short_name: String(
      read.overview_source_camera_short_name || ENTRY_OVERVIEW_HISTORY_CAMERA_SHORT_NAME
    ),
    plate_camera_name: String(read.camera_name || ""),
    direction_label: null,
    source_role: "primary",
    overview_context: "entry",
    expected_delta_ms: Number(read.overview_expected_delta_ms),
    tolerance_ms: Number(read.overview_tolerance_ms || 3_000),
    revision: Number(read.entry_history_profile_revision || 1),
    algorithm_revision: String(read.entry_history_algorithm_revision || ""),
    enabled: true,
  };
}

export function entryOverviewHistoryLifecycle(repository, read) {
  const jobId = Number(read?.entry_history_job_id);
  const claimToken = String(read?.vehicle_image_claim_token || "").trim();
  if (!Number.isSafeInteger(jobId) || jobId <= 0 || !claimToken) {
    throw new Error("A claimed Entry Overview history job is required.");
  }
  return {
    kind: "entry_overview_backfill",
    heartbeat: () => repository.heartbeatEntryOverviewBackfillJob(jobId, claimToken),
    markReady: ({ frame, options }) => repository.markEntryOverviewBackfillReady(jobId, frame, {
      claimToken,
      exportToken: options?.exportToken || null,
    }),
    markFailed: ({ failure }) => repository.markEntryOverviewBackfillFailed(jobId, {
      claimToken,
      errorCode: failure?.errorCode || "ENTRY_HISTORY_FAILED",
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

export const entryOverviewHistoryBackfillInternals = Object.freeze({ decodeStoredImage });
