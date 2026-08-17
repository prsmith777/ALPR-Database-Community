function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function arrayValue(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function objectValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function publicCounts(row) {
  return {
    total: number(row?.total),
    pending: number(row?.pending),
    processing: number(row?.processing),
    ready: number(row?.ready),
    retryable: number(row?.retryable),
    failed: number(row?.failed),
  };
}

function publicRun(row) {
  if (!row) return null;
  return {
    id: number(row.id),
    status: row.status,
    phase: row.phase,
    resumeStatus: row.resume_status || null,
    algorithmVersion: objectValue(row.preview_metrics).algorithmVersion || null,
    maxReadId: number(row.max_read_id),
    maxDerivativeId: number(row.max_derivative_id),
    maxPlateReviewId: number(row.max_plate_review_id),
    maxPairReviewId: number(row.max_pair_review_id),
    cropKind: row.crop_kind,
    cropAlgorithmVersion: row.crop_algorithm_version,
    embeddingModel: row.embedding_model,
    embeddingAlgorithmVersion: row.embedding_algorithm_version,
    sourceProfileCandidateRunId: number(row.source_profile_candidate_run_id),
    sourceProfileCandidateFingerprint: row.source_profile_candidate_fingerprint,
    profileCandidateAlgorithmVersion: row.profile_candidate_algorithm_version,
    identityEvidenceFingerprint: row.identity_evidence_fingerprint || null,
    previewFingerprint: row.preview_fingerprint || null,
    comparisonFingerprint: row.comparison_fingerprint || null,
    batchSize: number(row.batch_size),
    counts: publicCounts(row.counts),
    metrics: objectValue(row.preview_metrics),
    actor: {
      username: row.actor_username || null,
      displayName: row.actor_display_name || null,
    },
    lastRevalidationStatus: row.last_revalidation_status || "not_run",
    lastRevalidationFingerprint: row.last_revalidation_fingerprint || null,
    lastRevalidationErrorCode: row.last_revalidation_error_code || null,
    lastRevalidatedAt: row.last_revalidated_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    pausedAt: row.paused_at || null,
    cancelledAt: row.cancelled_at || null,
    staleAt: row.stale_at || null,
    lastErrorCode: row.last_error_code || null,
    lastErrorDetails: objectValue(row.last_error_details),
  };
}

export function publicVehicleReidV2ConversionOverview(raw) {
  const control = raw?.control || null;
  const authority = raw?.authority || {};
  return {
    control: control ? {
      mode: control.mode,
      previousMode: control.previous_mode || null,
      revision: number(control.revision),
      transitionReason: control.transition_reason || null,
      transitionedAt: control.transitioned_at || null,
    } : null,
    authority: {
      profiles: number(authority.profiles),
      members: number(authority.members),
      assignments: number(authority.assignments),
    },
    latestRun: publicRun(raw?.latestRun),
    retryCandidates: (raw?.retryCandidates || []).map((row) => ({
      jobId: number(row.job_id),
      readId: number(row.read_id),
      attemptCount: number(row.attempt_count),
      operatorRetryCount: number(row.operator_retry_count),
      errorCode: row.error_code || null,
      errorMessage: row.error_message || null,
    })),
    sampleProfiles: (raw?.sampleProfiles || []).map((row) => ({
      id: number(row.id),
      projectionKey: String(row.projection_key || "").trim(),
      profileKind: row.profile_kind,
      evidenceBasis: row.evidence_basis,
      representativeDerivativeId: number(row.representative_derivative_id),
      memberCount: number(row.member_count),
      readCount: number(row.read_count),
      anchorPlates: arrayValue(row.anchor_plates),
    })),
    conflicts: (raw?.conflicts || []).map((row) => ({
      conflictKey: String(row.conflict_key || "").trim(),
      scope: row.scope,
      reason: row.reason,
      derivativeIds: arrayValue(row.derivative_ids).map(Number).filter(Number.isFinite),
      readIds: arrayValue(row.read_ids).map(Number).filter(Number.isFinite),
      reviewIds: arrayValue(row.review_ids).map(Number).filter(Number.isFinite),
      effectivePlates: arrayValue(row.effective_plates),
      details: objectValue(row.details),
    })),
  };
}

export class VehicleReidV2ConversionService {
  constructor({ repository, shadowService }) {
    if (!repository) throw new TypeError("VehicleReidV2ConversionService requires a repository.");
    if (!shadowService) throw new TypeError("VehicleReidV2ConversionService requires the shadow service.");
    this.repository = repository;
    this.shadowService = shadowService;
  }

  async getOverview() {
    return publicVehicleReidV2ConversionOverview(await this.repository.getOverview());
  }

  async startPreview({ actor, batchSize = 5 } = {}) {
    let candidateSnapshot = await this.shadowService.createProfileCandidateSnapshot({ actor });
    let result;
    try {
      result = await this.repository.createPreview({ actor, candidateSnapshot, batchSize });
    } catch (error) {
      if (error?.code !== "VEHICLE_REID_V2_CONVERSION_CANDIDATE_STALE") throw error;
      candidateSnapshot = await this.shadowService.createProfileCandidateSnapshot({ actor });
      result = await this.repository.createPreview({ actor, candidateSnapshot, batchSize });
    }
    return {
      overview: await this.getOverview(),
      operation: {
        runId: result.runId,
        reused: result.reused,
        candidateRunId: result.candidateRunId,
        candidateFingerprint: result.candidateFingerprint,
        candidateAlgorithmVersion: result.candidateAlgorithmVersion,
      },
    };
  }

  async processBatch({ runId, limit = 5, actor } = {}) {
    const operation = await this.repository.processPreviewBatch({ runId, limit, actor });
    if (operation?.error) {
      const error = new Error(operation.error.message || "Preview batch failed.");
      error.code = operation.error.code || "PREVIEW_BATCH_FAILED";
      throw error;
    }
    return { overview: await this.getOverview(), operation };
  }

  async setPaused({ runId, paused, actor } = {}) {
    await this.repository.setPaused({ runId, paused: paused === true, actor });
    return { overview: await this.getOverview(), operation: { paused: paused === true } };
  }

  async cancel({ runId, actor } = {}) {
    await this.repository.cancel({ runId, actor });
    return { overview: await this.getOverview(), operation: { cancelled: true } };
  }

  async retryJob({ jobId, actor } = {}) {
    const runId = await this.repository.retryJob({ jobId, actor });
    return { overview: await this.getOverview(), operation: { runId, jobId: number(jobId) } };
  }

  async verifyCurrent({ runId, previewFingerprint, actor } = {}) {
    const operation = await this.repository.verifyCurrent({
      runId, previewFingerprint, actor,
    });
    return { overview: await this.getOverview(), operation };
  }
}

export const vehicleReidV2ConversionServiceInternals = Object.freeze({
  objectValue,
  publicCounts,
  publicRun,
});
