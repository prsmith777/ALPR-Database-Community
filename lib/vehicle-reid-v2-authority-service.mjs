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

function publicControl(row) {
  if (!row) return null;
  return {
    mode: row.mode,
    previousMode: row.previous_mode || null,
    revision: number(row.revision),
    transitionRunId: number(row.transition_run_id) || null,
    transitionReason: row.transition_reason || null,
    transitionedAt: row.transitioned_at || null,
  };
}

function publicOverview(raw) {
  const counts = raw?.counts || {};
  const live = raw?.liveJobs || {};
  return {
    control: publicControl(raw?.control),
    counts: {
      profiles: number(counts.profiles),
      provisionalProfiles: number(counts.provisional_profiles),
      multiMemberProfiles: number(counts.multi_member_profiles),
      singletonProfiles: number(counts.singleton_profiles),
      members: number(counts.members),
      plateAnchors: number(counts.plate_anchors),
      assignments: number(counts.assignments),
      unassignedReads: number(counts.unassigned_reads),
      exactPlateAssignments: number(counts.exact_plate_assignments),
      sharedAssetAssignments: number(counts.shared_asset_assignments),
      canonicalImageAssignments: number(counts.canonical_image_assignments),
    },
    liveJobs: {
      pending: number(live.pending),
      processing: number(live.processing),
      ready: number(live.ready),
      conflict: number(live.conflict),
      unavailable: number(live.unavailable),
      failed: number(live.failed),
    },
    comparison: objectValue(raw?.transitionRun?.preview_metrics),
  };
}

function publicProfile(row) {
  return {
    id: number(row.id),
    status: row.effective_status || row.status,
    revision: number(row.revision),
    provenanceBasis: row.provenance_basis,
    representativeDerivativeId: number(row.representative_derivative_id),
    representativeImageUrl: row.representative_storage_path
      ? `/images/${String(row.representative_storage_path).replaceAll("\\", "/")}`
      : null,
    memberCount: number(row.member_count),
    readCount: number(row.read_count),
    anchorPlates: arrayValue(row.anchor_plates),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

export class VehicleReidV2AuthorityService {
  constructor({ repository } = {}) {
    if (!repository) throw new TypeError("VehicleReidV2AuthorityService requires a repository.");
    this.repository = repository;
  }

  async getOverview() {
    return publicOverview(await this.repository.getOverview());
  }

  async acceptPreview(input = {}) {
    const operation = await this.repository.acceptPreview(input);
    return { operation, overview: await this.getOverview() };
  }

  async materializeAcceptedPreview(input = {}) {
    const operation = await this.repository.materializeAcceptedPreview(input);
    return { operation, overview: await this.getOverview() };
  }

  async transitionMode(input = {}) {
    const control = await this.repository.transitionMode(input);
    return { operation: { control: publicControl(control) }, overview: await this.getOverview() };
  }

  mergeProfilesByReview(input = {}) {
    return this.repository.mergeProfilesByReview(input);
  }

  async listProfiles(input = {}) {
    const [result, overview] = await Promise.all([
      this.repository.listProfiles(input),
      this.getOverview(),
    ]);
    return {
      profiles: result.rows.map(publicProfile),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      overview,
    };
  }

  async getProfile(profileId) {
    const result = await this.repository.getProfile(profileId);
    if (!result.profile) return null;
    return {
      profile: {
        ...publicProfile({
          ...result.profile,
          member_count: result.members.length,
          read_count: result.reads.length,
        }),
        representativeEmbeddingId: number(result.profile.representative_embedding_id),
        representativeSourceSha256: String(result.profile.representative_source_sha256 || "").trim(),
      },
      members: result.members.map((row) => ({
        id: number(row.id),
        derivativeId: number(row.derivative_id),
        assetId: number(row.asset_id),
        embeddingId: number(row.embedding_id),
        membershipBasis: row.membership_basis,
        storagePath: row.storage_path,
        effectivePlates: arrayValue(row.effective_plates),
        overviewContexts: arrayValue(row.overview_contexts),
      })),
      reads: result.reads.map((row) => ({
        id: number(row.read_id),
        assignmentBasis: row.assignment_basis,
        normalizedEffectivePlate: row.normalized_effective_plate || null,
        timestamp: row.read_timestamp,
        cameraName: row.camera_name || null,
        plateNumber: row.plate_number,
        imagePath: row.image_path || null,
        thumbnailPath: row.thumbnail_path || null,
        knownName: row.known_name || null,
        notes: row.notes || null,
        tags: arrayValue(row.tags),
      })),
    };
  }

  async resolveRead(readId) {
    const row = await this.repository.resolveRead(readId);
    if (!row) return null;
    return {
      readId: number(row.read_id),
      profileId: number(row.profile_id) || null,
      assignmentBasis: row.assignment_basis || null,
      derivativeId: number(row.derivative_id) || null,
      embeddingId: number(row.embedding_id) || null,
      cropPath: row.storage_path || null,
      currentIdentityLink: row.current_identity_link === true,
    };
  }
}

export const vehicleReidV2AuthorityServiceInternals = Object.freeze({
  arrayValue,
  number,
  publicControl,
  publicOverview,
  publicProfile,
});
