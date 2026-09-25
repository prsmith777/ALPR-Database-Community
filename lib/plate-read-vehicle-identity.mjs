const VEHICLE_IDENTITY_MODES = new Set([
  "v1_primary",
  "v2_shadow",
  "v2_primary",
  "v1_rollback",
]);

export function normalizeVehicleIdentityMode(mode) {
  const normalized = String(mode || "").trim().toLowerCase();
  return VEHICLE_IDENTITY_MODES.has(normalized) ? normalized : "v1_primary";
}

function assertParameterToken(parameterToken) {
  if (!/^\$\d+$/.test(parameterToken)) {
    throw new TypeError("Vehicle identity mode must use a positional SQL parameter");
  }
}

export function buildPlateReadVehicleIdentitySql(mode, modeParameter) {
  assertParameterToken(modeParameter);
  const normalizedMode = normalizeVehicleIdentityMode(mode);

  if (normalizedMode !== "v2_primary") {
    return {
      mode: normalizedMode,
      columns: `
        cluster_assignment.cluster_id AS vehicle_cluster_id,
        cluster_assignment.assignment_status AS vehicle_cluster_status,
        cluster_assignment.similarity AS vehicle_cluster_similarity,
        ${modeParameter}::varchar AS vehicle_identity_mode,
        NULL::bigint AS vehicle_profile_id,
        NULL::varchar AS vehicle_profile_assignment_basis,
        TRUE AS vehicle_find_similar_available`,
      joins: "",
    };
  }

  return {
    mode: normalizedMode,
    columns: `
        reid_v2_assignment.canonical_profile_id AS vehicle_cluster_id,
        CASE WHEN reid_v2_assignment.id IS NULL THEN NULL ELSE 'authoritative' END
          AS vehicle_cluster_status,
        NULL::double precision AS vehicle_cluster_similarity,
        ${modeParameter}::varchar AS vehicle_identity_mode,
        reid_v2_assignment.canonical_profile_id AS vehicle_profile_id,
        reid_v2_assignment.assignment_basis AS vehicle_profile_assignment_basis,
        (reid_v2_search.derivative_id IS NOT NULL)
          AS vehicle_find_similar_available`,
    joins: `
      LEFT JOIN LATERAL (
        SELECT assignments.*
        FROM public.vehicle_reid_v2_current_read_assignments assignments
        WHERE assignments.read_id = pr.id
        LIMIT 1
      ) reid_v2_assignment ON TRUE
      LEFT JOIN LATERAL (
        SELECT derivatives.id AS derivative_id
        FROM public.vehicle_image_asset_reads links
        JOIN public.vehicle_image_derivatives derivatives
          ON derivatives.asset_id = links.asset_id
         AND derivatives.derivative_kind = 'vehicle_crop'
         AND derivatives.algorithm_version = 'canonical-overview-detection-box-v1'
        JOIN public.vehicle_asset_embeddings embeddings
          ON embeddings.derivative_id = derivatives.id
         AND embeddings.model_name = 'vehicle-reid-0001-ir-fp16-v1'
         AND embeddings.algorithm_version = 'canonical-overview-crop-embedding-v1'
         AND embeddings.source_sha256 = derivatives.content_sha256
        WHERE links.read_id = pr.id
          AND links.identity_eligible = TRUE
          AND links.relationship <> 'display_fallback'
          AND pr.vehicle_image_status = 'ready'
          AND pr.vehicle_image_path = links.source_path_snapshot
          AND pr.vehicle_image_source_kind = links.source_kind
          AND pr.vehicle_image_updated_at IS NOT DISTINCT FROM links.source_updated_at
        LIMIT 1
      ) reid_v2_search ON TRUE`,
  };
}
